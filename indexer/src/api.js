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
import { devLocksForToken } from "./db.js";
import {
  coinDev, upsertCoinMetaFields, setCoinPfp, setCoinBanner,
  getCoinMetaLite, getCoinPfp, getCoinBanner,
  holdingsByActor, holdersByToken,
  setCoinSite, clearCoinSite, getSiteBySlug, slugOwnerToken, getCoinSite,
} from "./db.js";
import { checkSlug, isValidStyle, isTakenDown, normalizeSlug } from "./sitegate.js";
import { currentEpoch as rewardsEpoch, userAllocations as rewardsUserAlloc } from "./rewards.js";
import { handleQuote as uniHandleQuote, handleSwap as uniHandleSwap, handleApproval as uniHandleApproval } from "./uniproxy.js";
import { handleQuote as lifiQuote, handleTokens as lifiTokens, handleConnections as lifiConnections, handleStatus as lifiStatus, handleRoutes as lifiRoutes, stats as lifiUsage } from "./lifiproxy.js";
import { renderCard, coinOgHtml } from "./og.js";
import { enabled as memeEnabled, makeMeme } from "./memeproxy.js";
import { enabled as artEnabled, makeArt, tiers as artTiers, styles as artStyles, creditsFor } from "./artproxy.js";
import * as Credits from "./credits.js";
import * as Chat from "./chatproxy.js";
import { enabled as ordersEnabled, saveOrder, ordersForMaker, cancelOrder, verifyCancelledOnChain, orderExists } from "./orders.js";

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
    migratedFrom: p.migratedFrom || "", // "chain|oldToken" provenance, or ""
    pfp: p.pfp || "",       // data: URL or ""
    banner: p.banner || "", // data: URL or ""
    ts: p.ts,
  });
  return `Robin Labs - set coin profile\ntoken: ${token.toLowerCase()}\nts: ${p.ts}\ndigest: ${ethers.id(canon)}`;
}

// The message a coin's dev signs to set (or clear) its website. Kept SEPARATE from
// profileMessage so adding websites never changes the profile signature (no client
// breakage). An empty style+slug is the "remove my site" action. MUST byte-match the
// frontend (pad/website.html).
export function siteMessage(token, s) {
  const canon = JSON.stringify({ style: s.style || "", slug: s.slug || "", ts: s.ts });
  return `Robin Labs - set coin website\ntoken: ${token.toLowerCase()}\nts: ${s.ts}\ndigest: ${ethers.id(canon)}`;
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
ensureImg(); // preload at startup so /health can report `img` and the first upload isn't slow
function looksHeic(buf, mime) {
  if (/hei[cf]/i.test(mime || "")) return true;
  // ISO-BMFF: bytes 4..8 == "ftyp", brand at 8..12 is heic/heif/mif1/msf1/hevc…
  if (buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12).toLowerCase();
    return /hei[cf]|mif1|msf1|hevc|heix/.test(brand);
  }
  return false;
}
// Reject/timeout guard: image decode + convert is CPU-bound (heic-convert runs on the
// main thread; sharp offloads to libuv's threadpool). Bound the worst case with (a) the
// raw-byte cap enforced in parseUpload, (b) a pixel-dimension cap so a decompression bomb
// is refused before it's fully decoded, and (c) a wall-clock timeout on the whole convert
// so a pathological image can't wedge the event loop indefinitely.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Largest raster a HEIF declares, read from its `ispe` (image spatial extent) boxes WITHOUT
// decoding. heic-convert runs libheif SYNCHRONOUSLY and allocates width*height*4 from the
// HEADER dimensions, so a small file that declares a huge (tiled) image can OOM the whole
// process before sharp's limitInputPixels or the wall-clock timeout can ever apply. We refuse
// it here first. A real `ispe` box is exactly 20 bytes (size|type|version+flags|width|height),
// so we only trust a match whose preceding size field == 20 (near-zero false positives).
// Returns max(width*height) across boxes, or 0 if none parseable (libheif then can't size it).
function heifMaxPixels(buf) {
  let max = 0;
  for (let i = 4; i + 16 <= buf.length; i++) {
    if (buf[i] === 0x69 && buf[i + 1] === 0x73 && buf[i + 2] === 0x70 && buf[i + 3] === 0x65) { // 'ispe'
      if (buf.readUInt32BE(i - 4) !== 20) continue;
      const w = buf.readUInt32BE(i + 8), h = buf.readUInt32BE(i + 12);
      if (w > 0 && h > 0) max = Math.max(max, w * h);
    }
  }
  return max;
}

// Convert any uploaded image to a small web-displayable webp that fits `maxDim`.
// HEIC is decoded to JPEG first, EXIF orientation is applied, and it's never upscaled.
async function normalizeImage(buf, mime, maxDim) {
  await ensureImg();
  let input = buf;
  if (looksHeic(buf, mime)) {
    if (!_heic) throw new Error("this server build can't read HEIC yet — upload a JPG or PNG");
    // Refuse a decompression bomb by its DECLARED dimensions before the synchronous libheif
    // decode allocates the raster (sharp's limitInputPixels only guards the step AFTER this).
    if (heifMaxPixels(buf) > CFG.profileMaxPixels) throw new Error("image dimensions too large");
    input = Buffer.from(await _heic({ buffer: buf, format: "JPEG", quality: 0.92 }));
  }
  if (_sharp) {
    // limitInputPixels makes sharp throw on an over-large image from its header, BEFORE
    // allocating a full raster (covers the HEIC→JPEG output too, which re-enters sharp here).
    const out = await _sharp(input, { failOn: "none", limitInputPixels: CFG.profileMaxPixels })
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

// ── JSON-RPC read proxy ────────────────────────────────────────────────────────
// The pad makes its live on-chain READS (quotes, balances, slot0) through POST /rpc so
// thousands of browsers hit the paid RPC via this ONE cached hop instead of hammering
// the public RPC each. Read methods only — writes (sendRawTransaction) are refused;
// wallets broadcast their own txs. Identical reads are cached briefly, so a crowd
// loading the same coin collapses to a single upstream call — the real load reducer.
const RPC_READ_METHODS = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_estimateGas",
  "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getTransactionCount", "eth_feeHistory", "eth_getBlockReceipts",
]);
const RPC_CACHE = new Map(); // key -> { result, exp }
let RPC_CACHE_BYTES = 0;                        // approx cached bytes, so we can evict by SIZE not just count
const MAX_RPC_RESP_BYTES = 8_000_000;           // reject an upstream response bigger than this (never buffer/cache it)
const RPC_CACHE_BYTE_BUDGET = 64_000_000;       // total cache ceiling; clear when a new entry would exceed it
// Reject an eth_getLogs whose range is a whole-chain scan or wider than this many blocks, so a client can't
// force huge upstream responses (memory amplification). The pad's own reads page in <=50k-block chunks.
const MAX_LOGS_SPAN = 100000n;
// Best-effort chain head. On an API-only / read-replica node (`server.js --no-index`) the indexer loop
// never runs, so getHead() stays 0 forever; fall back to a recently-forwarded, cached eth_blockNumber so
// legitimate "recent block N .. latest" getLogs still pass the bound instead of being rejected outright.
function effectiveHead() {
  let h = 0n; try { h = BigInt(getHead() || 0); } catch { h = 0n; }
  if (h > 0n) return h;
  try { const c = RPC_CACHE.get("eth_blockNumber:[]"); if (c && c.result) return BigInt(c.result); } catch {}
  return 0n;
}
function getLogsRangeOk(params) {
  const p = Array.isArray(params) ? params[0] : null;
  if (!p || typeof p !== "object") return true; // malformed -> let upstream reject it
  if (typeof p.blockHash === "string") return true; // EIP-234 single-block query - never a range
  const headish = (b) => b === undefined || b === "latest" || b === "pending" || b === "safe" || b === "finalized";
  const num = (b) => { if (headish(b)) return null; if (b === "earliest") return 0n; try { return BigInt(b); } catch { return null; } };
  const from = num(p.fromBlock), to = num(p.toBlock);
  if ((p.fromBlock === undefined || p.fromBlock === "earliest" || from === 0n) && headish(p.toBlock)) return false; // earliest..head
  // A NUMERIC fromBlock with a head-ish toBlock is an open-ended upper bound: bound it against the indexer's
  // synced head (a close-enough estimate of chain head). Reject only when that span is too wide, so a
  // legitimate "recent block N .. latest" tail still works but "block 1 .. latest" does not.
  if (from !== null && headish(p.toBlock)) {
    const head = effectiveHead();
    if (head === 0n) return false;                       // head still unknown (fresh node, nothing forwarded yet): refuse
    if (head - from > MAX_LOGS_SPAN) return false;        // head known; reject a too-wide "N..latest" span
  }
  if (from !== null && to !== null && to - from > MAX_LOGS_SPAN) return false; // explicit span too wide
  return true;
}
function rpcTtl(method) {
  switch (method) {
    case "eth_chainId": case "net_version": return 3600_000;
    case "eth_call": case "eth_getCode": case "eth_getLogs": return 4000;
    case "eth_getBalance": case "eth_getTransactionCount":
    case "eth_getTransactionReceipt": case "eth_getTransactionByHash":
    case "eth_getBlockByNumber": case "eth_getBlockByHash": return 3000;
    case "eth_blockNumber": case "eth_gasPrice": case "eth_feeHistory":
    case "eth_maxPriorityFeePerGas": return 2000;
    default: return 0; // eth_estimateGas + anything else: never cache (per-tx / dynamic)
  }
}
async function rpcForward(payload) {
  // primary → optional backup (RPC_BACKUP, e.g. QuikNode) → last-resort fallback (blockscout). Deduped.
  // Free endpoints first, the paid RPC as the backstop — same order the poller uses, from one place, so the
  // two can't drift into disagreeing about which endpoint is the expensive one.
  const urls = CFG.readOrder;
  let lastErr;
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(9000) });
      if (!r.ok) { lastErr = new Error(`upstream ${r.status}`); continue; }
      const text = await r.text();
      if (text.length > MAX_RPC_RESP_BYTES) { lastErr = new Error("upstream response too large"); continue; } // don't buffer/cache a huge body
      return JSON.parse(text);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no upstream RPC");
}

