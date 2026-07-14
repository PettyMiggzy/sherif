/*
 * $SHERIFF Buy Bot — ape.store (Robinhood Chain)
 * ----------------------------------------------
 * Posts BUY alerts (with the animated Sheriff + live bonding-curve bar) and
 * answers a full suite of community commands (/mc, /price, /curve, /top, …).
 * Reads the public ape.store API and posts messages — no keys, no funds.
 * Config via env (.env — never commit real secrets).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MEDIA = path.join(__dirname, 'media', 'buy.mp4');

const cfg = {
  botToken:  req('TELEGRAM_BOT_TOKEN'),
  chatId:    req('TELEGRAM_CHAT_ID'),
  adminId:   (process.env.ADMIN_ID || '').trim(),
  apeBase:   (process.env.APE_API || 'https://ape.store/api').replace(/\/$/, ''),
  apeChain:  process.env.APE_CHAIN || 'robinhood',
  token:     req('TOKEN_ADDRESS').toLowerCase(),
  explorer:  (process.env.EXPLORER || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
  nativeSym: process.env.NATIVE_SYMBOL || 'ETH',
  minBuyUsd: Number(process.env.MIN_BUY_USD || 0),
  buyEmoji:  process.env.BUY_EMOJI || '🟢',
  emojiStepUsd: Number(process.env.EMOJI_STEP_USD || 20),
  pollMs:    Number(process.env.POLL_MS || 12000),
  rpc:       (process.env.RPC_URL || '').trim(),        // premium RPC -> instant on-chain buys
  pair:      (process.env.PAIR_ADDRESS || '').toLowerCase(),
  rpcPollMs: Number(process.env.RPC_POLL_MS || 4000),
  mediaUrl:  (process.env.MEDIA_URL || '').trim(),
  mediaPath: (process.env.MEDIA_PATH || (fs.existsSync(DEFAULT_MEDIA) ? DEFAULT_MEDIA : '')).trim(),
  enableCommands: (process.env.ENABLE_COMMANDS || 'true') === 'true',
  x:   process.env.SOCIAL_X  || 'https://x.com/hoodedsheriff',
  tg:  process.env.SOCIAL_TG || 'https://t.me/hoodedsheriff',
  web: process.env.WEBSITE   || '',
};
cfg.apePage = process.env.CHART_URL || `https://ape.store/${cfg.apeChain}/${cfg.token}`;

function req(n) { const v = (process.env[n] || '').trim(); if (!v) { console.error(`Missing env ${n} (copy .env.example -> .env)`); process.exit(1); } return v; }

const TG = `https://api.telegram.org/bot${cfg.botToken}`;
const STATE_FILE = path.join(__dirname, 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const usdStr = (n) => (Number(n) >= 1 ? '$' + fmt(n, 2) : '$' + Number(n).toPrecision(3));
const compact = (n) => { n = Number(n) || 0; const a = Math.abs(n); if (a >= 1e9) return (n/1e9).toFixed(2)+'B'; if (a >= 1e6) return (n/1e6).toFixed(2)+'M'; if (a >= 1e3) return (n/1e3).toFixed(1)+'K'; return fmt(n, 0); };

// ---------- persistent state ----------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastId: 0, seen: [], mediaFileId: null }; } }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId: store.lastId, seen: (store.seen||[]).slice(-4000), mediaFileId: store.mediaFileId||null, muted: !!store.muted, minBuyUsd: store.minBuyUsd, buyEmoji: store.buyEmoji })); } catch (e) { console.error('state', e.message); } }
const store = loadState();
const effMin   = () => (store.minBuyUsd ?? cfg.minBuyUsd);
const effEmoji = () => (store.buyEmoji || cfg.buyEmoji);

// ---------- ape.store API ----------
async function apeToken()  { const r = await fetch(`${cfg.apeBase}/token/${cfg.apeChain}/${cfg.token}`); if (!r.ok) throw new Error('token ' + r.status); return r.json(); }
async function apeTrades() { const r = await fetch(`${cfg.apeBase}/token/${cfg.apeChain}/${cfg.token}/trades`); if (!r.ok) throw new Error('trades ' + r.status); return r.json(); }
const isBuy  = (t) => Number(t.nativeIn) > 0 && Number(t.tokenOut) > 0;
const isSell = (t) => Number(t.tokenIn) > 0 && Number(t.nativeOut) > 0;

// cached token info (price / MC / curve) — enrichment for both modes
let _info = null, _infoAt = 0;
async function getInfo(maxAgeMs = 10000) {
  if (_info && Date.now() - _infoAt < maxAgeMs) return _info;
  try { _info = await apeToken(); _infoAt = Date.now(); meta.symbol = _info.token?.symbol || meta.symbol; meta.name = _info.token?.name || meta.name; } catch (e) { /* keep last */ }
  return _info;
}

