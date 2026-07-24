// ─────────────────────────────────────────────────────────────────────────────
// Group moderation — a "Rose"-style admin toolkit for Telegram groups.
//
// This runs in GROUP / SUPERGROUP chats only. It shares NOTHING with the
// custodial wallet code: no imports from store.js, no access to keys, no signing.
// Its blast radius is Telegram admin actions (ban / mute / delete / pin), never
// funds. All actions are best-effort: if the bot lacks admin rights the action
// fails gracefully with a clear message instead of throwing.
//
// Capabilities:
//   • Admin commands: ban/unban/kick, mute/unmute (timed), warn/unwarn/warns,
//     del, purge, pin/unpin, report, lock/unlock, and settings toggles.
//   • Anti-raid: new-member captcha (tap-to-verify or auto-remove) and a
//     join-rate spike detector that auto-locks the group and alerts admins.
//   • Spam control: per-user flood limiter and a link/invite filter for
//     non-admins. Both delete + escalate rather than nuke by default.
//
// Telegram note: to see ordinary messages (for flood/link filtering) the bot
// must be a group ADMIN (admins bypass privacy mode). It needs Ban Users +
// Delete Messages + Pin (optional) admin rights to enforce.
// ─────────────────────────────────────────────────────────────────────────────
import * as mod from './modstore.js';

// Injected from bot.js so we reuse one Telegram client + escaper.
let tg, esc;
export function init(deps) { tg = deps.tg; esc = deps.esc; }

const GROUP_TYPES = new Set(['group', 'supergroup']);
export const isGroup = (chat) => !!chat && GROUP_TYPES.has(chat.type);

// ── tunables (env-overridable) ───────────────────────────────────────────────
const num = (name, def, min, max) => {
  let n = Number(process.env[name]); if (!Number.isFinite(n)) n = def;
  return Math.min(max, Math.max(min, n));
};
const FLOOD_MSGS   = num('FLOOD_MSGS', 6, 3, 30);    // messages…
const FLOOD_SECS   = num('FLOOD_SECS', 7, 2, 60);    // …within this window → mute
const CAPTCHA_SECS = num('CAPTCHA_SECS', 120, 30, 600); // time to tap "I'm human"
const JOIN_BURST   = num('JOIN_BURST', 8, 3, 100);   // joins…
const JOIN_WINDOW  = num('JOIN_WINDOW', 20, 5, 300); // …within this window → auto-lockdown

// ── low-level helpers (never throw; moderation is best-effort) ────────────────
async function call(method, params) {
  try { return await tg(method, params); } catch (e) { return { __err: e?.message || String(e) }; }
}
const nowSecs = () => Math.floor(Date.now() / 1000);
const short = (a) => (a && a.length > 12) ? a.slice(0, 6) + '…' + a.slice(-4) : a;
function mention(user) {
  const name = esc(user.first_name || user.username || String(user.id));
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

// Muted = every send permission off. Unmuted = restore the normal member set.
const MUTED = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false,
};
const UNMUTED = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true,
  can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true,
};

// ── admin cache (60s) ─────────────────────────────────────────────────────────
const _admins = new Map(); // chatId -> { at, ids:Set }
async function adminIds(chatId) {
  const hit = _admins.get(String(chatId));
  if (hit && Date.now() - hit.at < 60_000) return hit.ids;
  const r = await call('getChatAdministrators', { chat_id: chatId });
  const ids = new Set();
  if (Array.isArray(r)) for (const a of r) ids.add(Number(a.user?.id));
  // Only cache a real answer; on error keep any prior set so a transient failure
  // doesn't momentarily treat every admin as a normal user.
  if (Array.isArray(r)) _admins.set(String(chatId), { at: Date.now(), ids });
  return ids.size ? ids : (hit?.ids || ids);
}
async function isAdmin(chatId, userId) {
  if (!userId) return false;
  const ids = await adminIds(chatId);
  return ids.has(Number(userId));
}

