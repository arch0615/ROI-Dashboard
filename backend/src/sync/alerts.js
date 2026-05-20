// Alert evaluator. Runs after rollup so daily_metrics already has the
// revenue/profit/roi columns populated. Three campaign-level rules from
// the original engine (in this order — first match wins per campaign):
//
//   1. ROI <= max_loss_roi_pct AND days >= analysis_days
//      -> critical / bad_campaign  (suggests pause)
//   2. ROI >= boost_roi_pct
//      -> info / opportunity
//   3. ROI <  min_roi_pct AND spend > 3 * min_spend_threshold
//      -> warning / risk
//
// Plus one placement-level rule: impressions > 1000 AND ecpm < 0.10
//      -> warning / bad_placement
//
// Re-evaluation REPLACES non-acknowledged alerts for the user (so stale
// ones disappear). Acknowledged alerts are preserved across runs.

const crypto = require('crypto');
const db = require('../db/database');

const PLACEMENT_LOW_ECPM = 0.10;
const PLACEMENT_MIN_IMPRESSIONS = 1000;

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function evaluateAlertsForUser({ userId }) {
  const rules = db.prepare(`SELECT * FROM rules_config WHERE user_id = ?`).get(userId);
  if (!rules) {
    // No rules row means /api/rules was never read — bail rather than
    // assume defaults silently. The dashboard creates one on first read.
    return { drafts_emitted: 0, inserted: 0, reason: 'no_rules_config' };
  }

  const analysisDays = Math.max(1, Number(rules.analysis_days ?? 2));
  const windowStart = daysAgoIso(analysisDays - 1);

  const campaignAggs = db
    .prepare(
      `SELECT
         c.id, c.google_account_id, c.campaign_id, c.name, c.status,
         COALESCE(SUM(dm.spend), 0)       AS spend,
         COALESCE(SUM(dm.revenue), 0)     AS revenue,
         COALESCE(SUM(dm.profit), 0)      AS profit,
         COALESCE(SUM(dm.impressions), 0) AS impressions,
         COUNT(DISTINCT dm.date)          AS days
       FROM campaigns c
       LEFT JOIN daily_metrics dm
         ON dm.user_id = c.user_id
        AND dm.google_account_id = c.google_account_id
        AND dm.campaign_id = c.campaign_id
        AND dm.date >= ?
       WHERE c.user_id = ?
       GROUP BY c.id`,
    )
    .all(windowStart, userId);

  const placementAggs = db
    .prepare(
      `SELECT
         placement_key,
         site,
         ad_unit,
         SUM(impressions) AS impressions,
         SUM(revenue)     AS revenue,
         CASE WHEN SUM(impressions) > 0
              THEN (SUM(revenue) / SUM(impressions)) * 1000
              ELSE 0 END AS ecpm
       FROM placements
       WHERE user_id = ? AND date >= ?
       GROUP BY placement_key`,
    )
    .all(userId, windowStart);

  const drafts = [];

  for (const a of campaignAggs) {
    const spend = a.spend ?? 0;
    if (spend < rules.min_spend_threshold) continue;
    const roi = spend > 0 ? (a.profit / spend) * 100 : 0;

    if (a.days >= analysisDays && roi <= rules.max_loss_roi_pct) {
      drafts.push({
        severity: 'critical',
        category: 'bad_campaign',
        campaign_id: a.campaign_id,
        placement_key: null,
        title: `🔥 ${a.name}`,
        message: `Prejuízo: ROI ${roi.toFixed(1)}% por ${a.days} dia(s) — abaixo do limite de ${rules.max_loss_roi_pct}%. Gasto ${spend.toFixed(2)} / Receita ${(a.revenue ?? 0).toFixed(2)}.`,
        metric_snapshot: { roi, spend, revenue: a.revenue, days: a.days },
      });
      continue;
    }

    if (roi >= rules.boost_roi_pct) {
      drafts.push({
        severity: 'info',
        category: 'opportunity',
        campaign_id: a.campaign_id,
        placement_key: null,
        title: `📈 ${a.name}`,
        message: `Oportunidade: ROI ${roi.toFixed(1)}% acima do alvo de ${rules.boost_roi_pct}% — considere aumentar o orçamento em ${rules.budget_increase_pct}%.`,
        metric_snapshot: { roi, spend, revenue: a.revenue },
      });
      continue;
    }

    if (roi < rules.min_roi_pct && spend > rules.min_spend_threshold * 3) {
      drafts.push({
        severity: 'warning',
        category: 'risk',
        campaign_id: a.campaign_id,
        placement_key: null,
        title: `⚠️ ${a.name}`,
        message: `Risco: ROI ${roi.toFixed(1)}% com gasto elevado (${spend.toFixed(2)}). Abaixo do mínimo de ${rules.min_roi_pct}%.`,
        metric_snapshot: { roi, spend, revenue: a.revenue },
      });
    }
  }

  for (const p of placementAggs) {
    if (p.impressions > PLACEMENT_MIN_IMPRESSIONS && p.ecpm < PLACEMENT_LOW_ECPM) {
      drafts.push({
        severity: 'warning',
        category: 'bad_placement',
        campaign_id: null,
        placement_key: p.placement_key,
        title: `🧱 Placement fraco: ${p.site ?? p.placement_key}`,
        message: `eCPM ${p.ecpm.toFixed(2)} com ${p.impressions} impressões em ${analysisDays} dia(s).`,
        metric_snapshot: { ecpm: p.ecpm, impressions: p.impressions, revenue: p.revenue },
      });
    }
  }

  const insert = db.prepare(`
    INSERT INTO alerts (
      id, user_id, severity, category, campaign_id, placement_key,
      title, message, metric_snapshot
    ) VALUES (
      @id, @user_id, @severity, @category, @campaign_id, @placement_key,
      @title, @message, @metric_snapshot
    )
  `);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM alerts WHERE user_id = ? AND acknowledged = 0`).run(userId);
    for (const d of drafts) {
      insert.run({
        id: crypto.randomUUID(),
        user_id: userId,
        severity: d.severity,
        category: d.category,
        campaign_id: d.campaign_id,
        placement_key: d.placement_key,
        title: d.title,
        message: d.message,
        metric_snapshot: d.metric_snapshot ? JSON.stringify(d.metric_snapshot) : null,
      });
    }
  });
  tx();

  return { drafts_emitted: drafts.length, window_start: windowStart, analysis_days: analysisDays };
}

module.exports = { evaluateAlertsForUser };
