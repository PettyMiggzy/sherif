/*
 * $SHERIFF Buy Bot — Robinhood Chain
 * -----------------------------------
 * Watches the token's liquidity pair for BUYS and posts alerts to Telegram.
 * Config comes from environment variables (.env — never commit real secrets).
 *
 * Buy detection: an ERC-20 Transfer where `from` == the LP pair address means
 * tokens left the pool = a buy. The paired base-token that flowed INTO the pool
 * in the same tx is the amount spent (used for price / market-cap).
 *
 * Works with UniswapV2-style pairs (token0/token1/getReserves). If the pair or
 * base token can't be resolved it degrades gracefully and still posts the token
 * amount + buyer + tx link.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const cfg = {
  botToken:   req('TELEGRAM_BOT_TOKEN'),
  chatId:     req('TELEGRAM_CHAT_ID'),
  adminId:    (process.env.ADMIN_ID || '').trim(),
  rpc:        process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId:    Number(process.env.CHAIN_ID || 4663),
  explorer:   (process.env.EXPLORER || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
  token:      req('TOKEN_ADDRESS').toLowerCase(),
  pair:       (process.env.PAIR_ADDRESS || '').toLowerCase(),
  nativeUsd:  process.env.NATIVE_USD ? Number(process.env.NATIVE_USD) : null,
  minBuyUsd:  process.env.MIN_BUY_USD ? Number(process.env.MIN_BUY_USD) : 0,
  buyEmoji:   process.env.BUY_EMOJI || '🟢',
  emojiStepUsd: Number(process.env.EMOJI_STEP_USD || 25),
  pollMs:     Number(process.env.POLL_MS || 15000),
  chartUrl:   process.env.CHART_URL || '',
  buyUrl:     process.env.BUY_URL || '',
  mediaUrl:   process.env.MEDIA_URL || '', // optional gif/mp4/png shown with each buy
  ticker:     process.env.TICKER || 'SHERIFF',
  enableCommands: (process.env.ENABLE_COMMANDS || 'true') === 'true',
};

function req(name) {
  const v = (process.env[name] || '').trim();
  if (!v) { console.error(`Missing required env var: ${name} (copy .env.example -> .env)`); process.exit(1); }
  return v;
}

const TG = `https://api.telegram.org/bot${cfg.botToken}`;
const STATE_FILE = path.join(__dirname, 'state.json');
const ERC20 = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const token = new ethers.Contract(cfg.token, ERC20, provider);

// ---------- telegram helpers ----------
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`TG ${method} failed:`, j.description || r.status);
  return j;
}
async function say(text, toChat = cfg.chatId) {
  if (cfg.mediaUrl) {
    const isVid = /\.(mp4|webm|mov)$/i.test(cfg.mediaUrl);
    const isGif = /\.gif$/i.test(cfg.mediaUrl);
    const method = isVid ? 'sendVideo' : isGif ? 'sendAnimation' : 'sendPhoto';
    const key = isVid ? 'video' : isGif ? 'animation' : 'photo';
    const res = await tg(method, { chat_id: toChat, [key]: cfg.mediaUrl, caption: text, parse_mode: 'HTML' });
    if (res.ok) return res;
    // fall through to text if media fails
  }
  return tg('sendMessage', { chat_id: toChat, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

// ---------- state ----------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.error('state save', e.message); } }

// ---------- token / pair metadata ----------
let meta = { symbol: cfg.ticker, decimals: 18, totalSupply: 0n };
let pairInfo = null; // { address, base: {address,symbol,decimals,isStable} }

async function loadMeta() {
  meta.symbol = await token.symbol().catch(() => cfg.ticker);
  meta.decimals = Number(await token.decimals().catch(() => 18));
  meta.totalSupply = await token.totalSupply().catch(() => 0n);
}

// Auto-detect the LP pair by scanning recent Transfer logs for the most active
// contract address; verify it exposes token0/token1 that includes our token.
async function resolvePair() {
  if (cfg.pair) { await describePair(cfg.pair); return; }
  console.log('No PAIR_ADDRESS set — attempting auto-detection from recent transfers…');
  const latest = await provider.getBlockNumber();
  const span = 40000; // scan window
  const topic = ethers.id('Transfer(address,address,uint256)');
  const counts = new Map();
  for (let from = Math.max(0, latest - span); from <= latest; from += 8000) {
    const to = Math.min(from + 7999, latest);
    let logs = [];
    try { logs = await provider.getLogs({ address: cfg.token, topics: [topic], fromBlock: from, toBlock: to }); }
    catch { continue; }
    for (const l of logs) {
      const a = '0x' + l.topics[1].slice(26);
      const b = '0x' + l.topics[2].slice(26);
      counts.set(a.toLowerCase(), (counts.get(a.toLowerCase()) || 0) + 1);
      counts.set(b.toLowerCase(), (counts.get(b.toLowerCase()) || 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  for (const [addr] of ranked.slice(0, 8)) {
    if (addr === cfg.token || addr === ethers.ZeroAddress) continue;
    const code = await provider.getCode(addr).catch(() => '0x');
    if (code === '0x') continue;
    const ok = await describePair(addr).catch(() => false);
    if (ok) { console.log('Auto-detected pair:', addr); return; }
  }
  console.warn('Could not auto-detect a pair. Set PAIR_ADDRESS in .env for buy detection.');
}

async function describePair(addr) {
  const p = new ethers.Contract(addr, PAIR_ABI, provider);
  const [t0, t1] = await Promise.all([p.token0(), p.token1()]);
  const [t0l, t1l] = [t0.toLowerCase(), t1.toLowerCase()];
  if (t0l !== cfg.token && t1l !== cfg.token) return false;
  const baseAddr = t0l === cfg.token ? t1l : t0l;
  const base = new ethers.Contract(baseAddr, ERC20, provider);
  const [bsym, bdec] = await Promise.all([base.symbol().catch(() => 'BASE'), base.decimals().catch(() => 18)]);
  pairInfo = { address: addr.toLowerCase(),
    base: { address: baseAddr, symbol: bsym, decimals: Number(bdec), isStable: /usd|dai/i.test(bsym) } };
  console.log(`Pair ${addr}  base=${bsym} (${baseAddr})`);
  return true;
}

// ---------- formatting ----------
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
function short(a) { return a.slice(0, 6) + '…' + a.slice(-4); }
function usdStr(n) { return n >= 1 ? '$' + fmt(n, 2) : '$' + Number(n).toPrecision(3); }

async function buildBuyMessage(ev) {
  const tokensOut = Number(ethers.formatUnits(ev.value, meta.decimals));
  const buyer = ev.to;
  const lines = [];
  let usd = null, priceUsd = null, mcap = null, spentStr = '';

  // amount spent (base into pair) from the same tx
  if (pairInfo) {
    try {
      const rc = await provider.getTransactionReceipt(ev.txHash);
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      let baseIn = 0n;
      for (const log of rc.logs) {
        if (log.address.toLowerCase() !== pairInfo.base.address) continue;
        if (log.topics[0] !== transferTopic) continue;
        const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
        if (to === pairInfo.address) baseIn += BigInt(log.data);
      }
      if (baseIn > 0n) {
        const baseHuman = Number(ethers.formatUnits(baseIn, pairInfo.base.decimals));
        const baseUsd = pairInfo.base.isStable ? 1 : (cfg.nativeUsd || null);
        spentStr = `${fmt(baseHuman, 4)} ${pairInfo.base.symbol}`;
        if (baseUsd) {
          usd = baseHuman * baseUsd;
          priceUsd = (baseHuman / tokensOut) * baseUsd;
          if (meta.totalSupply > 0n)
            mcap = Number(ethers.formatUnits(meta.totalSupply, meta.decimals)) * priceUsd;
        }
      }
    } catch (e) { /* price optional */ }
  }

  if (usd !== null && usd < cfg.minBuyUsd) return null; // below threshold

  // emoji bar scales with size
  const units = usd !== null ? usd : tokensOut / 1000;
  const n = Math.max(1, Math.min(64, Math.floor(units / cfg.emojiStepUsd) || 1));
  lines.push(cfg.buyEmoji.repeat(n));
  lines.push('');
  lines.push(`<b>$${meta.symbol} Buy!</b> 🐺🏹`);
  if (usd !== null) lines.push(`💰 <b>${usdStr(usd)}</b>${spentStr ? `  ·  ${spentStr}` : ''}`);
  else if (spentStr) lines.push(`💸 Spent: <b>${spentStr}</b>`);
  lines.push(`🪙 Got: <b>${fmt(tokensOut, tokensOut < 1 ? 6 : 0)} ${meta.symbol}</b>`);

  // holder status
  let status = '';
  try {
    const bal = await token.balanceOf(buyer);
    const balHuman = Number(ethers.formatUnits(bal, meta.decimals));
    status = balHuman - tokensOut < tokensOut * 0.02 ? '  🆕 New holder' : '';
  } catch {}
  lines.push(`👤 <a href="${cfg.explorer}/address/${buyer}">${short(buyer)}</a>${status}`);
  if (priceUsd) lines.push(`📊 Price: <b>${usdStr(priceUsd)}</b>`);
  if (mcap) lines.push(`🏦 MCap: <b>$${fmt(mcap, 0)}</b>`);

  const links = [`<a href="${cfg.explorer}/tx/${ev.txHash}">TX</a>`];
  if (cfg.chartUrl) links.push(`<a href="${cfg.chartUrl}">Chart</a>`);
  if (cfg.buyUrl) links.push(`<a href="${cfg.buyUrl}">Buy</a>`);
  lines.push('🔗 ' + links.join('  |  '));
  return lines.join('\n');
}

