// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Launch Bot
//
// A pure Telegram COMMAND bot (not a Mini App) that lets users launch and trade
// tokens on Robin Labs / Robinhood Chain from a custodial wallet the bot manages.
//
// Telegram ToS posture (see README): command bot only — no Mini App, no TON
// Connect, no Telegram Stars; on-chain value only. Opt-in, no broadcast/spam.
// Honest custody + risk disclaimer. /forget erases a user's data on request.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers';
import { CFG, CHAIN, tgApi, tgFile, explorerTx, explorerAddr, coinUrl } from './config.js';
import * as store from './store.js';
import * as chain from './chain.js';
import { setProfile } from './profile.js';

// ── tiny Telegram HTTP helpers ───────────────────────────────────────────────
async function tg(method, params, timeoutMs = 30000) {
  const r = await fetch(`${tgApi}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}
const send = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
// Escapes the five HTML-sensitive chars, incl. quotes (defensive: keeps any
// future user text safe even inside an attribute).
export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Serialize on-chain actions per user so two quick commands can't race the tx
// nonce (double-buy / double-withdraw). A second concurrent request is refused,
// not queued, so the user gets clear feedback.
const inFlight = new Set();
async function exclusive(userId, chatId, fn) {
  const id = String(userId);
  if (inFlight.has(id)) { await send(chatId, '⏳ Still processing your last action — give it a few seconds.'); return; }
  inFlight.add(id);
  try { await fn(); } finally { inFlight.delete(id); }
}
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const fmtEth = (wei) => Number(ethers.formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 6 });

// ── inline keyboards ─────────────────────────────────────────────────────────
const menuKb = {
  inline_keyboard: [
    [{ text: '🚀 Launch a coin', callback_data: 'launch' }, { text: '💰 Balance', callback_data: 'balance' }],
    [{ text: '📥 Deposit', callback_data: 'deposit' }, { text: '📤 Withdraw', callback_data: 'withdraw' }],
    [{ text: '🪙 My coins', callback_data: 'mycoins' }, { text: 'ℹ️ Help', callback_data: 'help' }],
  ],
};

// ─────────────────────────────────────────────────────────── copy ────────────
const termsLine = () => CFG.termsUrl ? `\n• Terms & privacy: ${CFG.termsUrl}` : '';
const DISCLAIMER =
  '<b>Before you start — please read.</b>\n\n' +
  '• This bot creates a <b>custodial wallet</b> for you. The bot holds its key (encrypted). ' +
  'Anything in it is at risk if the bot server is compromised. <b>Keep only what you plan to use, and /withdraw the rest.</b>\n' +
  '• Coins here are <b>experimental, extremely high risk</b> tokens with no intrinsic value — you can lose everything. ' +
  'This is <b>not an offer of securities, not investment advice</b>, and nothing here is a promise of profit.\n' +
  '• You are solely responsible for what you create and trade. Do <b>not</b> launch coins that impersonate people/brands, ' +
  'mislead buyers, or are illegal where you are.\n' +
  '• You must be <b>18+</b> and legally permitted to use crypto in your jurisdiction.\n' +
  '• The bot will <b>never</b> ask for your Telegram password or a login code. Never share those with anyone.\n' +
  '• Your data: we store only your Telegram id, your wallet, and your launches. Send <b>/forget</b> anytime to erase it.' +
  termsLine();

const HELP =
  '<b>Robin Labs Launch Bot</b> — launch & trade on Robinhood Chain.\n\n' +
  '<b>Commands</b>\n' +
  '/start — set up your wallet + menu\n' +
  '/launch — create a new coin (name → ticker → image → optional dev-buy)\n' +
  '/balance — your ETH + coins\n' +
  '/deposit — show your deposit address\n' +
  '/withdraw &lt;address&gt; — send your ETH out\n' +
  '/buy &lt;token&gt; &lt;eth&gt; — buy a coin\n' +
  '/sell &lt;token&gt; &lt;percent&gt; — sell part of a holding\n' +
  '/mycoins — coins you launched\n' +
  '/cancel — abort the current step\n' +
  '/disclaimer — risks &amp; how custody works\n' +
  '/forget — erase all your data (withdraw first!)\n' +
  '/paysupport — support & disputes\n\n' +
  `<i>Fees: every coin pays the pad's baseline 1% per trade. ${feeLine()}</i>`;

function feeLine() {
  const f = Number(CFG.launchFeeEth || 0);
  return f > 0 ? `A ${CFG.launchFeeEth} ETH bot fee is charged per launch.` : 'No extra bot fee to launch.';
}

// Basic content moderation for user-supplied coin name/ticker, so the bot can't
// be used to mint slurs or brand-impersonation coins that would get it reported.
// Not exhaustive — a first-line filter, extendable via BLOCKED_WORDS env.
//
// HARD terms are matched against the normalized (punctuation/space-stripped) text
// so "n i g g e r" is still caught; they're specific enough that false-positive
// substrings are unlikely. WORD terms are short or brand-ish (would over-block as
// substrings — "cp"→TCP, "rape"→Grape, "usdt"→a longer ticker) so they're matched
// only as whole words. Name and ticker are checked separately.
const HARD = ['nigger', 'nigga', 'faggot', 'kike', 'chink', 'tranny', 'childporn', 'nazi', 'hitler'];
const WORD = [
  'cp', 'rape', 'spic', 'retard', 'pedo', 'isis',
  'official', 'verified', 'binance', 'coinbase', 'robinhoodmarkets', 'telegram', 'tether', 'usdt', 'usdc',
  ...String(process.env.BLOCKED_WORDS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
];
// Precompile the whole-word matchers once, escaping regex metacharacters so an
// operator-supplied BLOCKED_WORDS entry like "a(" can't crash the matcher.
const WORD_RE = WORD.map((w) => ({ w, re: new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }));
function fieldReason(s) {
  const norm = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const w of HARD) if (norm.includes(w)) return w;
  const low = String(s).toLowerCase();
  for (const { w, re } of WORD_RE) if (re.test(low)) return w;
  return null;
}
export function moderationReason(name, symbol) {
  return fieldReason(name || '') || fieldReason(symbol || '');
}

// Require the terms/age gate before any wallet action.
async function requireAgreed(chatId, userId) {
  if (store.hasAgreed(userId)) return true;
  await send(chatId, 'Please run /start and tap <b>“I agree”</b> first — it takes one tap.',
    { reply_markup: { inline_keyboard: [[{ text: '✅ Review & agree', callback_data: 'review' }]] } });
  return false;
}

// ─────────────────────────────────────────────────────── command handlers ────
async function cmdStart(chatId, userId) {
  // Gate: no wallet is created until the user explicitly accepts the terms/age
  // gate. This records consent (§9 / 18+ posture) before any custody exists.
  if (!store.hasAgreed(userId)) {
    return send(chatId,
      `👋 <b>Welcome to Robin Labs.</b>\n\n${DISCLAIMER}\n\n` +
      `Tap <b>“I agree”</b> to confirm you’re 18+, in a permitted jurisdiction, and accept the risks. ` +
      `I’ll create your wallet after that.`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ I agree — create my wallet', callback_data: 'agree' }]] } });
  }
  return showWallet(chatId, userId, '👋 <b>Welcome back.</b>');
}

async function showWallet(chatId, userId, head) {
  const addr = store.ensureWallet(userId);
  const bal = await chain.ethBalance(addr).catch(() => 0n);
  await send(chatId,
    `${head}\n\n` +
    `<b>Your deposit address</b>\n<code>${addr}</code>\n` +
    `Balance: <b>${fmtEth(bal)} ETH</b>\n\n` +
    `Send ETH (Robinhood Chain) to that address, then tap <b>Launch a coin</b>. ` +
    `Keep only what you’ll use — /withdraw the rest.`,
    { reply_markup: menuKb });
}

// Called from the 'agree' button: record consent, then create + show the wallet.
async function cmdAgree(chatId, userId) {
  store.ensureWallet(userId);
  store.markAgreed(userId);
  await showWallet(chatId, userId, '✅ <b>Thanks — you’re set.</b> Wallet created.');
}

async function cmdBalance(chatId, userId) {
  const addr = store.addressOf(userId);
  if (!addr) return cmdStart(chatId, userId);
  const bal = await chain.ethBalance(addr).catch(() => 0n);
  const coins = store.coinsOf(userId);
  let body = `💰 <b>Your wallet</b>\n<code>${addr}</code>\nBalance: <b>${fmtEth(bal)} ETH</b>`;
  if (coins.length) {
    body += '\n\n<b>Coins you launched</b>\n' + coins.slice(0, 10)
      .map((c) => `• $${esc(c.symbol)} — <a href="${coinUrl(c.token)}">chart</a> · <code>${short(c.token)}</code>`).join('\n');
  }
  await send(chatId, body, { reply_markup: menuKb });
}

async function cmdDeposit(chatId, userId) {
  if (!await requireAgreed(chatId, userId)) return;
  const addr = store.ensureWallet(userId);
  await send(chatId,
    `📥 <b>Deposit address</b> (Robinhood Chain only)\n<code>${addr}</code>\n\n` +
    `Send ETH here, then /launch or /buy. Only send assets on <b>Robinhood Chain (id 4663)</b> — ` +
    `other chains will be lost.`);
}

async function cmdMycoins(chatId, userId) {
  const coins = store.coinsOf(userId);
  if (!coins.length) return send(chatId, 'You haven’t launched any coins yet. Tap /launch to make one.');
  const body = '🪙 <b>Your launches</b>\n\n' + coins.map((c) =>
    `• <b>$${esc(c.symbol)}</b>\n  <a href="${coinUrl(c.token)}">chart</a> · <a href="${explorerAddr(c.token)}">explorer</a>\n  <code>${c.token}</code>`).join('\n\n');
  await send(chatId, body);
}

async function cmdWithdraw(chatId, userId, arg) {
  if (!await requireAgreed(chatId, userId)) return;
  const addr = store.addressOf(userId);
  if (!addr) return cmdStart(chatId, userId);
  const to = (arg || '').trim();
  if (!ethers.isAddress(to)) {
    return send(chatId, 'Usage: <code>/withdraw 0xYourAddress</code>\nSends your entire ETH balance (minus gas) to that address.');
  }
  const signer = store.signer(userId, chain.provider);
  await send(chatId, '⏳ Withdrawing…');
  try {
    const res = await chain.withdrawAll(signer, to);
    if (!res) return send(chatId, 'Nothing to withdraw (balance doesn’t cover gas).');
    await send(chatId, `✅ Sent <b>${fmtEth(res.sent)} ETH</b> → <code>${short(to)}</code>\n<a href="${explorerTx(res.hash)}">view tx</a>`);
  } catch (e) { await send(chatId, `❌ Withdraw failed: ${esc(shortErr(e))}`); }
}

async function cmdBuy(chatId, userId, args) {
  if (!await requireAgreed(chatId, userId)) return;
  const addr = store.addressOf(userId);
  if (!addr) return cmdStart(chatId, userId);
  const [token, amt] = (args || '').trim().split(/\s+/);
  if (!ethers.isAddress(token || '') || !/^\d{1,9}(\.\d{1,18})?$/.test(amt || '') || !(Number(amt) > 0)) {
    return send(chatId, 'Usage: <code>/buy 0xToken 0.05</code>  (plain ETH amount)');
  }
  const signer = store.signer(userId, chain.provider);
  await send(chatId, `⏳ Buying ${esc(amt)} ETH of ${short(token)}…`);
  try {
    const { hash } = await chain.buy(signer, token, ethers.parseEther(String(amt)));
    await send(chatId, `✅ Bought.\n<a href="${explorerTx(hash)}">view tx</a> · <a href="${coinUrl(token)}">chart</a>`);
  } catch (e) { await send(chatId, `❌ Buy failed: ${esc(shortErr(e))}`); }
}

async function cmdSell(chatId, userId, args) {
  if (!await requireAgreed(chatId, userId)) return;
  const addr = store.addressOf(userId);
  if (!addr) return cmdStart(chatId, userId);
  const [token, pctRaw] = (args || '').trim().split(/\s+/);
  const pct = Number(pctRaw);
  if (!ethers.isAddress(token || '') || !/^\d{1,3}(\.\d{1,4})?$/.test(pctRaw || '') || !(pct > 0 && pct <= 100)) {
    return send(chatId, 'Usage: <code>/sell 0xToken 100</code>  (percent of your holding)');
  }
  const signer = store.signer(userId, chain.provider);
  try {
    const t = chain.erc20(token);
    const bal = await t.balanceOf(addr);
    if (bal === 0n) return send(chatId, 'You hold none of that token.');
    const amount = (bal * BigInt(Math.round(pct * 100))) / 10000n;
    await send(chatId, `⏳ Selling ${esc(String(pct))}%…`);
    const { hash } = await chain.sell(signer, token, amount);
    await send(chatId, `✅ Sold.\n<a href="${explorerTx(hash)}">view tx</a>`);
  } catch (e) { await send(chatId, `❌ Sell failed: ${esc(shortErr(e))}`); }
}

async function cmdForget(chatId, userId) {
  const addr = store.addressOf(userId);
  if (!addr) return send(chatId, 'You have no data stored. Nothing to erase.');
  const bal = await chain.ethBalance(addr).catch(() => 0n);
  if (bal > 0n) {
    return send(chatId,
      `⚠️ Your wallet still holds <b>${fmtEth(bal)} ETH</b>. If you /forget now, the key is deleted and the funds are <b>gone forever</b>.\n\n` +
      `Withdraw first: <code>/withdraw 0xYourAddress</code>\n` +
      `To erase anyway, send <code>/forget confirm</code>.`);
  }
  return doForget(chatId, userId);
}
async function doForget(chatId, userId) {
  store.forget(userId);
  await send(chatId, '🗑️ Done — your wallet key, address and launch history have been erased from the bot. (On-chain history is public and can’t be deleted.)');
}

// ───────────────────────────────────────────── launch wizard (multi-step) ────
async function launchStart(chatId, userId) {
  if (!await requireAgreed(chatId, userId)) return;
  const wait = store.cooldownLeft(userId, 'launch');
  if (wait > 0) return send(chatId, `⏳ You just launched — please wait ${wait}s before creating another coin.`);
  store.ensureWallet(userId);
  store.setSession(userId, { flow: 'launch', step: 'name' });
  await send(chatId, '🚀 <b>New coin</b> — step 1 of 4\n\nSend the <b>name</b> (e.g. <i>My Coin</i>). /cancel to stop.');
}

async function handleLaunchStep(chatId, userId, msg) {
  const s = store.getSession(userId);
  if (!s || s.flow !== 'launch') return false;
  const text = (msg.text || '').trim();

  if (s.step === 'name') {
    if (!text || text.length > 32) { await send(chatId, 'Send a name up to 32 characters.'); return true; }
    if (moderationReason(text, '')) { await send(chatId, 'That name isn’t allowed (impersonation or prohibited content). Pick another.'); return true; }
    store.setSession(userId, { ...s, step: 'symbol', name: text });
    await send(chatId, `Name: <b>${esc(text)}</b> ✓\n\nStep 2 of 4 — send the <b>ticker</b> (2–10 letters, e.g. <i>ROBIN</i>).`);
    return true;
  }
  if (s.step === 'symbol') {
    const sym = text.replace(/^\$/, '').toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(sym)) { await send(chatId, 'Ticker must be 2–10 letters/numbers, e.g. ROBIN.'); return true; }
    if (moderationReason(s.name || '', sym)) { await send(chatId, 'That ticker isn’t allowed. Pick another.'); return true; }
    store.setSession(userId, { ...s, step: 'image', symbol: sym });
    await send(chatId, `Ticker: <b>$${esc(sym)}</b> ✓\n\nStep 3 of 4 — send an <b>image</b> for the coin (photo), or type <b>skip</b>.`);
    return true;
  }
  if (s.step === 'image') {
    if (/^skip$/i.test(text)) {
      store.setSession(userId, { ...s, step: 'devbuy', pfp: '' });
      await askDevBuy(chatId); return true;
    }
    const pfp = await extractPhotoDataUrl(msg).catch(() => null);
    if (!pfp) { await send(chatId, 'Send the image as a <b>photo</b> (not a file), or type <b>skip</b>.'); return true; }
    store.setSession(userId, { ...s, step: 'devbuy', pfp });
    await send(chatId, 'Image received ✓');
    await askDevBuy(chatId); return true;
  }
  if (s.step === 'devbuy') {
    let devBuyEth = '0';
    if (!/^(0|no|skip|none)$/i.test(text)) {
      // Keep the ORIGINAL string and validate it round-trips through parseEther —
      // Number(text) would turn "0.0000001" into "1e-7", which parseEther rejects.
      if (!/^\d{1,9}(\.\d{1,18})?$/.test(text) || !(Number(text) > 0)) {
        await send(chatId, 'Send a plain ETH amount like <b>0.1</b> (max 18 decimals), or <b>0</b> to skip.');
        return true;
      }
      devBuyEth = text;
    }
    store.clearSession(userId);
    await exclusive(userId, chatId, () =>
      doLaunch(chatId, userId, { name: s.name, symbol: s.symbol, pfp: s.pfp || '', devBuyEth }));
    return true;
  }
  return false;
}

function askDevBuy(chatId) {
  return send(chatId,
    'Step 4 of 4 — how much ETH for your <b>first buy</b> (optional)?\n' +
    'Send an amount like <b>0.1</b>, or <b>0</b> to skip. You need enough ETH in your wallet for this + gas.');
}

async function doLaunch(chatId, userId, { name, symbol, pfp, devBuyEth }) {
  let addr, signer;
  try {
    addr = store.addressOf(userId);
    signer = store.signer(userId, chain.provider); // throws if the wallet was /forget'd mid-wizard
  } catch { return send(chatId, 'Your wallet isn’t available — run /start to set it up, then /launch again.'); }
  const bal = await chain.ethBalance(addr).catch(() => 0n);

  // devBuyEth is a validated decimal string; parse safely.
  let devBuyWei;
  try { devBuyWei = ethers.parseEther(String(devBuyEth || '0')); }
  catch { return send(chatId, 'That dev-buy amount wasn’t valid. Start over with /launch.'); }

  const feeEth = Number(CFG.launchFeeEth || 0);
  const feeWei = ethers.parseEther(CFG.launchFeeEth || '0'); // config guarantees a valid decimal string

  // Account for the WORST-CASE launch gas (the 2^24 cap) plus the fee tx gas, so
  // we never charge a fee and then fail the launch for want of gas. Gas on this
  // L2 is tiny, so the conservative budget barely affects the threshold.
  let gasBudget;
  try {
    const gp = await chain.gasPriceNow();
    gasBudget = gp * BigInt(CHAIN.perTxGasCap) + (feeWei > 0n ? gp * 21000n : 0n);
  } catch { gasBudget = 0n; }
  const need = devBuyWei + feeWei + gasBudget;
  if (bal <= need) {
    return send(chatId,
      `❌ Not enough ETH. Balance <b>${fmtEth(bal)}</b>, need &gt; <b>${fmtEth(need)}</b> (dev-buy + fee + gas).\n` +
      `Deposit to <code>${addr}</code> and try /launch again.`);
  }

  // Launch FIRST — never charge the fee before the thing the fee is for.
  await send(chatId, `⏳ Launching <b>$${esc(symbol)}</b>… deploying token, pool & curve. This takes a few seconds.`);
  let res;
  try {
    res = await chain.launch(signer, { name, symbol, devBuyWei });
  } catch (e) { return send(chatId, `❌ Launch failed: ${esc(shortErr(e))}`); }
  if (!res.token) return send(chatId, `⚠️ Launch tx sent but I couldn’t read the address. Check <a href="${explorerTx(res.hash)}">the tx</a>.`);

  store.noteCoin(userId, res.token, symbol);
  store.stampCooldown(userId, 'launch', CFG.launchCooldownSecs); // anti-spam: start the cooldown on success

  // Confirm the launch NOW, before any slow follow-ups (pfp upload / fee), so a
  // stalled indexer can never leave the user staring at "Launching…".
  const bought = res.devBought && res.devBought > 0n
    ? `\nYou bought the first <b>${Number(ethers.formatEther(res.devBought)).toLocaleString('en-US', { maximumFractionDigits: 0 })} $${esc(symbol)}</b>.` : '';
  await send(chatId,
    `✅ <b>$${esc(symbol)} is live!</b>${bought}\n\n` +
    `<b>Token</b> <code>${res.token}</code>\n` +
    `<a href="${coinUrl(res.token)}">📈 Chart / trade</a> · <a href="${explorerAddr(res.token)}">explorer</a>\n\n` +
    `Share the chart link to bring in buyers. Trade more with <code>/buy ${short(res.token)} 0.1</code>.`,
    { reply_markup: { inline_keyboard: [[{ text: '📈 Open chart', url: coinUrl(res.token) }]] } });

  // Best-effort pfp upload (the custodial key is the coin's dev, so it can sign).
  if (pfp) {
    try { await setProfile(signer, res.token, { pfpDataUrl: pfp }); await send(chatId, '🖼️ Image set.'); }
    catch (e) { await send(chatId, `(couldn’t set the image right now — ${esc(shortErr(e))}. You can set it later on the site.)`); }
  }

  // Optional on-chain bot fee, charged AFTER a successful launch (NOT via
  // Telegram Stars — ToS-compliant). Fire-and-forget with a BOUNDED wait so a
  // stuck fee tx can never pin this user's exclusive() lock. A failed fee never
  // harms the user (they already got the coin).
  if (feeWei > 0n && CFG.feeWallet && ethers.isAddress(CFG.feeWallet)) {
    chain.legacyOv({ value: feeWei, gasLimit: 21000n })
      .then((ov) => signer.sendTransaction({ to: CFG.feeWallet, ...ov }))
      .then((tx) => tx.wait(1, 180_000))
      .catch((e) => console.error('fee charge failed:', e.message));
  }

  announceLaunch({ name, symbol, token: res.token, devBought: res.devBought }).catch((e) => console.error('announce:', e.message));
}

// Post a new launch into the announce group/channel (free promo). Best-effort.
// Throttled to ≥1 post/interval so a launch burst can't turn it into channel spam
// (Telegram §5.2b). Must be a channel the operator owns/admins.
let _lastAnnounce = 0;
const ANNOUNCE_MIN_GAP_MS = 30_000;
async function announceLaunch({ name, symbol, token, devBought }) {
  if (!CFG.announceChatId) return;
  const now = Date.now();
  if (now - _lastAnnounce < ANNOUNCE_MIN_GAP_MS) return; // drop; never queue/spam
  _lastAnnounce = now;
  const firstBuy = devBought && devBought > 0n
    ? `\n💸 Dev opened with the first buy.` : '';
  await send(CFG.announceChatId,
    `🚀 <b>New launch on Robin Labs</b>\n\n` +
    `<b>${esc(name)}</b> ($${esc(symbol)})${firstBuy}\n` +
    `<code>${token}</code>\n\n` +
    `<a href="${coinUrl(token)}">📈 Chart / trade</a> · <a href="${explorerAddr(token)}">explorer</a>`,
    { reply_markup: { inline_keyboard: [[{ text: '📈 Trade it', url: coinUrl(token) }]] } });
}

// Download a Telegram photo → base64 data URL (server downscales any format).
async function extractPhotoDataUrl(msg) {
  let fileId = null;
  if (Array.isArray(msg.photo) && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document && /^image\//.test(msg.document.mime_type || '')) fileId = msg.document.file_id;
  if (!fileId) return null;
  const MAX = 8 * 1024 * 1024;
  const f = await tg('getFile', { file_id: fileId });
  // Telegram's getFile reports the size; reject oversized files before downloading.
  if (f.file_size && f.file_size > MAX) throw new Error('image too large');
  const r = await fetch(`${tgFile}/${f.file_path}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('download failed');
  const clen = Number(r.headers.get('content-length') || 0);
  if (clen > MAX) throw new Error('image too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX) throw new Error('image too large');
  const mime = /\.png$/i.test(f.file_path) ? 'image/png' : /\.webp$/i.test(f.file_path) ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ─────────────────────────────────────────────────────── dispatch ────────────
async function onMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (msg.chat.type !== 'private') return; // opt-in DMs only; ignore groups (no spam)
  const text = (msg.text || '').trim();

  // An in-progress wizard consumes non-command input first.
  if (!text.startsWith('/')) {
    if (await handleLaunchStep(chatId, userId, msg)) return;
    return send(chatId, 'Not sure what you mean. Send /help for commands, or /launch to make a coin.');
  }

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const arg = rest.join(' ');

  try {
    switch (cmd) {
      case '/start': return await cmdStart(chatId, userId);
      case '/help': return await send(chatId, HELP, { reply_markup: menuKb });
      case '/disclaimer': return await send(chatId, DISCLAIMER);
      case '/launch': case '/create': return await launchStart(chatId, userId);
      case '/balance': case '/wallet': return await cmdBalance(chatId, userId);
      case '/deposit': return await cmdDeposit(chatId, userId);
      case '/withdraw': return await exclusive(userId, chatId, () => cmdWithdraw(chatId, userId, arg));
      case '/buy': return await exclusive(userId, chatId, () => cmdBuy(chatId, userId, arg));
      case '/sell': return await exclusive(userId, chatId, () => cmdSell(chatId, userId, arg));
      case '/mycoins': return await cmdMycoins(chatId, userId);
      case '/cancel': store.clearSession(userId); return await send(chatId, 'Cancelled.');
      case '/forget': return /confirm/i.test(arg) ? await doForget(chatId, userId) : await cmdForget(chatId, userId);
      case '/paysupport':
        return await send(chatId, 'Need help or have a dispute? This bot takes no Telegram payments; on-chain actions are final. Contact support: ' + (process.env.SUPPORT_URL || 't.me/robinlabs'));
      default: return await send(chatId, 'Unknown command. Send /help.');
    }
  } catch (e) {
    console.error('cmd error:', e.message);
    try { await send(chatId, `⚠️ ${esc(shortErr(e))}`); } catch { /* ignore */ }
  }
}

async function onCallback(cb) {
  // Old/inaccessible messages can arrive without a usable chat; bail safely.
  if (!cb.message?.chat) return;
  if (cb.message.chat.type !== 'private') return; // never act on a group-posted keyboard
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data;
  try { await tg('answerCallbackQuery', { callback_query_id: cb.id }); } catch { /* ignore */ }
  try {
    switch (data) {
      case 'agree': return await cmdAgree(chatId, userId);
      case 'review': return await cmdStart(chatId, userId);
      case 'launch': return await launchStart(chatId, userId);
      case 'balance': return await cmdBalance(chatId, userId);
      case 'deposit': return await cmdDeposit(chatId, userId);
      case 'withdraw': return await send(chatId, 'To withdraw: <code>/withdraw 0xYourAddress</code>');
      case 'mycoins': return await cmdMycoins(chatId, userId);
      case 'help': return await send(chatId, HELP, { reply_markup: menuKb });
    }
  } catch (e) {
    console.error('callback error:', e.message);
    try { await send(chatId, `⚠️ ${esc(shortErr(e))}`); } catch { /* ignore */ }
  }
}

function shortErr(e) {
  const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  return m.length > 160 ? m.slice(0, 157) + '…' : m;
}

// ─────────────────────────────────────────── long-poll loop ──────────────────
async function setupCommands() {
  try {
    await tg('setMyCommands', { commands: [
      { command: 'start', description: 'Set up your wallet + menu' },
      { command: 'launch', description: 'Create a new coin' },
      { command: 'balance', description: 'Your ETH + coins' },
      { command: 'deposit', description: 'Show your deposit address' },
      { command: 'withdraw', description: 'Send your ETH out' },
      { command: 'buy', description: 'Buy a coin' },
      { command: 'sell', description: 'Sell a holding' },
      { command: 'mycoins', description: 'Coins you launched' },
      { command: 'help', description: 'How it works' },
      { command: 'disclaimer', description: 'Risks & custody' },
      { command: 'forget', description: 'Erase your data' },
    ] });
  } catch (e) { console.error('setMyCommands:', e.message); }
}

// Never let a single stray rejection (e.g. a transient Telegram send failure)
// take down the whole service and drop every user's session.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));
// Flush the wallet store synchronously on shutdown/redeploy (SIGTERM) so no
// just-created key is lost in the debounce window.
let _shuttingDown = false;
function shutdown(sig) {
  if (_shuttingDown) return; _shuttingDown = true;
  console.log(`${sig} — flushing wallet store…`);
  store.flushSync();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('beforeExit', () => store.flushSync());

async function main() {
  // Fail fast if the bot token or RPC is wrong.
  const me = await tg('getMe').catch((e) => { console.error('getMe failed:', e.message); process.exit(1); });
  const net = await chain.provider.getNetwork().catch((e) => { console.error('RPC failed:', e.message); process.exit(1); });
  console.log(`Launch bot @${me.username} up · chain ${net.chainId} · ${store.userCount()} wallets`);
  await setupCommands();
  setInterval(() => store.sweepSessions(), 5 * 60 * 1000).unref?.();

  let offset = 0;
  // Ignore backlog on boot so a restart doesn't replay old commands.
  try {
    const first = await tg('getUpdates', { timeout: 0, offset: -1 });
    if (first.length) offset = first[first.length - 1].update_id + 1;
  } catch { /* ignore */ }

  for (;;) {
    try {
      const updates = await tg('getUpdates', { timeout: 50, offset, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) onMessage(u.message).catch((e) => console.error('onMessage:', e.message));
        else if (u.callback_query) onCallback(u.callback_query).catch((e) => console.error('onCallback:', e.message));
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Only start polling when run directly (so tests can import the pure helpers).
if (!process.env.LAUNCHBOT_NO_MAIN) main();
