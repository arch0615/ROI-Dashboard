require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
require('./src/db/database');

const healthRouter = require('./src/api/health');
const scheduler = require('./src/scheduler/cron');

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use('/api/health', healthRouter);

const schedulerInfo = scheduler.start();
console.log('[startup] Scheduler:', schedulerInfo);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`ad-genius backend running on ${HOST}:${PORT}`));
