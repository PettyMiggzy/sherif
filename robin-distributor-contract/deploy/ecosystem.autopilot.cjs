// PM2 process file for the AUTOPILOT (deposit → fund wallets → buy, hands-off).
//   npm i -g pm2
//   pm2 start deploy/ecosystem.autopilot.cjs
//   pm2 logs robin-autopilot
//   pm2 save && pm2 startup     # survive reboots
module.exports = {
  apps: [
    {
      name: "robin-autopilot",
      script: "scripts/autopilot.js",
      cwd: __dirname + "/..",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 100,
      // .env in cwd supplies PRIVATE_KEY, ROBINHOOD_RPC, DISPERSE_ADDRESS + buy tuning
    },
  ],
};
