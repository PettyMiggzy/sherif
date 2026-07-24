// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — Buyback & Burn Bot
//
//   node index.js --status   show the burn wallet, balances, dip state, totals
//   node index.js --once     run ONE cycle now, then exit
//   node index.js            run every INTERVAL_MIN minutes (hourly by default)
//
// Each cycle:
//   1) burns any ROBIN sent directly to the wallet;
//   2) checks the price and, if it's DIPPING, spends a little ETH to buy & burn.
// Fund the printed wallet address with Robinhood ETH (and/or send it ROBIN).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { CFG, DEAD, CHAIN, explorerTx, explorerAddr } from './config.js';
import { makeProvider, buybackBurn, burnHeld, tokenContract, spendAmount, probePrice, pruneHistory, dipReference, isDip } from './burn.js';

const provider = makeProvider(CFG.rpc);
const wallet = new ethers.Wallet(CFG.pk, provider);
const TOKEN = ethers.getAddress(CFG.token);

const DATA_DIR = path.resolve(CFG.dataDir);
const LEDGER = path.join(DATA_DIR, 'burns.json');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const nowSec = () => Math.floor(Date.now() / 1000);
const fmt = (wei, d = 6) => Number(ethers.formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: d });
const compact = (n) => { n = Number(n); const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return n.toFixed(0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A row of burn emojis scaled to the ETH value of the burn (bigger → more).
// Uses a custom animated Telegram emoji when CUSTOM_EMOJI_ID is set (fallback char
// shown to non-Premium viewers); otherwise the plain emoji.
function emojiCount(ethValue) {
  if (!Number.isFinite(ethValue) || ethValue <= 0) return 3;
  return Math.max(1, Math.min(CFG.emojiMax, Math.round(ethValue / CFG.emojiStepEth)));
}
function burnRow(ethValue) {
  const unit = CFG.customEmojiId ? `<tg-emoji emoji-id="${CFG.customEmojiId}">${CFG.emoji}</tg-emoji>` : CFG.emoji;
  return unit.repeat(emojiCount(ethValue));
}
// ETH value (in ETH) of a token amount, using the cycle's price probe ratio.
function ethValueOf(tokensWei, priceRatio) {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return NaN;
  return (priceRatio * Number(tokensWei)) / 1e18;
}

function load() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { burns: [], totalEth: '0', totalTokens: '0', history: [] }; } }
function save(l) {
  if (l.burns.length > 5000) l.burns = l.burns.slice(-5000);
  const tmp = LEDGER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 }); fs.renameSync(tmp, LEDGER);
}
function addBurn(l, ethSpentWei, tokensWei, buyHash, burnHash, sym, dec) {
  l.burns.push({ ts: nowSec(), ethSpent: ethSpentWei.toString(), tokensBurned: tokensWei.toString(), buyHash, burnHash });
  l.totalEth = (BigInt(l.totalEth) + BigInt(ethSpentWei)).toString();
  l.totalTokens = (BigInt(l.totalTokens) + BigInt(tokensWei)).toString();
  l.symbol = sym; l.decimals = dec;
}

