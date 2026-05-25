// GAM UTM-based revenue attribution.
//
// Runs a HISTORICAL report with dimensions [DATE, CUSTOM_DIMENSION] and
// the user-configured custom-key id. GAM returns one row per (date,
// dimension_value); we treat the value as a Google Ads campaign_id
// (it's whatever string the publisher's ad tag set via ?utm_campaign=).
// Each row is converted from native currency -> TARGET_CURRENCY and
// upserted into utm_revenue.
//
// The rollup will later prefer utm_revenue for any (campaign, date)
// pair where a row exists, falling back to site-level pro-rata for
// campaigns without UTM data.

const crypto = require('crypto');
const db = require('../db/database');
const { decrypt } = require('../lib/crypto');
const gam = require('../lib/gam');
const fx = require('../lib/fx');
const { TARGET_CURRENCY } = require('./fx');

const { gamDateRangeFromInput } = require('./gam-dates');

async function syncGamUtm({ userId, accountId, datePreset, from, to }) {
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
  if (!account.utm_key_id) {
    const err = new Error(
      'Conta GAM sem utm_key_id configurado. Defina o ID da chave customizada de attribution na seção GAM.',
    );
    err.code = 'NO_UTM_KEY';
    throw err;
  }

  const saJson = decrypt({
    ciphertext: account.service_account_json_enc,
    iv: account.service_account_json_iv,
    tag: account.service_account_json_tag,
  });
  const sa = JSON.parse(saJson);
  const accessToken = await gam.getAccessToken(sa);

  const accountCurrency = (account.currency || TARGET_CURRENCY).toUpperCase();
  const dateRange = gamDateRangeFromInput({ datePreset, from, to });

  // The custom-dimension key id is passed as customDimensionKeyIds (an
  // array of numeric ids represented as strings).
  const report = await gam.runReport({
    networkCode: account.network_code,
    accessToken,
    dateRange,
    dimensions: ['DATE', 'CUSTOM_DIMENSION'],
    customDimensionKeyIds: [account.utm_key_id],
  });

  // FX rate per distinct date.
  const distinctDates = Array.from(new Set(report.map((r) => r.date))).filter(Boolean);
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
      console.warn(`[gam-utm] FX ${accountCurrency}->${TARGET_CURRENCY} @${d}: ${err.message}`);
      rateByDate.set(d, null);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO utm_revenue (
      id, user_id, gam_account_id, ga_campaign_id, date, impressions, revenue
    ) VALUES (
      @id, @user_id, @gam_account_id, @ga_campaign_id, @date, @impressions, @revenue
    )
    ON CONFLICT(user_id, gam_account_id, ga_campaign_id, date) DO UPDATE SET
      impressions = excluded.impressions,
      revenue     = excluded.revenue
  `);

  let written = 0;
  let totalRevenue = 0;
  let unmatched = 0;
  const writeAll = db.transaction(() => {
    // Replace any rows we previously wrote for this account in the window
    // (the report's full set is the new truth).
    const windowDates = distinctDates;
    if (windowDates.length > 0) {
      const placeholders = windowDates.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM utm_revenue
          WHERE user_id = ? AND gam_account_id = ?
            AND date IN (${placeholders})`,
      ).run(userId, account.id, ...windowDates);
    }

    for (const r of report) {
      const utmValue = (r.dims[0] || '').trim();
      if (!utmValue) {
        unmatched += 1;
        continue;
      }
      const rate = rateByDate.get(r.date);
      const revenueConverted = rate != null ? r.revenue * rate : r.revenue;
      upsert.run({
        id: crypto.randomUUID(),
        user_id: userId,
        gam_account_id: account.id,
        ga_campaign_id: utmValue,
        date: r.date,
        impressions: r.impressions,
        revenue: revenueConverted,
      });
      written += 1;
      totalRevenue += revenueConverted;
    }
  });
  writeAll();

  return {
    account: { id: account.id, network_code: account.network_code, utm_key_id: account.utm_key_id },
    rows_written: written,
    unmatched_rows: unmatched,
    total_revenue: totalRevenue,
    native_currency: accountCurrency,
    target_currency: TARGET_CURRENCY,
    date_range: dateRange,
  };
}

module.exports = { syncGamUtm };
