const express = require('express');
const { syncGoogleAdsAccount } = require('../sync/google-ads');
const { syncGamAccount } = require('../sync/gam');
const { rolloverDailyMetrics } = require('../sync/rollup');
const { withSyncLog } = require('../sync/with-log');
const { runDailySync } = require('../scheduler/jobs');

const router = express.Router();

function mapErrorToStatus(err) {
  if (err.code === 'NOT_FOUND') return 404;
  if (err.code === 'NO_TOKEN' || err.code === 'BAD_SA_JSON' || err.code === 'BAD_PRIVATE_KEY') {
    return 400;
  }
  if (err.code === 'NOT_CONFIGURED') return 503;
  if (err.code === 'TOKEN_REFRESH' || err.code === 'API_ERROR') return 502;
  return null;
}

router.post('/google-ads/:account_id', async (req, res) => {
  const { date_preset, from, to } = req.body || {};
  try {
    const result = await withSyncLog({
      userId: req.user.id,
      source: 'google-ads',
      fn: async () => {
        const r = await syncGoogleAdsAccount({
          userId: req.user.id,
          accountId: req.params.account_id,
          datePreset: date_preset,
          from,
          to,
        });
        return { ...r, records_processed: r.metric_rows };
      },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = mapErrorToStatus(err);
    if (status != null) return res.status(status).json({ error: err.message });
    throw err;
  }
});

router.post('/gam/:account_id', async (req, res) => {
  const { date_preset, from, to } = req.body || {};
  try {
    const result = await withSyncLog({
      userId: req.user.id,
      source: 'gam',
      fn: async () => {
        const r = await syncGamAccount({
          userId: req.user.id,
          accountId: req.params.account_id,
          datePreset: date_preset,
          from,
          to,
        });
        return { ...r, records_processed: r.rows_written };
      },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = mapErrorToStatus(err);
    if (status != null) return res.status(status).json({ error: err.message });
    throw err;
  }
});

router.post('/rollup', async (req, res) => {
  const { from, to } = req.body || {};
  try {
    const result = await withSyncLog({
      userId: req.user.id,
      source: 'rollup',
      fn: () => {
        const r = rolloverDailyMetrics({ userId: req.user.id, from, to });
        return { ...r, records_processed: r.rows_updated };
      },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = mapErrorToStatus(err);
    if (status != null) return res.status(status).json({ error: err.message });
    throw err;
  }
});

// Runs every Ads + GAM sync for THIS user with date_preset=YESTERDAY,
// then a rollup. Mirrors what the daily cron does — useful for "kick
// it now" after the user adds their first account.
router.post('/run-all', async (req, res) => {
  try {
    const summary = await runDailySync({ userId: req.user.id, datePreset: 'YESTERDAY' });
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
