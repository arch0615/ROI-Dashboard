// Preview of bad placements — the screen Julio uses to identify which
// landing pages to exclude in Google Ads. READ-ONLY in this phase.
// Apply lands later with a safety re-check.
//
// Attribution model (v2, after Julio's 2026-05-25 bug report):
//
//   For each (campaign_id, landing_page_url, date_range) row from GAM
//   2-dim UTM report:
//     revenue        = sum revenue   (already net of native FX -> BRL)
//     impressions    = sum impressions
//
//   Then for each campaign present in that set:
//     total_campaign_imps = sum of impressions over all its landing pages
//     total_campaign_cost = sum daily_metrics.spend for that campaign
//                           over the same date range
//
//   For each landing page within the campaign:
//     attributed_cost = total_campaign_cost
//                       * (this_row_impressions / total_campaign_imps)
//     profit          = revenue * (1 - revenue_share_pct/100) - cost
//     roi             = profit / attributed_cost * 100
//
// Classification (first-match-wins):
//     cost < min_cost OR days < min_days  -> skipped
//     roi <= -50%                          -> roi_critico
//     roi <= max_roi (cfg, default -10%)   -> roi_baixo
//
// "sem_match_utm" surfaces orphan cost: campaigns that spent money over
// the period but have ZERO GAM revenue rows for any landing page — these
// land in a separate per-campaign list (not per-placement) and the user
// decides whether to investigate.

const express = require('express');
const db = require('../db/database');
const { inClause } = require('../lib/access');
const { cleanPlacement } = require('../sync/google-ads-placements');
const { applyPlacementExclusions, undoPlacementExclusion } = require('../sync/placements-apply');

const router = express.Router();

const DEFAULT_MIN_COST = 20;
const DEFAULT_MAX_ROI = -10;
const DEFAULT_MIN_DAYS = 2;

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Julio's URL scheme tags utm_placement as "campaignid_placement".
// On the GAM 2-dim sync we now store the raw page URL (the GAM URL
// dimension) rather than a custom-key value, so the strip is a no-op
// when there's no leading "\d+_" — kept for backward compat with any
// older sync that did use utm_placement custom key.
function normalizeLandingPage(rawValue) {
  if (!rawValue) return '';
  const s = String(rawValue).trim();
  const stripped = s.replace(/^\d{4,}[_:-]/, '');
  return cleanPlacement(stripped, null);
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

  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  const rules = db
    .prepare(`SELECT revenue_share_pct FROM rules_config WHERE user_id = ?`)
    .get(tenantUserId);
  const netFactor = 1 - (rules?.revenue_share_pct ?? 6.5) / 100;

  // Per-(campaign, landing_page) GAM revenue. Group at row level here so
  // we can normalize each placement_value in JS without leaning on SQLite
  // for URL parsing.
  const rawRevRows = db
    .prepare(
      `SELECT
         u.ga_campaign_id AS campaign_id,
         u.placement_value,
         SUM(u.impressions) AS impressions,
         SUM(u.revenue) AS revenue,
         COUNT(DISTINCT u.date) AS days
       FROM utm_revenue_placements u
       WHERE u.user_id = ?
         AND u.date BETWEEN ? AND ?
       GROUP BY u.ga_campaign_id, u.placement_value`,
    )
    .all(tenantUserId, from, to);

  // Normalize and accumulate by (campaign_id, normalized_url).
  const perLanding = new Map();
  for (const r of rawRevRows) {
    const norm = normalizeLandingPage(r.placement_value);
    if (!norm) continue;
    if (!/^\d{6,}$/.test(String(r.campaign_id))) continue; // skip "(not applicable)" + non-numeric noise
    const key = `${r.campaign_id}|${norm}`;
    const cur = perLanding.get(key) ?? {
      campaign_id: String(r.campaign_id),
      landing_page: norm,
      raw_placement: r.placement_value,
      revenue: 0,
      impressions: 0,
      days: 0,
    };
    cur.revenue += Number(r.revenue) || 0;
    cur.impressions += Number(r.impressions) || 0;
    cur.days = Math.max(cur.days, Number(r.days) || 0);
    perLanding.set(key, cur);
  }

  // Per-campaign totals over the set of landing pages with revenue.
  const perCampaign = new Map();
  for (const v of perLanding.values()) {
    const c = perCampaign.get(v.campaign_id) ?? {
      campaign_id: v.campaign_id,
      revenue: 0,
      impressions: 0,
      cost: 0,
      campaign_name: null,
      landing_page_count: 0,
    };
    c.revenue += v.revenue;
    c.impressions += v.impressions;
    c.landing_page_count += 1;
    perCampaign.set(v.campaign_id, c);
  }

  // Get per-campaign cost and names from daily_metrics + campaigns,
  // restricted to the caller's scope of google_account_ids.
  if (perCampaign.size > 0) {
    const gaClause = inClause('dm.google_account_id', req.scope.google_account_ids);
    const campaignIds = [...perCampaign.keys()];
    const idPh = campaignIds.map(() => '?').join(',');
    const costRows = db
      .prepare(
        `SELECT
           dm.campaign_id,
           MAX(c.name) AS campaign_name,
           SUM(dm.spend) AS cost
         FROM daily_metrics dm
         LEFT JOIN campaigns c
           ON c.user_id = dm.user_id
          AND c.google_account_id = dm.google_account_id
          AND c.campaign_id = dm.campaign_id
         WHERE dm.user_id = ?
           AND dm.campaign_id IN (${idPh})
           AND dm.date BETWEEN ? AND ?
           AND ${gaClause.sql}
         GROUP BY dm.campaign_id`,
      )
      .all(tenantUserId, ...campaignIds, from, to, ...gaClause.params);
    for (const r of costRows) {
      const c = perCampaign.get(String(r.campaign_id));
      if (c) {
        c.cost = Number(r.cost) || 0;
        c.campaign_name = r.campaign_name;
      }
    }
  }

  // Build per-(campaign, landing_page) items with attributed cost +
  // classification.
  const items = [];
  for (const v of perLanding.values()) {
    const camp = perCampaign.get(v.campaign_id);
    if (!camp || camp.cost <= 0 || camp.impressions <= 0) continue;

    const impShare = v.impressions / camp.impressions;
    const attributedCost = camp.cost * impShare;
    const netRevenue = v.revenue * netFactor;
    const profit = netRevenue - attributedCost;
    const roi = attributedCost > 0 ? (profit / attributedCost) * 100 : 0;

    let reason = null;
    if (attributedCost < minCost) reason = null;
    else if (v.days < minDays) reason = null;
    else if (roi <= -50) reason = 'roi_critico';
    else if (roi <= maxRoi) reason = 'roi_baixo';

    if (reason) {
      items.push({
        key: `${v.campaign_id}|${v.landing_page}`,
        campaign_id: v.campaign_id,
        campaign_name: camp.campaign_name,
        placement: v.landing_page,
        placement_clean: v.landing_page,
        raw_placement: v.raw_placement,
        impressions: v.impressions,
        revenue: v.revenue,
        cost: attributedCost,
        profit,
        roi,
        days: v.days,
        matched: true,
        reason,
      });
    }
  }
  items.sort((a, b) => b.cost - a.cost);

  // Per-campaign rollup for the modal header.
  const campaignTotals = [];
  for (const c of perCampaign.values()) {
    const netRev = c.revenue * netFactor;
    const profit = netRev - c.cost;
    const roi = c.cost > 0 ? (profit / c.cost) * 100 : 0;
    campaignTotals.push({
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      cost: c.cost,
      revenue_brl: netRev,
      profit,
      roi,
      landing_page_count: c.landing_page_count,
      bad_count: items.filter((it) => it.campaign_id === c.campaign_id).length,
    });
  }
  campaignTotals.sort((a, b) => b.cost - a.cost);

  const stats = {
    period: { from, to },
    cfg: { min_cost: minCost, max_roi: maxRoi, min_days: minDays },
    gam_rev_rows: rawRevRows.length,
    campaigns_with_revenue: perCampaign.size,
    landing_pages_analyzed: perLanding.size,
    placements_bad: items.length,
  };

  res.json({ stats, items, campaign_totals: campaignTotals });
});

