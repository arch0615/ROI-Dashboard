const express = require('express');
const db = require('../db/database');

const router = express.Router();

const NUMERIC_FIELDS = [
  'min_roi_pct',
  'max_loss_roi_pct',
  'boost_roi_pct',
  'min_spend_threshold',
  'budget_increase_pct',
  'revenue_share_pct',
  'auto_analysis_days',
  'auto_scale_interval_days',
  'auto_stoploss_days',
  'auto_cpa_review_days',
  'auto_standby_enter_days',
  'auto_standby_max_days',
  'auto_scale_min_roi',
  'auto_scale_budget_pct',
  'auto_stoploss_min_roi',
  'auto_stoploss_min_cost',
  'auto_cpa_up_pct',
  'auto_cpa_down_pct',
  'auto_standby_roi_low',
  'auto_standby_roi_high',
  'auto_standby_exit_roi',
];

const BOOLEAN_FIELDS = ['auto_pause_enabled', 'auto_boost_enabled'];

function ensureRow(userId) {
  const existing = db.prepare(`SELECT * FROM rules_config WHERE user_id = ?`).get(userId);
  if (existing) return existing;
  db.prepare(`INSERT INTO rules_config (user_id) VALUES (?)`).run(userId);
  return db.prepare(`SELECT * FROM rules_config WHERE user_id = ?`).get(userId);
}

function shape(row) {
  if (!row) return null;
  const out = { ...row };
  out.auto_pause_enabled = !!row.auto_pause_enabled;
  out.auto_boost_enabled = !!row.auto_boost_enabled;
  return out;
}

router.get('/', (req, res) => {
  // Rules are tenant-wide. For members, return the tenant admin's rules.
  const tenantUserId = req.scope.tenant_user_id ?? req.user.id;
  res.json(shape(ensureRow(tenantUserId)));
});

router.put('/', (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const body = req.body || {};
  ensureRow(req.user.id);

  const sets = [];
  const params = [];
  for (const field of NUMERIC_FIELDS) {
    if (field in body) {
      const v = Number(body[field]);
      if (!Number.isFinite(v)) {
        return res.status(400).json({ error: `${field} deve ser número` });
      }
      sets.push(`${field} = ?`);
      params.push(v);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field in body) {
      sets.push(`${field} = ?`);
      params.push(body[field] ? 1 : 0);
    }
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  params.push(req.user.id);
  db.prepare(`UPDATE rules_config SET ${sets.join(', ')} WHERE user_id = ?`).run(...params);
  res.json(shape(db.prepare(`SELECT * FROM rules_config WHERE user_id = ?`).get(req.user.id)));
});

module.exports = router;
