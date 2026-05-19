require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
require('./src/db/database');

const healthRouter = require('./src/api/health');
const authRouter = require('./src/api/auth');
const oauthRouter = require('./src/api/oauth');
const googleAccountsRouter = require('./src/api/google-accounts');
const gamAccountsRouter = require('./src/api/gam-accounts');
const sitesRouter = require('./src/api/sites');
const accountSiteLinksRouter = require('./src/api/account-site-links');
const campaignsRouter = require('./src/api/campaigns');
const dashboardRouter = require('./src/api/dashboard');
const rulesRouter = require('./src/api/rules');
const syncRouter = require('./src/api/sync');
const syncLogsRouter = require('./src/api/sync-logs');
const scheduler = require('./src/scheduler/cron');

const { requireAuth } = authRouter;

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
// OAuth /start is auth-protected at the route level; /callback is
// intentionally public because the browser arrives from accounts.google.com
// without our session cookie depending on SameSite policy.
app.use('/api/oauth/google/start', requireAuth);
app.use('/api/oauth', oauthRouter);
app.use('/api/google-accounts', requireAuth, googleAccountsRouter);
app.use('/api/gam-accounts', requireAuth, gamAccountsRouter);
app.use('/api/sites', requireAuth, sitesRouter);
app.use('/api/account-site-links', requireAuth, accountSiteLinksRouter);
app.use('/api/campaigns', requireAuth, campaignsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/rules', requireAuth, rulesRouter);
app.use('/api/sync', requireAuth, syncRouter);
app.use('/api/sync-logs', requireAuth, syncLogsRouter);

const schedulerInfo = scheduler.start();
console.log('[startup] Scheduler:', schedulerInfo);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`ad-genius backend running on ${HOST}:${PORT}`));
