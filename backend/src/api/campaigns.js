const express = require('express');
const db = require('../db/database');
const { inClause } = require('../lib/access');

const router = express.Router();

// Per-campaign aggregate: JOINs each campaign to its daily_metrics rows
// in the requested window and sums spend/revenue/profit/clicks/etc.
// ROI and ROAS are recomputed from totals (sum-of-ratios is wrong);
// eCPM uses summed Ads impressions matching the per-row formula in rollup.
router.get('/aggregate', (req, res) => {
  const { from, to, google_account_id } = req.query;
  // Restrict the scope of campaigns AND daily_metrics to accounts the
  // caller can see. If a specific google_account_id is requested, intersect
  // it with the scope (silently ignore if out of scope).
  let accessibleAccountIds = req.scope.google_account_ids;
  if (google_account_id) {
    accessibleAccountIds = accessibleAccountIds.includes(google_account_id)
      ? [google_account_id]
      : [];
  }
  const params = [];
  let dateFilter = '';
  if (from) {
    dateFilter += ` AND dm.date >= ?`;
    params.push(from);
  }
  if (to) {
    dateFilter += ` AND dm.date <= ?`;
    params.push(to);
  }
  const accountInClause = inClause('c.google_account_id', accessibleAccountIds);
  params.push(...accountInClause.params);

  const rows = db
    .prepare(
      `SELECT
         c.id, c.google_account_id, c.campaign_id, c.name, c.status, c.channel_type,
         c.budget_micros, c.target_cpa_micros,
         COALESCE(SUM(dm.spend), 0)       AS spend,
         COALESCE(SUM(dm.revenue), 0)     AS revenue,
         COALESCE(SUM(dm.profit), 0)      AS profit,
         COALESCE(SUM(dm.clicks), 0)      AS clicks,
         COALESCE(SUM(dm.conversions), 0) AS conversions,
         COALESCE(SUM(dm.impressions), 0) AS impressions,
         COUNT(DISTINCT dm.date)          AS days_with_data
       FROM campaigns c
       LEFT JOIN daily_metrics dm
         ON dm.user_id = c.user_id
        AND dm.google_account_id = c.google_account_id
        AND dm.campaign_id = c.campaign_id
        ${dateFilter}
       WHERE ${accountInClause.sql}
       GROUP BY c.id
       ORDER BY spend DESC`,
    )
    .all(...params);

  for (const r of rows) {
    r.roi = r.spend > 0 ? (r.profit / r.spend) * 100 : 0;
    r.roas = r.spend > 0 ? (r.spend + r.profit) / r.spend : 0;
    r.ecpm = r.impressions > 0 ? (r.revenue / r.impressions) * 1000 : 0;
  }
  res.json(rows);
});

router.get('/', (req, res) => {
  const { google_account_id } = req.query;
  let accessibleAccountIds = req.scope.google_account_ids;
  if (google_account_id) {
    accessibleAccountIds = accessibleAccountIds.includes(google_account_id)
      ? [google_account_id]
      : [];
  }
  const { sql, params } = inClause('google_account_id', accessibleAccountIds);
  const rows = db
    .prepare(
      `SELECT id, google_account_id, campaign_id, name, status, channel_type,
              budget_micros, target_cpa_micros, created_at, updated_at
         FROM campaigns
        WHERE ${sql}
        ORDER BY name`,
    )
    .all(...params);
  res.json(rows);
});

module.exports = router;
