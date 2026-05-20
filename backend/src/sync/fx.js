// FX refresh — pulls today's rates for every currency pair that any
// gam_accounts row needs against TARGET_CURRENCY. We don't speculate
// about currencies the user hasn't actually configured.
//
// Called by the daily cron BEFORE the per-account syncs so historical
// data (yesterday) finds its rate already cached.

const db = require('../db/database');
const fx = require('../lib/fx');

const TARGET_CURRENCY = (process.env.TARGET_CURRENCY || 'BRL').toUpperCase();

async function refreshFxRates() {
  const sourceCurrencies = db
    .prepare(
      `SELECT DISTINCT currency
         FROM gam_accounts
        WHERE currency IS NOT NULL AND currency != ''`,
    )
    .all()
    .map((r) => String(r.currency).toUpperCase())
    .filter((c) => c !== TARGET_CURRENCY);

  if (sourceCurrencies.length === 0) {
    return { pairs_refreshed: 0, target: TARGET_CURRENCY, sources: [] };
  }

  const today = fx.todayIso();
  const results = [];
  for (const from of sourceCurrencies) {
    try {
      const rate = await fx.getRate({ from, to: TARGET_CURRENCY, date: today });
      results.push({ from, to: TARGET_CURRENCY, rate });
    } catch (err) {
      results.push({ from, to: TARGET_CURRENCY, error: err.message });
    }
  }
  return {
    pairs_refreshed: results.filter((r) => !r.error).length,
    target: TARGET_CURRENCY,
    sources: results,
  };
}

module.exports = { refreshFxRates, TARGET_CURRENCY };
