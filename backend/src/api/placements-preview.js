// Preview of bad placements — the same computation Julio uses to decide
// which to exclude in Google Ads. READ-ONLY for now (no destructive
// action). The Apply path lands in a later phase with a safety re-check
// step. Reading this file:
//
//   ads_placements          per (campaign, placement, date) cost from
//                           detail_placement_view (Ads)
//   utm_revenue_placements  per (campaign_id, placement, date) revenue
//                           from GAM 2-dim UTM report
//
// Join on (campaign_id, placement_clean = lower(placement_value)) for the
// date window. Matched placements get exact ROI. Unmatched placements
// (cost but no revenue row) get an estimated ROI by attributing the
// campaign's total unmatched revenue across them weighted by cost.
//
// Classification (matches the original tracker):
//   - cost < min_cost  -> not bad enough to consider, skipped
//   - matched && roi <= -50%  -> roi_critico
//   - matched && roi <= max_roi (cfg)  -> roi_baixo
//   - unmatched && roi_estimated <= max_roi -> sem_match_utm
//
// Returns the same shape the original "preview · placements ruins"
// modal consumes: per-campaign rollup + per-(campaign, placement) detail.

const express = require('express');
const db = require('../db/database');
const { inClause } = require('../lib/access');
const { cleanPlacement } = require('../sync/google-ads-placements');

const router = express.Router();

// Julio's ad URLs follow the format
//   utm_placement={campaignid}_{placement}
// where {placement} is Google's auto-expansion (typically host+path).
// To match against ads_placements.placement_clean (also host+path),
// strip the leading "<digits>_" then run it through the same cleaner
// the Ads sync uses.
function normalizeUtmPlacement(rawValue) {
  if (!rawValue) return '';
  const s = String(rawValue).trim();
  const stripped = s.replace(/^\d{4,}[_:-]/, '');
  return cleanPlacement(stripped, null);
}

const DEFAULT_MIN_COST = 20;   // BRL — match original placement_cleanup_min_cost_brl
const DEFAULT_MAX_ROI = -10;   // % — placement_cleanup_max_roi_pct
const DEFAULT_MIN_DAYS = 2;    // analysis_days

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

