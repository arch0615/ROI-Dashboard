// FX rate client — sourced from frankfurter.app (ECB rates, free, no
// API key). We cache rates in the fx_rates table keyed by (from, to, date)
// so historical syncs use the rate from THAT day's data, not today's
// rate. The cache is the source of truth at read time; we only hit
// the network when nothing is stored.

const db = require('../db/database');

const FX_BASE = 'https://api.frankfurter.app';

// Returns yyyy-mm-dd in UTC. Frankfurter normalizes its dates to ECB
// publication days; using UTC dates avoids surprises near midnight.
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function getStoredRate({ from, to, date }) {
  if (from === to) return 1;
  const row = db
    .prepare(
      `SELECT rate FROM fx_rates
        WHERE from_currency = ? AND to_currency = ? AND date = ?`,
    )
    .get(from, to, date);
  return row ? row.rate : null;
}

function storeRate({ from, to, date, rate }) {
  db.prepare(
    `INSERT INTO fx_rates (from_currency, to_currency, date, rate)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(from_currency, to_currency, date) DO UPDATE SET
       rate = excluded.rate,
       fetched_at = CURRENT_TIMESTAMP`,
  ).run(from, to, date, rate);
}

async function fetchFromFrankfurter({ from, to, date }) {
  // /latest works for "today's rate"; /{yyyy-mm-dd} works for historical.
  // Future dates 400 — caller is responsible for not passing them.
  const path = date === todayIso() ? '/latest' : `/${date}`;
  const url = `${FX_BASE}${path}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`FX fetch ${from}->${to} @ ${date} failed: ${data.message ?? res.status}`);
    err.code = 'FX_FETCH';
    throw err;
  }
  const rate = data?.rates?.[to];
  if (!Number.isFinite(rate)) {
    const err = new Error(`FX response missing rate for ${to}: ${JSON.stringify(data).slice(0, 120)}`);
    err.code = 'FX_FETCH';
    throw err;
  }
  return { rate, resolvedDate: data.date ?? date };
}

// Returns a numeric rate (units of `to` per unit of `from`) for the
// given date. Reads cache first; otherwise fetches and persists.
// Same-currency call short-circuits to 1.
async function getRate({ from, to, date }) {
  if (from === to) return 1;
  const cached = getStoredRate({ from, to, date });
  if (cached != null) return cached;
  const { rate, resolvedDate } = await fetchFromFrankfurter({ from, to, date });
  // Store under both the requested date AND the resolved date (frankfurter
  // returns the most recent ECB publication day, which may be Friday for a
  // weekend lookup). The next request for either date hits the cache.
  storeRate({ from, to, date, rate });
  if (resolvedDate && resolvedDate !== date) {
    storeRate({ from, to, date: resolvedDate, rate });
  }
  return rate;
}

async function convertTo({ amount, from, to, date }) {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (from === to) return amount;
  const rate = await getRate({ from, to, date });
  return amount * rate;
}

module.exports = {
  getStoredRate,
  storeRate,
  getRate,
  convertTo,
  todayIso,
};
