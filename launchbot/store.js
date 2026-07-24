// ─────────────────────────────────────────────────────────────────────────────
// Custodial wallet store
//
// One wallet per Telegram user. Private keys are encrypted AT REST with
// AES-256-GCM under a key derived (scrypt) from MASTER_SECRET + a per-user salt.
// Plaintext keys live only in memory for the moment a tx is signed, and are
// NEVER logged or persisted.
//
// This is real custody: if MASTER_SECRET leaks, every key is exposed; if it is
// lost, every wallet is unrecoverable. Keep it in .env, off the repo, backed up.
//
// Data minimization (Telegram ToS §4.3): we store only the Telegram user id, the
// encrypted key + address, and a tiny session for multi-step flows. `forget()`
// deletes a user's record entirely (§4.2).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { CFG } from './config.js';

const DATA_DIR = path.resolve(CFG.dataDir);
const FILE = path.join(DATA_DIR, 'wallets.json');

// 0700 dir so other local accounts can't traverse to the keystore.
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* best effort */ }

// scrypt cost. Raised from N=2^14 to 2^16 to make an offline brute force of a
// leaked keystore materially harder; maxmem must clear ~128*N*r bytes. The
// params are stored per-record so they can change without breaking old wallets.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };

// scrypt is deliberately slow; cache derived keys per (salt+params) so signing
// stays snappy (one derivation per user per process).
const _keyCache = new Map();
function cacheKey(salt, N, r, p) { return `${salt}:${N}:${r}:${p}`; }
function deriveKey(saltHex, N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p) {
  const ck = cacheKey(saltHex, N, r, p);
  let k = _keyCache.get(ck);
  if (!k) {
    k = crypto.scryptSync(CFG.masterSecret, Buffer.from(saltHex, 'hex'), 32, { N, r, p, maxmem: SCRYPT.maxmem });
    _keyCache.set(ck, k);
  }
  return k;
}

function encrypt(plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(salt.toString('hex'));
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return {
    v: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: tag.toString('hex'), ct: ct.toString('hex'),
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  };
}

function decrypt(rec) {
  // Fall back to the legacy params for any record written before they were stored.
  const key = deriveKey(rec.salt, rec.N || 16384, rec.r || 8, rec.p || 1);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'hex')), d.final()]).toString('utf8');
}

// ── persistence ──────────────────────────────────────────────────────────────
// A custodial key MUST reach disk before its address is handed out, so key
// creation and erasure persist SYNCHRONOUSLY and durably (fsync + atomic
// rename). Only low-stakes updates (noteCoin) use the debounced path.
function load() {
  // Distinguish "file absent" (fresh install → empty db is correct) from "file
  // present but unparseable" (corruption → we must NOT silently start empty and
  // then overwrite every real wallet). On corruption, preserve the bad file and
  // fail loud.
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { users: {} };
    throw e; // permissions/IO error — don't proceed blind
  }
  try {
    const db = JSON.parse(raw);
    if (!db || typeof db !== 'object' || Array.isArray(db)
      || db.users === null || typeof db.users !== 'object' || Array.isArray(db.users)) throw new Error('bad shape');
    return db;
  } catch (e) {
    const bak = `${FILE}.corrupt-${nowSecs()}`;
    try { fs.renameSync(FILE, bak); } catch { /* keep original if rename fails */ }
    console.error(`FATAL: ${FILE} is unreadable/corrupt (kept at ${bak}). Refusing to start empty and wipe wallets.`);
    process.exit(1);
  }
}
let db = load();
let saveTimer = null;

function writeDurable(data) {
  const tmp = FILE + '.tmp';
  const buf = Buffer.from(data, 'utf8');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    // writeSync can short-write (interrupt / near-full disk) — loop until the
    // whole buffer is on the fd, or the keystore would be silently truncated.
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, FILE);
  // fsync the directory so the rename itself is durable across a power loss.
  try { const dfd = fs.openSync(DATA_DIR, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* dir fsync unsupported */ }
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

/** Write NOW, durably. Throws on failure — critical writes must fail loud. */
function persistSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeDurable(JSON.stringify(db));
}

/** Debounced durable write for low-stakes updates. Errors are logged, not thrown. */
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeDurable(JSON.stringify(db)); } catch (e) { console.error('wallet persist failed:', e.message); }
  }, 250);
}

/** Flush any pending write synchronously — call from shutdown handlers. */
export function flushSync() {
  try { persistSync(); } catch (e) { console.error('flush failed:', e.message); }
}

// ── public API ───────────────────────────────────────────────────────────────

