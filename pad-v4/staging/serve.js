#!/usr/bin/env node
/* Bulletproof static server for the V4 testnet bench.
 *
 * Why not `npx serve` / `python3 -m http.server`? ES modules are BLOCKED by the browser unless the
 * server sends them as `text/javascript`. Some static servers mislabel .js (octet-stream), which
 * silently kills the whole module graph — every button goes dead with no error. This server pins the
 * correct Content-Type and disables caching (so the tunnel/browser can't serve a stale build).
 *
 * Run:  node serve.js              # port 8080, serves this folder
 *       PORT=3000 node serve.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found: " + p);
      }
      const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store, must-revalidate" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`serving ${ROOT}\n  → http://localhost:${PORT}  (Content-Type pinned, no-cache)`));