// Fallback creator lookup straight from the factory, for the RACE at launch: create.html uploads the coin's
// profile the instant the launch tx confirms, but the indexer polls every few seconds, so the coin is often
// NOT in the `coins` table yet. Without this, that upload 404s ("unknown coin") and the image is silently lost
// (exactly why an early coin launched with no picture). Reading recordOf(token).dev on-chain is authoritative
// and spam-proof: only a coin THIS factory actually launched has a nonzero dev.
const _factoryIface = new ethers.Interface([
  "function recordOf(address) view returns (address token, address curve, address dev, uint256 at)",
]);
async function chainDevOf(token) {
  try {
    const data = _factoryIface.encodeFunctionData("recordOf", [token]);
    const resp = await rpcForward({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CFG.factory, data }, "latest"] });
    if (!resp || !resp.result || resp.result === "0x") return null;
    const dev = String(_factoryIface.decodeFunctionResult("recordOf", resp.result).dev || "").toLowerCase();
    return /^0x0+$/.test(dev) ? null : dev;
  } catch { return null; }
}
async function rpcHandle(payload) {
  const arr = Array.isArray(payload) ? payload : [payload];
  if (arr.length > 20) throw new Error("batch too large");
  const out = new Array(arr.length);
  const miss = [], missIdx = [];
  for (let i = 0; i < arr.length; i++) {
    const req = arr[i] || {};
    const method = req.method;
    if (!RPC_READ_METHODS.has(method)) { out[i] = { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `method not allowed: ${method}` } }; continue; }
    if (method === "eth_getLogs" && !getLogsRangeOk(req.params)) { out[i] = { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32005, message: "eth_getLogs range too wide (max 100000 blocks; no whole-chain scan)" } }; continue; }
    const ttl = rpcTtl(method);
    const key = ttl ? method + ":" + JSON.stringify(req.params || []) : null;
    if (key) { const hit = RPC_CACHE.get(key); if (hit && hit.exp > Date.now()) { out[i] = { jsonrpc: "2.0", id: req.id, result: hit.result }; continue; } }
    miss.push(req); missIdx.push(i);
  }
  if (miss.length) {
    // Forward with SYNTHETIC unique ids (the array index), never the client's ids. A client
    // batch with duplicate or omitted ids would otherwise let one entry's response overwrite
    // another's in the id map — and get written to the shared cache under the WRONG params
    // key, poisoning that key for every other user for the TTL. We correlate by our own unique
    // id, then restore the client's original id on the way out.
    const fwd = miss.map((req, j) => ({ jsonrpc: "2.0", id: j, method: req.method, params: req.params ?? [] }));
    const resp = await rpcForward(fwd);
    const byId = new Map();
    for (const r of (Array.isArray(resp) ? resp : [resp])) if (r && typeof r.id === "number") byId.set(r.id, r);
    for (let j = 0; j < miss.length; j++) {
      const req = miss[j], i = missIdx[j];
      const r = byId.get(j);
      out[i] = r ? { ...r, id: req.id } : { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "no upstream response" } };
      const ttl = rpcTtl(req.method);
      // Cache only a real, non-null result: a null (e.g. a not-yet-mined receipt) cached for
      // the TTL would stall confirmation UIs; and never cache when correlation failed.
      if (ttl && r && r.result !== undefined && r.result !== null && !r.error) {
        let sz = 0; try { sz = JSON.stringify(r.result).length; } catch { sz = 0; }
        const key = req.method + ":" + JSON.stringify(req.params || []);
        const prev = RPC_CACHE.get(key);
        if (prev) RPC_CACHE_BYTES -= prev.sz || 0;   // re-caching an expired key: reclaim the old entry's bytes first, or the counter drifts up forever
        // Evict by COUNT or total BYTES, so a stream of large distinct responses can't pin the process toward OOM.
        if (RPC_CACHE.size > 8000 || RPC_CACHE_BYTES + sz > RPC_CACHE_BYTE_BUDGET) { RPC_CACHE.clear(); RPC_CACHE_BYTES = 0; }
        RPC_CACHE.set(key, { result: r.result, exp: Date.now() + ttl, sz });
        RPC_CACHE_BYTES += sz;
      }
    }
  }
  return Array.isArray(payload) ? out : out[0];
}
// The REAL client IP, used as the rate-limit / log key. Each trusted reverse-proxy in
// front of us APPENDS the peer it saw to X-Forwarded-For, so the client sits N entries
// from the RIGHT, where N = the number of trusted hops (Caddy alone = 1; Cloudflare→Caddy
// = 2). We never trust the LEFTMOST entry — it's client-supplied and spoofable. When
// Cloudflare is in front it also sets CF-Connecting-IP to the true client, which is
// immune to XFF spoofing, so we prefer that when present. OFF by default: the stock deploy
// is Caddy→indexer with NO Cloudflare, and Caddy forwards a client-supplied CF-Connecting-IP
// unstripped — so trusting it there would let anyone spoof the rate-limit key. Enable
// (USE_CF_IP=1) ONLY when Cloudflare genuinely fronts the service.
const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 1);
const USE_CF_IP = (process.env.USE_CF_IP ?? "0") !== "0";
function clientIp(req) {
  if (USE_CF_IP) {
    const cf = String(req.headers["cf-connecting-ip"] || "").trim();
    if (cf) return cf;
  }
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[Math.max(0, xff.length - TRUSTED_PROXY_HOPS)];
  return req.socket?.remoteAddress || "?";
}
// Parse a query-string integer, clamped to [min,max], falling back to `def` when it's
// missing OR non-numeric. NOTE: Number(null)/Number("") are 0 (finite!), so an ABSENT param
// would otherwise clamp to `min` instead of `def` — treat null/""/undefined as NaN so the
// default fires. Number("abc") is NaN too, which would bind to SQL LIMIT/OFFSET as a
// "datatype mismatch" → 500 on a public endpoint; Number.isFinite closes both off.
function intParam(v, def, min, max) {
  const n = (v === null || v === undefined || v === "") ? NaN : Number(v);
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : def, min), max);
}
// Tiny per-IP-per-second rate limiter, shared by /rpc and the profile POST so one abuser
// can't drain the upstream RPC or peg a CPU core on HEIC. `cost` lets a caller charge more
// than one unit for a single request — a JSON-RPC batch of N methods becomes N upstream
// calls, so it must count as N (see /rpc), not 1.
function makeRateLimiter(maxPerSec) {
  const m = new Map(); // ip -> { sec, n }
  return (ip, cost = 1) => {
    const sec = Math.floor(Date.now() / 1000);
    const e = m.get(ip);
    if (!e || e.sec !== sec) { m.set(ip, { sec, n: cost }); if (m.size > 20000) for (const [k, v] of m) if (v.sec !== sec) m.delete(k); return cost <= maxPerSec; }
    e.n += cost; return e.n <= maxPerSec;
  };
}
const rpcRateOk = makeRateLimiter(CFG.rpcProxyMaxPerSec);
const metaRateOk = makeRateLimiter(2); // profile uploads: ≤2/s/IP (HEIC decode is CPU-bound on the main thread)
const uniRateOk = makeRateLimiter(CFG.uniRatePerSec);       // per-IP cap on the Uniswap swap proxy
const uniGlobalOk = makeRateLimiter(CFG.uniGlobalPerSec);   // total upstream/sec (shared paid-key budget), keyed by a constant
const memeRateOk = makeRateLimiter(CFG.memeRatePerSec);     // per-IP/sec cap on the photo-to-meme generator
// Per-MINUTE global cap on meme generation — the hard spend bound (each image costs a few cents, so this
// is the ceiling on what a leaked endpoint can run up regardless of how many IPs hit it).
const _memeMin = { min: 0, n: 0 };
function memeGlobalOk() {
  const min = Math.floor(Date.now() / 60000);
  if (_memeMin.min !== min) { _memeMin.min = min; _memeMin.n = 0; }
  _memeMin.n += 1;
  return _memeMin.n <= CFG.memeGlobalPerMin;
}
const artRateOk = makeRateLimiter(CFG.veniceRatePerSec);    // per-IP/sec cap on the text-to-art generator
// Per-MINUTE global cap on art generation — its own budget, deliberately NOT shared with the meme
// generator. They are different endpoints at different per-image prices; one bucket would let the
// cheap one starve the expensive one, or the expensive one drain the cheap one's headroom.
const _artMin = { min: 0, n: 0 };
function artGlobalOk() {
  const min = Math.floor(Date.now() / 60000);
  if (_artMin.min !== min) { _artMin.min = min; _artMin.n = 0; }
  _artMin.n += 1;
  return _artMin.n <= CFG.veniceGlobalPerMin;
}
function artOrigin(req) {
  const o = String(req.headers["origin"] || "");
  return CFG.veniceCorsOrigins.includes(o) ? o : (CFG.veniceCorsOrigins[0] || "https://robinlab.io");
}
const chatRateOk = makeRateLimiter(CFG.chatRatePerSec);     // per-IP/sec cap on Robin Labs AI
const _chatMin = { min: 0, n: 0 };
function chatGlobalOk() {
  const min = Math.floor(Date.now() / 60000);
  if (_chatMin.min !== min) { _chatMin.min = min; _chatMin.n = 0; }
  _chatMin.n += 1;
  return _chatMin.n <= CFG.chatGlobalPerMin;
}
function chatOrigin(req) {
  const o = String(req.headers["origin"] || "");
  return CFG.chatCorsOrigins.includes(o) ? o : (CFG.chatCorsOrigins[0] || "https://robinlab.io");
}
const lifiRateOk = makeRateLimiter(CFG.lifiRatePerSec);     // per-IP cap on the LI.FI bridge proxy
const lifiGlobalOk = makeRateLimiter(CFG.lifiGlobalPerSec); // total upstream/sec (protects our per-key LI.FI budget)
// Per-IP cap on GET /api/* reads. The 5s micro-cache keys on url.search, so a client spraying distinct
// query strings (e.g. /api/coins?offset=<incrementing>) bypasses it and forces a full aggregate recompute
// each time; this cap stops one client saturating the single-threaded SQLite/event loop. Generous for real
// browsing (a page load fires a handful of calls). /health and /media stay uncapped.
const apiGetRateOk = makeRateLimiter(CFG.apiGetMaxPerSec);
const rpcGlobalOk = makeRateLimiter(CFG.rpcGlobalPerSec); // TOTAL /rpc upstream/sec across all IPs (keyed by a constant) so a third party can't repurpose our paid read-proxy
const metaGlobalOk = makeRateLimiter(CFG.metaGlobalPerSec); // TOTAL profile-POST/sec across all IPs (bounds the pre-auth big-body parse cost regardless of IP count)
const mediaRateOk = makeRateLimiter(CFG.mediaMaxPerSec);   // per-IP cap on /media blob reads
// Negative cache for chainDevOf: an unknown address's on-chain miss is remembered briefly so a flood of
// distinct-unknown-address meta POSTs can't each fire a paid eth_call.
const CHAIN_DEV_MISS = new Map(); // addr -> exp(ms)
const MEDIA_CACHE = new Map();    // token:kind:v -> { blob, mime } (immutable per ?v, so no TTL needed)
const OG_CACHE = new Map();       // og:token -> { blob, exp } (share card PNG; short TTL so stats stay fresh)
const OG_TTL_MS = Number(process.env.OG_CACHE_MS || 300000); // 5 min: crawlers refetch rarely; stats needn't be to-the-second

