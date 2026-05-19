const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { syncGoogleAdsAccount } = require('../sync/google-ads');

const router = express.Router();

// POST /api/sync/google-ads/:account_id
//   body: { date_preset?, from?, to? }
// Always writes a row to sync_logs whether the run succeeds or errors.
// On error, returns the error code mapping the same way as /customers
// (NOT_CONFIGURED -> 503, TOKEN_REFRESH/API_ERROR -> 502).
router.post('/google-ads/:account_id', async (req, res) => {
  const { account_id } = req.params;
  const { date_preset, from, to } = req.body || {};

  const logId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sync_logs (id, user_id, source, status, started_at)
     VALUES (?, ?, 'google-ads', 'running', CURRENT_TIMESTAMP)`,
  ).run(logId, req.user.id);

  try {
    const result = await syncGoogleAdsAccount({
      userId: req.user.id,
      accountId: account_id,
      datePreset: date_preset,
      from,
      to,
    });
    db.prepare(
      `UPDATE sync_logs
          SET status = 'ok',
              records_processed = ?,
              finished_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(result.metric_rows, logId);
    res.json({ ok: true, log_id: logId, ...result });
  } catch (err) {
    db.prepare(
      `UPDATE sync_logs
          SET status = 'error',
              error = ?,
              finished_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(err.message, logId);

    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'NO_TOKEN') return res.status(400).json({ error: err.message });
    if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message });
    if (err.code === 'TOKEN_REFRESH' || err.code === 'API_ERROR') {
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }
});

module.exports = router;
