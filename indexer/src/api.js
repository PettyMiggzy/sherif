// The read API. Plain node:http (no framework). Everything is derived from the
// coins + trades tables by query, so it always reflects the current canonical
// chain — even right after a reorg re-scan. Volume/price are summed as ETH-scale
// REAL for ranking + display; per-trade wei stay exact in /api/trades.
import http from "node:http";
import { ethers } from "ethers";
import { db } from "./db.js";
import { CFG } from "./config.js";
import { getHead } from "./indexer.js";
import { getRewardRoot, claimsForEpoch, claimsForUser, getRewardClaim } from "./db.js";
import {
  coinDev, upsertCoinMetaFields, setCoinPfp, setCoinBanner,
  getCoinMetaLite, getCoinPfp, getCoinBanner,
} from "./db.js";
import { currentEpoch as rewardsEpoch, userAllocations as rewardsUserAlloc } from "./rewards.js";

const DAY = 86400;

// ── origin micro-cache ────────────────────────────────────────────────────────
// Serve identical GET /api/* responses straight from memory for a few seconds, so a
// launch-day crowd is absorbed by RAM instead of hammering SQLite/the RPC — the same
// win a CDN gives, but at the origin (works even with no Cloudflare in front). Data is
// at most CACHE_TTL_MS stale, exactly matching the Cache-Control we already send.
const API_CACHE = new Map(); // key -> { body, headers, exp }
const CACHE_TTL_MS = Number(process.env.API_CACHE_MS || 5000);

// ── coin profiles (creator-signed metadata) ──────────────────────────────────
// The exact message a coin's dev signs to authorize a profile update. It binds the
// token + every field (images by keccak digest) so a signature can't be replayed to
// another coin or a changed payload. MUST byte-match the frontend (pad/assets/wallet.js).
export function profileMessage(token, p) {
  const canon = JSON.stringify({
    description: p.description || "",
    telegram: p.telegram || "",
    twitter: p.twitter || "",
    website: p.website || "",
    pfp: p.pfp || "",       // data: URL or ""
    banner: p.banner || "", // data: URL or ""
    ts: p.ts,
  });
  return `Robin Labs — set coin profile\ntoken: ${token.toLowerCase()}\nts: ${p.ts}\ndigest: ${ethers.id(canon)}`;
}

// Decode a base64 data: URL to { buf, mime } — accepts ANY image type (incl. HEIC/HEIF)
// because the server downscales/converts before storing. Only the raw UPLOAD cap applies
// here; the STORED-size cap is enforced after normalizeImage().
function parseUpload(dataUrl) {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl || "");
  if (!m) throw new Error("image must be a base64 data: URL");
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0) throw new Error("empty image");
  if (buf.length > CFG.profileMaxUploadBytes) throw new Error(`image too large (max ${Math.floor(CFG.profileMaxUploadBytes / (1024 * 1024))}MB)`);
  return { buf, mime };
}

// Lazily load the image toolchain so the indexer still boots if they're absent
// (e.g. a compute-only replica). sharp = resize/encode (its prebuilt libvips can't
// decode HEIC), heic-convert = pure-JS HEIC/HEIF → JPEG.
let _sharp, _heic, _imgReady = false;
async function ensureImg() {
  if (_imgReady) return;
  try { _sharp = (await import("sharp")).default; } catch { _sharp = null; }
  try { _heic = (await import("heic-convert")).default; } catch { _heic = null; }
  _imgReady = true;
}
function looksHeic(buf, mime) {
  if (/hei[cf]/i.test(mime || "")) return true;
  // ISO-BMFF: bytes 4..8 == "ftyp", brand at 8..12 is heic/heif/mif1/msf1/hevc…
  if (buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12).toLowerCase();
    return /hei[cf]|mif1|msf1|hevc|heix/.test(brand);
  }
  return false;
}
// Convert any uploaded image to a small web-displayable webp that fits `maxDim`.
// HEIC is decoded to JPEG first, EXIF orientation is applied, and it's never upscaled.
async function normalizeImage(buf, mime, maxDim) {
  await ensureImg();
  let input = buf;
  if (looksHeic(buf, mime)) {
    if (!_heic) throw new Error("this server build can't read HEIC yet — upload a JPG or PNG");
    input = Buffer.from(await _heic({ buffer: buf, format: "JPEG", quality: 0.92 }));
  }
  if (_sharp) {
    const out = await _sharp(input, { failOn: "none" })
      .rotate()                                                              // honor EXIF orientation
      .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    if (out.length > CFG.profileMaxImageBytes) throw new Error("image too large after processing");
    return { buf: out, mime: "image/webp" };
  }
  // No sharp: only accept an already-small web image, stored as-is.
  const ok = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (ok.has(mime) && input.length <= CFG.profileMaxImageBytes) return { buf: input, mime };
  throw new Error("image processing unavailable on this server");
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > maxBytes) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Absolute base for media links, derived from the request (works behind Caddy/any proxy).
function mediaBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `${proto}://${host}` : "";
}
const profileOf = (token, m, base) => (m ? {
  description: m.description || null, telegram: m.telegram || null,
  twitter: m.twitter || null, website: m.website || null,
  image: m.has_pfp ? `${base}/media/${token}/pfp?v=${m.updated_ts}` : null,
  banner: m.has_banner ? `${base}/media/${token}/banner?v=${m.updated_ts}` : null,
  updatedTs: m.updated_ts || null,
} : null);

