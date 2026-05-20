const express = require('express');
const db = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const { include_acknowledged } = req.query;
  const includeAcked = include_acknowledged === 'true' || include_acknowledged === '1';
  const rows = db
    .prepare(
      `SELECT id, severity, category, campaign_id, placement_key, title, message,
              metric_snapshot, acknowledged, created_at
         FROM alerts
        WHERE user_id = ?
          ${includeAcked ? '' : 'AND acknowledged = 0'}
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 0
            WHEN 'warning'  THEN 1
            ELSE 2
          END,
          created_at DESC`,
    )
    .all(req.user.id);
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
  const info = db
    .prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Não encontrado' });
  res.status(204).end();
});

module.exports = router;
