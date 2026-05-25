// Per-creative ROI comparison inside each campaign.
//
//   ads_creatives           per (campaign, ad, date) cost from
//                           ad_group_ad GAQL (real Ads dimension)
//   utm_revenue_placements  per (campaign, landing_page, date) GAM
//                           revenue via UTM
//
// Attribution model: each creative's slice of the campaign's GAM
// revenue is proportional to its click share (clicks correlate with
// users who actually landed on the GAM-served page). When click
// counts are zero across the board we fall back to impression share.
//
// Classification (matches the original tracker's "Otimização automática"
// thresholds in Julio's screenshot — Custo mín R$ 200, Dias mín 7,
// Dif ROI mín pp 10):
//   - cost < min_cost          -> skipped
//   - days < min_days          -> skipped
//   - (campaign_roi - creative_roi) >= max_roi_diff_pp -> flagged
//
// Returns campaign rollups + the bad-creative list so the UI can
// render the same collapsible "campaign -> creatives" structure
// without extra round trips.

const express = require('express');
const db = require('../db/database');
const { inClause } = require('../lib/access');
const { pauseCreatives, undoCreativePause } = require('../sync/creatives-pause');

const router = express.Router();

const DEFAULT_MIN_COST = 200;
const DEFAULT_MAX_ROI_DIFF_PP = 10;
const DEFAULT_MIN_DAYS = 7;

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

router.get('/preview', (req, res) => {
  const from =
    req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : daysAgoIso(7);
  const to =
    req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : daysAgoIso(0);
  const minCost = Number(req.query.min_cost ?? DEFAULT_MIN_COST);
  const maxRoiDiff = Number(req.query.max_roi_diff_pp ?? DEFAULT_MAX_ROI_DIFF_PP);
  const minDays = Number(req.query.min_days ?? DEFAULT_MIN_DAYS);

  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  const rules = db
    .prepare(`SELECT revenue_share_pct FROM rules_config WHERE user_id = ?`)
    .get(tenantUserId);
  const netFactor = 1 - (rules?.revenue_share_pct ?? 6.5) / 100;

  const gaClause = inClause('ac.google_account_id', req.scope.google_account_ids);

  // Per-creative aggregates in the window.
  const creativeRows = db
    .prepare(
      `SELECT
         ac.google_account_id,
         ac.campaign_id,
         MAX(ac.campaign_name) AS campaign_name,
         ac.ad_id,
         MAX(ac.ad_name) AS ad_name,
         MAX(ac.ad_type) AS ad_type,
         MAX(ac.status) AS status,
         MAX(ac.resource_name) AS resource_name,
         SUM(ac.clicks) AS clicks,
         SUM(ac.impressions) AS impressions,
         SUM(ac.cost) AS cost,
         SUM(ac.conversions) AS conversions,
         COUNT(DISTINCT ac.date) AS days
       FROM ads_creatives ac
       WHERE ${gaClause.sql}
         AND ac.date BETWEEN ? AND ?
       GROUP BY ac.google_account_id, ac.campaign_id, ac.ad_id`,
    )
    .all(...gaClause.params, from, to);

  // Per-campaign GAM revenue in the window.
  const campRevRows = db
    .prepare(
      `SELECT ga_campaign_id, SUM(revenue) AS revenue
         FROM utm_revenue_placements
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY ga_campaign_id`,
    )
    .all(tenantUserId, from, to);
  const revenueByCampaign = new Map(
    campRevRows.map((r) => [r.ga_campaign_id, Number(r.revenue) || 0]),
  );

  // Roll up campaign totals from per-creative data.
  const campaigns = new Map();
  for (const c of creativeRows) {
    const cur = campaigns.get(c.campaign_id) ?? {
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      google_account_id: c.google_account_id,
      total_clicks: 0,
      total_impressions: 0,
      total_cost: 0,
      creatives: [],
    };
    cur.total_clicks += Number(c.clicks) || 0;
    cur.total_impressions += Number(c.impressions) || 0;
    cur.total_cost += Number(c.cost) || 0;
    cur.creatives.push(c);
    campaigns.set(c.campaign_id, cur);
  }

  const bad = [];
  const campaignTotals = [];
  for (const camp of campaigns.values()) {
    const grossRevenue = revenueByCampaign.get(camp.campaign_id) ?? 0;
    const netRevenue = grossRevenue * netFactor;
    const campProfit = netRevenue - camp.total_cost;
    const campRoi = camp.total_cost > 0 ? (campProfit / camp.total_cost) * 100 : 0;

    const enriched = camp.creatives.map((c) => {
      const cost = Number(c.cost) || 0;
      // Click-share attribution, with impression fallback when the
      // campaign-level click total is zero (e.g. brand-new creatives).
      let share = 0;
      if (camp.total_clicks > 0) share = (Number(c.clicks) || 0) / camp.total_clicks;
      else if (camp.total_impressions > 0)
        share = (Number(c.impressions) || 0) / camp.total_impressions;
      const gross = grossRevenue * share;
      const net = gross * netFactor;
      const profit = net - cost;
      const roi = cost > 0 ? (profit / cost) * 100 : 0;
      const diff = campRoi - roi; // positive when creative is WORSE than campaign
      return {
        campaign_id: camp.campaign_id,
        campaign_name: camp.campaign_name,
        ad_id: c.ad_id,
        ad_name: c.ad_name,
        ad_type: c.ad_type,
        status: c.status,
        resource_name: c.resource_name,
        clicks: Number(c.clicks) || 0,
        impressions: Number(c.impressions) || 0,
        cost,
        revenue_attributed: gross,
        profit,
        roi,
        diff_vs_campaign_pp: diff,
        days: c.days,
        ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
      };
    });

    enriched.sort((a, b) => b.cost - a.cost);
    for (const cv of enriched) {
      if (cv.cost < minCost) continue;
      if (cv.days < minDays) continue;
      if (cv.diff_vs_campaign_pp >= maxRoiDiff) bad.push(cv);
    }

    campaignTotals.push({
      campaign_id: camp.campaign_id,
      campaign_name: camp.campaign_name,
      cost: camp.total_cost,
      revenue: grossRevenue,
      profit: campProfit,
      roi: campRoi,
      creative_count: camp.creatives.length,
      bad_count: enriched.filter(
        (cv) => cv.cost >= minCost && cv.days >= minDays && cv.diff_vs_campaign_pp >= maxRoiDiff,
      ).length,
      creatives: enriched,
    });
  }
  campaignTotals.sort((a, b) => b.cost - a.cost);

  res.json({
    stats: {
      period: { from, to },
      cfg: { min_cost: minCost, max_roi_diff_pp: maxRoiDiff, min_days: minDays },
      creatives_analyzed: creativeRows.length,
      campaigns_with_data: campaignTotals.length,
      creatives_bad: bad.length,
    },
    bad,
    campaigns: campaignTotals,
  });
});

