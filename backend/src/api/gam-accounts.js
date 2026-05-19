const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { encrypt } = require('../lib/crypto');

const router = express.Router();

function parseServiceAccountJson(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    const err = new Error('service_account_json inválido (não é JSON)');
    err.code = 'BAD_SA_JSON';
    throw err;
  }
  if (!parsed.client_email || !parsed.private_key) {
    const err = new Error('service_account_json sem client_email/private_key');
    err.code = 'BAD_SA_JSON';
    throw err;
  }
  return parsed;
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, network_code, account_name, service_account_email, currency, status,
              last_synced_at, created_at,
              CASE WHEN service_account_json_enc IS NOT NULL THEN 1 ELSE 0 END AS has_service_account
         FROM gam_accounts
        WHERE user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(req.user.id);
  res.json(rows.map((r) => ({ ...r, has_service_account: !!r.has_service_account })));
});

router.post('/', (req, res) => {
  const { network_code, account_name, service_account_email, service_account_json } = req.body || {};
  if (!network_code) return res.status(400).json({ error: 'network_code obrigatório' });

  let sa = null;
  try {
    sa = parseServiceAccountJson(service_account_json);
  } catch (err) {
    if (err.code === 'BAD_SA_JSON') return res.status(400).json({ error: err.message });
    throw err;
  }
  const enc = sa ? encrypt(JSON.stringify(sa)) : { ciphertext: null, iv: null, tag: null };
  const email = sa?.client_email ?? service_account_email ?? null;

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO gam_accounts
         (id, user_id, network_code, account_name, service_account_email,
          service_account_json_enc, service_account_json_iv, service_account_json_tag, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.user.id,
      network_code,
      account_name || null,
      email,
      enc.ciphertext,
      enc.iv,
      enc.tag,
      sa ? 'active' : 'pending',
    );
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'network_code já existe para este usuário' });
    }
    throw err;
  }
  const row = db
    .prepare(
      `SELECT id, network_code, account_name, service_account_email, currency, status, created_at
         FROM gam_accounts WHERE id = ?`,
    )
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
