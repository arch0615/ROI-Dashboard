const express = require('express');
const db = require('../db/database');
const { inClause } = require('../lib/access');

const router = express.Router();

// Returns the list of campaign_id text values (Google Ads campaign IDs)
// the caller can see, derived from their accessible google_account_ids.
function accessibleCampaignTextIds(scope) {
  if (scope.is_admin) {
    // Admin: every campaign in the tenant
    return db
      .prepare(`SELECT campaign_id FROM campaigns WHERE user_id = ?`)
      .all(scope.tenant_user_id)
      .map((r) => r.campaign_id);
  }
  if (scope.google_account_ids.length === 0) return [];
  const ph = scope.google_account_ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT DISTINCT campaign_id FROM campaigns WHERE google_account_id IN (${ph})`,
    )
    .all(...scope.google_account_ids)
    .map((r) => r.campaign_id);
}

router.get('/', (req, res) => {
  const { include_acknowledged } = req.query;
  const includeAcked = include_acknowledged === 'true' || include_acknowledged === '1';

  // Admins see every alert in the tenant. Members see only alerts
  // whose campaign_id maps to a campaign they can access (or alerts
  // with no campaign_id at all — the "data readiness" notices).
  let where, params;
  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  if (req.scope.is_admin) {
    where = `user_id = ?`;
    params = [tenantUserId];
  } else {
    const campaignIds = accessibleCampaignTextIds(req.scope);
    const cClause = inClause('campaign_id', campaignIds);
    where = `user_id = ? AND (campaign_id IS NULL OR ${cClause.sql})`;
    params = [tenantUserId, ...cClause.params];
  }
  const rows = db
    .prepare(
      `SELECT id, severity, category, campaign_id, placement_key, title, message,
              metric_snapshot, acknowledged, created_at
         FROM alerts
        WHERE ${where}
          ${includeAcked ? '' : 'AND acknowledged = 0'}
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 0
            WHEN 'warning'  THEN 1
            ELSE 2
          END,
          created_at DESC`,
    )
    .all(...params);
  for (const r of rows) {
    r.acknowledged = !!r.acknowledged;
    if (r.metric_snapshot) {
      try {
        r.metric_snapshot = JSON.parse(r.metric_snapshot);
      } catch {
        r.metric_snapshot = null;
      }
    }
  }
  res.json(rows);
});

router.post('/:id/ack', (req, res) => {
  // Members can ack alerts they're allowed to see. Look up the alert,
  // verify it's accessible, then ack it.
  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  const alert = db
    .prepare(`SELECT campaign_id FROM alerts WHERE id = ? AND user_id = ?`)
    .get(req.params.id, tenantUserId);
  if (!alert) return res.status(404).json({ error: 'Não encontrado' });
  if (!req.scope.is_admin) {
    if (alert.campaign_id) {
      const allowed = accessibleCampaignTextIds(req.scope);
      if (!allowed.includes(alert.campaign_id)) {
        return res.status(404).json({ error: 'Não encontrado' });
      }
    }
  }
  db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ? AND user_id = ?`).run(
    req.params.id,
    tenantUserId,
  );
  res.status(204).end();
});

module.exports = router;