// Absolute base for media links, derived from the request (works behind Caddy/any proxy).
function mediaBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `${proto}://${host}` : "";
}
const profileOf = (token, m, base) => (m ? {
  description: m.description || null, telegram: m.telegram || null,
  twitter: m.twitter || null, website: m.website || null,
  migratedFrom: m.migrated_from || null,
  siteStyle: m.site_style || null, siteSlug: m.site_slug || null,
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

// TODO(perf): each ranked row runs ~7 correlated per-coin subqueries over `trades`
// (all-time + 24h vol/count, distinct-actor count, last price/ts). Indexes on
// trades(token, ts) and trades(token, actor) (see db.js) keep these cheap for now, but at
// scale the real fix is a per-coin aggregate/snapshot table (trades_all, vol_all, 24h
// rollups, holders_est, last_price) maintained incrementally on trade insert / reorg
// re-scan, so the feed reads O(1) columns instead of scanning each coin's trade history.
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
      cm.migrated_from AS meta_migrated,
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
  migratedFrom: r.meta_migrated || null,
  // per-coin website (null until the creator picks a style + slug)
  siteStyle: r.meta_site_style || null, siteSlug: r.meta_site_slug || null,
  launchBlock: r.launch_block, launchTs: r.launch_ts, launchTx: r.launch_tx,
  devBought: r.dev_bought,
  graduated: !!r.graduated,
  gradBlock: r.grad_block, gradTs: r.grad_ts, raisedWeth: r.raised_weth, bond: r.bond,
  tradesAll: r.trades_all, trades24h: r.trades_24h,
  holders: r.holders_est != null ? r.holders_est : null, // distinct traders (approx holders); only on single-coin reads
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
    (SELECT COUNT(DISTINCT t.actor) FROM trades t WHERE t.token=c.token) AS holders_est,
    (SELECT COUNT(*) FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS trades_24h,
    (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token) AS vol_all,
    (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS vol_24h,
    (SELECT MAX(t.ts) FROM trades t WHERE t.token=c.token) AS last_trade_ts,
    (SELECT CAST(t.eth AS REAL)/NULLIF(CAST(t.tokens AS REAL),0)
       FROM trades t WHERE t.token=c.token ORDER BY t.block DESC, t.log_index DESC LIMIT 1) AS last_price,
    cm.description AS meta_desc, cm.telegram AS meta_tg, cm.twitter AS meta_tw, cm.website AS meta_web,
    cm.migrated_from AS meta_migrated, cm.site_style AS meta_site_style, cm.site_slug AS meta_site_slug,
    cm.updated_ts AS meta_ts, (cm.pfp IS NOT NULL) AS has_pfp, (cm.banner IS NOT NULL) AS has_banner
  FROM coins c LEFT JOIN coin_meta cm ON cm.token = c.token WHERE c.token=@token
`);
const tradesStmt = db.prepare(
  "SELECT tx, log_index, side, actor, eth, tokens, fee, block, ts FROM trades WHERE token=? ORDER BY block DESC, log_index DESC LIMIT ?");
// Global recent activity across ALL coins (for the homepage live ticker). Joined to coins for name/symbol.
const recentActivityStmt = db.prepare(
  "SELECT t.token, t.side, t.eth, t.tokens, t.ts, c.symbol, c.name FROM trades t JOIN coins c ON c.token = t.token ORDER BY t.block DESC, t.log_index DESC LIMIT ?");

// ── token list (Uniswap-standard tokenlist.json of every launched coin) ──
// Every Robin Labs coin is a fixed-supply 18-decimal ERC20 from one audited template, so wallets
// and aggregators that consume token lists get our whole catalogue (name/symbol/logo) with zero
// per-coin submission. Oldest-first so `version.major` (= row count) only ever climbs.
// LIMIT 10000: the Uniswap token-list schema caps `tokens` at 10,000; past that a strict consumer rejects
// the WHOLE list, so we cap rather than emit an invalid list. Oldest-first keeps version.minor monotonic.
const TOKENLIST_MAX = 10000;
const tokenListStmt = db.prepare(
  `SELECT c.token, c.name, c.symbol, cm.updated_ts AS meta_ts, (cm.pfp IS NOT NULL) AS has_pfp
   FROM coins c LEFT JOIN coin_meta cm ON cm.token = c.token
   ORDER BY c.launch_block ASC LIMIT ${TOKENLIST_MAX}`);

// ── rewards ──
const coinNameStmt = db.prepare("SELECT name, symbol FROM coins WHERE token = ?");
const rewardAccruedStmt = db.prepare(
  "SELECT COALESCE(SUM(CAST(amount AS REAL)),0)/1e18 AS eth, COUNT(DISTINCT coin) AS coins FROM reward_accruals");
const rewardRootsPostedStmt = db.prepare("SELECT COUNT(*) AS posted FROM reward_roots WHERE posted_tx IS NOT NULL");

// /health + / run two COUNT(*) scans (coins, trades). trades grows unbounded, so on a hot health-check
// path these become full-table scans. Prepare once and cache the counts for a few seconds so a burst of
// unauthenticated / and /health hits can't turn into a scan-per-request. head/cursor stay live (cheap).
const healthCoinsStmt = db.prepare("SELECT COUNT(*) n FROM coins");
const healthTradesStmt = db.prepare("SELECT COUNT(*) n FROM trades");
let _healthCounts = { at: 0, coins: 0, trades: 0 };
function healthCounts() {
  const nowMs = Date.now();
  if (nowMs - _healthCounts.at > 5000) {
    _healthCounts = { at: nowMs, coins: healthCoinsStmt.get().n, trades: healthTradesStmt.get().n };
  }
  return _healthCounts;
}
const rewardClaimsStmt = db.prepare(
  "SELECT COALESCE(SUM(CAST(amount AS REAL)),0)/1e18 AS eth, COUNT(*) AS n FROM reward_claims");
// Per-side split (0=traders, 1=holders) + distinct claimants, for the rewards page totals strip.
const rewardClaimsBySideStmt = db.prepare(
  "SELECT COALESCE(SUM(CASE WHEN side=0 THEN CAST(amount AS REAL) END),0)/1e18 AS traders, " +
  "COALESCE(SUM(CASE WHEN side=1 THEN CAST(amount AS REAL) END),0)/1e18 AS holders, " +
  "COUNT(DISTINCT user) AS claimants FROM reward_claims");

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

// Uniswap proxy responses: scope CORS to our own origins (not "*") and never cache per-user quote/swap data.
function uniOrigin(req) {
  const o = String(req.headers["origin"] || "");
  return CFG.uniCorsOrigins.includes(o) ? o : (CFG.uniCorsOrigins[0] || "https://robinlab.io");
}
// Meme proxy responses: scope CORS to our own origins (not "*"), never cache a per-user image.
function memeOrigin(req) {
  const o = String(req.headers["origin"] || "");
  return CFG.memeCorsOrigins.includes(o) ? o : (CFG.memeCorsOrigins[0] || "https://robinlab.io");
}
function sendUni(res, code, body, origin) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "vary": "Origin",
  });
  res.end(JSON.stringify(body));
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

    // ── LI.FI cross-chain bridge proxy: /api/lifi/{quote,tokens,connections,status,routes} ─────────
    // Handled BEFORE the method split because most of these are GET (tokens/quote/connections/status),
    // only `routes` is POST. Off unless a LIFI key is set. Injects the secret key + our integrator/fee
    // server-side, locks the destination to Robinhood Chain, scoped CORS + rate limits.
    if (CFG.lifiApiKeys.length && path.startsWith("/api/lifi/")) {
      const lorigin = uniOrigin(req);
      const ip = clientIp(req);
      if (!lifiRateOk(ip)) return sendUni(res, 429, { error: "rate limited, slow down" }, lorigin);
      if (!lifiGlobalOk("g")) return sendUni(res, 429, { error: "busy, retry in a moment" }, lorigin);
      const sub = path.slice("/api/lifi/".length);
      if (sub === "stats") return sendUni(res, 200, lifiUsage(), lorigin); // usage/rate-limit monitor (no upstream call)
      try {
        let out;
        if (sub === "quote") out = await lifiQuote(url.searchParams);
        else if (sub === "tokens") out = await lifiTokens(url.searchParams);
        else if (sub === "connections") out = await lifiConnections(url.searchParams);
        else if (sub === "status") out = await lifiStatus(url.searchParams);
        else if (sub === "routes") {
          let lb; try { lb = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")); }
          catch { return sendUni(res, 400, { error: "bad json" }, lorigin); }
          out = await lifiRoutes(lb);
        } else return sendUni(res, 404, { error: "no such route" }, lorigin);
        return sendUni(res, out.status, out.json, lorigin);
      } catch { return sendUni(res, 502, { error: "bridge upstream error" }, lorigin); }
    }

    // ── write: set a coin's profile (creator-signed) ──────────────────────────
    // Body: { description, telegram, twitter, website, pfp?, banner?, ts, signature }.
    // pfp/banner are base64 data: URLs. The signature must be the coin's dev over
    // profileMessage(token, body); anyone else is rejected. See docs/api.md.
    if (req.method === "POST") {
      // Read-only JSON-RPC proxy (served by the paid RPC, cached, rate-limited).
      if (CFG.rpcProxy && path === "/rpc") {
        const ip = clientIp(req);
        // Cheap pre-check (cost 1) drops a flood of single requests before we read a body.
        if (!rpcRateOk(ip)) return send(res, 429, { error: "rate limited" }, origin);
        try {
          const raw = await readBody(req, 512 * 1024);
          const payload = JSON.parse(raw.toString("utf8"));
          // A batch of N methods fans out to N upstream calls — charge the limiter the
          // remaining N-1 so a big batch can't drive maxPerSec×batchSize upstream/sec/IP.
          const n = Array.isArray(payload) ? payload.length : 1;
          if (n > 1 && !rpcRateOk(ip, n - 1)) return send(res, 429, { error: "rate limited" }, origin);
          // Global upstream cap (all IPs): CORS can't stop non-browser clients, so bound total budget abuse.
          if (!rpcGlobalOk("g", n)) return send(res, 429, { error: "busy, retry shortly" }, origin);
          const result = await rpcHandle(payload);
          return send(res, 200, result, origin);
        } catch (e) { return send(res, 400, { error: String(e.message || e) }, origin); }
      }
      // ── Uniswap Trading API proxy: /api/uni/{quote,swap,check_approval} ──────────────────
      // Off unless UNISWAP_API_KEY is set. Injects the secret key + our fee server-side, allowlists
      // inputs, asserts the fee applied + the swap target, per-IP + global rate limits, scoped CORS.
      if (CFG.uniApiKey && path.startsWith("/api/uni/")) {
        const uorigin = uniOrigin(req);
        const ip = clientIp(req);
        if (!uniRateOk(ip)) return sendUni(res, 429, { error: "rate limited, slow down" }, uorigin);
        if (!uniGlobalOk("g")) return sendUni(res, 429, { error: "busy, retry in a moment" }, uorigin);
        let ubody;
        try { ubody = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")); }
        catch { return sendUni(res, 400, { error: "bad json" }, uorigin); }
        const sub = path.slice("/api/uni/".length);
        try {
          let out;
          if (sub === "quote") out = await uniHandleQuote(ubody);
          else if (sub === "swap") out = await uniHandleSwap(ubody);
          else if (sub === "check_approval") out = await uniHandleApproval(ubody);
          else return sendUni(res, 404, { error: "no such route" }, uorigin);
          return sendUni(res, out.status, out.json, uorigin);
        } catch { return sendUni(res, 502, { error: "trading upstream error" }, uorigin); }
      }

      // ── Robin Labs AI: POST /api/chat ────────────────────────────────────────
      // Body: { messages: [{role,content}], scope?: "pad"|"coin", token?: "0x…" }.
      // The SYSTEM PROMPT IS NOT ACCEPTED FROM THE CLIENT and never will be — it carries the rules
      // that stop a launchpad's chat box giving financial advice, and a client-supplied persona is
      // no persona at all. Any system message in `messages` is dropped by chatproxy's filter.
      if (path === "/api/chat") {
        const corigin = chatOrigin(req);
        if (!Chat.enabled()) return sendUni(res, 503, { error: "Robin Labs AI is not switched on yet" }, corigin);
        if (!chatRateOk(clientIp(req))) return sendUni(res, 429, { error: "one message at a time — give it a second" }, corigin);
        if (!chatGlobalOk()) return sendUni(res, 429, { error: "Robin Labs AI is busy, try again shortly" }, corigin);
        let cbody;
        try { cbody = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
        catch { return sendUni(res, 400, { error: "bad request" }, corigin); }

        // For a coin question, look the coin up HERE and hand the model the row. The alternative —
        // letting the client post the facts — means the page tells the model what is true about the
        // coin it is selling, which is exactly backwards.
        let facts = null;
        const scope = cbody.scope === "coin" ? "coin" : "pad";
        if (scope === "coin") {
          const tok = String(cbody.token || "").toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(tok)) return sendUni(res, 400, { error: "bad token" }, corigin);
          try {
            const row = db.prepare("SELECT * FROM coins WHERE token = ?").get(tok);
            facts = Chat.coinFacts(row);
          } catch { facts = null; }
          if (!facts) return sendUni(res, 404, { error: "I do not know that coin yet" }, corigin);
        }

        try {
          const out = await Chat.ask({ messages: cbody.messages, scope, facts });
          // ONLY the reply crosses to the browser. `ask` also returns which model answered and the
          // token usage; both are for our logs and tuning. Which model served a request is a
          // supplier detail exactly like the image models, and the pool is the thing that would be
          // reverse-engineered from it.
          return sendUni(res, 200, { reply: out.reply }, corigin);
        } catch (e) {
          // retryAfter is passed through so the UI can count down instead of guessing.
          const body = { error: (e && e.message) || "Robin Labs AI could not answer" };
          if (e && e.retryAfter) body.retryAfter = e.retryAfter;
          return sendUni(res, e && e.retryAfter ? 429 : 502, body, corigin);
        }
      }

      // ── Text-to-art proxy: POST /api/art ─────────────────────────────────────
      // Off unless VENICE_API_KEY is set. Body: { prompt: string }. The key, the model and
      // safe_mode are all injected server-side; nothing about the request can change what we spend
      // per image. The body cap is small on purpose — this endpoint takes words, not uploads, so a
      // large body is abuse rather than a legitimate call.
      if (path === "/api/art") {
        const aorigin = artOrigin(req);
        if (!artEnabled()) return sendUni(res, 503, { error: "art generator is not enabled yet" }, aorigin);
        if (!artRateOk(clientIp(req))) return sendUni(res, 429, { error: "one at a time — try again in a moment" }, aorigin);
        if (!artGlobalOk()) return sendUni(res, 429, { error: "the art generator is busy, try again shortly" }, aorigin);
        let abody;
        try { abody = JSON.parse((await readBody(req, 8 * 1024)).toString("utf8")); }
        catch { return sendUni(res, 400, { error: "bad request" }, aorigin); }
        const prompt = String(abody.prompt || "").slice(0, CFG.veniceMaxPromptChars);
        const tier = String(abody.tier || "medium").toLowerCase();
        const cost = creditsFor(tier);
        if (cost === null) return sendUni(res, 400, { error: "pick a quality level" }, aorigin);

        // The paywall. When credits are not configured the generator stays free and the rate limits
        // above are the only bound — which is fine for a closed beta and NOT fine in public, so the
        // /api/art/enabled probe reports which mode we are in rather than leaving it to be guessed.
        let release = null;
        if (Credits.enabled()) {
          const { user, nonce, deadline, signature } = abody;
          if (!/^0x[0-9a-fA-F]{40}$/.test(String(user || ""))) {
            return sendUni(res, 400, { error: "connect your wallet first" }, aorigin);
          }
          try {
            release = await Credits.reserve({
              user, amount: cost, nonce: String(nonce || "0"),
              deadline: String(deadline || "0"), signature: String(signature || "0x"),
            });
          } catch (e) {
            // 402 rather than 400: this is "pay to continue", and a client can branch on it to open
            // the top-up flow instead of showing an error.
            return sendUni(res, e && e.code === "NO_CREDITS" ? 402 : 400,
              { error: (e && e.message) || "could not verify your credits", need: cost }, aorigin);
          }
        }

        try {
          const out = await makeArt({ prompt, tier, style: abody.style });
          // Charged only now, and only because it worked. A blank or failed generation releases the
          // reservation without spending — see artproxy's blank guard.
          const txHash = release ? await release(true) : null;
          return sendUni(res, 200, { image: out.dataUrl, bytes: out.bytes, spent: release ? cost : 0, tx: txHash }, aorigin);
        } catch (e) {
          if (release) await release(false);
          return sendUni(res, 502, { error: (e && e.message) || "art generation failed" }, aorigin);
        }
      }

      // ── Photo-to-meme proxy: POST /api/meme ──────────────────────────────────
      // Off unless MEME_API_KEY is set. Body: { image: <base64 data URL>, style?: string }. Injects the
      // secret key server-side, per-IP + global-per-minute rate limits (the spend bound), scoped CORS.
      if (path === "/api/meme") {
        const morigin = memeOrigin(req);
        if (!memeEnabled()) return sendUni(res, 503, { error: "meme generator is not enabled yet" }, morigin);
        if (!memeRateOk(clientIp(req))) return sendUni(res, 429, { error: "one at a time — try again in a moment" }, morigin);
        if (!memeGlobalOk()) return sendUni(res, 429, { error: "the meme generator is busy, try again shortly" }, morigin);
        let mbody;
        try { mbody = JSON.parse((await readBody(req, Math.ceil(CFG.memeMaxUploadBytes * 1.4) + 4096)).toString("utf8")); }
        catch { return sendUni(res, 400, { error: "image too large or bad request" }, morigin); }
        const dm = /^data:[^;,]*;base64,(.+)$/s.exec(String(mbody.image || ""));
        if (!dm) return sendUni(res, 400, { error: "send a photo as a base64 data URL" }, morigin);
        let buf; try { buf = Buffer.from(dm[1], "base64"); } catch { return sendUni(res, 400, { error: "bad image" }, morigin); }
        try {
          const out = await makeMeme({ imageBuf: buf, style: mbody.style });
          return sendUni(res, 200, { image: out.dataUrl }, morigin);
        } catch (e) {
          return sendUni(res, 502, { error: (e && e.message) || "meme generation failed" }, morigin);
        }
      }

      // ── RobinLimit order store: POST /api/orders and /api/orders/cancel ───────
      // Off unless RobinLimit is deployed. Signature-verified on save; cancel only hides an order
      // the maker actually cancelled on-chain. Scoped CORS + a light rate limit.
      if (path === "/api/orders" || path === "/api/orders/cancel") {
        const oorigin = memeOrigin(req); // same allowlisted pad origins
        if (!ordersEnabled()) return sendUni(res, 503, { error: "automations are not live yet" }, oorigin);
        if (!apiGetRateOk(clientIp(req))) return sendUni(res, 429, { error: "slow down" }, oorigin);
        let ob;
        try { ob = JSON.parse((await readBody(req, 32 * 1024)).toString("utf8")); }
        catch { return sendUni(res, 400, { error: "bad json" }, oorigin); }
        if (path === "/api/orders/cancel") {
          const hash = String(ob.hash || "");
          if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return sendUni(res, 400, { error: "bad hash" }, oorigin);
          if (!orderExists(hash)) return sendUni(res, 404, { error: "unknown order" }, oorigin); // no RPC for a hash we don't store
          if (!(await verifyCancelledOnChain(hash))) return sendUni(res, 409, { error: "not cancelled on-chain yet" }, oorigin);
          cancelOrder(hash); // source of truth is the chain; we only mirror a confirmed cancel
          return sendUni(res, 200, { ok: true }, oorigin);
        }
        try {
          const { hash } = saveOrder(ob.order, ob.signature, now);
          return sendUni(res, 200, { ok: true, hash }, oorigin);
        } catch (e) { return sendUni(res, 400, { error: (e && e.message) || "bad order" }, oorigin); }
      }

      // ── set/clear a coin's website: POST /api/coin/:token/site ──────────────
      // Creator-signed (siteMessage). Body: { style, slug, ts, signature }. An empty
      // style AND slug clears the site (releases the slug). Small body, so the same
      // per-IP + global meta budget bounds the pre-auth parse.
      const sm = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/site$/);
      if (sm) {
        if (!metaRateOk(clientIp(req))) return send(res, 429, { error: "rate limited — wait a moment and try again" }, origin);
        if (!metaGlobalOk("g")) return send(res, 503, { error: "busy, retry shortly" }, origin);
        try {
          const token = sm[1].toLowerCase();
          let devAddr = coinDev.get(token)?.dev;
          if (!devAddr) {
            const miss = CHAIN_DEV_MISS.get(token);
            if (miss && miss > Date.now()) return send(res, 404, { error: "unknown coin" }, origin);
            if (!rpcGlobalOk("g")) return send(res, 503, { error: "busy, retry shortly" }, origin);
            devAddr = await chainDevOf(token);
            if (!devAddr) {
              if (CHAIN_DEV_MISS.size > 5000) CHAIN_DEV_MISS.clear();
              CHAIN_DEV_MISS.set(token, Date.now() + 60_000);
              return send(res, 404, { error: "unknown coin" }, origin);
            }
          }
          const raw = await readBody(req, 8192); // tiny JSON — no images here
          const body = JSON.parse(raw.toString("utf8"));
          const ts = Number(body.ts);
          if (!Number.isFinite(ts)) return send(res, 400, { error: "missing ts" }, origin);
          if (Math.abs(now - ts) > CFG.profileMaxSigAgeSecs) return send(res, 400, { error: "signature expired — sign and submit again" }, origin);
          const style = String(body.style || "").trim().toLowerCase();
          const slugRaw = String(body.slug || "").trim();
          let signer;
          try { signer = ethers.verifyMessage(siteMessage(token, { style, slug: slugRaw, ts }), String(body.signature || "")); }
          catch { return send(res, 400, { error: "bad signature" }, origin); }
          if (signer.toLowerCase() !== String(devAddr).toLowerCase())
            return send(res, 403, { error: "only the coin's creator can set its website" }, origin);
          const existing = getCoinMetaLite.get(token);
          const stampTs = Math.max(ts, existing?.updated_ts || 0); // never move the media cache-bust backwards
          // CLEAR: empty style + slug removes the site and frees the slug.
          if (!style && !slugRaw) {
            clearCoinSite.run({ token, updated_ts: stampTs, updated_by: signer.toLowerCase() });
            return send(res, 200, { ok: true, token, site: null }, origin);
          }
          if (!isValidStyle(style)) return send(res, 400, { error: "unknown style" }, origin);
          const chk = checkSlug(slugRaw);
          if (!chk.ok) return send(res, 400, { error: `slug ${chk.reason}` }, origin);
          // Uniqueness: the slug must be unclaimed, or already this coin's.
          const owner = slugOwnerToken.get(chk.slug);
          if (owner && owner.token.toLowerCase() !== token)
            return send(res, 409, { error: "that address is taken — pick another" }, origin);
          setCoinSite.run({ token, site_style: style, site_slug: chk.slug, updated_ts: stampTs, updated_by: signer.toLowerCase() });
          return send(res, 200, {
            ok: true, token,
            site: { style, slug: chk.slug, url: `https://${chk.slug}.robinlabs.fun` },
          }, origin);
        } catch (e) { return send(res, 400, { error: String(e.message || e) }, origin); }
      }

      const mm = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/meta$/);
      if (!mm) return send(res, 404, { error: "no such route" }, origin);
      if (!metaRateOk(clientIp(req))) return send(res, 429, { error: "rate limited — wait a moment and try again" }, origin);
      // Global cap across ALL IPs: the profile POST buffers + synchronously JSON.parses a large body, so bound
      // total meta processing/sec so a distributed flood can't monopolise the single-threaded event loop.
      if (!metaGlobalOk("g")) return send(res, 503, { error: "busy, retry shortly" }, origin);
      try {
        const token = mm[1].toLowerCase();
        // Creator from the index, else straight from the factory on-chain — so a profile uploaded the instant
        // a launch confirms (before the indexer has polled the coin in) is NOT dropped with a 404.
        let devAddr = coinDev.get(token)?.dev;
        if (!devAddr) {
          const miss = CHAIN_DEV_MISS.get(token);
          if (miss && miss > Date.now()) return send(res, 404, { error: "unknown coin" }, origin); // remembered miss, no upstream call
          // chainDevOf fires a paid eth_call — charge the shared /rpc budget so this path can't be a side-door around it.
          if (!rpcGlobalOk("g")) return send(res, 503, { error: "busy, retry shortly" }, origin);
          devAddr = await chainDevOf(token);
          if (!devAddr) {
            if (CHAIN_DEV_MISS.size > 5000) CHAIN_DEV_MISS.clear();
            CHAIN_DEV_MISS.set(token, Date.now() + 60_000); // 60s negative cache
            return send(res, 404, { error: "unknown coin" }, origin);
          }
        }
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
        if (signer.toLowerCase() !== String(devAddr).toLowerCase())
          return send(res, 403, { error: "only the coin's creator can set its profile" }, origin);
        // Convert/downscale server-side so ANY format works (incl. iPhone HEIC that phones
        // can't process). These awaits happen before the sync db transaction below.
        const pfpRaw = body.pfp ? parseUpload(body.pfp) : null;
        const bannerRaw = body.banner ? parseUpload(body.banner) : null;
        const pfp = pfpRaw ? await withTimeout(normalizeImage(pfpRaw.buf, pfpRaw.mime, CFG.profilePfpDim), CFG.profileDecodeTimeoutMs, "image processing") : null;
        const banner = bannerRaw ? await withTimeout(normalizeImage(bannerRaw.buf, bannerRaw.mime, CFG.profileBannerDim), CFG.profileDecodeTimeoutMs, "image processing") : null;
        const fields = {
          token,
          description: String(body.description || "").slice(0, 280),
          telegram: String(body.telegram || "").slice(0, 200),
          twitter: String(body.twitter || "").slice(0, 200),
          website: String(body.website || "").slice(0, 200),
          migrated_from: String(body.migratedFrom || "").trim().slice(0, 120),
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
    // The token list is reachable at BOTH /api/tokenlist.json and the clean /tokenlist.json; the clean
    // path must get the SAME rate-limit + cache as the /api/ twin, or it becomes an uncapped, uncached
    // event-loop DoS (a full 10k-row join + 10k keccak checksums per hit). Treat it as an api path here.
    const isApiPath = path.startsWith("/api/") || path === "/tokenlist.json";
    if (isApiPath && !apiGetRateOk(clientIp(req))) return send(res, 429, { error: "rate limited — slow down" }, origin);

    // Micro-cache for GET api paths (not /media, not /health). On a hit, serve the stored
    // bytes from RAM; on a miss, transparently capture this response into the cache.
    if (CACHE_TTL_MS > 0 && isApiPath) {
      // Key by host too: responses embed absolute media URLs built from the request host
      // (base), so a body cached for one host must not be served to a different one.
      const key = base + "\n" + path + url.search;
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
        const { coins: c, trades: t } = healthCounts();   // cached ~5s so a health-check burst can't scan-per-request
        const cur = db.prepare("SELECT v FROM meta WHERE k='cursor'").get();
        // `img` proves this build has the image-conversion toolchain loaded (HEIC etc.) —
        // a quick way to confirm a redeploy actually took and the deps installed.
        return send(res, 200, { ok: true, head: getHead(), cursor: cur ? Number(cur.v) : null, coins: c, trades: t, img: !!(_sharp && _heic) }, origin);
      }

      // Whether the photo-to-meme generator is configured — the create page shows its button only if so.
      if (path === "/api/meme/enabled") return send(res, 200, { enabled: memeEnabled() }, origin);
      // Tier names and their credit cost only — never the model or the provider behind them.
      if (path === "/api/chat/enabled") return send(res, 200, { enabled: Chat.enabled(), docs: Chat.enabled() ? Chat.docsLoaded() : false }, origin);
      if (path === "/api/art/enabled") {
        return send(res, 200, {
          enabled: artEnabled(),
          tiers: artEnabled() ? artTiers() : [],
          styles: artEnabled() ? artStyles() : [],
          // The client needs to know whether to ask for a signature at all, and where the ledger is.
          // The model behind each tier is still never named.
          paid: Credits.enabled(),
          creditsContract: Credits.enabled() ? CFG.artCredits : null,
        }, origin);
      }
      // How many credits this wallet can actually spend right now — on-chain balance minus anything
      // already reserved by a generation still running.
      if (path === "/api/art/credits") {
        const who = url.searchParams.get("user") || "";
        if (!Credits.enabled()) return send(res, 200, { paid: false, credits: null }, origin);
        if (!/^0x[0-9a-fA-F]{40}$/.test(who)) return send(res, 400, { error: "bad user" }, origin);
        try { return send(res, 200, { paid: true, credits: await Credits.available(who) }, origin); }
        catch { return send(res, 502, { error: "could not read credits" }, origin); }
      }

      // ── DexScreener logo proxy for migrate-in: GET /api/img?u=<dexscreener image url> ──
      // DexScreener's image CDN sends no CORS header, so the browser can't fetch a migrating coin's
      // existing logo directly. We fetch it server-side (SSRF-guarded to DexScreener CDNs only, image
      // content-type + size capped) and return it with CORS, so the create page can import the logo.
      if (path === "/api/img") {
        if (!mediaRateOk(clientIp(req))) return send(res, 429, { error: "rate limited" }, origin);
        let u; try { u = new URL(url.searchParams.get("u") || ""); } catch { return send(res, 400, { error: "bad url" }, origin); }
        const ALLOWED = new Set(["cdn.dexscreener.com", "dd.dexscreener.com", "media.dexscreener.com", "dexscreener.com"]);
        if (u.protocol !== "https:" || !ALLOWED.has(u.hostname)) return send(res, 400, { error: "host not allowed" }, origin);
        try {
          // redirect: "manual" — the host allowlist above only vetted the INITIAL url. Following a 3xx
          // would let an allowlisted (or open-redirecting) host bounce us to an arbitrary internal host
          // (SSRF). Refuse redirects: a 3xx surfaces as !up.ok below and returns 502.
          const up = await fetch(u.toString(), { signal: AbortSignal.timeout(8000), headers: { accept: "image/*" }, redirect: "manual" });
          if (!up.ok) return send(res, 502, { error: "upstream " + up.status }, origin);
          const ct = up.headers.get("content-type") || "";
          if (!/^image\//.test(ct)) return send(res, 415, { error: "not an image" }, origin);
          const buf = Buffer.from(await up.arrayBuffer());
          if (buf.length > 3 * 1024 * 1024) return send(res, 413, { error: "too large" }, origin);
          res.writeHead(200, { "content-type": ct, "access-control-allow-origin": origin, "cache-control": "public, max-age=86400" });
          return res.end(buf);
        } catch { return send(res, 502, { error: "fetch failed" }, origin); }
      }

      // A maker's open limit/DCA orders (for the portfolio's Automations panel).
      const ordersMatch = path.match(/^\/api\/orders\/(0x[0-9a-fA-F]{40})$/);
      if (ordersMatch) {
        if (!ordersEnabled()) return send(res, 200, { orders: [] }, origin);
        return send(res, 200, { orders: ordersForMaker(ordersMatch[1], now) }, origin);
      }

      if (path === "/api/stats") {
        const s = statsStmt.get({ since });
        return send(res, 200, {
          coins: s.coins, graduated: s.graduated,
          tradesAll: s.trades_all, trades24h: s.trades_24h,
          volAllEth: s.vol_all, vol24hEth: s.vol_24h,
        }, origin);
      }

      // Uniswap-standard token list of every launched coin (self-hosted, no third-party gatekeeper).
      // Served at both /api/tokenlist.json (cached) and /tokenlist.json (clean URL).
      if (path === "/api/tokenlist.json" || path === "/tokenlist.json") {
        const rows = tokenListStmt.all();
        const tokens = [];
        for (const r of rows) {
          let addr; try { addr = ethers.getAddress(r.token); } catch { continue; } // valid, checksummed
          // Uniswap list schema: symbol ^[a-zA-Z0-9+\-%/$.]+$ (<=20), name (<=40, DIFFERENT charset - no '$').
          const nameChars = (s) => String(s || "").replace(/[^ \w.'+\-%/&()\[\]]/g, "").trim().slice(0, 40);
          const symbol = String(r.symbol || "").replace(/[^a-zA-Z0-9+\-%/$.]/g, "").slice(0, 20) || "TOKEN";
          // The name FALLBACK must be sanitized against the NAME charset too: falling back to the raw symbol
          // could put a '$' (legal in a symbol, illegal in a name) into `name`, which fails schema validation
          // for the WHOLE list and makes strict consumers drop every token.
          const name = nameChars(r.name) || nameChars(symbol) || "Token";
          const t = { chainId: CFG.chainId, address: addr, name, symbol, decimals: 18 };
          if (r.has_pfp) t.logoURI = `${base}/media/${r.token}/pfp?v=${r.meta_ts || 0}`;
          tokens.push(t);
        }
        // The Uniswap list schema requires tokens.minItems >= 1; serving an empty list (fresh DB / a
        // not-yet-indexed replica) is schema-INVALID and a strict consumer caches a hard failure. 503 until ready.
        if (tokens.length === 0) return send(res, 503, { error: "token list not ready" }, origin);
        // MONOTONIC patch = the newest coin_meta.updated_ts (only ever increases as metadata is edited), so a
        // logo/name edit yields a strictly HIGHER version and version-gating consumers apply it. A non-monotonic
        // hash would drop ~half of edits (Uniswap's getVersionUpgrade needs patch strictly greater).
        let _patch = 0;
        for (const r of rows) { const t = Number(r.meta_ts) || 0; if (t > _patch) _patch = t; }
        return send(res, 200, {
          name: "Robin Labs",
          timestamp: new Date().toISOString(),
          // Token-list semver: additions bump MINOR (major is reserved for removals / breaking changes),
          // PATCH is the newest metadata-edit timestamp so a metadata-only change is still a strictly higher version.
          version: { major: 1, minor: tokens.length, patch: _patch },
          logoURI: "https://robinlab.io/assets/favicon-512.png",
          keywords: ["robinlabs", "robinhood chain", "memecoin", "launchpad"],
          tokens,
        }, origin);
      }

      if (path === "/api/series") {
        const days = intParam(url.searchParams.get("days"), 30, 1, 180);
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
        const limit = intParam(url.searchParams.get("limit"), 60, 1, 200);
        const offset = intParam(url.searchParams.get("offset"), 0, 0, 1e9);
        const params = { since, limit, offset, q: qRaw ? `%${qRaw}%` : "%" };
        const rows = coinsStmt(sort, filter, !!qRaw).all(params);
        const total = coinsCountStmt(filter, !!qRaw).get(params).n; // full match count for {coins,total} contract
        return send(res, 200, { coins: rows.map((r) => shapeCoin(r, base)), total, sort, filter, limit, offset }, origin);
      }

      // Serve a coin's image bytes (pfp | banner). Cacheable; ?v=updatedTs busts the cache. Per-IP rate
      // limited + a small origin LRU so a flood on one image can't hammer synchronous SQLite blob reads
      // (each read is up to ~800KB on the single event-loop thread) when no CDN is in front.
      let m = path.match(/^\/media\/(0x[0-9a-fA-F]{40})\/(pfp|banner)$/);
      if (m) {
        if (!mediaRateOk(clientIp(req))) return send(res, 429, { error: "rate limited" }, origin);
        const token = m[1].toLowerCase();
        const ckey = token + ":" + m[2] + ":" + (url.searchParams.get("v") || "");
        let hit = MEDIA_CACHE.get(ckey);
        if (!hit) {
          const row = m[2] === "pfp" ? getCoinPfp.get(token) : getCoinBanner.get(token);
          if (!row || !row.blob) return send(res, 404, { error: "no image" }, origin);
          hit = { blob: row.blob, mime: row.mime };
          if (MEDIA_CACHE.size > 200) MEDIA_CACHE.clear(); // bounded LRU-ish; images are small + immutable per ?v
          MEDIA_CACHE.set(ckey, hit);
        }
        return sendMedia(res, hit.blob, hit.mime, origin);
      }

      // ── social share card image: GET /og/:token.png ──────────────────────────
      // A per-coin Open Graph / Twitter card (pfp + name + live stats), so a shared coin
      // link unfurls as a product instead of the one generic site image. Rate-limited +
      // memory-cached (render is CPU work on the loop). Falls back to the coin's own pfp,
      // then a 404, so a render hiccup never hard-fails the unfurl.
      m = path.match(/^\/og\/(0x[0-9a-fA-F]{40})\.png$/);
      if (m) {
        if (!mediaRateOk(clientIp(req))) return send(res, 429, { error: "rate limited" }, origin);
        const token = m[1].toLowerCase();
        const ck = "og:" + token;
        let hit = OG_CACHE.get(ck);
        if (!hit || hit.exp < Date.now()) {
          const r = oneCoinStmt.get({ token, since });
          if (!r) return send(res, 404, { error: "no coin" }, origin);
          try {
            const png = await renderCard(shapeCoin(r, base), getCoinPfp.get(token));
            if (OG_CACHE.size > 500) OG_CACHE.clear();
            hit = { blob: png, exp: Date.now() + OG_TTL_MS };
            OG_CACHE.set(ck, hit);
          } catch {
            const pf = getCoinPfp.get(token); // degrade to the raw pfp if compositing failed
            if (pf && pf.blob) return sendMedia(res, pf.blob, pf.mime, origin);
            return send(res, 404, { error: "card unavailable" }, origin);
          }
        }
        return sendMedia(res, hit.blob, "image/png", origin);
      }

      // ── share landing: GET /coin/:token (and /og/:token) ─────────────────────
      // Tiny HTML doc carrying THIS coin's real og:/twitter: tags for crawlers, then it
      // bounces a human to the pad coin page. Share buttons point here so a link finally
      // unfurls with the coin's own card. Unknown coins still resolve (generic image).
      m = path.match(/^\/(?:coin|og)\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        if (!mediaRateOk(clientIp(req))) return send(res, 429, { error: "rate limited" }, origin);
        const token = m[1].toLowerCase();
        const r = oneCoinStmt.get({ token, since });
        const coin = r ? shapeCoin(r, base) : { token, name: "Coin", symbol: "", graduated: false };
        const img = r ? `${base}/og/${token}.png` : `${CFG.siteBase}/assets/og.jpg`;
        const body = coinOgHtml(coin, img, CFG.siteBase);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=120",
        });
        return res.end(body);
      }

      // A coin's profile (creator-set metadata + image URLs). `profile` is null until set.
      m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/meta$/);
      if (m) {
        const token = m[1].toLowerCase();
        return send(res, 200, { token, profile: profileOf(token, getCoinMetaLite.get(token), base) }, origin);
      }

      // A coin's dev lock (creator dev-bag vesting) for the fast badge. `hasLock:false` = indexed, no lock.
      // Vested is computed with the SAME floor formula as the contract so the numbers match on-chain.
      m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/devlock$/);
      if (m) {
        const token = m[1].toLowerCase();
        const dev = coinDev.get(token)?.dev || null;
        const rows = devLocksForToken.all(token).filter((r) => !dev || r.beneficiary === dev);
        if (!rows.length) return send(res, 200, { token, hasLock: false }, origin);
        let locked = 0n, releasable = 0n, total = 0n, end = 0;
        for (const r of rows) {
          const T = BigInt(r.total); total += T;
          const vested = now < r.cliff ? 0n
            : now >= r.start + r.duration ? T
            : (T * BigInt(now - r.start)) / BigInt(r.duration || 1);
          locked += T - vested;
          releasable += vested; // CUMULATIVE vested — the indexer doesn't track on-chain `released`
          end = Math.max(end, r.start + r.duration);
        }
        const lockedPct = total > 0n ? Number((locked * 10000n) / total) : 0;
        return send(res, 200, {
          token, hasLock: true, ids: rows.map((r) => r.id),
          // `vestedWei` is CUMULATIVE vested (honest — we don't index Released). The client derives the
          // exact still-claimable amount on-chain (vested − released). `lockedWei`/`lockedPct` are exact.
          totalWei: total.toString(), lockedWei: locked.toString(), vestedWei: releasable.toString(),
          lockedPct, end,
        }, origin);
      }

      m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const r = oneCoinStmt.get({ token: m[1].toLowerCase(), since });
        if (!r) return send(res, 404, { error: "not found" }, origin);
        return send(res, 200, { coin: shapeCoin(r, base) }, origin);
      }

      // ── per-coin website: slug availability check (form live feedback) ───────
      // MUST be matched before /api/site/:slug (else "available" looks like a slug).
      m = path.match(/^\/api\/site\/available\/([a-z0-9-]{1,40})$/i);
      if (m) {
        const chk = checkSlug(m[1]);
        if (!chk.ok) return send(res, 200, { slug: normalizeSlug(m[1]), available: false, reason: chk.reason }, origin);
        const owner = slugOwnerToken.get(chk.slug);
        const token = (url.searchParams.get("token") || "").toLowerCase();
        // "available" = free, OR already owned by the coin doing the asking (so a
        // creator re-saving their own site doesn't see their slug as taken).
        const free = !owner || owner.token.toLowerCase() === token;
        return send(res, 200, {
          slug: chk.slug, available: free, reason: free ? null : "taken",
          url: `https://${chk.slug}.robinlabs.fun`,
        }, origin);
      }

      // ── per-coin website: resolve slug → coin + chosen style ────────────────
      // The wildcard serving layer (site.html on <slug>.robinlabs.fun) calls this.
      m = path.match(/^\/api\/site\/([a-z0-9-]{1,40})$/i);
      if (m) {
        const slug = normalizeSlug(m[1]);
        if (isTakenDown(slug)) return send(res, 410, { error: "this site has been removed" }, origin);
        const row = getSiteBySlug.get(slug);
        if (!row || !row.site_style) return send(res, 404, { error: "no site here" }, origin);
        const r = oneCoinStmt.get({ token: String(row.token).toLowerCase(), since });
        if (!r) return send(res, 404, { error: "no site here" }, origin);
        return send(res, 200, {
          slug, style: isValidStyle(row.site_style) ? row.site_style : "neonvault",
          coin: shapeCoin(r, base),
        }, origin);
      }

      // Global recent activity across all coins — powers the homepage live ticker.
      if (path === "/api/activity") {
        const limit = intParam(url.searchParams.get("limit"), 30, 1, 100);
        const rows = recentActivityStmt.all(limit).map((t) => ({
          token: t.token, side: t.side, sym: t.symbol, name: t.name,
          eth: t.eth, tokens: t.tokens, ts: t.ts,
        }));
        return send(res, 200, { activity: rows }, origin);
      }

      m = path.match(/^\/api\/trades\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const limit = intParam(url.searchParams.get("limit"), 50, 1, 500);
        const rows = tradesStmt.all(m[1].toLowerCase(), limit).map((t) => ({
          tx: t.tx, logIndex: t.log_index, side: t.side, actor: t.actor,
          eth: t.eth, tokens: t.tokens, fee: t.fee, block: t.block, ts: t.ts,
        }));
        return send(res, 200, { trades: rows }, origin);
      }

      // A wallet's holdings — coins it launched or traded, with an approximate balance
      // and enough coin metadata to render a card. Derived from curve activity (see
      // db.js): the client can refine each `balance` with a live balanceOf. `approx` flags
      // that these are curve-derived, not a full ERC20-transfer ledger.
      m = path.match(/^\/api\/holdings\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const rows = holdingsByActor.all({ a: m[1].toLowerCase() });
        const coins = rows.map((r) => ({
          token: r.token, curve: r.curve, pool: r.pool, dev: r.dev,
          name: r.name, symbol: r.symbol, graduated: !!r.graduated,
          mcapEth: r.mcap_eth ?? null, progress: r.progress ?? null, launchTs: r.launch_ts ?? null,
          image: r.has_pfp ? `${base}/media/${r.token}/pfp?v=${r.meta_ts}` : null,
          balance: r.bal_wei / 1e18,          // whole tokens (approx)
          isDev: String(r.dev).toLowerCase() === m[1].toLowerCase(),
        }));
        return send(res, 200, { holder: m[1].toLowerCase(), approx: true, count: coins.length, coins }, origin);
      }

      // A coin's holders (top N + count), from curve activity. dev_bought is credited to
      // the creator. Same approximation caveat as /api/holdings.
      m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})\/holders$/);
      if (m) {
        const token = m[1].toLowerCase();
        const limit = intParam(url.searchParams.get("limit"), 20, 1, 200);
        const dev = coinDev.get(token);
        const devBoughtTokens = dev ? Number((db.prepare("SELECT dev_bought AS d FROM coins WHERE token=?").get(token) || {}).d || 0) / 1e18 : 0;
        const map = new Map();
        for (const r of holdersByToken.all({ t: token })) map.set(r.holder, (r.net_wei || 0) / 1e18);
        if (dev) map.set(dev.dev, (map.get(dev.dev) || 0) + devBoughtTokens); // credit the launch allocation
        const all = [...map.entries()].map(([holder, balance]) => ({ holder, balance })).filter((h) => h.balance > 1e-6).sort((a, b) => b.balance - a.balance);
        return send(res, 200, { token, approx: true, holders: all.length, top: all.slice(0, limit) }, origin);
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
        const bySide = rewardClaimsBySideStmt.get();
        return send(res, 200, {
          accruedEth: accrued.eth, coinsWithRewards: accrued.coins,
          epochsPosted: roots.posted, allocatedEth: claims.eth, leaves: claims.n,
          // Names the rewards page's totals strip reads (global protocol totals):
          paidEth: claims.eth, claimants: bySide.claimants, tradersEth: bySide.traders, holdersEth: bySide.holders,
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
          .filter((c) => {
            const r = getRewardRoot.get(c.epoch) || {};
            if (!r.posted_tx) return false;                         // root not on-chain yet
            if (r.posted_ts == null) return true;                   // posted but un-stamped (legacy) — best effort
            return now >= r.posted_ts + CFG.challengeWindow;        // claims only open AFTER the challenge window (contract reverts otherwise)
          })
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
