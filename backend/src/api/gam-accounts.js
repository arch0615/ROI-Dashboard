const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, network_code, account_name, service_account_email, status,
              last_synced_at, created_at
         FROM gam_accounts
        WHERE user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(req.user.id);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { network_code, account_name, service_account_email } = req.body || {};
  if (!network_code) return res.status(400).json({ error: 'network_code obrigatório' });

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO gam_accounts (id, user_id, network_code, account_name, service_account_email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.user.id,
      network_code,
      account_name || null,
      service_account_email || null,
      service_account_email ? 'active' : 'pending',
    );
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'network_code já existe para este usuário' });
    }
    throw err;
  }
  const row = db
    .prepare(`SELECT id, network_code, account_name, status, created_at FROM gam_accounts WHERE id = ?`)
    .get(id);
  res.status(201).json(row);
});

router.delete('/:id', (req, res) => {
  const info = db
    .prepare(`DELETE FROM gam_accounts WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Não encontrado' });
  res.status(204).end();
});

module.exports = router;
