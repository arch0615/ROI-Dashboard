const express = require('express');
const db = require('../db/database');

const router = express.Router();

// Per-campaign aggregate: JOINs each campaign to its daily_metrics rows
// in the requested window and sums spend/revenue/profit/clicks/etc.
// ROI and ROAS are recomputed from totals (sum-of-ratios is wrong);
// eCPM uses summed Ads impressions matching the per-row formula in rollup.
router.get('/aggregate', (req, res) => {
  const { from, to, google_account_id } = req.query;
  // SQL has placeholders in this order:
  //   1. dateFilter inside the LEFT JOIN ON  (0..2 params: from, to)
  //   2. WHERE c.user_id = ?                 (1 param)
  //   3. accountFilter inside the WHERE      (0..1 params)
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
  params.push(req.user.id);
  let accountFilter = '';
  if (google_account_id) {
    accountFilter += ` AND c.google_account_id = ?`;
    params.push(google_account_id);
  }

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
       WHERE c.user_id = ?
       ${accountFilter}
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
  const params = [req.user.id];
  let where = `WHERE user_id = ?`;
  if (google_account_id) {
    where += ` AND google_account_id = ?`;
    params.push(google_account_id);
  }
  const rows = db
    .prepare(
      `SELECT id, google_account_id, campaign_id, name, status, channel_type,
              budget_micros, target_cpa_micros, created_at, updated_at
         FROM campaigns
         ${where}
        ORDER BY name`,
    )
    .all(...params);
  res.json(rows);
});

module.exports = router;