// POST /api/creatives/pause — admin only. Re-checks each item's diff
// against its campaign baseline using the freshest data, then PATCHes
// ad_group_ad.status -> PAUSED via campaignCriterion sibling endpoint
// adGroupAds:mutate. Items whose ROI has come back inside the
// baseline (diff < max_roi_diff_pp) get rejected, not sent.
router.post('/pause', async (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const { items, max_roi_diff_pp, min_days, from, to } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items obrigatório (lista não vazia)' });
  }
  const fromIso = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : daysAgoIso(7);
  const toIso = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : daysAgoIso(0);
  try {
    const result = await pauseCreatives({
      userId: req.scope.tenant_user_id ?? req.user.id,
      appliedByUserId: req.user.id,
      items,
      maxRoiDiffPp: Number(max_roi_diff_pp ?? DEFAULT_MAX_ROI_DIFF_PP),
      minDays: Number(min_days ?? DEFAULT_MIN_DAYS),
      from: fromIso,
      to: toIso,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message });
    if (err.code === 'TOKEN_REFRESH' || err.code === 'API_ERROR') {
      return res.status(502).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/pauses', (req, res) => {
  const { include_undone } = req.query;
  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  const showUndone = include_undone === 'true' || include_undone === '1';
  const rows = db
    .prepare(
      `SELECT id, campaign_id, campaign_name, ad_id, ad_name, resource_name,
              snapshot_cost, snapshot_revenue, snapshot_roi, snapshot_diff_pp,
              snapshot_days, applied_at, applied_by_user_id, undone_at, error
         FROM creative_pauses
        WHERE user_id = ?
          ${showUndone ? '' : 'AND undone_at IS NULL'}
        ORDER BY applied_at DESC
        LIMIT 500`,
    )
    .all(tenantUserId);
  res.json(rows);
});

router.post('/pauses/:id/undo', async (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  try {
    const result = await undoCreativePause({
      userId: req.scope.tenant_user_id ?? req.user.id,
      pauseId: req.params.id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'ALREADY_UNDONE') return res.status(409).json({ error: err.message });
    if (err.code === 'API_ERROR' || err.code === 'TOKEN_REFRESH') {
      return res.status(502).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
