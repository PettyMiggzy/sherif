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
import { CFG, tgApi, tgFile, explorerTx, explorerAddr, coinUrl } from './config.js';
import * as store from './store.js';
import * as chain from './chain.js';
import { setProfile } from './profile.js';

// ── tiny Telegram HTTP helpers ───────────────────────────────────────────────
async function tg(method, params) {
  const r = await fetch(`${tgApi}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}
const send = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
const DISCLAIMER =
  '<b>Before you start — please read.</b>\n\n' +
  '• This bot creates a <b>custodial wallet</b> for you. The bot holds its key (encrypted). ' +
  'Anything in it is at risk if the bot server is compromised. <b>Keep only what you plan to use, and /withdraw the rest.</b>\n' +
  '• Memecoins are <b>extremely high risk</b>. You can lose everything. Nothing here is financial advice.\n' +
  '• You must be <b>18+</b> and permitted to use crypto where you live.\n' +
  '• The bot will <b>never</b> ask for your Telegram password or a login code. Never share those with anyone.\n' +
  '• Your data: we store only your Telegram id, your wallet, and your launches. Send <b>/forget</b> anytime to erase it.';

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

// ─────────────────────────────────────────────────────── command handlers ────
async function cmdStart(chatId, userId) {
  const created = !store.has(userId);
  const addr = store.ensureWallet(userId);
  const bal = await chain.ethBalance(addr).catch(() => 0n);
  const head = created ? '👋 <b>Welcome to Robin Labs.</b> I made you a wallet.' : '👋 <b>Welcome back.</b>';
  await send(chatId,
    `${head}\n\n${DISCLAIMER}\n\n` +
    `<b>Your deposit address</b>\n<code>${addr}</code>\n` +
    `Balance: <b>${fmtEth(bal)} ETH</b>\n\n` +
    `Send ETH (Robinhood Chain) to that address, then tap <b>Launch a coin</b>.`,
    { reply_markup: menuKb });
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
  const addr = store.addressOf(userId);
  if (!addr) return cmdStart(chatId, userId);
  const [token, amt] = (args || '').trim().split(/\s+/);
  if (!ethers.isAddress(token || '') || !(Number(amt) > 0)) {
    return send(chatId, 'Usage: <code>/buy 0xToken 0.05</code>');
  }
  const signer = store.signer(userId, chain.provider);
  await send(chatId, `⏳ Buying ${esc(amt)} ETH of ${short(token)}…`);
  try {
    const { hash } = await chain.buy(signer, token, ethers.parseEther(String(amt)));
    await send(chatId, `✅ Bought.\n<a href="${explorerTx(hash)}">view tx</a> · <a href="${coinUrl(token)}">chart</a>`);
  } catch (e) { await send(chatId, `❌ Buy failed: ${esc(shortErr(e))}`); }
}

async function cmdSell(chatId, userId, args) {
  const addr = store.addressOf(userId);
  if (!addr) return cmdStart(chatId, userId);
  const [token, pctRaw] = (args || '').trim().split(/\s+/);
  const pct = Number(pctRaw);
  if (!ethers.isAddress(token || '') || !(pct > 0 && pct <= 100)) {
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
  store.ensureWallet(userId);
  store.setSession(userId, { flow: 'launch', step: 'name' });
  await send(chatId, '🚀 <b>New coin</b> — step 1 of 4\n\nSend the <b>name</b> (e.g. <i>Robin Labs</i>). /cancel to stop.');
}

async function handleLaunchStep(chatId, userId, msg) {
  const s = store.getSession(userId);
  if (!s || s.flow !== 'launch') return false;
  const text = (msg.text || '').trim();

  if (s.step === 'name') {
    if (!text || text.length > 32) return send(chatId, 'Send a name up to 32 characters.'), true;
    store.setSession(userId, { ...s, step: 'symbol', name: text });
    await send(chatId, `Name: <b>${esc(text)}</b> ✓\n\nStep 2 of 4 — send the <b>ticker</b> (2–10 letters, e.g. <i>ROBIN</i>).`);
    return true;
  }
  if (s.step === 'symbol') {
    const sym = text.replace(/^\$/, '').toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(sym)) return send(chatId, 'Ticker must be 2–10 letters/numbers, e.g. ROBIN.'), true;
    store.setSession(userId, { ...s, step: 'image', symbol: sym });
    await send(chatId, `Ticker: <b>$${esc(sym)}</b> ✓\n\nStep 3 of 4 — send an <b>image</b> for the coin (photo), or type <b>skip</b>.`);
    return true;
  }
  if (s.step === 'image') {
    if (/^skip$/i.test(text)) {
      store.setSession(userId, { ...s, step: 'devbuy', pfp: '' });
      return askDevBuy(chatId, userId), true;
    }
    const pfp = await extractPhotoDataUrl(msg).catch(() => null);
    if (!pfp) return send(chatId, 'Send the image as a <b>photo</b> (not a file), or type <b>skip</b>.'), true;
    store.setSession(userId, { ...s, step: 'devbuy', pfp });
    await send(chatId, 'Image received ✓');
    return askDevBuy(chatId, userId), true;
  }
  if (s.step === 'devbuy') {
    let devBuyEth = 0;
    if (!/^(0|no|skip|none)$/i.test(text)) {
      devBuyEth = Number(text);
      if (!(devBuyEth >= 0) || Number.isNaN(devBuyEth)) return send(chatId, 'Send an ETH amount like <b>0.1</b>, or <b>0</b> to skip.'), true;
    }
    store.clearSession(userId);
    await doLaunch(chatId, userId, { name: s.name, symbol: s.symbol, pfp: s.pfp || '', devBuyEth });
    return true;
  }
  return false;
}

function askDevBuy(chatId, userId) {
  return send(chatId,
    'Step 4 of 4 — how much ETH for your <b>first buy</b> (optional)?\n' +
    'Send an amount like <b>0.1</b>, or <b>0</b> to skip. You need enough ETH in your wallet for this + gas.');
}

async function doLaunch(chatId, userId, { name, symbol, pfp, devBuyEth }) {
  const addr = store.addressOf(userId);
  const signer = store.signer(userId, chain.provider);
  const bal = await chain.ethBalance(addr).catch(() => 0n);
  const feeEth = Number(CFG.launchFeeEth || 0);
  const need = ethers.parseEther(String(devBuyEth || 0)) + ethers.parseEther(String(feeEth || 0));
  if (bal <= need) {
    return send(chatId,
      `❌ Not enough ETH. Balance <b>${fmtEth(bal)}</b>, need &gt; <b>${fmtEth(need)}</b> (dev-buy + fee) plus gas.\n` +
      `Deposit to <code>${addr}</code> and try /launch again.`);
  }

  // Optional on-chain bot fee (NOT via Telegram Stars — ToS-compliant).
  if (feeEth > 0 && CFG.feeWallet && ethers.isAddress(CFG.feeWallet)) {
    try {
      const ov = await chain.legacyOv({ value: ethers.parseEther(String(feeEth)), gasLimit: 21000n });
      await (await signer.sendTransaction({ to: CFG.feeWallet, ...ov })).wait();
    } catch (e) { console.error('fee charge failed:', e.message); }
  }

  await send(chatId, `⏳ Launching <b>$${esc(symbol)}</b>… deploying token, pool & curve. This takes a few seconds.`);
  let res;
  try {
    res = await chain.launch(signer, { name, symbol, devBuyWei: ethers.parseEther(String(devBuyEth || 0)) });
  } catch (e) { return send(chatId, `❌ Launch failed: ${esc(shortErr(e))}`); }
  if (!res.token) return send(chatId, `⚠️ Launch tx sent but I couldn’t read the address. Check <a href="${explorerTx(res.hash)}">the tx</a>.`);

  store.noteCoin(userId, res.token, symbol);

  // Best-effort pfp upload (the custodial key is the coin's dev, so it can sign).
  let pfpNote = '';
  if (pfp) {
    try { await setProfile(signer, res.token, { pfpDataUrl: pfp }); pfpNote = '\n🖼️ Image set.'; }
    catch (e) { pfpNote = `\n(image upload will retry — ${esc(shortErr(e))})`; }
  }

  const bought = res.devBought && res.devBought > 0n
    ? `\nYou bought the first <b>${Number(ethers.formatEther(res.devBought)).toLocaleString('en-US', { maximumFractionDigits: 0 })} $${esc(symbol)}</b>.` : '';
  await send(chatId,
    `✅ <b>$${esc(symbol)} is live!</b>${bought}${pfpNote}\n\n` +
    `<b>Token</b> <code>${res.token}</code>\n` +
    `<a href="${coinUrl(res.token)}">📈 Chart / trade</a> · <a href="${explorerAddr(res.token)}">explorer</a>\n\n` +
    `Share the chart link to bring in buyers. Trade more with <code>/buy ${short(res.token)} 0.1</code>.`,
    { reply_markup: { inline_keyboard: [[{ text: '📈 Open chart', url: coinUrl(res.token) }]] } });

  announceLaunch({ name, symbol, token: res.token, devBought: res.devBought }).catch((e) => console.error('announce:', e.message));
}

// Post a new launch into the announce group/channel (free promo). Best-effort.
async function announceLaunch({ name, symbol, token, devBought }) {
  if (!CFG.announceChatId) return;
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
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch(`${tgFile}/${f.file_path}`);
  if (!r.ok) throw new Error('download failed');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('image too large');
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
      case '/withdraw': return await cmdWithdraw(chatId, userId, arg);
      case '/buy': return await cmdBuy(chatId, userId, arg);
      case '/sell': return await cmdSell(chatId, userId, arg);
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
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data;
  try { await tg('answerCallbackQuery', { callback_query_id: cb.id }); } catch { /* ignore */ }
  switch (data) {
    case 'launch': return launchStart(chatId, userId);
    case 'balance': return cmdBalance(chatId, userId);
    case 'deposit': return cmdDeposit(chatId, userId);
    case 'withdraw': return send(chatId, 'To withdraw: <code>/withdraw 0xYourAddress</code>');
    case 'mycoins': return cmdMycoins(chatId, userId);
    case 'help': return send(chatId, HELP, { reply_markup: menuKb });
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

async function main() {
  // Fail fast if the bot token or RPC is wrong.
  const me = await tg('getMe').catch((e) => { console.error('getMe failed:', e.message); process.exit(1); });
  const net = await chain.provider.getNetwork().catch((e) => { console.error('RPC failed:', e.message); process.exit(1); });
  console.log(`Launch bot @${me.username} up · chain ${net.chainId} · ${store.userCount()} wallets`);
  await setupCommands();

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

main();
