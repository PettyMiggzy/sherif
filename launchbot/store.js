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

fs.mkdirSync(DATA_DIR, { recursive: true });

// scrypt is deliberately slow; cache derived keys per salt so signing stays snappy.
const _keyCache = new Map();
function deriveKey(saltHex) {
  let k = _keyCache.get(saltHex);
  if (!k) {
    k = crypto.scryptSync(CFG.masterSecret, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    _keyCache.set(saltHex, k);
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
  return { salt: salt.toString('hex'), iv: iv.toString('hex'), tag: tag.toString('hex'), ct: ct.toString('hex') };
}

function decrypt(rec) {
  const key = deriveKey(rec.salt);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'hex')), d.final()]).toString('utf8');
}

// ── persistence (atomic write) ───────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { users: {} }; }
}
let db = load();
let saveTimer = null;
function persist() {
  // debounce bursty writes; always flush atomically via a temp file + rename.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
      fs.renameSync(tmp, FILE);
      fs.chmodSync(FILE, 0o600);
    } catch (e) { console.error('wallet persist failed:', e.message); }
  }, 250);
}

// ── public API ───────────────────────────────────────────────────────────────

/** Whether a Telegram user already has a wallet. */
export function has(userId) { return !!db.users[String(userId)]; }

/** Create a wallet for a user if absent; return its public address. Idempotent. */
export function ensureWallet(userId) {
  const id = String(userId);
  if (!db.users[id]) {
    const w = ethers.Wallet.createRandom();
    db.users[id] = { address: w.address, enc: encrypt(w.privateKey), createdTs: nowSecs() };
    persist();
  }
  return db.users[id].address;
}

/** A user's deposit/public address, or null. */
export function addressOf(userId) { return db.users[String(userId)]?.address || null; }

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
  if (!db.users[id]) return false;
  delete db.users[id];
  persist();
  sessions.delete(id);
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

function nowSecs() { return Math.floor(Date.now() / 1000); }
