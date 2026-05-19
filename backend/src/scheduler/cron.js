// node-cron registration. One daily job at CRON_DAILY_HOUR (TZ
// CRON_TZ, default America/Sao_Paulo) runs runDailySync() across
// every user that has stored credentials. Set CRON_ENABLED=false in
// env (or NODE_ENV=test) to skip registration entirely — useful for
// dev and for the smoke tests.

const cron = require('node-cron');
const { runDailySync } = require('./jobs');

function start() {
  const enabled =
    process.env.CRON_ENABLED !== 'false' && process.env.NODE_ENV !== 'test';
  if (!enabled) {
    return { started: false, reason: 'CRON_ENABLED=false or NODE_ENV=test', jobs: [] };
  }

  const tz = process.env.CRON_TZ || 'America/Sao_Paulo';
  const dailyHour = Number(process.env.CRON_DAILY_HOUR ?? 3);
  if (!Number.isFinite(dailyHour) || dailyHour < 0 || dailyHour > 23) {
    console.warn(`[cron] invalid CRON_DAILY_HOUR=${process.env.CRON_DAILY_HOUR}, defaulting to 3`);
  }
  const hour = Number.isFinite(dailyHour) && dailyHour >= 0 && dailyHour <= 23 ? dailyHour : 3;

  const expression = `0 ${hour} * * *`;
  cron.schedule(
    expression,
    async () => {
      const startedAt = Date.now();
      console.log(`[cron] daily-sync tick at ${new Date().toISOString()}`);
      try {
        const r = await runDailySync({ datePreset: 'YESTERDAY' });
        console.log(`[cron] daily-sync done in ${Date.now() - startedAt}ms: ${r.users_processed} user(s)`);
      } catch (err) {
        console.error(`[cron] daily-sync fatal: ${err.message}`);
      }
    },
    { name: 'daily-sync', timezone: tz },
  );

  return {
    started: true,
    jobs: [{ name: 'daily-sync', expression, timezone: tz }],
  };
}

module.exports = { start };
