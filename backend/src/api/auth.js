const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');

const router = express.Router();

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function pruneExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
}

function seedAdminFromEnv() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  if (count > 0) return;
  const username = process.env.DASHBOARD_USER || 'admin';
  const password = process.env.DASHBOARD_PASS || 'admin123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`).run(
    username,
    hash,
  );
  console.log(`[auth] seeded admin user "${username}" from env`);
}

seedAdminFromEnv();

function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token);
  return row || null;
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  }
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  pruneExpiredSessions();
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
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
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = getSessionUser(req.cookies?.session);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user });
});

function requireAuth(req, res, next) {
  const user = getSessionUser(req.cookies?.session);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
}

module.exports = router;
module.exports.requireAuth = requireAuth;