// ── target resolution: reply > text_mention entity > numeric id ───────────────
function targetFromMessage(msg, arg) {
  if (msg.reply_to_message?.from) return msg.reply_to_message.from;
  if (Array.isArray(msg.entities)) {
    const e = msg.entities.find((x) => x.type === 'text_mention' && x.user);
    if (e) return e.user;
  }
  const m = (arg || '').trim().match(/^(\d{4,})/); // a raw numeric user id
  if (m) return { id: Number(m[1]), first_name: `user ${m[1]}` };
  return null;
}
// Duration like 10m / 2h / 1d / 30 (bare = minutes). Returns until_date secs, or 0 (permanent).
function parseUntil(tok) {
  if (!tok) return 0;
  const m = String(tok).match(/^(\d{1,7})\s*([mhd]?)$/i);
  if (!m) return null; // signals "not a duration" so callers can treat it as reason text
  const n = Number(m[1]); const unit = (m[2] || 'm').toLowerCase();
  const secs = unit === 'h' ? n * 3600 : unit === 'd' ? n * 86400 : n * 60;
  return secs > 0 ? nowSecs() + Math.min(secs, 366 * 86400) : 0;
}

async function reply(msg, text, extra = {}) {
  return call('sendMessage', {
    chat_id: msg.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_to_message_id: msg.message_id, ...extra,
  });
}
async function say(chatId, text, extra = {}) {
  return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}
