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
const { getProvider, getWallet, getDisperse, baseFeeGasPrice, safeGetBalance, getEthUsd, ethers, CHAIN } = require("./lib");
const { drainWalletBuys, buyOnce, BUY_GAS_LIMIT } = require("./buy-core");

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
// Optional spend throttle: hold outflow to ~$SPEND_USD_PER_HOUR so a deposit drips
// out over time instead of in one burst. 0 = burst (spend as fast as possible).
const SPEND_USD_PER_HOUR = Number(process.env.SPEND_USD_PER_HOUR || 0);
const THROTTLE_MINUTES = Number(process.env.THROTTLE_MINUTES || 2); // budget funded per round when throttling

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

// Drip mode: buy ONE at a time, sleeping `intervalMs` after each buy so the buys
// land spread across many blocks instead of all at once. Used when throttling.
async function buyPaced(provider, walletKeys, gasPrice, intervalMs, log) {
  let total = 0;
  for (const k of walletKeys) {
    const wallet = new ethers.Wallet(k.privateKey, provider);
    for (;;) {
      let bal;
      try { bal = await provider.getBalance(wallet.address, "latest"); } catch { break; }
      if (bal < BUY_GAS_LIMIT * gasPrice + AMOUNT_IN) break; // this wallet can't afford another
      try {
        const tx = await buyOnce(wallet, AMOUNT_IN, gasPrice);
        await tx.wait();
        total++;
      } catch (e) {
        log(`    buy failed ${wallet.address.slice(0, 10)}…: ${e.shortMessage || e.message}`);
        break;
      }
      if (intervalMs > 0) await sleep(intervalMs); // space every single buy apart
    }
  }
  return total;
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

  // Throttle setup: convert the $/hr target into an ETH/hr outflow cap.
  let targetWeiPerHour = 0n, ethUsd = 0, calibUsdPerBuy = 0; // calibUsdPerBuy learned from actual spend
  if (SPEND_USD_PER_HOUR > 0) {
    try { ethUsd = (await getEthUsd()).price; } catch { ethUsd = Number(process.env.ETH_USD || 1900); }
    targetWeiPerHour = BigInt(Math.round((SPEND_USD_PER_HOUR / ethUsd) * 1e18));
    log(`THROTTLE ON: ~$${SPEND_USD_PER_HOUR}/hr (ETH ~$${ethUsd.toFixed(0)} → ${ethers.formatEther(targetWeiPerHour)} ETH/hr). A $30 deposit lasts ~${(30 / SPEND_USD_PER_HOUR).toFixed(1)}h; $100 ~${(100 / SPEND_USD_PER_HOUR).toFixed(0)}h.\n`);
  }

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
      // throttle: fund only ~THROTTLE_MINUTES worth of the target spend per round
      if (targetWeiPerHour > 0n) {
        const perRoundWei = (targetWeiPerHour * BigInt(Math.round(THROTTLE_MINUTES * 100))) / 6000n;
        const capN = Number(perRoundWei / costPerWallet);
        n = capN < 1 ? 1 : Math.min(n, capN);
      }
      const picks = [];
      for (let i = 0; i < n; i++) picks.push(keys[(state.cursor + i) % keys.length]);
      const addrs = picks.map((k) => k.address);
      log(`balance ${ethers.formatEther(bal)} ETH → funding ${n} wallets @ ${ethers.formatEther(fundPerWallet)} ETH each (${ethers.formatUnits(gasPrice, "gwei")} gwei)`);
      await fundWallets(disperse, addrs, fundPerWallet, gasPrice);
      let buys;
      if (targetWeiPerHour > 0n) {
        // drip: space each buy so the round's buys spread evenly at the target rate,
        // instead of firing them all into one block.
        const estUsdPerBuy = calibUsdPerBuy > 0 ? calibUsdPerBuy : (Number(ethers.formatEther(costPerWallet)) * ethUsd) / 1.5;
        const intervalMs = Math.max(0, Math.round((estUsdPerBuy / SPEND_USD_PER_HOUR) * 3600000));
        log(`  dripping buys from ${n} wallets, ~${(intervalMs / 1000).toFixed(1)}s apart…`);
        buys = await buyPaced(provider, picks, gasPrice, intervalMs, log);
      } else {
        log(`  buying from ${n} wallets (${BUY_CONCURRENCY} at a time)…`);
        buys = await buyFromAll(provider, picks, gasPrice);
      }
      const balAfter = await safeGetBalance(provider, funder.address);
      state.cursor = (state.cursor + n) % keys.length;
      state.totalBuys += buys;
      state.rounds += 1;
      saveState(state);
      // learn the real $/buy from actual outflow so the spacing self-corrects next round
      if (targetWeiPerHour > 0n && buys > 0) {
        const spent = bal > balAfter ? bal - balAfter : 0n;
        calibUsdPerBuy = (Number(ethers.formatEther(spent)) * ethUsd) / buys;
      }
      const paceNote = targetWeiPerHour > 0n && calibUsdPerBuy > 0
        ? `  (~$${SPEND_USD_PER_HOUR}/hr, ~${Math.round((calibUsdPerBuy / SPEND_USD_PER_HOUR) * 3600)}s/buy)` : "";
      log(`✓ round ${state.rounds}: ${buys} buys from ${n} wallets. Lifetime ${state.totalBuys} buys. cursor=${state.cursor}${paceNote}\n`);
      if (buys === 0) { log("  no buys landed — backing off (RPC/router hiccup?)"); await sleep(POLL_MS); }
    } catch (e) {
      log(`loop error: ${e.shortMessage || e.message}`);
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
