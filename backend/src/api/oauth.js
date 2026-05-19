// Google OAuth2 flow for Google Ads. Two endpoints:
//
//   POST /api/oauth/google/start  (authenticated)
//     Generates a state token, persists it bound to the calling user,
//     returns the consent URL. The web client opens this URL in the
//     same window (or popup).
//
//   GET  /api/oauth/google/callback  (NOT authenticated)
//     Google redirects here with ?code=&state=. We look up the state,
//     verify it's still valid, exchange the code for tokens, then
//     upsert every accessible customer as a google_accounts row with
//     the refresh_token encrypted at rest. Redirects back to
//     /integrations with ?google_oauth=ok or =error.

const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { encrypt } = require('../lib/crypto');
const googleAds = require('../lib/google-ads');

const router = express.Router();

const STATE_TTL_MS = 1000 * 60 * 15;

function pruneExpiredStates() {
  db.prepare(`DELETE FROM oauth_states WHERE expires_at < datetime('now')`).run();
}

// POST /api/oauth/google/start — must be called with the session cookie.
// Returns { url } so the client can navigate to Google's consent screen.
router.post('/google/start', (req, res) => {
  let authUrl;
  try {
    // Eagerly verify config before generating state — we'd rather 503
    // here than after creating a row that will never be consumed.
    googleAds.requireOAuthConfig();
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message });
    throw err;
  }
  pruneExpiredStates();
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO oauth_states (state, user_id, provider, expires_at)
     VALUES (?, ?, 'google', ?)`,
  ).run(state, req.user.id, expiresAt);
  authUrl = googleAds.buildAuthUrl({ state });
  res.json({ url: authUrl });
});

// GET /api/oauth/google/callback — unauthenticated by design (Google
// redirects the browser here without our session cookie necessarily
// being attached, depending on SameSite). We use state for CSRF + to
// look up which user this code belongs to.
router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const back = (status, params = {}) => {
    const qs = new URLSearchParams({ google_oauth: status, ...params });
    res.redirect(`/integrations?${qs.toString()}`);
  };

  if (oauthError) {
    return back('error', { message: String(oauthError).slice(0, 200) });
  }
  if (!code || !state) {
    return back('error', { message: 'missing_code_or_state' });
  }

  const stateRow = db
    .prepare(
      `SELECT user_id FROM oauth_states
        WHERE state = ?
          AND provider = 'google'
          AND expires_at > datetime('now')`,
    )
    .get(String(state));
  db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(String(state));
  if (!stateRow) return back('error', { message: 'invalid_or_expired_state' });

  let tokens;
  try {
    tokens = await googleAds.exchangeCode({ code: String(code) });
  } catch (err) {
    return back('error', { message: err.message.slice(0, 200) });
  }

  let customerIds;
  try {
    customerIds = await googleAds.listAccessibleCustomers(tokens.refreshToken);
  } catch (err) {
    return back('error', { message: `Token salvo, mas falha ao listar clientes: ${err.message}`.slice(0, 200) });
  }

  const enc = encrypt(tokens.refreshToken);
  const upsert = db.prepare(`
    INSERT INTO google_accounts (
      id, user_id, customer_id, account_name, is_mcc,
      refresh_token_enc, refresh_token_iv, refresh_token_tag, status
    ) VALUES (
      @id, @user_id, @customer_id, @account_name, 0,
      @enc, @iv, @tag, 'connected'
    )
    ON CONFLICT(user_id, customer_id) DO UPDATE SET
      refresh_token_enc = excluded.refresh_token_enc,
      refresh_token_iv  = excluded.refresh_token_iv,
      refresh_token_tag = excluded.refresh_token_tag,
      status            = 'connected'
  `);

  const upserted = db.transaction(() => {
    let n = 0;
    for (const cid of customerIds) {
      upsert.run({
        id: crypto.randomUUID(),
        user_id: stateRow.user_id,
        customer_id: cid,
        account_name: null,
        enc: enc.ciphertext,
        iv: enc.iv,
        tag: enc.tag,
      });
      n += 1;
    }
    return n;
  })();

  return back('ok', { accounts: String(upserted) });
});

module.exports = router;