router.get('/preview', (req, res) => {
  const from =
    req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from
      : daysAgoIso(7);
  const to =
    req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to
      : daysAgoIso(0);
  const minCost = Number(req.query.min_cost ?? DEFAULT_MIN_COST);
  const maxRoi = Number(req.query.max_roi ?? DEFAULT_MAX_ROI);
  const minDays = Number(req.query.min_days ?? DEFAULT_MIN_DAYS);

  // Apply revenue-share to GAM revenue when computing ROI, matching the
  // dashboard's daily_metrics convention.
  const rules = db
    .prepare(`SELECT revenue_share_pct FROM rules_config WHERE user_id = ?`)
    .get(req.scope.tenant_user_id ?? req.user.id);
  const netFactor = 1 - (rules?.revenue_share_pct ?? 6.5) / 100;

  const gaClause = inClause('ap.google_account_id', req.scope.google_account_ids);
  const params = [...gaClause.params, from, to];

  // Per-(campaign, placement) cost from Ads. Aggregated across the date
  // window. Filtered by date and by accessible google_account_ids.
  const costRows = db
    .prepare(
      `SELECT
         ap.google_account_id,
         ap.campaign_id,
         MAX(ap.campaign_name) AS campaign_name,
         ap.placement,
         ap.placement_clean,
         MAX(ap.placement_type) AS placement_type,
         SUM(ap.clicks) AS clicks,
         SUM(ap.impressions) AS impressions,
         SUM(ap.cost) AS cost,
         COUNT(DISTINCT ap.date) AS days
       FROM ads_placements ap
       WHERE ${gaClause.sql}
         AND ap.date BETWEEN ? AND ?
       GROUP BY ap.google_account_id, ap.campaign_id, ap.placement_clean`,
    )
    .all(...params);

  // Per-(campaign, placement) revenue from GAM via UTM. The raw
  // placement_value carries the "campaignid_" prefix from Julio's
  // utm_placement scheme (utm_placement={campaignid}_{placement}); we
  // run it through normalizeUtmPlacement so both sides of the join end
  // up in the same "host/path" form. SQL can't safely strip the
  // numeric prefix, so we group at the row level here in JS.
  const rawRevRows = db
    .prepare(
      `SELECT
         u.ga_campaign_id AS campaign_id,
         u.placement_value,
         SUM(u.impressions) AS impressions,
         SUM(u.revenue) AS revenue
       FROM utm_revenue_placements u
       WHERE u.user_id = ?
         AND u.date BETWEEN ? AND ?
       GROUP BY u.ga_campaign_id, u.placement_value`,
    )
    .all(req.scope.tenant_user_id ?? req.user.id, from, to);

  // Index revenue rows for O(1) lookup by (campaign_id, normalized
  // placement). Multiple raw placement_values can normalize to the
  // same key (e.g. with or without query strings) so we accumulate.
  const revByKey = new Map();
  const revRows = [];
  for (const r of rawRevRows) {
    const placement_norm = normalizeUtmPlacement(r.placement_value);
    if (!placement_norm) continue;
    const key = `${r.campaign_id}|${placement_norm}`;
    const cur = revByKey.get(key) ?? { campaign_id: r.campaign_id, placement_norm, revenue: 0, impressions: 0 };
    cur.revenue += Number(r.revenue) || 0;
    cur.impressions += Number(r.impressions) || 0;
    revByKey.set(key, cur);
  }
  revByKey.forEach((v) => revRows.push(v));
  // And per-campaign totals so we can attribute the orphan revenue.
  const revByCampaign = new Map();
  for (const r of revRows) {
    const cur = revByCampaign.get(r.campaign_id) ?? { revenue: 0, impressions: 0 };
    cur.revenue += r.revenue;
    cur.impressions += r.impressions;
    revByCampaign.set(r.campaign_id, cur);
  }

  // Per-campaign cost totals + orphan-cost totals (used to estimate
  // revenue per unmatched placement).
  const costByCampaign = new Map();
  for (const c of costRows) {
    const cur = costByCampaign.get(c.campaign_id) ?? {
      campaign_name: c.campaign_name,
      cost: 0,
      orphan_cost: 0,
      matched_cost: 0,
    };
    cur.cost += c.cost;
    if (revByKey.has(`${c.campaign_id}|${(c.placement_clean || '').toLowerCase()}`)) {
      cur.matched_cost += c.cost;
    } else {
      cur.orphan_cost += c.cost;
    }
    costByCampaign.set(c.campaign_id, cur);
  }

  const items = [];
  for (const c of costRows) {
    const key = `${c.campaign_id}|${(c.placement_clean || '').toLowerCase()}`;
    const rev = revByKey.get(key);
    const cost = c.cost || 0;
    const matched = !!rev;
    const grossRevenue = rev ? rev.revenue : 0;

    // Estimated revenue for unmatched placements: orphan_revenue
    // proportional to this placement's share of the orphan_cost in
    // its campaign. Same heuristic as the original tracker.
    const camp = costByCampaign.get(c.campaign_id) ?? { orphan_cost: 0 };
    const totalRev = revByCampaign.get(c.campaign_id)?.revenue ?? 0;
    const matchedRevenue = (() => {
      let sum = 0;
      for (const [k, r] of revByKey) {
        if (k.startsWith(`${c.campaign_id}|`)) sum += r.revenue;
      }
      return sum;
    })();
    const orphanRevenue = Math.max(0, totalRev - matchedRevenue);
    const estRevenue =
      camp.orphan_cost > 0 && !matched
        ? orphanRevenue * (cost / camp.orphan_cost)
        : grossRevenue;

    const netRevenue = matched ? grossRevenue * netFactor : estRevenue * netFactor;
    const profit = netRevenue - cost;
    const roi = cost > 0 ? (profit / cost) * 100 : 0;
    const roiExact = cost > 0 ? ((grossRevenue * netFactor - cost) / cost) * 100 : 0;

    // Classification — first match wins.
    let reason = null;
    if (cost < minCost) {
      reason = null; // skipped
    } else if (c.days < minDays) {
      reason = null;
    } else if (matched && roiExact <= -50) {
      reason = 'roi_critico';
    } else if (matched && roiExact <= maxRoi) {
      reason = 'roi_baixo';
    } else if (!matched && roi <= maxRoi) {
      reason = 'sem_match_utm';
    }

    if (reason) {
      items.push({
        key,
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        google_account_id: c.google_account_id,
        placement: c.placement,
        placement_clean: c.placement_clean,
        placement_type: c.placement_type,
        clicks: c.clicks,
        impressions: c.impressions,
        cost,
        revenue_exact: grossRevenue,
        revenue_est: matched ? grossRevenue : estRevenue,
        profit,
        roi,         // includes estimate for unmatched
        roi_exact: matched ? roiExact : null,
        days: c.days,
        matched,
        reason,
      });
    }
  }

  // Per-campaign totals for the modal header.
  const campaignTotals = [];
  for (const [campaign_id, c] of costByCampaign) {
    const totalRev = revByCampaign.get(campaign_id)?.revenue ?? 0;
    const netRev = totalRev * netFactor;
    const profit = netRev - c.cost;
    const roi = c.cost > 0 ? (profit / c.cost) * 100 : 0;
    campaignTotals.push({
      campaign_id,
      campaign_name: c.campaign_name,
      cost: c.cost,
      revenue_brl: netRev,
      profit,
      roi,
      bad_count: items.filter((it) => it.campaign_id === campaign_id).length,
    });
  }
  campaignTotals.sort((a, b) => b.cost - a.cost);

  const stats = {
    period: { from, to },
    cfg: { min_cost: minCost, max_roi: maxRoi, min_days: minDays },
    ads_rows: costRows.length,
    gam_rows: revRows.length,
    placements_analyzed: costRows.length,
    placements_bad: items.length,
    placements_matched: costRows.filter((c) =>
      revByKey.has(`${c.campaign_id}|${(c.placement_clean || '').toLowerCase()}`),
    ).length,
    match_pct: (() => {
      const tot = costRows.length;
      const m = costRows.filter((c) =>
        revByKey.has(`${c.campaign_id}|${(c.placement_clean || '').toLowerCase()}`),
      ).length;
      return tot === 0 ? 0 : Math.round((m / tot) * 10000) / 100;
    })(),
  };

  res.json({ stats, items, campaign_totals: campaignTotals });
});

module.exports = router;
