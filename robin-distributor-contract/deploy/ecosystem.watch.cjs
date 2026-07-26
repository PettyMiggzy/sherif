// PM2 process file for the auto-watcher.
//   npm i -g pm2
//   pm2 start deploy/ecosystem.watch.cjs
//   pm2 logs robin-watcher
//   pm2 save && pm2 startup     # survive reboots
module.exports = {
  apps: [
    {
      name: "robin-watcher",
      script: "scripts/watch.js",
      cwd: __dirname + "/..",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 100,
    },
  ],
};
