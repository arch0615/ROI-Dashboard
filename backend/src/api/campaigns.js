const express = require('express');
const db = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const { google_account_id } = req.query;
  const params = [req.user.id];
  let where = `WHERE user_id = ?`;
  if (google_account_id) {
    where += ` AND google_account_id = ?`;
    params.push(google_account_id);
  }
  const rows = db
    .prepare(
      `SELECT id, google_account_id, campaign_id, name, status, channel_type,
              budget_micros, target_cpa_micros, created_at, updated_at
         FROM campaigns
         ${where}
        ORDER BY name`,
    )
    .all(...params);
  res.json(rows);
});

module.exports = router;
