const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { encrypt } = require('../lib/crypto');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, customer_id, login_customer_id, account_name, is_mcc, status,
              last_synced_at, created_at,
              CASE WHEN refresh_token_enc IS NOT NULL THEN 1 ELSE 0 END AS has_refresh_token
         FROM google_accounts
        WHERE user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(req.user.id);
  res.json(rows.map((r) => ({ ...r, is_mcc: !!r.is_mcc, has_refresh_token: !!r.has_refresh_token })));
});

router.post('/', (req, res) => {
  const { customer_id, login_customer_id, account_name, is_mcc, refresh_token } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id obrigatório' });

  const id = crypto.randomUUID();
  const enc = encrypt(refresh_token);
  try {
    db.prepare(
      `INSERT INTO google_accounts
         (id, user_id, customer_id, login_customer_id, account_name, is_mcc,
          refresh_token_enc, refresh_token_iv, refresh_token_tag, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.user.id,
      customer_id,
      login_customer_id || null,
      account_name || null,
      is_mcc ? 1 : 0,
      enc.ciphertext,
      enc.iv,
      enc.tag,
      refresh_token ? 'active' : 'pending',
    );
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'customer_id já existe para este usuário' });
    }
    throw err;
  }
  const row = db
    .prepare(`SELECT id, customer_id, account_name, status, created_at FROM google_accounts WHERE id = ?`)
    .get(id);
  res.status(201).json(row);
});

router.delete('/:id', (req, res) => {
  const info = db
    .prepare(`DELETE FROM google_accounts WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Não encontrado' });
  res.status(204).end();
});

module.exports = router;
