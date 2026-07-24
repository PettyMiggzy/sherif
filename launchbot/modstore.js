// ─────────────────────────────────────────────────────────────────────────────
// Moderation state store
//
// Per-group moderation data: settings, per-user warn counts, rules text, and
// pending-captcha state. Deliberately SEPARATE from the custodial wallet store
// (store.js) so the moderation feature shares zero code with — and can never
// read or corrupt — the encrypted keystore. This file holds NO secrets, so it
// uses a plain debounced JSON write (atomic rename), not the fsync-durable path
// the keystore needs.
//
// Data model (data/moderation.json):
//   { chats: { "<chatId>": {
//       settings: { captcha, antilink, antiflood, warnLimit, muteMins, rules },
//       warns:    { "<userId>": <count> },
//       lockdown: <bool>,
//   } } }
// Ephemeral state (pending captchas, flood counters, admin cache, join-rate) is
// in-memory only — it must not survive a restart.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.js';

const DATA_DIR = path.resolve(CFG.dataDir);
const FILE = path.join(DATA_DIR, 'moderation.json');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// Defaults for a group the bot has never seen. Every group starts with sane,
// non-destructive settings: filters ON but low-impact (delete+warn, not ban).
export const DEFAULTS = Object.freeze({
  captcha: true,        // new members must tap "I'm human" or get removed
  antilink: true,       // delete links/@invite spam from non-admins
  antiflood: true,      // mute a user who floods the chat
  warnLimit: 3,         // warns before an auto-mute
  muteMins: 60,         // default mute length (minutes) for warn-limit / flood
  rules: '',            // /rules text (operator sets via /setrules)
});

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { chats: {} }; throw e; }
  try {
    const db = JSON.parse(raw);
    if (!db || typeof db !== 'object' || Array.isArray(db) || typeof db.chats !== 'object' || db.chats === null || Array.isArray(db.chats)) throw new Error('bad shape');
    return db;
  } catch (e) {
    // Non-secret data: on corruption, preserve the bad file and start empty
    // rather than crash the whole bot (which also serves wallets). Groups just
    // fall back to DEFAULTS until re-configured.
    const bak = `${FILE}.corrupt-${Math.floor(Date.now() / 1000)}`;
    try { fs.renameSync(FILE, bak); } catch { /* keep original */ }
    console.error(`moderation.json unreadable (kept at ${bak}); starting with empty moderation state.`);
    return { chats: {} };
  }
}

let db = load();
let timer = null;

function writeDurable(data) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { writeDurable(JSON.stringify(db)); } catch (e) { console.error('moderation persist failed:', e.message); }
  }, 300);
}
export function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { writeDurable(JSON.stringify(db)); } catch (e) { console.error('moderation flush failed:', e.message); }
}

function chat(chatId) {
  const id = String(chatId);
  if (!db.chats[id]) db.chats[id] = { settings: { ...DEFAULTS }, warns: {}, lockdown: false };
  const c = db.chats[id];
  // Backfill any keys added in a later version so old records get new defaults.
  c.settings = { ...DEFAULTS, ...(c.settings || {}) };
  if (!c.warns || typeof c.warns !== 'object') c.warns = {};
  return c;
}

// ── settings ─────────────────────────────────────────────────────────────────
export function settings(chatId) { return { ...chat(chatId).settings }; }
export function setSetting(chatId, key, value) {
  if (!(key in DEFAULTS)) return false;
  chat(chatId).settings[key] = value;
  persist();
  return true;
}
export function rules(chatId) { return chat(chatId).settings.rules || ''; }
export function setRules(chatId, text) { chat(chatId).settings.rules = String(text || '').slice(0, 4000); persist(); }

export function isLockdown(chatId) { return !!chat(chatId).lockdown; }
export function setLockdown(chatId, on) { chat(chatId).lockdown = !!on; persist(); }

// ── warns (persisted, per chat+user) ─────────────────────────────────────────
export function warnCount(chatId, userId) { return chat(chatId).warns[String(userId)] || 0; }
export function addWarn(chatId, userId) {
  const c = chat(chatId);
  const n = (c.warns[String(userId)] || 0) + 1;
  c.warns[String(userId)] = n;
  persist();
  return n;
}
export function removeWarn(chatId, userId) {
  const c = chat(chatId);
  const n = Math.max(0, (c.warns[String(userId)] || 0) - 1);
  if (n === 0) delete c.warns[String(userId)];
  else c.warns[String(userId)] = n;
  persist();
  return n;
}
export function resetWarns(chatId, userId) {
  const c = chat(chatId);
  if (c.warns[String(userId)]) { delete c.warns[String(userId)]; persist(); }
}
