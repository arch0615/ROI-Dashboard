// Admin-only endpoints for managing member users and their per-site
// access. Mounted under /api/admin/* with a router-level guard that
// rejects every non-admin request with 403.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.scope?.is_admin) {
    return res.status(403).json({ error: 'Apenas administradores' });
  }
  next();
});

function genPassword(len = 20) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += charset[buf[i] % charset.length];
  return out;
}

function loadUserWithSites(userId) {
  const u = db
    .prepare(`SELECT id, username, role, created_at, last_login_at FROM users WHERE id = ?`)
    .get(userId);
  if (!u) return null;
  u.site_ids = db
    .prepare(`SELECT site_id FROM site_memberships WHERE user_id = ?`)
    .all(userId)
    .map((m) => m.site_id);
  return u;
}

// GET /api/admin/users — list all users with their site_ids.
router.get('/users', (req, res) => {
  const users = db
    .prepare(`SELECT id, username, role, created_at, last_login_at FROM users ORDER BY id`)
    .all();
  const memberships = db
    .prepare(`SELECT user_id, site_id FROM site_memberships`)
    .all();
  const byUser = new Map();
  for (const m of memberships) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m.site_id);
  }
  for (const u of users) u.site_ids = byUser.get(u.id) ?? [];
  res.json(users);
});

// POST /api/admin/users — create a member user.
// Body: { username, password?, site_ids: string[] }
// If password is omitted, the server generates one and returns it ONCE.
router.post('/users', (req, res) => {
  const { username, password, site_ids } = req.body || {};
  if (!username || typeof username !== 'string' || username.length < 2) {
    return res.status(400).json({ error: 'username obrigatório (mínimo 2 caracteres)' });
  }
  const desiredSiteIds = Array.isArray(site_ids) ? site_ids.filter((s) => typeof s === 'string') : [];

  // Validate every requested site belongs to the admin's tenant.
  if (desiredSiteIds.length > 0) {
    const ph = desiredSiteIds.map(() => '?').join(',');
    const owned = db
      .prepare(`SELECT id FROM sites WHERE id IN (${ph}) AND user_id = ?`)
      .all(...desiredSiteIds, req.user.id)
      .map((s) => s.id);
    const missing = desiredSiteIds.filter((s) => !owned.includes(s));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Sites inválidos: ${missing.join(', ')}` });
    }
  }

  const finalPassword = password && password.length >= 8 ? password : genPassword(20);
  const hash = bcrypt.hashSync(finalPassword, 10);

  let userId;
  try {
    const info = db
      .prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'member')`)
      .run(username, hash);
    userId = Number(info.lastInsertRowid);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'username já existe' });
    }
    throw err;
  }

  const insertMembership = db.prepare(
    `INSERT INTO site_memberships (id, user_id, site_id) VALUES (?, ?, ?)`,
  );
  db.transaction(() => {
    for (const sid of desiredSiteIds) {
      insertMembership.run(crypto.randomUUID(), userId, sid);
    }
  })();

  res.status(201).json({
    user: loadUserWithSites(userId),
    // Returned ONCE so the admin can copy it. We don't store the
    // plaintext; the bcrypt hash is the only persistent form.
    initial_password: password ? null : finalPassword,
  });
});

// PATCH /api/admin/users/:id — update site access and/or password.
// Body: { site_ids?: string[], password?: string }
router.patch('/users/:id', (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'id inválido' });
  const target = db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin') {
    return res.status(400).json({ error: 'Não é possível editar o admin por aqui' });
  }

  const { site_ids, password } = req.body || {};
  const updatedFields = [];

  if (Array.isArray(site_ids)) {
    const desired = site_ids.filter((s) => typeof s === 'string');
    if (desired.length > 0) {
      const ph = desired.map(() => '?').join(',');
      const owned = db
        .prepare(`SELECT id FROM sites WHERE id IN (${ph}) AND user_id = ?`)
        .all(...desired, req.user.id)
        .map((s) => s.id);
      const missing = desired.filter((s) => !owned.includes(s));
      if (missing.length > 0) {
        return res.status(400).json({ error: `Sites inválidos: ${missing.join(', ')}` });
      }
    }
    db.transaction(() => {
      db.prepare(`DELETE FROM site_memberships WHERE user_id = ?`).run(targetId);
      const ins = db.prepare(
        `INSERT INTO site_memberships (id, user_id, site_id) VALUES (?, ?, ?)`,
      );
      for (const sid of desired) {
        ins.run(crypto.randomUUID(), targetId, sid);
      }
    })();
    updatedFields.push('site_ids');
  }

  let newPassword = null;
  if (typeof password === 'string') {
    if (password.length < 8) {
      return res.status(400).json({ error: 'Senha precisa de pelo menos 8 caracteres' });
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, targetId);
    // Invalidate every active session for this user — they have to log in again.
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetId);
    updatedFields.push('password');
    newPassword = password;
  }

  if (updatedFields.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }
  res.json({ user: loadUserWithSites(targetId), updated: updatedFields });
});

// POST /api/admin/users/:id/reset-password — generate a new random
// password for the target user and return it ONCE. Logs them out.
router.post('/users/:id/reset-password', (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin') {
    return res.status(400).json({ error: 'Não é possível resetar a senha do admin por aqui' });
  }
  const fresh = genPassword(20);
  const hash = bcrypt.hashSync(fresh, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, targetId);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetId);
  res.json({ user_id: targetId, new_password: fresh });
});

// DELETE /api/admin/users/:id — remove a member user (and their
// memberships + sessions via FK cascades).
router.delete('/users/:id', (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin') {
    return res.status(400).json({ error: 'Não é possível remover o admin' });
  }
  db.prepare(`DELETE FROM users WHERE id = ?`).run(targetId);
  res.status(204).end();
});

module.exports = router;