async function announce(text) {
  if (!CFG.tgToken || !CFG.tgChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.tgChat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { console.error('announce failed:', e.message); }
}

async function tokenMeta() {
  const erc = tokenContract(TOKEN, provider);
  const [sym, dec] = await Promise.all([erc.symbol().catch(() => '?'), erc.decimals().catch(() => 18)]);
  return { sym, dec: Number(dec) };
}

async function status() {
  const { sym, dec } = await tokenMeta();
  const erc = tokenContract(TOKEN, provider);
  const [bal, dead] = await Promise.all([provider.getBalance(wallet.address), erc.balanceOf(DEAD).catch(() => 0n)]);
  const l = load();
  const ref = dipReference(pruneHistory(l.history, nowSec(), CFG.dipWindowHrs));
  console.log('── Robin Labs Buyback & Burn ──');
  console.log('Burn wallet:   ', wallet.address);
  console.log('  fund it at:  ', explorerAddr(wallet.address), '(send ETH to buy&burn, or send $' + sym + ' to burn directly)');
  console.log('ETH balance:   ', fmt(bal), 'ETH');
  console.log('Per-cycle spend:', CFG.buyback, 'ETH   ·   every', CFG.intervalMin, 'min   ·   dip gate', CFG.dipPct + '% over', CFG.dipWindowHrs + 'h');
  console.log('Dip reference: ', ref == null ? '(building history…)' : ref.toExponential(4), `· ${l.history?.length || 0} samples`);
  console.log('Burned by bot: ', compact(ethers.formatUnits(BigInt(l.totalTokens), dec)), `$${sym}  (spent ${fmt(BigInt(l.totalEth))} ETH over ${l.burns.length} burns)`);
  console.log('Total at DEAD: ', compact(ethers.formatUnits(dead, dec)), `$${sym}  (all-time, everyone)`);
}

async function runOnce() {
  const l = load();
  const { sym, dec } = await tokenMeta();

  // 0) Price probe first, so we can value a sent-in burn (and gate the dip buy).
  let price = null;
  try { price = await probePrice(provider, TOKEN, ethers.parseEther(CFG.probeEth)); }
  catch (e) { console.error('price probe failed:', e.message); } // held-burn still proceeds; buy is skipped below

  // 1) Burn any ROBIN sent directly to the wallet — always, regardless of dips.
  try {
    const held = await burnHeld(wallet, provider, TOKEN);
    if (held) {
      addBurn(l, 0n, held.tokensBurned, null, held.hash, sym, dec);
      save(l);
      const amt = compact(ethers.formatUnits(held.tokensBurned, dec));
      const ethVal = ethValueOf(held.tokensBurned, price);
      console.log(`[burn] ${amt} $${sym} sent-in and burned. tx ${held.hash.slice(0, 12)}…`);
      await announce(`${burnRow(ethVal)}\n\n🔥 <b>Burn</b>\n\nBurned <b>${amt} $${sym}</b> (sent straight to the fire).\n<a href="${explorerTx(held.hash)}">tx ↗</a>`);
    }
  } catch (e) { console.error('held-burn failed:', e.message); }

  // 2) Roll the dip window (needs a price).
  if (price == null) { console.log('[hold] no price this cycle — skipping buy.'); save(l); return; }
  l.history = pruneHistory(l.history, nowSec(), CFG.dipWindowHrs);
  const ref = dipReference(l.history);
  l.history.push({ ts: nowSec(), price });
  save(l);

  // 3) Enough ETH? Is it a dip?
  const bal = await provider.getBalance(wallet.address);
  const spendWei = spendAmount({
    balanceWei: bal, buyback: CFG.buyback,
    gasReserveWei: ethers.parseEther(CFG.gasReserve), minBalanceWei: ethers.parseEther(CFG.minBalance),
  });
  if (spendWei <= 0n) { console.log(`[hold] ETH balance ${fmt(bal)} below the min/gas threshold — fund ${wallet.address}.`); return; }
  if (!isDip(price, ref, CFG.dipPct)) {
    console.log(`[hold] not a dip (price ${price.toExponential(4)} vs ref ${ref == null ? 'n/a' : ref.toExponential(4)}, need ≤ -${CFG.dipPct}%) — holding ETH.`);
    return;
  }

  // 4) Dip → buy & burn.
  console.log(`[buy] dip detected — spending ${fmt(spendWei)} ETH to buy & burn $${sym}…`);
  const r = await buybackBurn(wallet, provider, { token: TOKEN, spendWei, slippagePct: CFG.slippagePct });
  addBurn(l, r.ethSpent, r.tokensBurned, r.buyHash, r.burnHash, sym, dec);
  save(l);
  const burned = ethers.formatUnits(r.tokensBurned, dec);
  console.log(`[burn] ${compact(burned)} $${sym} bought & burned. buy ${r.buyHash.slice(0, 12)}… burn ${r.burnHash.slice(0, 12)}…`);
  await announce(
    `${burnRow(Number(ethers.formatEther(r.ethSpent)))}\n\n🔥 <b>Dip Buyback &amp; Burn</b>\n\n` +
    `Bought the dip with <b>${fmt(r.ethSpent)} ETH</b> → burned <b>${compact(burned)} $${sym}</b> forever.\n` +
    `Total burned by the bot: <b>${compact(ethers.formatUnits(BigInt(l.totalTokens), dec))} $${sym}</b>.\n` +
    `<a href="${explorerTx(r.burnHash)}">burn tx ↗</a>`);
}

async function main() {
  const arg = (process.argv[2] || '').replace(/^--/, '');
  const net = await provider.getNetwork().catch((e) => { console.error('RPC failed:', e.message); process.exit(1); });
  if (Number(net.chainId) !== CHAIN.id) { console.error(`Wrong chain: RPC is ${net.chainId}, expected ${CHAIN.id}`); process.exit(1); }

  if (arg === 'status') return status();
  if (arg === 'once') { await runOnce().catch((e) => { console.error('cycle failed:', e.message); process.exit(1); }); return; }

  console.log(`Buyback & Burn · wallet ${wallet.address} · every ${CFG.intervalMin}m · ${CFG.buyback} ETH/dip · dip ${CFG.dipPct}%/${CFG.dipWindowHrs}h`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
  for (;;) {
    try { await runOnce(); } catch (e) { console.error('cycle failed:', e.message); }
    await sleep(CFG.intervalMin * 60 * 1000);
  }
}

main();