// ---------- main poll loop ----------
async function poll(state) {
  if (!pairInfo) return; // nothing to watch reliably
  const latest = await provider.getBlockNumber();
  let from = state.lastBlock ? state.lastBlock + 1 : latest;
  if (from > latest) return;
  const topic = ethers.id('Transfer(address,address,uint256)');
  const pairTopic = ethers.zeroPadValue(pairInfo.address, 32);
  const step = 2000;
  for (let b = from; b <= latest; b += step) {
    const to = Math.min(b + step - 1, latest);
    let logs = [];
    try { logs = await provider.getLogs({ address: cfg.token, topics: [topic, pairTopic], fromBlock: b, toBlock: to }); }
    catch (e) { console.error('getLogs', e.message); continue; }
    for (const log of logs) {
      const ev = {
        from: '0x' + log.topics[1].slice(26),
        to: '0x' + log.topics[2].slice(26),
        value: BigInt(log.data),
        txHash: log.transactionHash,
      };
      if (ev.to.toLowerCase() === pairInfo.address) continue; // pair->pair / adds, skip
      try {
        const msg = await buildBuyMessage(ev);
        if (msg) await say(msg);
      } catch (e) { console.error('buy msg', e.message); }
    }
  }
  state.lastBlock = latest;
  saveState(state);
}

