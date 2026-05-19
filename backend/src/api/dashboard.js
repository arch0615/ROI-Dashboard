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
  const roi = spend > 0 ? ((revenue - spend) / spend) * 100 : 0;
  const roas = spend > 0 ? revenue / spend : 0;

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

module.exports = router;
