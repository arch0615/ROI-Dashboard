// Daily metrics rollup. Ties GAM revenue (placements) back to Google Ads
// campaigns (daily_metrics) via account_site_links.
//
// Attribution model (v1 — site-level pro-rata by spend share):
//   For each (site, date):
//     site_revenue   = SUM(placements.revenue over linked GAM accounts)
//     site_spend     = SUM(daily_metrics.spend over linked Ads accounts)
//   For each daily_metrics row tied to a site that has site_spend > 0:
//     allocated_rev  = site_revenue * (row.spend / site_spend)
//   Otherwise allocated_rev = 0.
//
// Then revenue_share_pct from rules_config is applied:
//   net_revenue = allocated_rev * (1 - revenue_share_pct/100)
//   profit      = net_revenue - spend
//   roi (%)     = profit / spend * 100   (when spend > 0)
//   roas        = net_revenue / spend    (when spend > 0)
//   ecpm        = allocated_rev / impressions * 1000  (when impressions > 0)
//
// FX is NOT applied here — Ads spend is in the Ads account's native
// currency (typically BRL), GAM revenue in the network's currency
// (typically USD). Conversion happens in M3 D5 once we have fx rates.

const db = require('../db/database');

function rolloverDailyMetrics({ userId, from, to }) {
  const rules = db
    .prepare(`SELECT revenue_share_pct FROM rules_config WHERE user_id = ?`)
    .get(userId);
  const revShare = rules?.revenue_share_pct ?? 6.5;
  const netFactor = 1 - revShare / 100;

  const filters = ['dm.user_id = ?'];
  const params = [userId];
  if (from) {
    filters.push('dm.date >= ?');
    params.push(from);
  }
  if (to) {
    filters.push('dm.date <= ?');
    params.push(to);
  }
  const where = filters.join(' AND ');

  // We bind userId four times into the CTEs + once into the outer where,
  // and the optional from/to bindings tail the params array. Re-derive
  // the CTE params from scratch so we don't accidentally interleave.
  const rows = db
    .prepare(
      `
    WITH
    site_for_ads AS (
      SELECT google_account_id, MIN(site_id) AS site_id
      FROM account_site_links
      WHERE user_id = @user_id AND google_account_id IS NOT NULL
      GROUP BY google_account_id
    ),
    site_revenue AS (
      SELECT asl.site_id, p.date,
             SUM(p.revenue) AS revenue,
             SUM(p.impressions) AS impressions
      FROM placements p
      JOIN account_site_links asl
        ON asl.gam_account_id = p.gam_account_id
       AND asl.user_id = @user_id
      WHERE p.user_id = @user_id
      GROUP BY asl.site_id, p.date
    ),
    site_spend AS (
      SELECT sfa.site_id, dm.date, SUM(dm.spend) AS spend
      FROM daily_metrics dm
      JOIN site_for_ads sfa ON sfa.google_account_id = dm.google_account_id
      WHERE dm.user_id = @user_id
      GROUP BY sfa.site_id, dm.date
    )
    SELECT
      dm.id,
      dm.spend AS row_spend,
      dm.impressions AS row_impressions,
      sfa.site_id,
      COALESCE(sr.revenue, 0) AS site_revenue,
      COALESCE(ss.spend, 0)   AS site_spend
    FROM daily_metrics dm
    LEFT JOIN site_for_ads sfa ON sfa.google_account_id = dm.google_account_id
    LEFT JOIN site_revenue sr  ON sr.site_id = sfa.site_id AND sr.date = dm.date
    LEFT JOIN site_spend   ss  ON ss.site_id = sfa.site_id AND ss.date = dm.date
    WHERE ${where.replace('dm.user_id = ?', 'dm.user_id = @user_id')}
       ${from ? 'AND dm.date >= @from' : ''}
       ${to ? 'AND dm.date <= @to' : ''}
    `,
    )
    .all({
      user_id: userId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });

  const update = db.prepare(`
    UPDATE daily_metrics
       SET revenue   = @revenue,
           profit    = @profit,
           roi       = @roi,
           roas      = @roas,
           ecpm      = @ecpm,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = @id
  `);

  let updated = 0;
  let totalRevenueAllocated = 0;
  const writeAll = db.transaction(() => {
    for (const r of rows) {
      const allocatedRev =
        r.site_spend > 0 && r.row_spend > 0
          ? r.site_revenue * (r.row_spend / r.site_spend)
          : 0;
      const netRevenue = allocatedRev * netFactor;
      const spend = r.row_spend;
      const profit = netRevenue - spend;
      const roi = spend > 0 ? (profit / spend) * 100 : 0;
      const roas = spend > 0 ? netRevenue / spend : 0;
      const ecpm = r.row_impressions > 0 ? (allocatedRev / r.row_impressions) * 1000 : 0;
      update.run({
        id: r.id,
        revenue: allocatedRev,
        profit,
        roi,
        roas,
        ecpm,
      });
      updated += 1;
      totalRevenueAllocated += allocatedRev;
    }
  });
  writeAll();

  return {
    revenue_share_pct: revShare,
    rows_updated: updated,
    revenue_allocated: totalRevenueAllocated,
    from: from ?? null,
    to: to ?? null,
  };
}

module.exports = { rolloverDailyMetrics };