// ---------- admin commands (long poll) ----------
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
        if (cmd === '/ping') await say('🟢 Pong. Sheriff is watching.', m.chat.id);
        else if (cmd === '/status') {
          await say(
            `<b>Sheriff Buy Bot</b>\n` +
            `Token: <code>${cfg.token}</code>\n` +
            `Pair: <code>${pairInfo ? pairInfo.address : 'not resolved'}</code>\n` +
            `Watching chain ${cfg.chainId}. Min buy: $${cfg.minBuyUsd}.`, m.chat.id);
        } else if (cmd === '/testbuy' && isAdmin) {
          await say(
            `${cfg.buyEmoji.repeat(6)}\n\n<b>$${meta.symbol} Buy!</b> 🐺🏹\n💰 <b>$420.69</b>\n🪙 Got: <b>1,000,000 ${meta.symbol}</b>\n👤 <a href="${cfg.explorer}/address/0x0000000000000000000000000000000000000000">0x0000…0000</a>  🆕 New holder\n🔗 <i>(test alert)</i>`,
            m.chat.id);
        }
      }
    } catch (e) { await sleep(3000); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- boot ----------
async function main() {
  const check = process.argv.includes('--check');
  console.log(`Sheriff Buy Bot — chain ${cfg.chainId}, token ${cfg.token}`);
  const net = await provider.getNetwork().catch((e) => { console.error('RPC error:', e.message); process.exit(1); });
  console.log('Connected. chainId', Number(net.chainId), 'block', await provider.getBlockNumber());

  const code = await provider.getCode(cfg.token).catch(() => '0x');
  if (code === '0x') {
    console.warn('⚠️  No contract code at TOKEN_ADDRESS on this chain yet.');
    console.warn('   The token is not a live ERC-20 here (pre-deploy / launchpad / wrong chain).');
    if (check) process.exit(2);
    console.warn('   Will keep retrying every 60s until it goes live…');
    while ((await provider.getCode(cfg.token).catch(() => '0x')) === '0x') await sleep(60000);
  }

  await loadMeta();
  console.log(`Token: ${meta.symbol} (${meta.decimals} dec), supply ${fmt(Number(ethers.formatUnits(meta.totalSupply, meta.decimals)), 0)}`);
  await resolvePair();

  if (check) {
    console.log('Check complete. Pair:', pairInfo ? pairInfo.address : 'NONE');
    process.exit(pairInfo ? 0 : 3);
  }

  const state = loadState();
  if (!state.lastBlock) { state.lastBlock = await provider.getBlockNumber(); saveState(state); }

  if (cfg.adminId) say('🟢 <b>Sheriff Buy Bot online.</b> Watching the vault…', cfg.adminId).catch(() => {});
  commandLoop();

  console.log(`Polling every ${cfg.pollMs}ms…`);
  for (;;) {
    try { await poll(state); } catch (e) { console.error('poll', e.message); }
    await sleep(cfg.pollMs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
