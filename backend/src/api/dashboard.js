const express = require('express');
const db = require('../db/database');

const router = express.Router();

// GET /api/dashboard/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates daily_metrics over the range. Empty range -> all-time.
router.get('/overview', (req, res) => {
  const { from, to } = req.query;
  const params = [req.user.id];
  let where = `WHERE user_id = ?`;
  if (from) {
    where += ` AND date >= ?`;
    params.push(from);
  }
  if (to) {
    where += ` AND date <= ?`;
    params.push(to);
  }
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(spend), 0)      AS spend,
         COALESCE(SUM(revenue), 0)    AS revenue,
         COALESCE(SUM(profit), 0)     AS profit,
         COALESCE(SUM(clicks), 0)     AS clicks,
         COALESCE(SUM(conversions), 0) AS conversions,
         COALESCE(SUM(impressions), 0) AS impressions,
         COUNT(DISTINCT campaign_id)  AS campaigns_with_data,
         COUNT(DISTINCT date)         AS days_with_data
       FROM daily_metrics
       ${where}`,
    )
    .get(...params);

  const spend = row.spend || 0;
  const revenue = row.revenue || 0;
  const profit = row.profit || 0;
  // ROI and ROAS use the per-row `profit` column (already net of
  // revenue_share_pct from rollup) so the totals here match what each
  // daily_metrics row shows. `revenue` stays as gross GAM revenue.
  const roi = spend > 0 ? (profit / spend) * 100 : 0;
  const roas = spend > 0 ? (spend + profit) / spend : 0;

  res.json({
    range: { from: from || null, to: to || null },
    totals: {
      spend,
      revenue,
      profit,
      roi,
      roas,
      clicks: row.clicks,
      conversions: row.conversions,
      impressions: row.impressions,
    },
    coverage: {
      campaigns_with_data: row.campaigns_with_data,
      days_with_data: row.days_with_data,
    },
  });
});

// GET /api/dashboard/timeseries?from=&to=
// One row per day. ROI is recomputed from per-day totals so summed
// ratios stay correct.
router.get('/timeseries', (req, res) => {
  const { from, to } = req.query;
  const params = [req.user.id];
  let where = `WHERE user_id = ?`;
  if (from) {
    where += ` AND date >= ?`;
    params.push(from);
  }
  if (to) {
    where += ` AND date <= ?`;
    params.push(to);
  }
  const rows = db
    .prepare(
      `SELECT
         date,
         COALESCE(SUM(spend), 0)       AS spend,
         COALESCE(SUM(revenue), 0)     AS revenue,
         COALESCE(SUM(profit), 0)      AS profit,
         COALESCE(SUM(clicks), 0)      AS clicks,
         COALESCE(SUM(impressions), 0) AS impressions
       FROM daily_metrics
       ${where}
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(...params);
  for (const r of rows) {
    r.roi = r.spend > 0 ? (r.profit / r.spend) * 100 : 0;
    r.roas = r.spend > 0 ? (r.spend + r.profit) / r.spend : 0;
  }
  res.json(rows);
});

module.exports = router;
