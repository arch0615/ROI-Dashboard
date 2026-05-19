// Day-job runner shared by the manual /run-all route and the daily
// cron. For each user that has any account with stored credentials:
//
//   1. Iterate google_accounts that are roots (manager_account_id IS NULL).
//      MCC parents expand their children inside syncGoogleAdsAccount,
//      so we don't need to enumerate leaves here.
//   2. Iterate gam_accounts that have a saved service_account_json.
//   3. The rollup auto-fires inside each sync, so daily_metrics ends
//      up coherent without an extra explicit pass.
//
// One account failure is logged via sync_logs but does NOT block other
// accounts. The summary returned at the end is best-effort and meant
// for human/log inspection, not for client UI.

const db = require('../db/database');
const { syncGoogleAdsAccount } = require('../sync/google-ads');
const { syncGamAccount } = require('../sync/gam');
const { withSyncLog } = require('../sync/with-log');

async function runDailySyncForUser({ userId, datePreset = 'YESTERDAY' }) {
  const adsAccounts = db
    .prepare(
      `SELECT id FROM google_accounts
        WHERE user_id = ?
          AND refresh_token_enc IS NOT NULL
          AND manager_account_id IS NULL`,
    )
    .all(userId);

  const gamAccounts = db
    .prepare(
      `SELECT id FROM gam_accounts
        WHERE user_id = ?
          AND service_account_json_enc IS NOT NULL`,
    )
    .all(userId);

  const adsResults = [];
  for (const a of adsAccounts) {
    try {
      const r = await withSyncLog({
        userId,
        source: 'google-ads',
        fn: async () => {
          const result = await syncGoogleAdsAccount({ userId, accountId: a.id, datePreset });
          return { ...result, records_processed: result.metric_rows };
        },
      });
      adsResults.push({ account_id: a.id, ok: true, metric_rows: r.metric_rows });
    } catch (err) {
      adsResults.push({ account_id: a.id, ok: false, error: err.message });
    }
  }

  const gamResults = [];
  for (const a of gamAccounts) {
    try {
      const r = await withSyncLog({
        userId,
        source: 'gam',
        fn: async () => {
          const result = await syncGamAccount({ userId, accountId: a.id, datePreset });
          return { ...result, records_processed: result.rows_written };
        },
      });
      gamResults.push({ account_id: a.id, ok: true, rows_written: r.rows_written });
    } catch (err) {
      gamResults.push({ account_id: a.id, ok: false, error: err.message });
    }
  }

  return { user_id: userId, ads: adsResults, gam: gamResults };
}

async function runDailySync({ userId, datePreset = 'YESTERDAY' } = {}) {
  // If a userId is passed, scope to that user. Otherwise iterate every
  // user with at least one provider-credentialed account.
  let targets;
  if (userId) {
    targets = [{ user_id: userId }];
  } else {
    targets = db
      .prepare(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM google_accounts WHERE refresh_token_enc IS NOT NULL
           UNION
           SELECT user_id FROM gam_accounts WHERE service_account_json_enc IS NOT NULL
         )`,
      )
      .all();
  }

  const perUser = [];
  for (const { user_id } of targets) {
    const r = await runDailySyncForUser({ userId: user_id, datePreset });
    perUser.push(r);
  }
  return { date_preset: datePreset, users_processed: perUser.length, per_user: perUser };
}

module.exports = { runDailySync, runDailySyncForUser };
