// Wraps a sync run with a sync_logs row. The row goes 'running' on
// entry, then either 'ok' (with records_processed) or 'error' (with
// the thrown message) — so the audit log captures both success and
// every kind of failure regardless of whether the call is initiated by
// the manual route or the cron.
//
// The fn() should resolve to an object with `records_processed`. Any
// extra fields are passed through to the caller alongside `log_id`.

const crypto = require('crypto');
const db = require('../db/database');

async function withSyncLog({ userId, source, fn }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sync_logs (id, user_id, source, status, started_at)
     VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)`,
  ).run(id, userId, source);
  try {
    const result = (await fn()) ?? {};
    db.prepare(
      `UPDATE sync_logs
          SET status = 'ok',
              records_processed = ?,
              finished_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(result.records_processed ?? 0, id);
    return { log_id: id, ...result };
  } catch (err) {
    db.prepare(
      `UPDATE sync_logs
          SET status = 'error',
              error = ?,
              finished_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(err.message, id);
    err.log_id = id;
    throw err;
  }
}

module.exports = { withSyncLog };
