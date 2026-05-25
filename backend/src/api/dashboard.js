const express = require('express');
const db = require('../db/database');
const { inClause } = require('../lib/access');

const router = express.Router();

// GET /api/dashboard/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates daily_metrics over the range, scoped to the caller's
// accessible google_account_ids.
router.get('/overview', (req, res) => {
  const { from, to } = req.query;
  const accountClause = inClause('google_account_id', req.scope.google_account_ids);
  const params = [...accountClause.params];
  let where = accountClause.sql;
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
       WHERE ${where}`,
    )
    .get(...params);

  const spend = row.spend || 0;
  const revenue = row.revenue || 0;
  const profit = row.profit || 0;
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

router.get('/timeseries', (req, res) => {
  const { from, to } = req.query;
  const accountClause = inClause('google_account_id', req.scope.google_account_ids);
  const params = [...accountClause.params];
  let where = accountClause.sql;
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
       WHERE ${where}
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
