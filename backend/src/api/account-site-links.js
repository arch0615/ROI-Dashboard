const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { inClause } = require('../lib/access');

const router = express.Router();

router.get('/', (req, res) => {
  const { sql, params } = inClause('site_id', req.scope.site_ids);
  const rows = db
    .prepare(
      `SELECT id, site_id, google_account_id, gam_account_id, created_at
         FROM account_site_links
        WHERE ${sql}
        ORDER BY created_at DESC`,
    )
    .all(...params);
  res.json(rows);
});

router.post('/', (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const { site_id, google_account_id, gam_account_id } = req.body || {};
  if (!site_id) return res.status(400).json({ error: 'site_id obrigatório' });
  if (!google_account_id && !gam_account_id) {
    return res.status(400).json({ error: 'google_account_id ou gam_account_id obrigatório' });
  }

  // Verify all referenced entities belong to this user — FKs only enforce
  // existence, not ownership.
  const site = db.prepare(`SELECT 1 FROM sites WHERE id = ? AND user_id = ?`).get(site_id, req.user.id);
  if (!site) return res.status(404).json({ error: 'Site não encontrado' });

  if (google_account_id) {
    const ga = db
      .prepare(`SELECT 1 FROM google_accounts WHERE id = ? AND user_id = ?`)
      .get(google_account_id, req.user.id);
    if (!ga) return res.status(404).json({ error: 'Conta Google Ads não encontrada' });
  }
  if (gam_account_id) {
    const gam = db
      .prepare(`SELECT 1 FROM gam_accounts WHERE id = ? AND user_id = ?`)
      .get(gam_account_id, req.user.id);
    if (!gam) return res.status(404).json({ error: 'Conta GAM não encontrada' });
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO account_site_links (id, user_id, site_id, google_account_id, gam_account_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, req.user.id, site_id, google_account_id || null, gam_account_id || null);

  res.status(201).json(
    db
      .prepare(
        `SELECT id, site_id, google_account_id, gam_account_id, created_at
           FROM account_site_links WHERE id = ?`,
      )
      .get(id),
  );
});

router.delete('/:id', (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const info = db
    .prepare(`DELETE FROM account_site_links WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Não encontrado' });
  res.status(204).end();
});

module.exports = router;
