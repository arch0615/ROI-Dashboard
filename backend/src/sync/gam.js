// GAM revenue sync orchestrator.
//
// Flow:
//  1. Resolve the gam_accounts row; decrypt the stored service account JSON.
//  2. Exchange the JWT for an access_token.
//  3. (Best-effort) detect network currency and persist it.
//  4. Run one HISTORICAL report on dimensions [DATE, AD_UNIT_NAME] with
//     the standard ad-server + AdX + AdSense impressions+revenue metrics.
//  5. Upsert each row into placements with placement_key = ad_unit_name,
//     computing ecpm as revenue/impressions * 1000.

const crypto = require('crypto');
const db = require('../db/database');
const { decrypt } = require('../lib/crypto');
const gam = require('../lib/gam');
const fx = require('../lib/fx');
const { TARGET_CURRENCY } = require('./fx');
const { rolloverDailyMetrics } = require('./rollup');

const ALLOWED_PRESETS = new Set([
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_14_DAYS',
  'LAST_30_DAYS',
]);

function gamDateRangeFromInput({ datePreset, from, to }) {
  if (datePreset && ALLOWED_PRESETS.has(String(datePreset).toUpperCase())) {
    return { relativeDateRange: String(datePreset).toUpperCase() };
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (from && to && iso.test(from) && iso.test(to)) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    return {
      fixedDateRange: {
        startDate: { year: fy, month: fm, day: fd },
        endDate: { year: ty, month: tm, day: td },
      },
    };
  }
  return { relativeDateRange: 'LAST_7_DAYS' };
}

async function syncGamAccount({ userId, accountId, datePreset, from, to }) {
  const account = db
    .prepare(`SELECT * FROM gam_accounts WHERE id = ? AND user_id = ?`)
    .get(accountId, userId);
  if (!account) {
    const err = new Error('Conta GAM não encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!account.service_account_json_enc) {
    const err = new Error('Conta GAM sem service_account_json salvo');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const saJson = decrypt({
    ciphertext: account.service_account_json_enc,
    iv: account.service_account_json_iv,
    tag: account.service_account_json_tag,
  });
  let sa;
  try {
    sa = JSON.parse(saJson);
  } catch {
    const err = new Error('service_account_json corrompido em repouso');
    err.code = 'BAD_SA_JSON';
    throw err;
  }

  const accessToken = await gam.getAccessToken(sa);

  // Best-effort currency detection — failure here shouldn't abort the sync.
  let accountCurrency = (account.currency || '').toUpperCase() || null;
  try {
    const cc = await gam.fetchNetworkCurrency({
      networkCode: account.network_code,
      accessToken,
    });
    if (cc) {
      if (cc !== accountCurrency) {
        db.prepare(`UPDATE gam_accounts SET currency = ? WHERE id = ?`).run(cc, account.id);
      }
      accountCurrency = cc;
    }
  } catch (err) {
    // Non-fatal; report it in the response but keep going.
    console.warn(`[gam-sync] currency detect failed for ${account.network_code}: ${err.message}`);
  }
  // Fall back to TARGET if we still couldn't detect — no conversion will run.
  if (!accountCurrency) accountCurrency = TARGET_CURRENCY;

  const dateRange = gamDateRangeFromInput({ datePreset, from, to });
  const rows = await gam.runReport({
    networkCode: account.network_code,
    accessToken,
    dateRange,
    dimensions: ['DATE', 'AD_UNIT_NAME'],
  });

  const upsert = db.prepare(`
    INSERT INTO placements (
      id, user_id, gam_account_id, placement_key, ad_unit, date,
      impressions, revenue, ecpm
    ) VALUES (
      @id, @user_id, @gam_account_id, @placement_key, @ad_unit, @date,
      @impressions, @revenue, @ecpm
    )
    ON CONFLICT(user_id, gam_account_id, placement_key, date) DO UPDATE SET
      ad_unit     = excluded.ad_unit,
      impressions = excluded.impressions,
      revenue     = excluded.revenue,
      ecpm        = excluded.ecpm
  `);

  // Resolve FX rates per distinct date we're about to write. We do this
  // BEFORE opening the write transaction so we don't hold a write lock
  // while making HTTP calls.
  const distinctDates = Array.from(new Set(rows.map((r) => r.date))).filter(Boolean);
  const rateByDate = new Map();
  for (const d of distinctDates) {
    if (accountCurrency === TARGET_CURRENCY) {
      rateByDate.set(d, 1);
      continue;
    }
    try {
      const rate = await fx.getRate({ from: accountCurrency, to: TARGET_CURRENCY, date: d });
      rateByDate.set(d, rate);
    } catch (err) {
      console.warn(`[gam-sync] FX ${accountCurrency}->${TARGET_CURRENCY} @${d} failed: ${err.message}; storing native revenue`);
      rateByDate.set(d, null); // marker: skip conversion, store native
    }
  }

  let written = 0;
  let totalRevenue = 0;
  const writeAll = db.transaction(() => {
    for (const r of rows) {
      const adUnit = r.dims[0] || '(unknown)';
      const rate = rateByDate.get(r.date);
      const revenueConverted = rate != null ? r.revenue * rate : r.revenue;
      const ecpm = r.impressions > 0 ? (revenueConverted / r.impressions) * 1000 : 0;
      upsert.run({
        id: crypto.randomUUID(),
        user_id: userId,
        gam_account_id: account.id,
        placement_key: adUnit,
        ad_unit: adUnit,
        date: r.date,
        impressions: r.impressions,
        revenue: revenueConverted,
        ecpm,
      });
      written += 1;
      totalRevenue += revenueConverted;
    }
  });
  writeAll();

  db.prepare(`UPDATE gam_accounts SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    account.id,
  );

  // New placement data invalidates the existing rollup numbers — re-run
  // so daily_metrics.revenue/profit/roi/roas/ecpm catch up.
  const rollup = rolloverDailyMetrics({ userId });

  return {
    account: { id: account.id, network_code: account.network_code },
    rows_written: written,
    total_revenue: totalRevenue,
    native_currency: accountCurrency,
    target_currency: TARGET_CURRENCY,
    date_range: dateRange,
    rollup,
  };
}

module.exports = { syncGamAccount };