// One row per coin, enriched with all-time + 24h activity and last price (ETH/token).
// WHERE clause shared by the page query and the total-count query, so a filter can't drift between them.
const coinsWhere = (filter, hasQ) => {
  const where = [];
  if (filter === "live") where.push("c.graduated = 0");
  else if (filter === "graduated") where.push("c.graduated = 1");
  else if (filter === "final") where.push("c.graduated = 0 AND c.progress >= 0.70"); // "Final Stretch": >=70% up the curve
  if (hasQ) where.push("(LOWER(c.name) LIKE @q OR LOWER(c.symbol) LIKE @q OR c.token LIKE @q)");
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
};

const coinsStmt = (sort, filter, hasQ) => {
  const order = {
    new: "c.launch_block DESC",
    old: "c.launch_block ASC",
    trending: "vol_24h DESC, trades_24h DESC, c.launch_block DESC",
    top: "COALESCE(NULLIF(c.mcap_eth,0), vol_all) DESC, c.launch_block DESC", // "Market cap" (mcap, vol fallback)
    volume: "vol_24h DESC, vol_all DESC, c.launch_block DESC",
    holders: "holders_est DESC, c.launch_block DESC",
    graduated: "c.grad_block DESC",
  }[sort] || "c.launch_block DESC";
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM trades t WHERE t.token=c.token) AS trades_all,
      (SELECT COUNT(*) FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS trades_24h,
      (SELECT COUNT(DISTINCT t.actor) FROM trades t WHERE t.token=c.token) AS holders_est,
      (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token) AS vol_all,
      (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS vol_24h,
      (SELECT MAX(t.ts) FROM trades t WHERE t.token=c.token) AS last_trade_ts,
      (SELECT CAST(t.eth AS REAL)/NULLIF(CAST(t.tokens AS REAL),0)
         FROM trades t WHERE t.token=c.token ORDER BY t.block DESC, t.log_index DESC LIMIT 1) AS last_price,
      cm.description AS meta_desc, cm.telegram AS meta_tg, cm.twitter AS meta_tw, cm.website AS meta_web,
      cm.updated_ts AS meta_ts, (cm.pfp IS NOT NULL) AS has_pfp, (cm.banner IS NOT NULL) AS has_banner
    FROM coins c
    LEFT JOIN coin_meta cm ON cm.token = c.token
    ${coinsWhere(filter, hasQ)}
    ORDER BY ${order}
    LIMIT @limit OFFSET @offset
  `);
};

const coinsCountStmt = (filter, hasQ) =>
  db.prepare(`SELECT COUNT(*) AS n FROM coins c ${coinsWhere(filter, hasQ)}`);

const shapeCoin = (r, base = "") => ({
  token: r.token, curve: r.curve, pool: r.pool, dev: r.dev,
  name: r.name, symbol: r.symbol,
  // creator-set profile (null until a profile is saved). `image` is the coin's pfp.
  image: r.has_pfp ? `${base}/media/${r.token}/pfp?v=${r.meta_ts}` : null,
  banner: r.has_banner ? `${base}/media/${r.token}/banner?v=${r.meta_ts}` : null,
  description: r.meta_desc || null,
  telegram: r.meta_tg || null, twitter: r.meta_tw || null, website: r.meta_web || null,
  launchBlock: r.launch_block, launchTs: r.launch_ts, launchTx: r.launch_tx,
  devBought: r.dev_bought,
  graduated: !!r.graduated,
  gradBlock: r.grad_block, gradTs: r.grad_ts, raisedWeth: r.raised_weth, bond: r.bond,
  tradesAll: r.trades_all, trades24h: r.trades_24h,
  volAllEth: r.vol_all, vol24hEth: r.vol_24h,
  lastTradeTs: r.last_trade_ts, lastPriceEth: r.last_price,
  // live curve snapshot — lets the pad render the progress bar + mcap with no
  // per-coin chain read (the whole point of the indexer at scale).
  progress: r.progress, mcapEth: r.mcap_eth, lastTick: r.last_tick, snapTs: r.snap_ts,
  startTick: r.start_tick, minGradTick: r.min_grad_tick, gradTick: r.grad_tick, gradTarget: r.grad_target,
});

const statsStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM coins) AS coins,
    (SELECT COUNT(*) FROM coins WHERE graduated=1) AS graduated,
    (SELECT COUNT(*) FROM trades) AS trades_all,
    (SELECT COUNT(*) FROM trades WHERE ts>=@since) AS trades_24h,
    (SELECT COALESCE(SUM(CAST(eth AS REAL)),0)/1e18 FROM trades) AS vol_all,
    (SELECT COALESCE(SUM(CAST(eth AS REAL)),0)/1e18 FROM trades WHERE ts>=@since) AS vol_24h
`);

// Daily buckets for the analytics dashboard. One row per UTC day inside the
// window, so the pad can draw real volume / launch / graduation charts straight
// from our own index — no third-party analytics dependency.
const seriesVolStmt = db.prepare(`
  SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS d,
         SUM(CAST(eth AS REAL))/1e18 AS vol,
         COUNT(*) AS trades,
         SUM(CASE WHEN side='buy'  THEN 1 ELSE 0 END) AS buys,
         SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) AS sells
  FROM trades WHERE ts >= @since GROUP BY d`);
const seriesLaunchStmt = db.prepare(`
  SELECT strftime('%Y-%m-%d', launch_ts, 'unixepoch') AS d, COUNT(*) AS n
  FROM coins WHERE launch_ts >= @since GROUP BY d`);
const seriesGradStmt = db.prepare(`
  SELECT strftime('%Y-%m-%d', grad_ts, 'unixepoch') AS d, COUNT(*) AS n
  FROM coins WHERE graduated=1 AND grad_ts >= @since GROUP BY d`);

const oneCoinStmt = db.prepare(`
  SELECT c.*,
    (SELECT COUNT(*) FROM trades t WHERE t.token=c.token) AS trades_all,
    (SELECT COUNT(*) FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS trades_24h,
    (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token) AS vol_all,
    (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS vol_24h,
    (SELECT MAX(t.ts) FROM trades t WHERE t.token=c.token) AS last_trade_ts,
    (SELECT CAST(t.eth AS REAL)/NULLIF(CAST(t.tokens AS REAL),0)
       FROM trades t WHERE t.token=c.token ORDER BY t.block DESC, t.log_index DESC LIMIT 1) AS last_price,
    cm.description AS meta_desc, cm.telegram AS meta_tg, cm.twitter AS meta_tw, cm.website AS meta_web,
    cm.updated_ts AS meta_ts, (cm.pfp IS NOT NULL) AS has_pfp, (cm.banner IS NOT NULL) AS has_banner
  FROM coins c LEFT JOIN coin_meta cm ON cm.token = c.token WHERE c.token=@token
`);
const tradesStmt = db.prepare(
  "SELECT tx, log_index, side, actor, eth, tokens, fee, block, ts FROM trades WHERE token=? ORDER BY block DESC, log_index DESC LIMIT ?");

// ── rewards ──
const coinNameStmt = db.prepare("SELECT name, symbol FROM coins WHERE token = ?");
const rewardAccruedStmt = db.prepare(
  "SELECT COALESCE(SUM(CAST(amount AS REAL)),0)/1e18 AS eth, COUNT(DISTINCT coin) AS coins FROM reward_accruals");
const rewardRootsPostedStmt = db.prepare("SELECT COUNT(*) AS posted FROM reward_roots WHERE posted_tx IS NOT NULL");
const rewardClaimsStmt = db.prepare(
  "SELECT COALESCE(SUM(CAST(amount AS REAL)),0)/1e18 AS eth, COUNT(*) AS n FROM reward_claims");

function send(res, code, body, origin) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "public, max-age=5",
  });
  res.end(json);
}