/** Whether a Telegram user already has a wallet. */
export function has(userId) { return !!db.users[String(userId)]; }

/**
 * Create a wallet for a user if absent; return its public address. Idempotent.
 * The new key is persisted SYNCHRONOUSLY and durably before the address is
 * returned — so we never reveal a deposit address whose key isn't safely on
 * disk. If the write fails we roll back and throw, rather than hand out an
 * unbacked address (which would make any deposit unrecoverable).
 */
export function ensureWallet(userId) {
  const id = String(userId);
  if (!db.users[id]) {
    const w = ethers.Wallet.createRandom();
    const enc = encrypt(w.privateKey);
    db.users[id] = { address: w.address, enc, createdTs: nowSecs() };
    try {
      persistSync();
    } catch (e) {
      delete db.users[id]; // don't keep an in-memory-only wallet
      _keyCache.delete(cacheKey(enc.salt, enc.N, enc.r, enc.p)); // and don't leave its derived key behind
      throw new Error('could not save your wallet — try again in a moment');
    }
  }
  return db.users[id].address;
}

/** A user's deposit/public address, or null. */
export function addressOf(userId) { return db.users[String(userId)]?.address || null; }

/** Whether a user has accepted the terms/age/jurisdiction gate. */
export function hasAgreed(userId) { return !!db.users[String(userId)]?.agreed; }

/** Record acceptance of the terms gate (durably). Creates no wallet on its own. */
export function markAgreed(userId) {
  const r = db.users[String(userId)];
  if (r && !r.agreed) { r.agreed = nowSecs(); try { persistSync(); } catch (e) { console.error('agree persist:', e.message); } }
}

/** Per-user cooldown (in-memory). cooldownLeft peeks; stampCooldown starts it. */
const _cooldowns = new Map();
export function cooldownLeft(userId, action) {
  const until = _cooldowns.get(`${userId}:${action}`) || 0;
  const now = Date.now();
  return now < until ? Math.ceil((until - now) / 1000) : 0;
}
export function stampCooldown(userId, action, secs) {
  _cooldowns.set(`${userId}:${action}`, Date.now() + secs * 1000);
}

/** An ethers Wallet connected to `provider`, for signing. Throws if no wallet. */
export function signer(userId, provider) {
  const rec = db.users[String(userId)];
  if (!rec) throw new Error('no wallet — send /start first');
  const pk = decrypt(rec.enc);
  return new ethers.Wallet(pk, provider);
}

/** Record a launched token under the user (for /mycoins). Best-effort. */
export function noteCoin(userId, token, symbol) {
  const rec = db.users[String(userId)];
  if (!rec) return;
  rec.coins = rec.coins || [];
  if (!rec.coins.find((c) => c.token.toLowerCase() === token.toLowerCase())) {
    rec.coins.push({ token, symbol, ts: nowSecs() });
    if (rec.coins.length > 200) rec.coins = rec.coins.slice(-200);
    persist();
  }
}

/** A user's launched coins (newest first). */
export function coinsOf(userId) {
  return (db.users[String(userId)]?.coins || []).slice().reverse();
}

/** Delete every trace of a user (Telegram ToS §4.2 right-to-erasure). */
export function forget(userId) {
  const id = String(userId);
  const rec = db.users[id];
  if (!rec) return false;
  // Evict the derived AES key from the cache too, so nothing about this user
  // lingers in memory after erasure.
  if (rec.enc) _keyCache.delete(cacheKey(rec.enc.salt, rec.enc.N || 16384, rec.enc.r || 8, rec.enc.p || 1));
  delete db.users[id];
  sessions.delete(id);
  // Let a write failure propagate — the caller must NOT tell the user "erased"
  // if the record is still on disk (it would resurrect on restart).
  persistSync();
  return true;
}

/** Total wallets under custody (admin stat). */
export function userCount() { return Object.keys(db.users).length; }

// ── ephemeral per-user session for multi-step flows (in-memory only) ─────────
const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

export function getSession(userId) {
  const id = String(userId);
  const s = sessions.get(id);
  if (s && Date.now() - s._t > SESSION_TTL_MS) { sessions.delete(id); return null; }
  return s || null;
}
export function setSession(userId, data) {
  sessions.set(String(userId), { ...data, _t: Date.now() });
}
export function clearSession(userId) { sessions.delete(String(userId)); }

/** Drop expired wizard sessions (abandoned /launch flows). Call periodically. */
export function sweepSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s._t > SESSION_TTL_MS) sessions.delete(id);
}

function nowSecs() { return Math.floor(Date.now() / 1000); }
