// GAM revenue by (utm_campaign, utm_placement) — uses two CUSTOM_DIMENSION
// entries in the report dimensions list, each one paired with a key id
// in customDimensionKeyIds (order-matched).
//
// Writes per-(campaign_id, placement_value, date) revenue to
// utm_revenue_placements. The placement_value is whatever the publisher's
// ad tag set on the utm_placement custom key — typically
// "campaignid_placement" or just "placement". We DON'T parse it further;
// the join is done case-insensitive against ads_placements.placement_clean
// by the preview aggregator.

const crypto = require('crypto');
const db = require('../db/database');
const { decrypt } = require('../lib/crypto');
const gam = require('../lib/gam');
const fx = require('../lib/fx');
const { TARGET_CURRENCY } = require('./fx');
const { gamDateRangeFromInput } = require('./gam-dates');

async function syncGamUtmPlacement({ userId, accountId, datePreset, from, to }) {
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
      'Conta GAM precisa de utm_key_id (utm_campaign) configurado. Rode discover-utm-keys.',
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

  // URL-only report. We previously added CUSTOM_DIMENSION_0_VALUE for
  // utm_campaign so we could attribute Ads campaign -> GAM revenue
  // directly, but in practice GAM returned (not applicable) for the
  // utm_campaign cell on the vast majority of rows (only campaigns whose
  // Ads Final URL template explicitly contains {campaignid} forward
  // it). Adding the custom dimension also caused some networks to
  // silently return zero rows. URL alone is always populated, so we
  // attribute downstream by matching ads_creatives.final_url to
  // placement_value (host+path) instead.
  const report = await gam.runReport({
    networkCode: account.network_code,
    accessToken,
    dateRange,
    dimensions: ['DATE', 'URL'],
  });

  // Resolve FX rates per distinct date BEFORE the write transaction.
  const distinctDates = Array.from(new Set(report.map((r) => r.date))).filter(Boolean);
  const rateByDate = new Map();
  for (const d of distinctDates) {
    if (accountCurrency === TARGET_CURRENCY) {
      rateByDate.set(d, 1);
      continue;
    }
    try {
      rateByDate.set(d, await fx.getRate({ from: accountCurrency, to: TARGET_CURRENCY, date: d }));
    } catch (err) {
      console.warn(`[gam-utm-placement] FX ${accountCurrency}->${TARGET_CURRENCY} @${d}: ${err.message}`);
      rateByDate.set(d, null);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO utm_revenue_placements (
      id, user_id, gam_account_id, ga_campaign_id, placement_value, date,
      impressions, revenue
    ) VALUES (
      @id, @user_id, @gam_account_id, @ga_campaign_id, @placement_value, @date,
      @impressions, @revenue
    )
    ON CONFLICT(user_id, gam_account_id, ga_campaign_id, placement_value, date)
    DO UPDATE SET impressions = excluded.impressions, revenue = excluded.revenue
  `);

  let written = 0;
  let unmatched = 0;
  let totalRevenue = 0;
  const writeAll = db.transaction(() => {
    // Wipe the window for this account first so a re-sync purges stale
    // rows (e.g. a placement that no longer reports any traffic this period).
    if (distinctDates.length > 0) {
      const ph = distinctDates.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM utm_revenue_placements
          WHERE user_id = ? AND gam_account_id = ? AND date IN (${ph})`,
      ).run(userId, account.id, ...distinctDates);
    }

    for (const r of report) {
      // dims[0] = URL (the page where the ad rendered).
      const urlValue = (r.dims[0] || '').trim();
      if (!urlValue || urlValue.toLowerCase() === '(not applicable)') {
        unmatched += 1;
        continue;
      }
      const rate = rateByDate.get(r.date);
      const revenueConverted = rate != null ? r.revenue * rate : r.revenue;
      upsert.run({
        id: crypto.randomUUID(),
        user_id: userId,
        gam_account_id: account.id,
        // ga_campaign_id is kept for backwards compatibility with the
        // unique index; empty string means "no utm_campaign breakdown".
        ga_campaign_id: '',
        placement_value: urlValue,
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
    account: { id: account.id, network_code: account.network_code },
    rows_written: written,
    unmatched_rows: unmatched,
    total_revenue: totalRevenue,
    native_currency: accountCurrency,
    target_currency: TARGET_CURRENCY,
    date_range: dateRange,
  };
}

module.exports = { syncGamUtmPlacement };
