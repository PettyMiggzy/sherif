// AUTOPILOT — the whole hands-off pipeline in one loop. No funding game.
//
//   1. Watch the distributor (funder) wallet.
//   2. The moment ETH lands, spread it: fund the next N fresh wallets with exactly
//      ONE buy's worth each — as many as the deposit covers (max distinct buyers).
//   3. Immediately buy from each wallet we just funded (we know exactly which ones,
//      so there's no slow full-pool scan).
//   4. Advance a cursor through the pool and repeat forever. When the cursor reaches
//      the end it wraps around, reusing wallets that have spent down.
//
// Send ETH to the distributor whenever you want; it buys on its own. Put it behind
// systemd/pm2 so it stays up.
//   node scripts/autopilot.js
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { getProvider, getWallet, getDisperse, baseFeeGasPrice, safeGetBalance, ethers, CHAIN } = require("./lib");
const { drainWalletBuys, BUY_GAS_LIMIT } = require("./buy-core");

const ROOT = path.join(__dirname, "..");
const STATE_FILE = path.join(ROOT, "autopilot-state.json");

const POLL_MS = Number(process.env.POLL_MS || 12000);
const AMOUNT_IN = BigInt(process.env.BUY_AMOUNT_IN_WEI || "100000000000"); // 1e-7 ETH (floor)
const FUND_BUFFER_BP = BigInt(process.env.FUND_BUFFER_BP || 300);          // +3% over one buy's need
const BUY_CONCURRENCY = Number(process.env.BUY_CONCURRENCY || 8);
const DISPERSE_BATCH = Number(process.env.DISPERSE_BATCH || 300);
const GAS_PER_RECIPIENT = BigInt(process.env.GAS_PER_RECIPIENT || 45000);
const BATCH_OVERHEAD = 60000n;
const GAS_CAP = BigInt(process.env.SAFE_GAS || 16_000_000);
const MIN_DEPOSIT = BigInt(process.env.MIN_DEPOSIT_WEI || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function batchGasLimit(n) { return BigInt(n) * GAS_PER_RECIPIENT + BATCH_OVERHEAD; }
function fitBatch() { let b = DISPERSE_BATCH; while (b > 1 && batchGasLimit(b) > GAS_CAP) b = Math.floor(b / 2); return b; }

function loadKeys() {
  const p = path.join(ROOT, "keys.json");
  if (!fs.existsSync(p)) throw new Error("keys.json missing — run `node scripts/generate-wallets.js` first.");
  const arr = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("keys.json is empty.");
  return arr;
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { cursor: 0, totalBuys: 0, rounds: 0 }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }

// Disperse a flat `amountEach` to `addrs`, split under the per-tx gas cap.
async function fundWallets(disperse, addrs, amountEach, gasPrice) {
  const batch = fitBatch();
  for (let s = 0; s < addrs.length; s += batch) {
    const slice = addrs.slice(s, s + batch);
    const value = amountEach * BigInt(slice.length);
    const tx = await disperse.disperseEqual(slice, amountEach, { type: 0, gasPrice, value, gasLimit: batchGasLimit(slice.length) });
    const rc = await tx.wait();
    log(`  funded [${Math.min(s + batch, addrs.length)}/${addrs.length}] gas ${rc.gasUsed}  ${tx.hash}`);
  }
}

// Buy from every wallet we just funded, a few in parallel (independent nonces).
async function buyFromAll(provider, walletKeys, gasPrice) {
  let idx = 0, totalBuys = 0;
  async function worker() {
    while (idx < walletKeys.length) {
      const k = walletKeys[idx++];
      const wallet = new ethers.Wallet(k.privateKey, provider);
      const { buys } = await drainWalletBuys({ wallet, provider, amountIn: AMOUNT_IN, gasPrice, log });
      totalBuys += buys;
      if ((idx % 250) === 0) log(`  …bought from ${idx}/${walletKeys.length} wallets (${totalBuys} buys so far)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(BUY_CONCURRENCY, walletKeys.length) }, worker));
  return totalBuys;
}

async function main() {
  const provider = getProvider();
  const funder = getWallet(provider);
  const disperse = getDisperse(null, funder);
  const keys = loadKeys();
  const state = loadState();

  log(`AUTOPILOT up on ${CHAIN.name}`);
  log(`funder(distributor)=${funder.address}  disperse=${await disperse.getAddress()}  pool=${keys.length} wallets`);
  log(`buy amount=${ethers.formatEther(AMOUNT_IN)} ETH  buyGasLimit=${BUY_GAS_LIMIT}  cursor=${state.cursor}  lifetime buys=${state.totalBuys}`);
  log(`Send ETH to ${funder.address} anytime — it funds wallets and buys automatically. Ctrl-C to stop.\n`);

  // Spend whatever the funder holds down to dust. Each pass funds up to the whole
  // pool (one buy's worth each) and buys from them, then loops immediately. A small
  // pool (e.g. 200) just gets CYCLED many times per deposit — reusing warm wallets,
  // which is the cheapest way to rack up the most transactions. A big pool gets
  // funded in one pass. When nothing's left to fund, idle until the next deposit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const bal = await safeGetBalance(provider, funder.address);
      const gasPrice = await baseFeeGasPrice(provider);
      const perBuyNeed = BUY_GAS_LIMIT * gasPrice + AMOUNT_IN;
      const fundPerWallet = perBuyNeed + (perBuyNeed * FUND_BUFFER_BP) / 10000n;
      // The funder ALSO pays gas to send ETH to each wallet (~35k fresh, ~10k once it
      // exists). Reserve it per wallet or the disperse tx underfunds. GAS_PER_RECIPIENT
      // (45k) is a safe ceiling.
      const costPerWallet = fundPerWallet + GAS_PER_RECIPIENT * gasPrice;
      if (bal < costPerWallet || bal < MIN_DEPOSIT) { await sleep(POLL_MS); continue; }

      let n = Number(bal / costPerWallet);
      if (n > keys.length) n = keys.length; // one buy per wallet per pass; the loop reuses the pool
      const picks = [];
      for (let i = 0; i < n; i++) picks.push(keys[(state.cursor + i) % keys.length]);
      const addrs = picks.map((k) => k.address);
      log(`balance ${ethers.formatEther(bal)} ETH → funding ${n} wallets @ ${ethers.formatEther(fundPerWallet)} ETH each (${ethers.formatUnits(gasPrice, "gwei")} gwei)`);
      await fundWallets(disperse, addrs, fundPerWallet, gasPrice);
      log(`  buying from ${n} wallets (${BUY_CONCURRENCY} at a time)…`);
      const buys = await buyFromAll(provider, picks, gasPrice);
      state.cursor = (state.cursor + n) % keys.length;
      state.totalBuys += buys;
      state.rounds += 1;
      saveState(state);
      log(`✓ round ${state.rounds}: ${buys} buys from ${n} wallets. Lifetime ${state.totalBuys} buys. cursor=${state.cursor}\n`);
      if (buys === 0) { log("  no buys landed — backing off (RPC/router hiccup?)"); await sleep(POLL_MS); }
    } catch (e) {
      log(`loop error: ${e.shortMessage || e.message}`);
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
