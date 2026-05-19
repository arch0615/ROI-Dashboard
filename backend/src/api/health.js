const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ad-genius/backend',
    env: process.env.NODE_ENV || 'development',
    uptime_s: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});

module.exports = router;
