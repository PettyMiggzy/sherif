/*
 * $SHERIFF Buy Bot — ape.store (Robinhood Chain)
 * ----------------------------------------------
 * $SHERIFF is a bonding-curve token on ape.store. This bot polls the ape.store
 * API for new trades, posts BUY alerts to Telegram, and shows the live bonding-
 * curve progress bar (+ king-of-the-hill progress), price and market cap.
 *
 * No keys, no funds — it only reads the public API and posts messages.
 * Config via env only (.env — never commit real secrets).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  mediaUrl:  process.env.MEDIA_URL || '',
  enableCommands: (process.env.ENABLE_COMMANDS || 'true') === 'true',
};
cfg.apePage = process.env.CHART_URL || `https://ape.store/${cfg.apeChain}/${cfg.token}`;

function req(n) { const v = (process.env[n] || '').trim(); if (!v) { console.error(`Missing env ${n} (copy .env.example -> .env)`); process.exit(1); } return v; }

const TG = `https://api.telegram.org/bot${cfg.botToken}`;
const STATE_FILE = path.join(__dirname, 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const usdStr = (n) => (n >= 1 ? '$' + fmt(n, 2) : '$' + Number(n).toPrecision(3));

// ---------- ape.store API ----------
async function apeToken() {
  const r = await fetch(`${cfg.apeBase}/token/${cfg.apeChain}/${cfg.token}`);
  if (!r.ok) throw new Error('token ' + r.status);
  return r.json();
}
async function apeTrades() {
  const r = await fetch(`${cfg.apeBase}/token/${cfg.apeChain}/${cfg.token}/trades`);
  if (!r.ok) throw new Error('trades ' + r.status);
  return r.json();
}
const isBuy = (t) => Number(t.nativeIn) > 0 && Number(t.tokenOut) > 0;

// ---------- telegram ----------
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`TG ${method}:`, j.description || r.status);
  return j;
}
async function say(text, toChat = cfg.chatId) {
  if (cfg.mediaUrl) {
    const isVid = /\.(mp4|webm|mov)$/i.test(cfg.mediaUrl), isGif = /\.gif$/i.test(cfg.mediaUrl);
    const method = isVid ? 'sendVideo' : isGif ? 'sendAnimation' : 'sendPhoto';
    const key = isVid ? 'video' : isGif ? 'animation' : 'photo';
    const res = await tg(method, { chat_id: toChat, [key]: cfg.mediaUrl, caption: text, parse_mode: 'HTML' });
    if (res.ok) return res;
  }
  return tg('sendMessage', { chat_id: toChat, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

// ---------- state ----------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastId: 0, seen: [] }; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId: s.lastId, seen: (s.seen || []).slice(-4000) })); } catch (e) { console.error('state', e.message); } }

// ---------- progress bar ----------
function bar(pct, len = 12) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * len);
  return '▰'.repeat(filled) + '▱'.repeat(len - filled) + `  ${p.toFixed(p < 10 ? 1 : 0)}%`;
}

let meta = { symbol: 'SHERIFF', name: 'Sheriff of Nottingham' };

async function buildBuyMsg(t, info, seenSet) {
  const tokens = Math.abs(Number(t.tokenChange));
  const native = Math.abs(Number(t.nativeVolume));
  const price = Number(info.currentPrice) || 0;         // USD per token
  const usd = tokens * price;
  if (cfg.minBuyUsd && usd < cfg.minBuyUsd) return null;
  const mcap = Number(info.marketCap) || 0;
  const ape = info.apeProgress ?? 0;                    // bonding-curve %
  const king = info.kingProgress ?? 0;                  // king-of-the-hill %
  const hash = String(t.transactionHash).split('[')[0];
  const buyer = String(t.to).toLowerCase();
  const isNew = seenSet && !seenSet.has(buyer);

  const n = Math.max(1, Math.min(72, Math.floor(usd / cfg.emojiStepUsd) || 1));
  const L = [];
  L.push(cfg.buyEmoji.repeat(n));
  L.push('');
  L.push(`<b>$${meta.symbol} Buy!</b> 🐺🏹`);
  L.push(`💰 <b>${usd > 0 ? usdStr(usd) : ''}</b>${usd > 0 ? '  ·  ' : ''}${fmt(native, 5)} ${cfg.nativeSym}`);
  L.push(`🪙 Got: <b>${fmt(tokens, tokens < 1 ? 6 : 0)} ${meta.symbol}</b>`);
  L.push(`👤 <a href="${cfg.explorer}/address/${buyer}">${short(buyer)}</a>${isNew ? '  🆕 New holder' : ''}`);
  if (price) L.push(`📊 ${usdStr(price)}   ·   🏦 MC <b>$${fmt(mcap, 0)}</b>`);
  L.push(`📈 Curve  ${bar(ape)}`);
  if (king) L.push(`👑 King   ${bar(king)}`);
  L.push(`🔗 <a href="${cfg.explorer}/tx/${hash}">TX</a>  |  <a href="${cfg.apePage}">Chart</a>  |  <a href="${cfg.apePage}">Buy</a>`);
  return L.join('\n');
}

// ---------- commands ----------
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
        const isAdmin = cfg.adminId && String(m.from.id) === String(cfg.adminId);
        const cmd = m.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
        if (cmd === '/ping') await say('🟢 Pong. The Sheriff is watching the vault.', m.chat.id);
        else if (cmd === '/status' || cmd === '/curve') {
          try {
            const info = await apeToken();
            await say(
              `<b>$${meta.symbol}</b> — ${meta.name}\n` +
              `📊 ${usdStr(Number(info.currentPrice) || 0)}  ·  🏦 MC $${fmt(info.marketCap || 0, 0)}\n` +
              `📈 Curve  ${bar(info.apeProgress ?? 0)}\n` +
              `👑 King   ${bar(info.kingProgress ?? 0)}\n` +
              `👥 Holders: ${info.token?.holders ?? 0}\n` +
              `🔗 <a href="${cfg.apePage}">ape.store</a>`, m.chat.id);
          } catch { await say('Could not reach ape.store right now.', m.chat.id); }
        } else if (cmd === '/testbuy' && isAdmin) {
          await say(await buildBuyMsg(
            { tokenChange: 5723015.23, nativeVolume: 0.0297, transactionHash: '0x0000…[0x0]', to: '0x1111111111111111111111111111111111111111', nativeIn: '1', tokenOut: '1' },
            await apeToken().catch(() => ({ currentPrice: 6.3e-6, marketCap: 6349, apeProgress: 4, kingProgress: 18 })),
            new Set()) + '\n<i>(test alert)</i>', m.chat.id);
        }
      }
    } catch { await sleep(3000); }
  }
}

// ---------- poll ----------
async function poll(state) {
  let trades;
  try { trades = await apeTrades(); } catch (e) { console.error('trades', e.message); return; }
  const info = await apeToken().catch(() => null);
  if (info) { meta.symbol = info.token?.symbol || meta.symbol; meta.name = info.token?.name || meta.name; }
  const seen = new Set(state.seen || []);
  // ascending by id; only new ones
  const fresh = trades.filter((t) => t.id > state.lastId).sort((a, b) => a.id - b.id);
  for (const t of fresh) {
    state.lastId = Math.max(state.lastId, t.id);
    const buyer = String(t.to).toLowerCase();
    if (isBuy(t) && info) {
      try { const msg = await buildBuyMsg(t, info, seen); if (msg) await say(msg); }
      catch (e) { console.error('buy msg', e.message); }
    }
    seen.add(buyer);
  }
  state.seen = [...seen];
  saveState(state);
}

// ---------- boot ----------
async function main() {
  const check = process.argv.includes('--check');
  console.log(`Sheriff Buy Bot (ape.store/${cfg.apeChain}) — token ${cfg.token}`);
  let info;
  try { info = await apeToken(); } catch (e) { console.error('ape.store unreachable:', e.message); process.exit(1); }
  meta.symbol = info.token?.symbol || meta.symbol; meta.name = info.token?.name || meta.name;
  console.log(`Token: ${meta.name} ($${meta.symbol})  price ${usdStr(Number(info.currentPrice) || 0)}  MC $${fmt(info.marketCap || 0, 0)}`);
  console.log(`Curve ${info.apeProgress ?? 0}%  ·  King ${info.kingProgress ?? 0}%  ·  pair ${info.token?.pairAddress || '?'}`);

  const state = loadState();
  if (check) { console.log('Check OK.'); process.exit(0); }

  if (process.argv.includes('--preview')) {
    const trades = await apeTrades();
    const buy = trades.filter(isBuy).sort((a, b) => b.id - a.id)[0];
    if (!buy) { console.log('No recent buy to preview.'); process.exit(0); }
    const msg = await buildBuyMsg(buy, info, new Set());
    console.log('\n----- BUY ALERT PREVIEW (not sent) -----\n');
    console.log(msg.replace(/<[^>]+>/g, ''));   // strip HTML tags for terminal
    console.log('\n----------------------------------------');
    process.exit(0);
  }

  // first run: don't replay history
  if (!state.lastId) {
    const trades = await apeTrades().catch(() => []);
    state.lastId = trades.reduce((m, t) => Math.max(m, t.id), 0);
    state.seen = trades.map((t) => String(t.to).toLowerCase());
    saveState(state);
    console.log('Baselined at trade id', state.lastId, `(watching new buys only)`);
  }

  if (cfg.adminId) say('🟢 <b>Sheriff Buy Bot online.</b> Watching ape.store for buys…', cfg.adminId).catch(() => {});
  commandLoop();
  console.log(`Polling ape.store every ${cfg.pollMs}ms…`);
  for (;;) { try { await poll(state); } catch (e) { console.error('poll', e.message); } await sleep(cfg.pollMs); }
}
main().catch((e) => { console.error(e); process.exit(1); });
