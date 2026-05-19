// PM2 process definitions. Run from repo root:
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup
//
// Both processes listen on 127.0.0.1 only — Nginx is the public entry point.

module.exports = {
  apps: [
    {
      name: 'ad-genius-backend',
      cwd: './backend',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 4000,
      },
    },
    {
      name: 'ad-genius-web',
      cwd: './web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001 -H 127.0.0.1',
      instances: 1,
      autorestart: true,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
