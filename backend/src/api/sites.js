const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { inClause } = require('../lib/access');

const router = express.Router();

router.get('/', (req, res) => {
  const { sql, params } = inClause('id', req.scope.site_ids);
  const rows = db
    .prepare(`SELECT id, name, domain, created_at FROM sites WHERE ${sql} ORDER BY name`)
    .all(...params);
  res.json(rows);
});

router.post('/', (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const { name, domain } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name obrigatório' });
  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO sites (id, user_id, name, domain) VALUES (?, ?, ?, ?)`).run(
      id,
      req.user.id,
      name,
      domain || null,
    );
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Já existe um site com esse nome' });
    }
    throw err;
  }
  res.status(201).json(db.prepare(`SELECT id, name, domain, created_at FROM sites WHERE id = ?`).get(id));
});

router.delete('/:id', (req, res) => {
  if (!req.scope.is_admin) return res.status(403).json({ error: 'Apenas administradores' });
  const info = db
    .prepare(`DELETE FROM sites WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Não encontrado' });
  res.status(204).end();
});

module.exports = router;
