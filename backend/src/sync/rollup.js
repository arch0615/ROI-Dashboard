// Daily metrics rollup. Ties GAM revenue (placements) back to Google Ads
// campaigns (daily_metrics) via account_site_links.
//
// Attribution model (v2 — UTM-direct + site-level pro-rata residual):
//   For each (campaign, date):
//     If utm_revenue has a row for that (campaign, date), use it as the
//     direct attribution and DO NOT include this campaign in pro-rata.
//   For the remaining campaigns on each site (those without UTM data):
//     site_rev_residual   = SUM(placements.revenue) - SUM(utm_revenue
//                            attributed to UTM-tagged campaigns on this site)
//     site_spend_residual = SUM(daily_metrics.spend) - SUM(spend of
//                            UTM-tagged campaigns on this site)
//     allocated_rev = site_rev_residual * (row.spend / site_spend_residual)
//   Without UTM at all, this degrades to the original v1 site-level
//   pro-rata.
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
const { evaluateAlertsForUser } = require('./alerts');

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
    ),
    -- For each (site, date) sum the utm_revenue tied to that site
    -- via the GAM account's link. This is what we subtract from
    -- site_revenue to get the leftover for pro-rata.
    utm_attributed_revenue AS (
      SELECT asl.site_id, u.date, SUM(u.revenue) AS revenue
      FROM utm_revenue u
      JOIN account_site_links asl
        ON asl.gam_account_id = u.gam_account_id
       AND asl.user_id = @user_id
      WHERE u.user_id = @user_id
      GROUP BY asl.site_id, u.date
    ),
    -- For each (site, date) sum the spend of UTM-attributed campaigns
    -- on this site. Same subtraction trick on the spend denominator.
    utm_attributed_spend AS (
      SELECT sfa.site_id, dm.date, SUM(dm.spend) AS spend
      FROM daily_metrics dm
      JOIN site_for_ads sfa ON sfa.google_account_id = dm.google_account_id
      WHERE dm.user_id = @user_id
        AND EXISTS (
          SELECT 1 FROM utm_revenue u
          WHERE u.user_id = @user_id
            AND u.ga_campaign_id = dm.campaign_id
            AND u.date = dm.date
        )
      GROUP BY sfa.site_id, dm.date
    )
    SELECT
      dm.id,
      dm.spend AS row_spend,
      dm.impressions AS row_impressions,
      sfa.site_id,
      COALESCE(sr.revenue, 0)  AS site_revenue,
      COALESCE(ss.spend, 0)    AS site_spend,
      COALESCE(uar.revenue, 0) AS utm_attributed_revenue,
      COALESCE(uas.spend, 0)   AS utm_attributed_spend,
      COALESCE((
        SELECT SUM(u.revenue)
        FROM utm_revenue u
        WHERE u.user_id = dm.user_id
          AND u.ga_campaign_id = dm.campaign_id
          AND u.date = dm.date
      ), 0) AS row_utm_revenue,
      CASE WHEN EXISTS (
        SELECT 1 FROM utm_revenue u
        WHERE u.user_id = dm.user_id
          AND u.ga_campaign_id = dm.campaign_id
          AND u.date = dm.date
      ) THEN 1 ELSE 0 END AS has_utm
    FROM daily_metrics dm
    LEFT JOIN site_for_ads sfa ON sfa.google_account_id = dm.google_account_id
    LEFT JOIN site_revenue sr  ON sr.site_id = sfa.site_id AND sr.date = dm.date
    LEFT JOIN site_spend   ss  ON ss.site_id = sfa.site_id AND ss.date = dm.date
    LEFT JOIN utm_attributed_revenue uar ON uar.site_id = sfa.site_id AND uar.date = dm.date
    LEFT JOIN utm_attributed_spend   uas ON uas.site_id = sfa.site_id AND uas.date = dm.date
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
  let utmDirectCount = 0;
  const writeAll = db.transaction(() => {
    for (const r of rows) {
      let allocatedRev = 0;
      if (r.has_utm) {
        allocatedRev = r.row_utm_revenue;
        utmDirectCount += 1;
      } else {
        const residualRev = Math.max(0, r.site_revenue - r.utm_attributed_revenue);
        const residualSpend = Math.max(0, r.site_spend - r.utm_attributed_spend);
        allocatedRev =
          residualSpend > 0 && r.row_spend > 0
            ? residualRev * (r.row_spend / residualSpend)
            : 0;
      }
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

  // After the rollup, re-evaluate alerts so the dashboard's badges
  // stay in sync with the freshest ROI numbers. A failure here
  // shouldn't roll back the rollup itself — surface it but keep going.
  let alertsResult = null;
  try {
    alertsResult = evaluateAlertsForUser({ userId });
  } catch (err) {
    console.warn(`[rollup] alerts eval failed for user ${userId}: ${err.message}`);
    alertsResult = { error: err.message };
  }

  return {
    revenue_share_pct: revShare,
    rows_updated: updated,
    utm_direct_rows: utmDirectCount,
    revenue_allocated: totalRevenueAllocated,
    from: from ?? null,
    to: to ?? null,
    alerts: alertsResult,
  };
}

module.exports = { rolloverDailyMetrics };