// Surface a failed enforcement action honestly (usually "bot isn't admin").
function enforceErr(res) {
  if (!res || !res.__err) return null;
  const e = String(res.__err);
  if (/not enough rights|admin|CHAT_ADMIN_REQUIRED|can't remove|PARTICIPANT/i.test(e))
    return 'I need admin rights here (Ban Users + Delete Messages).';
  return esc(e.slice(0, 140));
}

// ── ephemeral raid/flood/captcha state (in-memory; must not survive restart) ──
const flood = new Map();   // `${chat}:${user}` -> [tsMs,...]
const joins = new Map();   // chatId -> [tsMs,...]
const captcha = new Map(); // `${chat}:${user}` -> { msgId, at }

// ─────────────────────────────────────────────── enforcement primitives ──────
async function doMute(chatId, userId, untilSecs) {
  return call('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: MUTED, ...(untilSecs ? { until_date: untilSecs } : {}) });
}
async function doUnmute(chatId, userId) {
  return call('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: UNMUTED });
}
async function doBan(chatId, userId, untilSecs, revoke) {
  return call('banChatMember', { chat_id: chatId, user_id: userId, ...(untilSecs ? { until_date: untilSecs } : {}), ...(revoke ? { revoke_messages: true } : {}) });
}
async function doUnban(chatId, userId) {
  return call('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true });
}
async function delMsg(chatId, msgId) { return call('deleteMessage', { chat_id: chatId, message_id: msgId }); }

// ─────────────────────────────────────────────────── command handlers ────────
// Each returns after acting. `parts` = args after the command. Admin gate is
// applied by the dispatcher for the admin-only set.

async function cmdBan(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to a user (or pass their numeric id) to ban: <code>/ban</code> (as a reply).');
  if (await isAdmin(msg.chat.id, t.id)) return reply(msg, 'That user is an admin — I won’t ban an admin.');
  const err = enforceErr(await doBan(msg.chat.id, t.id, 0, true));
  if (err) return reply(msg, `❌ ${err}`);
  mod.resetWarns(msg.chat.id, t.id);
  return reply(msg, `🔨 Banned ${mention(t)}.`);
}
async function cmdUnban(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to (or pass the id of) the user to unban.');
  const err = enforceErr(await doUnban(msg.chat.id, t.id));
  if (err) return reply(msg, `❌ ${err}`);
  return reply(msg, `♻️ Unbanned ${mention(t)} — they can rejoin.`);
}
async function cmdKick(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to a user to kick.');
  if (await isAdmin(msg.chat.id, t.id)) return reply(msg, 'That user is an admin — I won’t kick an admin.');
  const err = enforceErr(await doBan(msg.chat.id, t.id, 0, false));
  if (err) return reply(msg, `❌ ${err}`);
  await doUnban(msg.chat.id, t.id); // ban→unban = kick (they may rejoin)
  return reply(msg, `👢 Kicked ${mention(t)}.`);
}
async function cmdMute(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to a user to mute: <code>/mute 2h</code> (optional duration).');
  if (await isAdmin(msg.chat.id, t.id)) return reply(msg, 'That user is an admin — I can’t mute an admin.');
  // First non-target token may be a duration; the rest is a reason.
  const firstTok = msg.reply_to_message ? (parts || '').trim().split(/\s+/)[0] : (parts || '').trim().split(/\s+/).slice(1)[0];
  const until = parseUntil(firstTok);
  const err = enforceErr(await doMute(msg.chat.id, t.id, until === null ? 0 : until));
  if (err) return reply(msg, `❌ ${err}`);
  const how = until ? `until ${new Date(until * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'indefinitely';
  return reply(msg, `🔇 Muted ${mention(t)} ${how}.`);
}
async function cmdUnmute(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to a user to unmute.');
  const err = enforceErr(await doUnmute(msg.chat.id, t.id));
  if (err) return reply(msg, `❌ ${err}`);
  return reply(msg, `🔊 Unmuted ${mention(t)}.`);
}
async function cmdWarn(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to a user to warn them.');
  if (await isAdmin(msg.chat.id, t.id)) return reply(msg, 'That user is an admin.');
  const { warnLimit, muteMins } = mod.settings(msg.chat.id);
  const n = mod.addWarn(msg.chat.id, t.id);
  const reason = (parts || '').replace(/^\s*\d{4,}\s*/, '').trim();
  if (n >= warnLimit) {
    mod.resetWarns(msg.chat.id, t.id);
    await doMute(msg.chat.id, t.id, nowSecs() + muteMins * 60);
    return reply(msg, `⚠️ ${mention(t)} hit ${warnLimit}/${warnLimit} warns → muted ${muteMins}m.${reason ? `\nReason: ${esc(reason)}` : ''}`);
  }
  return reply(msg, `⚠️ Warned ${mention(t)} — ${n}/${warnLimit}.${reason ? ` (${esc(reason)})` : ''}`);
}
async function cmdUnwarn(msg, parts) {
  const t = targetFromMessage(msg, parts);
  if (!t) return reply(msg, 'Reply to a user to remove a warn.');
  const n = mod.removeWarn(msg.chat.id, t.id);
  const { warnLimit } = mod.settings(msg.chat.id);
  return reply(msg, `➖ ${mention(t)} now ${n}/${warnLimit} warns.`);
}
async function cmdWarns(msg, parts) {
  const t = targetFromMessage(msg, parts) || msg.from;
  const n = mod.warnCount(msg.chat.id, t.id);
  const { warnLimit } = mod.settings(msg.chat.id);
  return reply(msg, `${mention(t)}: <b>${n}/${warnLimit}</b> warns.`);
}
async function cmdDel(msg) {
  if (!msg.reply_to_message) return reply(msg, 'Reply to the message you want to delete with <code>/del</code>.');
  await delMsg(msg.chat.id, msg.reply_to_message.message_id);
  await delMsg(msg.chat.id, msg.message_id); // clean up the command too
}
async function cmdPurge(msg) {
  if (!msg.reply_to_message) return reply(msg, 'Reply to the FIRST message to purge from, with <code>/purge</code>.');
  const from = msg.reply_to_message.message_id;
  const to = msg.message_id;
  if (to - from > 200) return reply(msg, 'That range is too large (max 200 messages). Purge in smaller chunks.');
  let n = 0;
  for (let id = from; id <= to; id++) { const r = await delMsg(msg.chat.id, id); if (!r.__err) n++; }
  return say(msg.chat.id, `🧹 Purged ${n} messages.`);
}
async function cmdPin(msg) {
  if (!msg.reply_to_message) return reply(msg, 'Reply to a message with <code>/pin</code> to pin it.');
  const err = enforceErr(await call('pinChatMessage', { chat_id: msg.chat.id, message_id: msg.reply_to_message.message_id, disable_notification: true }));
  if (err) return reply(msg, `❌ ${err}`);
  return reply(msg, '📌 Pinned.');
}
async function cmdUnpin(msg) {
  const err = enforceErr(await call('unpinChatMessage', { chat_id: msg.chat.id, ...(msg.reply_to_message ? { message_id: msg.reply_to_message.message_id } : {}) }));
  if (err) return reply(msg, `❌ ${err}`);
  return reply(msg, '📌 Unpinned.');
}
async function cmdReport(msg) {
  const target = msg.reply_to_message;
  if (!target) return reply(msg, 'Reply to the message you’re reporting with <code>/report</code>.');
  const ids = await adminIds(msg.chat.id);
  const pings = [...ids].slice(0, 8).map((id) => `<a href="tg://user?id=${id}">⁠</a>`).join('');
  return say(msg.chat.id,
    `🚨 <b>Report</b> from ${mention(msg.from)} about ${mention(target.from)}.${pings}`,
    { reply_to_message_id: target.message_id });
}
async function cmdRules(msg) {
  const r = mod.rules(msg.chat.id);
  return reply(msg, r ? `📜 <b>Rules</b>\n\n${esc(r)}` : 'No rules set yet. An admin can set them with <code>/setrules …</code>');
}
async function cmdSetRules(msg, parts) {
  const text = (parts || '').trim();
  if (!text) return reply(msg, 'Usage: <code>/setrules Be nice. No spam. No scams.</code>');
  mod.setRules(msg.chat.id, text);
  return reply(msg, '📜 Rules updated.');
}
async function cmdLock(msg) { mod.setLockdown(msg.chat.id, true); return reply(msg, '🔒 Lockdown ON — new joiners are muted on entry. <code>/unlock</code> to lift.'); }
async function cmdUnlock(msg) { mod.setLockdown(msg.chat.id, false); return reply(msg, '🔓 Lockdown OFF.'); }

async function cmdSettings(msg, parts) {
  const [key, val] = (parts || '').trim().split(/\s+/);
  const s = mod.settings(msg.chat.id);
  if (!key) {
    return reply(msg,
      '⚙️ <b>Moderation settings</b>\n' +
      `• captcha: <b>${s.captcha ? 'on' : 'off'}</b>\n` +
      `• antilink: <b>${s.antilink ? 'on' : 'off'}</b>\n` +
      `• antiflood: <b>${s.antiflood ? 'on' : 'off'}</b>\n` +
      `• warnlimit: <b>${s.warnLimit}</b>\n` +
      `• mutetime: <b>${s.muteMins}m</b>\n` +
      `• lockdown: <b>${mod.isLockdown(msg.chat.id) ? 'on' : 'off'}</b>\n\n` +
      'Change: <code>/set captcha off</code> · <code>/set antilink on</code> · <code>/set warnlimit 4</code> · <code>/set mutetime 120</code>');
  }
  const k = key.toLowerCase();
  const onOff = (v) => /^(on|true|yes|1)$/i.test(v) ? true : /^(off|false|no|0)$/i.test(v) ? false : null;
  if (k === 'captcha' || k === 'antilink' || k === 'antiflood') {
    const b = onOff(val); if (b === null) return reply(msg, `Usage: <code>/set ${k} on|off</code>`);
    mod.setSetting(msg.chat.id, k === 'captcha' ? 'captcha' : k === 'antilink' ? 'antilink' : 'antiflood', b);
    return reply(msg, `✓ ${k} ${b ? 'on' : 'off'}.`);
  }
  if (k === 'warnlimit') { const n = Number(val); if (!Number.isInteger(n) || n < 1 || n > 20) return reply(msg, 'warnlimit must be 1–20.'); mod.setSetting(msg.chat.id, 'warnLimit', n); return reply(msg, `✓ warnlimit ${n}.`); }
  if (k === 'mutetime') { const n = Number(val); if (!Number.isInteger(n) || n < 1 || n > 20160) return reply(msg, 'mutetime is minutes (1–20160).'); mod.setSetting(msg.chat.id, 'muteMins', n); return reply(msg, `✓ mutetime ${n}m.`); }
  return reply(msg, 'Unknown setting. Options: captcha, antilink, antiflood, warnlimit, mutetime.');
}

const MODHELP =
  '<b>🛡️ Group moderation</b>\n\n' +
  '<b>Admins</b> (reply to a user, or pass their numeric id):\n' +
  '/ban · /unban · /kick — remove a user\n' +
  '/mute [10m|2h|1d] · /unmute — timed silence\n' +
  '/warn [reason] · /unwarn · /warns — strikes (auto-mute at the limit)\n' +
  '/del · /purge — delete the replied message / a range\n' +
  '/pin · /unpin — manage the pinned message\n' +
  '/lock · /unlock — anti-raid lockdown\n' +
  '/setrules … · /set … — configure (see <code>/set</code>)\n\n' +
  '<b>Anyone</b>:\n' +
  '/rules — show the rules\n' +
  '/report — reply to flag a message to admins\n\n' +
  '<i>Auto: new-member captcha, flood limiter, link filter, join-spike lockdown. I must be an admin (Ban + Delete) to enforce.</i>';

// Admin-only command set.
const ADMIN_CMDS = {
  ban: cmdBan, unban: cmdUnban, kick: cmdKick, mute: cmdMute, unmute: cmdUnmute,
  warn: cmdWarn, unwarn: cmdUnwarn, del: cmdDel, purge: cmdPurge, pin: cmdPin,
  unpin: cmdUnpin, setrules: cmdSetRules, set: cmdSettings, modsettings: cmdSettings,
  lock: cmdLock, unlock: cmdUnlock,
};
// Open to everyone.
const OPEN_CMDS = { rules: cmdRules, report: cmdReport, warns: cmdWarns, modhelp: async (m) => reply(m, MODHELP) };

// ─────────────────────────────────────────── new-member handling ─────────────
async function onNewMembers(msg) {
  const chatId = msg.chat.id;
  const members = msg.new_chat_members || [];
  const s = mod.settings(chatId);

  // Join-rate spike → auto lockdown + alert (once).
  const arr = joins.get(String(chatId)) || [];
  const cutoff = Date.now() - JOIN_WINDOW * 1000;
  const recent = arr.filter((t) => t > cutoff);
  for (let i = 0; i < members.length; i++) recent.push(Date.now());
  joins.set(String(chatId), recent);
  if (recent.length >= JOIN_BURST && !mod.isLockdown(chatId)) {
    mod.setLockdown(chatId, true);
    await say(chatId, `🚨 <b>Join spike detected</b> (${recent.length} in ${JOIN_WINDOW}s) — <b>lockdown ON</b>. New members are muted until an admin runs <code>/unlock</code>.`);
  }

  for (const u of members) {
    if (u.is_bot) continue; // admins add bots deliberately; don't gate them
    // Under lockdown, silence every joiner (no captcha button to auto-approve a raid).
    if (mod.isLockdown(chatId)) { await doMute(chatId, u.id, 0); continue; }
    if (!s.captcha) continue;
    // Captcha: mute, then offer a one-tap human check.
    const r = await doMute(chatId, u.id, 0);
    if (r.__err) continue; // not admin → can't gate; leave them be
    const sent = await say(chatId,
      `👋 Welcome ${mention(u)} — tap below within ${Math.round(CAPTCHA_SECS / 60) || 1} min to verify you’re human.`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ I’m human', callback_data: `cap:${u.id}` }]] } });
    if (sent && sent.message_id) captcha.set(`${chatId}:${u.id}`, { msgId: sent.message_id, at: Date.now() });
  }
}

// Captcha button tap. Only the target may pass it.
export async function onCallback(cb) {
  const data = cb.data || '';
  if (!data.startsWith('cap:')) return false;
  const chatId = cb.message?.chat?.id;
  const targetId = Number(data.slice(4));
  if (!chatId) return true;
  if (Number(cb.from.id) !== targetId) {
    await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'This button isn’t for you.', show_alert: false });
    return true;
  }
  await doUnmute(chatId, targetId);
  const key = `${chatId}:${targetId}`;
  const pend = captcha.get(key);
  if (pend) { await delMsg(chatId, pend.msgId); captcha.delete(key); }
  await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Verified ✅ Welcome!', show_alert: false });
  return true;
}

// ─────────────────────────────────────────── passive spam filters ────────────
const LINK_RE = /\b(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/|discord\.gg\/|discord\.com\/invite)\S+/i;
function hasLinkEntity(msg) {
  const ents = [...(msg.entities || []), ...(msg.caption_entities || [])];
  return ents.some((e) => e.type === 'url' || e.type === 'text_link');
}

async function runFilters(msg, sender) {
  const chatId = msg.chat.id;
  const s = mod.settings(chatId);
  const text = msg.text || msg.caption || '';

  // Flood limiter.
  if (s.antiflood) {
    const key = `${chatId}:${sender.id}`;
    const cutoff = Date.now() - FLOOD_SECS * 1000;
    const hits = (flood.get(key) || []).filter((t) => t > cutoff);
    hits.push(Date.now());
    flood.set(key, hits);
    if (hits.length > FLOOD_MSGS) {
      flood.delete(key);
      const r = await doMute(chatId, sender.id, nowSecs() + s.muteMins * 60);
      if (!r.__err) { await delMsg(chatId, msg.message_id); await say(chatId, `🌊 ${mention(sender)} muted ${s.muteMins}m for flooding.`); }
      return true;
    }
  }

  // Link / invite filter for non-admins.
  if (s.antilink && (LINK_RE.test(text) || hasLinkEntity(msg))) {
    const r = await delMsg(chatId, msg.message_id);
    if (!r.__err) {
      const n = mod.addWarn(chatId, sender.id);
      if (n >= s.warnLimit) { mod.resetWarns(chatId, sender.id); await doMute(chatId, sender.id, nowSecs() + s.muteMins * 60); await say(chatId, `🔗 ${mention(sender)} muted ${s.muteMins}m (links after ${s.warnLimit} warns).`); }
      else await say(chatId, `🔗 Link removed — ${mention(sender)} please don’t post links. Warn ${n}/${s.warnLimit}.`);
    }
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────── entrypoints ─────────────
// An edited group message: re-run the passive spam filters only (so you can't post
// benign text then edit a link/scam in). Never re-executes commands.
export async function onEditedGroupMessage(msg) {
  if (!isGroup(msg.chat) || !msg.from) return false;
  if (await isAdmin(msg.chat.id, msg.from.id)) return true; // admins exempt
  await runFilters(msg, msg.from).catch((e) => console.error('mod edit filter:', e?.message));
  return true;
}

// Returns true if the message was a group event we handled (so bot.js stops).
export async function onGroupMessage(msg) {
  if (!isGroup(msg.chat)) return false;

  // Service messages: new members / left member.
  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) { await onNewMembers(msg); return true; }
  if (msg.left_chat_member) return true; // consume; nothing to do
  if (!msg.from) return true; // anonymous admin / channel post — ignore

  const text = (msg.text || '').trim();
  const isCmd = text.startsWith('/');
  const admin = await isAdmin(msg.chat.id, msg.from.id);

  // Passive filters (flood + link) run on EVERY non-admin message — commands
  // INCLUDED — so a leading "/" can't bypass antilink/antiflood, and command-spam
  // (even OPEN commands like /rules) is counted toward the flood limit. If a filter
  // acts (deletes/mutes), stop here and don't also dispatch the command.
  if (!admin) {
    if (await runFilters(msg, msg.from).catch(() => false)) return true;
  }

  if (isCmd) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.slice(1).split('@')[0].toLowerCase();
    const parts = rest.join(' ');
    if (OPEN_CMDS[cmd]) { try { await OPEN_CMDS[cmd](msg, parts); } catch (e) { console.error('mod open cmd:', e?.message); } return true; }
    if (ADMIN_CMDS[cmd]) {
      if (!admin) { await reply(msg, '🔒 Admins only.'); return true; }
      try { await ADMIN_CMDS[cmd](msg, parts); } catch (e) { console.error('mod admin cmd:', e?.message); }
      return true;
    }
    return true; // unrecognized command — filters already ran; consume it (not a wallet command)
  }
  return true;
}

// Periodic sweep: remove joiners who never solved the captcha; trim stale counters.
export async function sweep() {
  const now = Date.now();
  for (const [key, pend] of captcha) {
    if (now - pend.at < CAPTCHA_SECS * 1000) continue;
    captcha.delete(key);
    const [chatId, userId] = key.split(':');
    await delMsg(chatId, pend.msgId);
    // Kick (ban→unban) so they can try again later; they never verified.
    await doBan(chatId, Number(userId), 0, false);
    await doUnban(chatId, Number(userId));
    await say(chatId, `⏳ Removed an unverified new member (captcha timeout).`).catch?.(() => {});
  }
  const floodCut = now - FLOOD_SECS * 1000;
  for (const [k, arr] of flood) { const keep = arr.filter((t) => t > floodCut); if (keep.length) flood.set(k, keep); else flood.delete(k); }
  const joinCut = now - JOIN_WINDOW * 1000;
  for (const [k, arr] of joins) { const keep = arr.filter((t) => t > joinCut); if (keep.length) joins.set(k, keep); else joins.delete(k); }
}
