const express = require('express');
const db = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db
    .prepare(
      `SELECT id, source, status, records_processed, error, started_at, finished_at
         FROM sync_logs
        WHERE user_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(req.user.id, limit);
  res.json(rows);
});

module.exports = router;