// ---------- premium RPC (on-chain instant buy detection) ----------
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hexInt = (h) => parseInt(h, 16);
const padTopic = (addr) => '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
async function rpc(method, params = []) {
  const r = await fetch(cfg.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || j.error}`);
  return j.result;
}

// ---------- telegram ----------
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`TG ${method}:`, j.description || r.status);
  return j;
}
const DRY = process.argv.includes('--cmd') || process.argv.includes('--dry'); // print instead of posting
async function sendText(text, toChat = cfg.chatId, kb = null) {
  if (DRY) { console.log('\n' + text.replace(/<[^>]+>/g, '') + (kb ? '\n[buttons: ' + kb.flat().map(b => b.text).join(' ') + ']' : '')); return { ok: true }; }
  const body = { chat_id: toChat, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (kb) body.reply_markup = { inline_keyboard: kb };
  return tg('sendMessage', body);
}
function mediaKind(src) {
  if (/\.(mp4|webm|mov)$/i.test(src)) return ['sendVideo', 'video'];
  if (/\.gif$/i.test(src)) return ['sendAnimation', 'animation'];
  return ['sendPhoto', 'photo'];
}
const grabFileId = (res = {}) => res.video?.file_id || res.animation?.file_id || (res.photo && res.photo[res.photo.length-1]?.file_id) || null;

async function sendAlert(text, toChat = cfg.chatId, kb = null) {
  if (DRY) { console.log('\n[🎬 media] ' + text.replace(/<[^>]+>/g, '') + (kb ? '\n[buttons: ' + kb.flat().map(b => b.text).join(' ') + ']' : '')); return { ok: true }; }
  const src = cfg.mediaUrl || cfg.mediaPath;
  const markup = kb ? { reply_markup: { inline_keyboard: kb } } : {};
  if (!src) return sendText(text, toChat, kb);
  const [method, key] = mediaKind(src);
  try {
    if (store.mediaFileId) {
      const j = await tg(method, { chat_id: toChat, [key]: store.mediaFileId, caption: text, parse_mode: 'HTML', ...markup });
      if (j.ok) return j;
      store.mediaFileId = null;
    }
    let j;
    if (cfg.mediaUrl) {
      j = await tg(method, { chat_id: toChat, [key]: cfg.mediaUrl, caption: text, parse_mode: 'HTML', ...markup });
    } else {
      const fd = new FormData();
      fd.append('chat_id', String(toChat)); fd.append('caption', text); fd.append('parse_mode', 'HTML');
      if (kb) fd.append('reply_markup', JSON.stringify({ inline_keyboard: kb }));
      fd.append(key, new Blob([fs.readFileSync(cfg.mediaPath)]), path.basename(cfg.mediaPath));
      const r = await fetch(`${TG}/${method}`, { method: 'POST', body: fd });
      j = await r.json().catch(() => ({}));
      if (!j.ok) console.error(`TG ${method}:`, j.description);
    }
    if (j.ok) { const fid = grabFileId(j.result); if (fid) { store.mediaFileId = fid; saveState(); } return j; }
  } catch (e) { console.error('media send error:', e.message); }
  return sendText(text, toChat, kb);
}

// ---------- helpers ----------
function bar(pct, len = 12) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * len);
  return '▰'.repeat(filled) + '▱'.repeat(len - filled) + `  ${p.toFixed(p > 0 && p < 10 ? 1 : 0)}%`;
}
function pctStr(x) { if (x === null || x === undefined) return '—'; const n = Number(x); const s = n >= 0 ? '🟢 +' : '🔴 '; return s + n.toFixed(1) + '%'; }
const linkKb = () => [[
  { text: '📈 Chart', url: cfg.apePage }, { text: '🪙 Buy', url: cfg.apePage },
], [
  ...(cfg.web ? [{ text: '🌐 Site', url: cfg.web }] : []),
  { text: '𝕏', url: cfg.x }, { text: '✈️ TG', url: cfg.tg },
]];

let meta = { symbol: 'SHERIFF', name: 'Sheriff of Nottingham', ca: cfg.token };

function volumeUsd(trades, price) { return trades.reduce((s, t) => s + Math.abs(Number(t.tokenChange)) * price, 0); }
function supplyOf(info) { const p = Number(info.currentPrice) || 0, mc = Number(info.marketCap) || 0; return p > 0 ? mc / p : 0; }
function topBuyers(trades, price, n = 5) {
  const agg = new Map();
  for (const t of trades) if (isBuy(t)) { const k = String(t.to).toLowerCase(); agg.set(k, (agg.get(k) || 0) + Math.abs(Number(t.tokenChange))); }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([a, tok]) => ({ a, tok, usd: tok * price }));
}

const QUOTES = [
  'Tax first. Ask questions never.', 'The rich deserve more.', 'Your gold looks better in my vault.',
  "Poor is a choice. Mine wasn't.", "I don't steal. I collect.", 'Every road leads to my taxes.',
  'No coin left behind… unless it\'s yours.', 'Your wallet is public property.', 'Justice has a price.',
  "If you're smiling, you're not paying enough.", "Robin Hood is the criminal. I'm just doing my job.",
  'The kingdom runs on taxes… and I own the kingdom.', 'Greed is law.', 'Steal. Tax. Repeat.', 'Protect the rich.',
];
const pick = (a) => a[(Math.random() * a.length) | 0];

async function dashboard(info, trades) {
  const price = Number(info.currentPrice) || 0;
  const vol = trades ? volumeUsd(trades, price) : null;
  const L = [];
  L.push(`<b>🐺 $${meta.symbol}</b> — ${meta.name}`);
  L.push(`📊 Price: <b>${usdStr(price)}</b>`);
  L.push(`🏦 Market Cap: <b>$${fmt(info.marketCap || 0, 0)}</b>`);
  if (info.token?.price1H != null || info.token?.price24H != null)
    L.push(`📈 1h ${pctStr(info.token?.price1H)}   ·   24h ${pctStr(info.token?.price24H)}`);
  if (vol !== null) L.push(`💧 Volume (recent): <b>$${compact(vol)}</b>`);
  L.push(`👥 Holders: <b>${info.token?.holders ?? 0}</b>`);
  L.push('');
  L.push(`📈 Bonding curve  ${bar(info.apeProgress ?? 0)}`);
  L.push(`👑 King of hill   ${bar(info.kingProgress ?? 0)}`);
  return L.join('\n');
}

async function buildBuyMsg(t, info, seenSet) {
  const tokens = Math.abs(Number(t.tokenChange));
  const native = Math.abs(Number(t.nativeVolume));
  const price = Number(info.currentPrice) || 0;
  const usd = tokens * price;
  if (effMin() && usd < effMin()) return null;
  const hash = String(t.transactionHash).split('[')[0];
  const buyer = String(t.to).toLowerCase();
  const isNew = seenSet && !seenSet.has(buyer);
  const n = Math.max(1, Math.min(72, Math.floor(usd / cfg.emojiStepUsd) || 1));
  const L = [];
  L.push(effEmoji().repeat(n)); L.push('');
  L.push(`<b>$${meta.symbol} Buy!</b> 🐺🏹`);
  let money = usd > 0 ? `<b>${usdStr(usd)}</b>` : '';
  if (native > 0) money += (money ? '  ·  ' : '') + `${fmt(native, 5)} ${cfg.nativeSym}`;
  if (money) L.push(`💰 ${money}`);
  L.push(`🪙 Got: <b>${fmt(tokens, tokens < 1 ? 6 : 0)} ${meta.symbol}</b>`);
  L.push(`👤 <a href="${cfg.explorer}/address/${buyer}">${short(buyer)}</a>${isNew ? '  🆕 New holder' : ''}`);
  if (price) L.push(`📊 ${usdStr(price)}   ·   🏦 MC <b>$${fmt(info.marketCap || 0, 0)}</b>`);
  L.push(`📈 Curve  ${bar(info.apeProgress ?? 0)}`);
  if (info.kingProgress) L.push(`👑 King   ${bar(info.kingProgress)}`);
  L.push(`🔗 <a href="${cfg.explorer}/tx/${hash}">TX</a>  |  <a href="${cfg.apePage}">Chart</a>  |  <a href="${cfg.apePage}">Buy</a>`);
  return L.join('\n');
}

// ---------- command router ----------
const HELP = [
  '<b>🐺 Sheriff Bot — commands</b>', '',
  '📊 <b>Market</b>',
  '/price · /mc · /stats · /curve · /king · /vol · /supply · /holders',
  '🏆 <b>Community</b>',
  '/top · /recent · /info · /ca · /chart · /buy · /links · /quote · /shill',
  'ℹ️ /help /ping',
].join('\n');

async function handleCommand(cmd, args, m) {
  const chat = m.chat.id;
  const isAdmin = cfg.adminId && String(m.from.id) === String(cfg.adminId);
  const info = ['price','mc','marketcap','stats','status','curve','progress','king','vol','volume','supply','holders','top','recent','trades','info'].includes(cmd)
    ? await apeToken().catch(() => null) : null;
  if (info) { meta.symbol = info.token?.symbol || meta.symbol; meta.name = info.token?.name || meta.name; }
  const needTrades = ['stats','status','vol','volume','top','recent','trades'].includes(cmd);
  const trades = needTrades ? await apeTrades().catch(() => []) : null;

  switch (cmd) {
    case 'start': case 'help': return sendText(HELP, chat);
    case 'ping': return sendText('🟢 Pong. The Sheriff is watching the vault.', chat);

    case 'price': if (!info) return apiDown(chat);
      return sendText(`📊 <b>$${meta.symbol}</b>: <b>${usdStr(info.currentPrice||0)}</b>\n1h ${pctStr(info.token?.price1H)} · 24h ${pctStr(info.token?.price24H)}`, chat, linkKb());
    case 'mc': case 'marketcap': if (!info) return apiDown(chat);
      return sendText(`🏦 <b>$${meta.symbol}</b> Market Cap: <b>$${fmt(info.marketCap||0,0)}</b>\n📈 Curve ${bar(info.apeProgress??0)}`, chat, linkKb());
    case 'stats': case 'status': if (!info) return apiDown(chat);
      return sendText(await dashboard(info, trades), chat, linkKb());
    case 'curve': case 'progress': if (!info) return apiDown(chat);
      return sendText(`📈 <b>Bonding curve</b>\n${bar(info.apeProgress??0)}\n\nMC $${fmt(info.marketCap||0,0)} — graduates the higher it climbs.`, chat, linkKb());
    case 'king': if (!info) return apiDown(chat);
      return sendText(`👑 <b>King of the hill</b>\n${bar(info.kingProgress??0)}${info.token?.isKing?'\n\n🏆 $'+meta.symbol+' is currently KING!':''}`, chat, linkKb());
    case 'vol': case 'volume': if (!info) return apiDown(chat);
      return sendText(`💧 <b>$${meta.symbol}</b> recent volume: <b>$${compact(volumeUsd(trades||[], Number(info.currentPrice)||0))}</b> (${(trades||[]).length} trades)`, chat, linkKb());
    case 'supply': if (!info) return apiDown(chat);
      return sendText(`🪙 <b>$${meta.symbol}</b> supply: <b>${compact(supplyOf(info))}</b>`, chat);
    case 'holders': if (!info) return apiDown(chat);
      return sendText(`👥 <b>$${meta.symbol}</b> holders: <b>${info.token?.holders ?? 0}</b>`, chat, linkKb());

    case 'top': { if (!info) return apiDown(chat);
      const tb = topBuyers(trades||[], Number(info.currentPrice)||0);
      if (!tb.length) return sendText('No buys in the recent window yet.', chat);
      const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
      const rows = tb.map((b,i)=>`${medals[i]||'▫️'} <a href="${cfg.explorer}/address/${b.a}">${short(b.a)}</a> — ${compact(b.tok)} ${meta.symbol} (${usdStr(b.usd)})`);
      return sendText(`🏆 <b>Top buyers</b> (recent)\n`+rows.join('\n'), chat, linkKb()); }
    case 'recent': case 'trades': { if (!info) return apiDown(chat);
      const price = Number(info.currentPrice)||0;
      const buys = (trades||[]).filter(isBuy).sort((a,b)=>b.id-a.id).slice(0,5);
      if (!buys.length) return sendText('No recent buys.', chat);
      const rows = buys.map(t=>`🟢 ${compact(Math.abs(+t.tokenChange))} ${meta.symbol} · ${usdStr(Math.abs(+t.tokenChange)*price)} — ${short(String(t.to).toLowerCase())}`);
      return sendText(`🧾 <b>Recent buys</b>\n`+rows.join('\n'), chat, linkKb()); }
    case 'info': { if (!info) return apiDown(chat);
      return sendText(
        `🐺 <b>${meta.name}</b> ($${meta.symbol})\n`+
        `<i>${info.token?.description||''}</i>\n\n`+
        `CA: <code>${cfg.token}</code>\n`+
        `Chain: Robinhood Chain (${cfg.apeChain})\n`+
        `📊 ${usdStr(info.currentPrice||0)} · 🏦 $${fmt(info.marketCap||0,0)} · 👥 ${info.token?.holders??0}\n`+
        `📈 Curve ${bar(info.apeProgress??0)}`, chat, linkKb()); }

    case 'ca': case 'contract': return sendText(`📜 <b>$${meta.symbol}</b> contract:\n<code>${cfg.token}</code>`, chat, linkKb());
    case 'chart': return sendText(`📈 Chart & trade $${meta.symbol}:\n${cfg.apePage}`, chat, linkKb());
    case 'buy': return sendText(`🪙 Buy $${meta.symbol} on ape.store:\n${cfg.apePage}`, chat, linkKb());
    case 'links': case 'socials': return sendText(
      `🔗 <b>$${meta.symbol} links</b>\n📈 Chart: ${cfg.apePage}\n𝕏 ${cfg.x}\n✈️ ${cfg.tg}${cfg.web?`\n🌐 ${cfg.web}`:''}`, chat, linkKb());
    case 'quote': return sendText(`🐺 <i>"${pick(QUOTES)}"</i>\n— The Sheriff`, chat);
    case 'gm': return sendText(`☀️ GM, tax collectors. Another day to protect the rich. 🐺💰`, chat);
    case 'shill': return sendAlert(
      `🐺 <b>$${meta.symbol} — Sheriff of Nottingham</b>\n<i>Takes from the poor. Feeds his greed.</i>\n\n`+
      `The taxman meme on Robinhood Chain. He keeps ALL the taxes.\n\n`+
      `📜 <code>${cfg.token}</code>\n📈 ${cfg.apePage}`, chat, linkKb());

    // ---- admin ----
    case 'testbuy': { if (!isAdmin) return; const i = await apeToken().catch(()=>({currentPrice:6.3e-6,marketCap:6349,apeProgress:4,kingProgress:18}));
      const msg = await buildBuyMsg({ tokenChange:5723015.23, nativeVolume:0.0297, transactionHash:'0x0000000000000000000000000000000000000000000000000000000000000000[0x0]', to:'0x1111111111111111111111111111111111111111', nativeIn:'1', tokenOut:'1' }, i, new Set());
      return sendAlert(msg+'\n<i>(test alert)</i>', chat); }
    case 'mute': if (!isAdmin) return; store.muted = true; saveState(); return sendText('🔇 Buy alerts muted.', chat);
    case 'unmute': if (!isAdmin) return; store.muted = false; saveState(); return sendText('🔊 Buy alerts on.', chat);
    case 'setmin': if (!isAdmin) return; { const v = Number(args[0]); if (isNaN(v)) return sendText('Usage: /setmin <usd>', chat); store.minBuyUsd = v; saveState(); return sendText(`✅ Min buy alert set to $${v}.`, chat); }
    case 'setemoji': if (!isAdmin) return; { if (!args[0]) return sendText('Usage: /setemoji 🟢', chat); store.buyEmoji = args[0]; saveState(); return sendText(`✅ Buy emoji set to ${args[0]}.`, chat); }
    case 'say': if (!isAdmin) return; { const text = args.join(' '); if (!text) return sendText('Usage: /say <message>', chat); return sendText(text, cfg.chatId); }
    default: return; // unknown command: ignore
  }
}
const apiDown = (chat) => sendText('⚠️ Could not reach ape.store right now — try again in a moment.', chat);

async function commandLoop() {
  if (!cfg.enableCommands) return;
  let offset = 0;
  for (;;) {
    try {
      const r = await fetch(`${TG}/getUpdates?timeout=30&offset=${offset}`);
      const j = await r.json();
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const m = u.message; if (!m || !m.text) continue;
        const parts = m.text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase().replace(/^\//, '').replace(/@.*$/, '');
        if (!m.text.startsWith('/')) continue;
        try { await handleCommand(cmd, parts.slice(1), m); } catch (e) { console.error('cmd', cmd, e.message); }
      }
    } catch { await sleep(3000); }
  }
}

// ---------- on-chain detection (premium RPC) ----------
async function onchainLoop() {
  let pair = cfg.pair;
  if (!pair) { const info = await getInfo(); pair = (info?.token?.pairAddress || '').toLowerCase(); }
  if (!pair) { console.error('No pair address — set PAIR_ADDRESS. Falling back to ape.store polling.'); return apePollForever(); }
  let dec = 18;
  try { dec = hexInt(await rpc('eth_call', [{ to: cfg.token, data: '0x313ce567' }, 'latest'])) || 18; } catch {}
  let last = hexInt(await rpc('eth_blockNumber'));
  console.log(`⚡ On-chain mode via premium RPC — pair ${pair}, decimals ${dec}, from block ${last}`);
  for (;;) {
    try {
      const latest = hexInt(await rpc('eth_blockNumber'));
      if (latest > last) {
        const logs = await rpc('eth_getLogs', [{ address: cfg.token, topics: [TRANSFER_TOPIC, padTopic(pair)], fromBlock: '0x' + (last + 1).toString(16), toBlock: '0x' + latest.toString(16) }]);
        const info = await getInfo();
        const seen = new Set(store.seen || []);
        for (const log of logs) {
          const buyer = ('0x' + log.topics[2].slice(26)).toLowerCase();
          if (buyer === pair || /^0x0+$/.test(buyer)) { seen.add(buyer); continue; }
          const tokens = Number(BigInt(log.data)) / 10 ** dec;
          let native = 0;
          try { const tx = await rpc('eth_getTransactionByHash', [log.transactionHash]); native = Number(BigInt(tx?.value || '0x0')) / 1e18; } catch {}
          if (info && !store.muted) {
            const t = { tokenChange: tokens, nativeVolume: native, transactionHash: log.transactionHash, to: buyer, nativeIn: '1', tokenOut: '1' };
            try { const msg = await buildBuyMsg(t, info, seen); if (msg) await sendAlert(msg); } catch (e) { console.error('buy', e.message); }
          }
          seen.add(buyer);
        }
        store.seen = [...seen]; last = latest; saveState();
      }
    } catch (e) { console.error('onchain:', e.message); }
    await sleep(cfg.rpcPollMs);
  }
}
async function apePollForever() {
  console.log(`Polling ape.store every ${cfg.pollMs}ms…`);
  for (;;) { try { await poll(); } catch (e) { console.error('poll', e.message); } await sleep(cfg.pollMs); }
}

// ---------- ape.store polling ----------
async function poll() {
  let trades; try { trades = await apeTrades(); } catch (e) { console.error('trades', e.message); return; }
  const info = await apeToken().catch(() => null);
  if (info) { meta.symbol = info.token?.symbol || meta.symbol; meta.name = info.token?.name || meta.name; }
  const seen = new Set(store.seen || []);
  const fresh = trades.filter((t) => t.id > store.lastId).sort((a, b) => a.id - b.id);
  for (const t of fresh) {
    store.lastId = Math.max(store.lastId, t.id);
    const buyer = String(t.to).toLowerCase();
    if (isBuy(t) && info && !store.muted) {
      try { const msg = await buildBuyMsg(t, info, seen); if (msg) await sendAlert(msg); }
      catch (e) { console.error('buy msg', e.message); }
    }
    seen.add(buyer);
  }
  store.seen = [...seen]; saveState();
}

// ---------- boot ----------
async function main() {
  const check = process.argv.includes('--check');
  console.log(`Sheriff Buy Bot (ape.store/${cfg.apeChain}) — token ${cfg.token}`);
  console.log(`Media: ${cfg.mediaUrl || cfg.mediaPath || '(none)'}  ·  Commands: ${cfg.enableCommands}`);
  let info; try { info = await apeToken(); } catch (e) { console.error('ape.store unreachable:', e.message); process.exit(1); }
  meta.symbol = info.token?.symbol || meta.symbol; meta.name = info.token?.name || meta.name;
  console.log(`Token: ${meta.name} ($${meta.symbol})  ${usdStr(info.currentPrice||0)}  MC $${fmt(info.marketCap||0,0)}  Curve ${info.apeProgress??0}%  King ${info.kingProgress??0}%`);
  if (check) { console.log('Check OK.'); process.exit(0); }
  if (process.argv.includes('--cmd')) {
    const i = process.argv.indexOf('--cmd');
    const name = (process.argv[i + 1] || 'help').toLowerCase();
    const rest = process.argv.slice(i + 2);
    const fakeMsg = { chat: { id: cfg.chatId }, from: { id: cfg.adminId || 0 } };
    console.log(`===== /${name} =====`);
    await handleCommand(name, rest, fakeMsg);
    console.log('\n===================');
    process.exit(0);
  }
  if (process.argv.includes('--preview')) {
    const trades = await apeTrades(); const buy = trades.filter(isBuy).sort((a,b)=>b.id-a.id)[0];
    if (!buy) { console.log('No recent buy.'); process.exit(0); }
    console.log('\n----- PREVIEW -----\n' + (await buildBuyMsg(buy, info, new Set())).replace(/<[^>]+>/g,'') + '\n-------------------');
    process.exit(0);
  }
  if (!store.lastId) {
    const trades = await apeTrades().catch(() => []);
    store.lastId = trades.reduce((m, t) => Math.max(m, t.id), 0);
    store.seen = trades.map((t) => String(t.to).toLowerCase());
    saveState(); console.log('Baselined at trade id', store.lastId);
  }
  if (cfg.adminId) sendText('🟢 <b>Sheriff Buy Bot online.</b> /help for commands.', cfg.adminId).catch(() => {});
  if (!DRY) commandLoop();
  if (cfg.rpc) await onchainLoop();   // premium RPC = instant on-chain buys
  else await apePollForever();        // no RPC = ape.store polling
}
main().catch((e) => { console.error(e); process.exit(1); });
