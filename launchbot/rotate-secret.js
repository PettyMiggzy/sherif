// ─────────────────────────────────────────────────────────────────────────────
// MASTER_SECRET rotation (re-encryption migration)
//
// Every custodial key is encrypted AES-256-GCM under scrypt(MASTER_SECRET, salt).
// So you CANNOT rotate MASTER_SECRET by editing .env and restarting: the new
// secret derives different AES keys, every GCM auth tag fails, and every user is
// locked out of their own wallet.
//
// This tool does it correctly: it decrypts each record with the OLD secret and
// re-encrypts it with the NEW one (fresh salt/iv, current scrypt params), all or
// nothing, after verifying every record round-trips. The private keys themselves
// never change — only the secret that protects them.
//
// Usage (run on the host that holds data/wallets.json; keep both secrets in env,
// never on the command line / shell history):
//
//   node rotate-secret.js --gen                 # print a strong new secret
//   node rotate-secret.js --check               # verify the keystore decrypts under the CURRENT secret
//   OLD_MASTER_SECRET=... NEW_MASTER_SECRET=... node rotate-secret.js --dry-run
//   OLD_MASTER_SECRET=... NEW_MASTER_SECRET=... node rotate-secret.js
//   # then set MASTER_SECRET=<new> in .env and restart the bot
//
// OLD_MASTER_SECRET defaults to MASTER_SECRET (the value in .env) if unset, so a
// --check / plain rotation can use the live secret without repeating it.
//
// IMPORTANT: this re-protects the SAME private keys. If both the old secret AND
// the keystore file leaked, the plaintext keys are already exposed — re-encrypting
// does not un-leak them; you must move funds to fresh wallets. Rotation fully
// restores safety only when the keystore itself never left the host.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'; // load launchbot/.env (MASTER_SECRET, DATA_DIR) exactly like the bot does
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';

// Resolves against the bot's own DATA_DIR (from .env) so it targets the SAME keystore the bot uses.
const DATA_DIR = path.resolve((process.env.DATA_DIR || './data').trim());
const FILE = path.join(DATA_DIR, 'wallets.json');

// MUST match store.js exactly.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const MIN_SECRET = 32;

function deriveKey(secret, saltHex, N, r, p) {
  return crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), 32, { N, r, p, maxmem: SCRYPT.maxmem });
}
function encrypt(secret, plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret, salt.toString('hex'), SCRYPT.N, SCRYPT.r, SCRYPT.p);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { v: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'),
    ct: ct.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}
function decrypt(secret, rec) {
  // Legacy fallback for records written before params were stored (store.js does the same).
  const key = deriveKey(secret, rec.salt, rec.N || 16384, rec.r || 8, rec.p || 1);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'hex')), d.final()]).toString('utf8');
}

function writeDurable(file, data) {
  const tmp = file + '.tmp';
  const buf = Buffer.from(data, 'utf8');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const dfd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* dir fsync unsupported */ }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
function loadDb() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') die(`no keystore at ${FILE}`); throw e; }
  const db = JSON.parse(raw);
  if (!db || typeof db.users !== 'object' || Array.isArray(db.users)) die(`bad keystore shape at ${FILE}`);
  return db;
}

const args = new Set(process.argv.slice(2));

// ── --gen: print a strong secret and exit ──
if (args.has('--gen')) {
  console.log(crypto.randomBytes(32).toString('hex'));
  process.exit(0);
}

const OLD = (process.env.OLD_MASTER_SECRET || process.env.MASTER_SECRET || '').trim();
const NEW = (process.env.NEW_MASTER_SECRET || '').trim();
const dryRun = args.has('--dry-run');
const checkOnly = args.has('--check');

if (!OLD) die('set OLD_MASTER_SECRET (or MASTER_SECRET) in the environment');

const db = loadDb();
const ids = Object.keys(db.users);
console.log(`keystore: ${FILE}`);
console.log(`wallets:  ${ids.length}`);

// ── --check: verify every record decrypts under the current secret ──
if (checkOnly) {
  let ok = 0;
  for (const id of ids) {
    const rec = db.users[id];
    if (!rec.enc) { console.log(`  user ${id}: no key (skipped)`); continue; }
    try {
      const pk = decrypt(OLD, rec.enc);
      const addr = new ethers.Wallet(pk).address;
      if (addr.toLowerCase() !== String(rec.address).toLowerCase()) die(`user ${id}: decrypts but address MISMATCH (corrupt record)`);
      ok++;
    } catch { die(`user ${id}: does NOT decrypt under this secret (wrong MASTER_SECRET or corrupt)`); }
  }
  console.log(`OK — all ${ok} wallets decrypt and match their address under the current secret.`);
  process.exit(0);
}

// ── rotate (or dry-run) ──
if (!NEW) die('set NEW_MASTER_SECRET in the environment');
if (NEW.length < MIN_SECRET) die(`NEW_MASTER_SECRET too weak (${NEW.length} chars). Use \`node rotate-secret.js --gen\` (>= ${MIN_SECRET}).`);
if (NEW === OLD) die('NEW_MASTER_SECRET must differ from OLD_MASTER_SECRET');

const next = { ...db, users: {} };
let done = 0;
for (const id of ids) {
  const rec = db.users[id];
  if (!rec.enc) { next.users[id] = rec; continue; } // preserve records that carry no key
  let pk;
  try { pk = decrypt(OLD, rec.enc); }
  catch { die(`user ${id}: does NOT decrypt under OLD_MASTER_SECRET — aborting, nothing written.`); }
  // Prove the decryption is correct BEFORE we trust it: the key must yield the stored address.
  let addr;
  try { addr = new ethers.Wallet(pk).address; } catch { die(`user ${id}: decrypted value is not a valid key — aborting.`); }
  if (addr.toLowerCase() !== String(rec.address).toLowerCase()) die(`user ${id}: address MISMATCH after decrypt — aborting.`);
  // Re-encrypt under NEW and verify the round-trip before accepting it.
  const enc = encrypt(NEW, pk);
  let back;
  try { back = decrypt(NEW, enc); } catch { die(`user ${id}: re-encrypted record failed to decrypt under NEW — aborting.`); }
  if (back !== pk) die(`user ${id}: round-trip mismatch — aborting.`);
  next.users[id] = { ...rec, enc };
  done++;
  console.log(`  user ${id}: ${rec.address} re-encrypted ok`);
  pk = back = null; // drop plaintext references promptly
}

if (dryRun) {
  console.log(`\nDRY RUN: ${done} wallets decrypt under OLD and re-encrypt+verify under NEW. Nothing written.`);
  console.log('Re-run without --dry-run to write, then set MASTER_SECRET to the new value and restart.');
  process.exit(0);
}

// Back up the current keystore durably, then write the rotated one atomically.
const bak = `${FILE}.bak-${Math.floor(Date.now() / 1000)}`;
writeDurable(bak, JSON.stringify(db));
writeDurable(FILE, JSON.stringify(next));
console.log(`\nROTATED ${done} wallets. Backup of the pre-rotation keystore: ${bak}`);
console.log('Now set MASTER_SECRET=<new value> in .env and restart the bot.');
console.log('Verify with:  MASTER_SECRET=<new> node rotate-secret.js --check');
console.log('Once verified and the bot is healthy, delete the .bak file (it is still readable with the OLD secret).');
