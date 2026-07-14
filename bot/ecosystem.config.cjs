// pm2: `pm2 start ecosystem.config.cjs`  (loads bot/.env automatically)
module.exports = {
  apps: [{
    name: 'sheriff-buybot',
    script: 'buybot.js',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' },
  }],
};
