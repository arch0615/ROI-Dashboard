const cron = require('node-cron');

function start() {
  const jobs = [];
  return { started: true, jobs };
}

module.exports = { start };