// POST /api/placements/exclude — destructive. Re-checks each item's
// ROI against the freshest data, then submits negative-placement
// criteria to Google Ads in one mutate batch per customer. Admin
// only.
router.post('/exclude', async (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const { items, max_roi, from, to } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items obrigatório (lista não vazia)' });
  }
  const fromIso = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : daysAgoIso(7);
  const toIso = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : daysAgoIso(0);
  try {
    const result = await applyPlacementExclusions({
      userId: req.scope.tenant_user_id ?? req.user.id,
      appliedByUserId: req.user.id,
      items,
      maxRoi: Number(max_roi ?? DEFAULT_MAX_ROI),
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

// GET /api/placements/exclusions — list of every exclusion we've
// applied, with the snapshot of why and whether it's still active.
router.get('/exclusions', (req, res) => {
  const { include_undone } = req.query;
  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  const showUndone = include_undone === 'true' || include_undone === '1';
  const rows = db
    .prepare(
      `SELECT id, campaign_id, campaign_name, placement,
              criterion_resource_name,
              snapshot_cost, snapshot_revenue, snapshot_roi, snapshot_days,
              reason, applied_at, applied_by_user_id, undone_at, error
         FROM placement_exclusions
        WHERE user_id = ?
          ${showUndone ? '' : 'AND undone_at IS NULL'}
        ORDER BY applied_at DESC
        LIMIT 500`,
    )
    .all(tenantUserId);
  res.json(rows);
});

// POST /api/placements/exclusions/:id/undo — remove the negative
// placement criterion from Google Ads and mark the row undone.
router.post('/exclusions/:id/undo', async (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  try {
    const result = await undoPlacementExclusion({
      userId: req.scope.tenant_user_id ?? req.user.id,
      exclusionId: req.params.id,
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
