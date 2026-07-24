// pm2 alternative to Docker:  pm2 start ecosystem.config.cjs  (loads ./.env)
module.exports = {
  apps: [{
    name: 'robinlabs-launchbot',
    script: 'bot.js',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' },
  }],
};
