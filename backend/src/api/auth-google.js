// Google Sign-In routes. Two endpoints:
//
//   GET  /api/auth/google           -> generate state, set cookie, redirect to Google
//   GET  /api/auth/google/callback  -> validate state, exchange code, find-or-create user, set session, redirect to /
//
// First-time Google users are auto-created with role='member' and an
// unusable password_hash so they can't fall back to password login.
// Admins still need to assign sites via /admin before the user sees data.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { buildSignInUrl, exchangeCodeForClaims } = require('../lib/google-signin');

const router = express.Router();

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const STATE_TTL_MS = 1000 * 60 * 10;
const WEB_BASE = process.env.WEB_BASE_URL || '';

function loginRedirect(res, qs) {
  // The web app lives at the same origin as the backend in production
  // (nginx routes /api/* to backend, everything else to Next.js), so a
  // bare path works. WEB_BASE_URL only needs setting in dev / split deploys.
  const url = `${WEB_BASE}/login${qs ? `?${qs}` : ''}`;
  return res.redirect(url);
}

router.get('/google', (req, res) => {
  let authUrl;
  try {
    const state = crypto.randomBytes(24).toString('hex');
    authUrl = buildSignInUrl({ state });
    res.cookie('g_signin_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: STATE_TTL_MS,
    });
  } catch (err) {
    return loginRedirect(res, `error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return loginRedirect(res, `error=${encodeURIComponent(String(oauthError))}`);
  const cookieState = req.cookies?.g_signin_state;
  if (!state || !cookieState || state !== cookieState) {
    return loginRedirect(res, `error=${encodeURIComponent('state inválido')}`);
  }
  res.clearCookie('g_signin_state');
  if (!code) return loginRedirect(res, `error=${encodeURIComponent('code ausente')}`);

  let claims;
  try {
    claims = await exchangeCodeForClaims({ code: String(code) });
  } catch (err) {
    return loginRedirect(res, `error=${encodeURIComponent(err.message)}`);
  }
  if (!claims.email_verified) {
    return loginRedirect(res, `error=${encodeURIComponent('Email não verificado pelo Google')}`);
  }

  // Find or create the user. Match priority: google_id -> email.
  let user = db.prepare(`SELECT * FROM users WHERE google_id = ?`).get(claims.sub);
  if (!user) {
    user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(claims.email);
    if (user) {
      db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`).run(claims.sub, user.id);
    }
  }
  if (!user) {
    // First-time sign-in: auto-create as member with unusable password.
    const unusable = crypto.randomBytes(32).toString('hex');
    const fallbackUsername = claims.email;
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, role, email, google_id)
         VALUES (?, ?, 'member', ?, ?)`,
      )
      .run(fallbackUsername, bcrypt.hashSync(unusable, 10), claims.email, claims.sub);
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(
    token,
    user.id,
    expiresAt,
  );
  db.prepare(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user.id);

  res.cookie('session', token, {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    sameSite: 'lax',
  });
  res.redirect(`${WEB_BASE}/`);
});

module.exports = router;