function sendMedia(res, blob, mime, origin) {
  res.writeHead(200, {
    "content-type": mime || "application/octet-stream",
    "access-control-allow-origin": origin,
    "cache-control": "public, max-age=300",
  });
  res.end(blob);
}

export function startApi() {
  const server = http.createServer(async (req, res) => {
    const origin = CFG.corsOrigin;
    if (req.method === "OPTIONS") { send(res, 204, {}, origin); return; }
    let url;
    try { url = new URL(req.url, "http://x"); } catch { send(res, 400, { error: "bad url" }, origin); return; }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const now = Math.floor(Date.now() / 1000);
    const since = now - DAY;
    const base = mediaBase(req);

    // ── write: set a coin's profile (creator-signed) ──────────────────────────
    // Body: { description, telegram, twitter, website, pfp?, banner?, ts, signature }.
    // pfp/banner are base64 data: URLs. The signature must be the coin's dev over
    // profileMessage(token, body); anyone else is rejected. See docs/api.md.
    if (req.method === "POST") {
      const mm = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/meta$/);
      if (!mm) return send(res, 404, { error: "no such route" }, origin);
      try {
        const token = mm[1].toLowerCase();
        const dev = coinDev.get(token);
        if (!dev) return send(res, 404, { error: "unknown coin" }, origin);
        const raw = await readBody(req, CFG.profileMaxUploadBytes * 3);
        const body = JSON.parse(raw.toString("utf8"));
        const ts = Number(body.ts);
        if (!Number.isFinite(ts)) return send(res, 400, { error: "missing ts" }, origin);
        if (Math.abs(now - ts) > CFG.profileMaxSigAgeSecs) return send(res, 400, { error: "signature expired — sign and submit again" }, origin);
        const existing = getCoinMetaLite.get(token);
        if (existing && existing.updated_ts && ts <= existing.updated_ts) return send(res, 409, { error: "a newer profile already exists" }, origin);
        let signer;
        try { signer = ethers.verifyMessage(profileMessage(token, body), String(body.signature || "")); }
        catch { return send(res, 400, { error: "bad signature" }, origin); }
        if (signer.toLowerCase() !== String(dev.dev).toLowerCase())
          return send(res, 403, { error: "only the coin's creator can set its profile" }, origin);
        // Convert/downscale server-side so ANY format works (incl. iPhone HEIC that phones
        // can't process). These awaits happen before the sync db transaction below.
        const pfpRaw = body.pfp ? parseUpload(body.pfp) : null;
        const bannerRaw = body.banner ? parseUpload(body.banner) : null;
        const pfp = pfpRaw ? await normalizeImage(pfpRaw.buf, pfpRaw.mime, CFG.profilePfpDim) : null;
        const banner = bannerRaw ? await normalizeImage(bannerRaw.buf, bannerRaw.mime, CFG.profileBannerDim) : null;
        const fields = {
          token,
          description: String(body.description || "").slice(0, 280),
          telegram: String(body.telegram || "").slice(0, 200),
          twitter: String(body.twitter || "").slice(0, 200),
          website: String(body.website || "").slice(0, 200),
          updated_ts: ts, updated_by: signer.toLowerCase(),
        };
        db.transaction(() => {
          upsertCoinMetaFields.run(fields);
          if (pfp) setCoinPfp.run({ token, blob: pfp.buf, mime: pfp.mime });
          if (banner) setCoinBanner.run({ token, blob: banner.buf, mime: banner.mime });
        })();
        return send(res, 200, { ok: true, token, profile: profileOf(token, getCoinMetaLite.get(token), base) }, origin);
      } catch (e) { return send(res, 400, { error: String(e.message || e) }, origin); }
    }
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }, origin);

    // Micro-cache for GET /api/* (not /media, not /health). On a hit, serve the stored
    // bytes from RAM; on a miss, transparently capture this response into the cache.
    if (CACHE_TTL_MS > 0 && path.startsWith("/api/")) {
      const key = path + url.search;
      const hit = API_CACHE.get(key);
      if (hit && hit.exp > Date.now()) {
        res.writeHead(200, { ...hit.headers, "x-cache": "HIT" });
        return res.end(hit.body);
      }
      const _end = res.end.bind(res);
      const _writeHead = res.writeHead.bind(res);
      let _code = 200, _hdrs = {};
      res.writeHead = (code, headers) => { _code = code; _hdrs = headers || {}; return _writeHead(code, { ...(headers || {}), "x-cache": "MISS" }); };
      res.end = (chunk) => {
        try {
          if (_code === 200 && chunk) {
            if (API_CACHE.size > 2000) API_CACHE.clear(); // expire-in-5s working set is tiny; this is just a safety valve
            API_CACHE.set(key, { body: chunk, headers: _hdrs, exp: Date.now() + CACHE_TTL_MS });
          }
        } catch { /* caching is best-effort */ }
        return _end(chunk);
      };
    }

    try {
      if (path === "/" || path === "/health") {
        const c = db.prepare("SELECT COUNT(*) n FROM coins").get().n;
        const t = db.prepare("SELECT COUNT(*) n FROM trades").get().n;
        const cur = db.prepare("SELECT v FROM meta WHERE k='cursor'").get();
        return send(res, 200, { ok: true, head: getHead(), cursor: cur ? Number(cur.v) : null, coins: c, trades: t }, origin);
      }

      if (path === "/api/stats") {
        const s = statsStmt.get({ since });
        return send(res, 200, {
          coins: s.coins, graduated: s.graduated,
          tradesAll: s.trades_all, trades24h: s.trades_24h,
          volAllEth: s.vol_all, vol24hEth: s.vol_24h,
        }, origin);
      }

      if (path === "/api/series") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30), 1), 180);
        const from = now - days * DAY;
        // Bucket by UTC day, then fill gaps so the chart has a point per day.
        const byDay = new Map();
        const touch = (d) => byDay.get(d) || byDay.set(d, { d, volEth: 0, trades: 0, buys: 0, sells: 0, launched: 0, graduated: 0 }).get(d);
        for (const r of seriesVolStmt.all({ since: from })) { const o = touch(r.d); o.volEth = r.vol || 0; o.trades = r.trades || 0; o.buys = r.buys || 0; o.sells = r.sells || 0; }
        for (const r of seriesLaunchStmt.all({ since: from })) touch(r.d).launched = r.n || 0;
        for (const r of seriesGradStmt.all({ since: from })) touch(r.d).graduated = r.n || 0;
        // Dense series oldest→newest (zero-filled days included).
        const out = [];
        for (let i = days - 1; i >= 0; i--) {
          const t = new Date((now - i * DAY) * 1000).toISOString().slice(0, 10);
          out.push(byDay.get(t) || { d: t, volEth: 0, trades: 0, buys: 0, sells: 0, launched: 0, graduated: 0 });
        }
        return send(res, 200, { days, series: out }, origin);
      }

      if (path === "/api/coins") {
        const sort = url.searchParams.get("sort") || "new";
        const filter = url.searchParams.get("filter") || "all";
        const qRaw = (url.searchParams.get("q") || "").trim().toLowerCase();
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 60), 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
        const params = { since, limit, offset, q: qRaw ? `%${qRaw}%` : "%" };
        const rows = coinsStmt(sort, filter, !!qRaw).all(params);
        const total = coinsCountStmt(filter, !!qRaw).get(params).n; // full match count for {coins,total} contract
        return send(res, 200, { coins: rows.map((r) => shapeCoin(r, base)), total, sort, filter, limit, offset }, origin);
      }

      // Serve a coin's image bytes (pfp | banner). Cacheable; ?v=updatedTs busts the cache.
      let m = path.match(/^\/media\/(0x[0-9a-fA-F]{40})\/(pfp|banner)$/);
      if (m) {
        const token = m[1].toLowerCase();
        const row = m[2] === "pfp" ? getCoinPfp.get(token) : getCoinBanner.get(token);
        if (!row || !row.blob) return send(res, 404, { error: "no image" }, origin);
        return sendMedia(res, row.blob, row.mime, origin);
      }

      // A coin's profile (creator-set metadata + image URLs). `profile` is null until set.
      m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/meta$/);
      if (m) {
        const token = m[1].toLowerCase();
        return send(res, 200, { token, profile: profileOf(token, getCoinMetaLite.get(token), base) }, origin);
      }

      m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const r = oneCoinStmt.get({ token: m[1].toLowerCase(), since });
        if (!r) return send(res, 404, { error: "not found" }, origin);
        return send(res, 200, { coin: shapeCoin(r, base) }, origin);
      }

      m = path.match(/^\/api\/trades\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 500);
        const rows = tradesStmt.all(m[1].toLowerCase(), limit).map((t) => ({
          tx: t.tx, logIndex: t.log_index, side: t.side, actor: t.actor,
          eth: t.eth, tokens: t.tokens, fee: t.fee, block: t.block, ts: t.ts,
        }));
        return send(res, 200, { trades: rows }, origin);
      }

      // ── rewards ──
      const rootMeta = (epoch) => {
        const r = getRewardRoot.get(epoch);
        return r ? { root: r.root, algoHash: r.algo_hash, uri: r.uri, posted: !!r.posted_tx, postedTx: r.posted_tx } : null;
      };
      const enrich = (coin) => { const c = coinNameStmt.get(coin) || {}; return { name: c.name || null, sym: c.symbol || null }; };
      const ethOf = (wei) => Number(BigInt(wei)) / 1e18;

      // Global reward totals for the stats page.
      if (path === "/api/rewards/stats") {
        const accrued = rewardAccruedStmt.get();
        const roots = rewardRootsPostedStmt.get();
        const claims = rewardClaimsStmt.get();
        return send(res, 200, {
          accruedEth: accrued.eth, coinsWithRewards: accrued.coins,
          epochsPosted: roots.posted, allocatedEth: claims.eth, leaves: claims.n,
          epoch: rewardsEpoch(now), epochLen: CFG.epochLen,
        }, origin);
      }

      // Transparency artifact: the full leaf set + root for an epoch (what the on-chain `uri` points at).
      m = path.match(/^\/api\/rewards\/epoch\/(\d+)$/);
      if (m) {
        const epoch = Number(m[1]);
        const meta = rootMeta(epoch);
        if (!meta) return send(res, 404, { error: "epoch not computed" }, origin);
        const r = getRewardRoot.get(epoch);
        const leaves = claimsForEpoch.all(epoch).map((c) => ({
          coin: c.coin, side: c.side, user: c.user, amount: c.amount, proof: JSON.parse(c.proof),
        }));
        return send(res, 200, {
          epoch, ...meta, nLeaves: r.n_leaves, perCoin: r.per_coin ? JSON.parse(r.per_coin) : {}, leaves,
        }, origin);
      }

      // A single claim's exact args + proof (used to re-fetch one leaf).
      m = path.match(/^\/api\/rewards\/claim\/(\d+)\/(0x[0-9a-fA-F]{40})\/([01])\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const epoch = Number(m[1]), coin = m[2].toLowerCase(), side = Number(m[3]), user = m[4].toLowerCase();
        const c = getRewardClaim.get(epoch, coin, side, user);
        if (!c) return send(res, 404, { error: "no claim" }, origin);
        return send(res, 200, { epoch, coin, side, user, amount: c.amount, proof: JSON.parse(c.proof), ...(rootMeta(epoch) || {}) }, origin);
      }

      // The wallet page's feed: everything `addr` can claim (finalized+posted epochs, with proofs) + what's
      // still accruing this (open) epoch (a live provisional estimate, no proof yet). Shape matches Pad.rewards().
      m = path.match(/^\/api\/rewards\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const who = m[1].toLowerCase();
        const ep = rewardsEpoch(now);
        const sideName = (s) => (s === 0 ? "trader" : "holder");
        const claimable = claimsForUser.all(who)
          .filter((c) => (getRewardRoot.get(c.epoch) || {}).posted_tx) // only epochs whose root is actually on-chain
          .map((c) => ({
            epoch: c.epoch, coin: c.coin, side: c.side, sideName: sideName(c.side),
            amount: c.amount, eth: ethOf(c.amount), proof: JSON.parse(c.proof), ...enrich(c.coin),
          }));
        // pending = provisional allocation for the current, not-yet-finalized epoch.
        const pending = rewardsUserAlloc(who, ep).map((p) => ({
          epoch: ep, coin: p.coin, side: p.side, sideName: sideName(p.side),
          amount: p.amount, eth: ethOf(p.amount), ...enrich(p.coin),
        }));
        const totalEth = claimable.reduce((s, c) => s + c.eth, 0);
        return send(res, 200, {
          epoch: ep,
          epochEndsIn: (ep + 1) * CFG.epochLen - now,
          claimWindowH: Math.round(CFG.challengeWindow / 3600),
          claimable, pending,
          totals: { claimableEth: totalEth, pendingEth: pending.reduce((s, p) => s + p.eth, 0) },
        }, origin);
      }

      return send(res, 404, { error: "no such route" }, origin);
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) }, origin);
    }
  });
  server.listen(CFG.port, () => console.log(`[api] listening on :${CFG.port}  (GET /health)`));
  return server;
}
