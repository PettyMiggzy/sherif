// Shared distribution pass used by watch.js and disperse-once.js.
//
// Modes (env DISPERSE_MODE):
//   fixed (default) — send a flat amount (INCREMENT_USD) to as many wallets as
//                     the balance affords.
//   even            — split the WHOLE balance across all wallets (drain it).
//   topup           — bring as many wallets as possible UP TO a target balance
//                     (INCREMENT_USD), only sending each the shortfall. Best for
//                     "fund enough for one complete round," and it reuses whatever
//                     the wallets already hold, so the budget stretches furthest.
//
// This chain's RPC can't eth_estimateGas reliably, so every send carries an
// explicit gasLimit (no estimation).
const { safeGetBalance, baseFeeGasPrice, ethers } = require("./lib");

const GAS_PER_RECIPIENT = BigInt(process.env.GAS_PER_RECIPIENT || 45000);
const BATCH_OVERHEAD = 60000n;
const GAS_CAP = BigInt(process.env.SAFE_GAS || 16_000_000);
const BATCH = Number(process.env.DISPERSE_BATCH || 300);
const READ_CONCURRENCY = Number(process.env.READ_CONCURRENCY || 40);

const NONE = { count: 0, sentWei: 0n, gasWei: 0n };
function batchGasLimit(n) { return BigInt(n) * GAS_PER_RECIPIENT + BATCH_OVERHEAD; }
function fitBatch() { let b = BATCH; while (b > 1 && batchGasLimit(b) > GAS_CAP) b = Math.floor(b / 2); return b; }

async function readBalances(provider, addrs) {
  const out = new Array(addrs.length);
  for (let i = 0; i < addrs.length; i += READ_CONCURRENCY) {
    const chunk = addrs.slice(i, i + READ_CONCURRENCY);
    const res = await Promise.all(chunk.map((a) => provider.getBalance(a, "latest").catch(() => 0n)));
    for (let j = 0; j < res.length; j++) out[i + j] = res[j];
  }
  return out;
}

async function distributeOnce({ provider, wallet, disperse, recipients, amountEach, log }) {
  const mode = (process.env.DISPERSE_MODE || "fixed").toLowerCase();
  const balance = await safeGetBalance(provider, wallet.address);
  if (balance === 0n) { log("balance 0 — nothing to do."); return NONE; }

  const gasPrice = await baseFeeGasPrice(provider);
  const gasPer = GAS_PER_RECIPIENT * gasPrice; // per-recipient reserve (matches gasLimit rate)
  const batch = fitBatch();

  // ── topup: fund each wallet up to `target`, as many as the balance allows ──
  if (mode === "topup") {
    const target = amountEach;
    if (target <= 0n) { log("topup target is 0 — set INCREMENT_USD."); return NONE; }
    log(`[topup] reading ${recipients.length} balances (target ${ethers.formatEther(target)} ETH each)…`);
    const bals = await readBalances(provider, recipients);
    let avail = balance;
    const toFund = [], amts = [];
    for (let i = 0; i < recipients.length; i++) {
      if (bals[i] >= target) continue;         // already funded enough
      const deficit = target - bals[i];
      if (avail < deficit + gasPer) break;      // can't afford the next one
      toFund.push(recipients[i]); amts.push(deficit); avail -= deficit + gasPer;
    }
    if (toFund.length === 0) {
      log(`[topup] nothing to do — wallets already at target, or balance ${ethers.formatEther(balance)} ETH too low.`);
      return NONE;
    }
    const txsNeeded = Math.ceil(toFund.length / batch);
    log(`[topup] topping ${toFund.length} wallets up to ${ethers.formatEther(target)} ETH in ${txsNeeded} tx${txsNeeded === 1 ? "" : "s"} (${ethers.formatUnits(gasPrice, "gwei")} gwei)…`);
    let sentWei = 0n, gasWei = 0n;
    for (let s = 0; s < toFund.length; s += batch) {
      const rs = toFund.slice(s, s + batch);
      const as = amts.slice(s, s + batch);
      const value = as.reduce((a, b) => a + b, 0n);
      const tx = await disperse.disperse(rs, as, { type: 0, gasPrice, value, gasLimit: batchGasLimit(rs.length) });
      const rc = await tx.wait();
      sentWei += value; gasWei += rc.gasUsed * (rc.gasPrice ?? gasPrice);
      log(`  [${Math.min(s + batch, toFund.length)}/${toFund.length}] gas ${rc.gasUsed}  ${tx.hash}`);
    }
    log(`✓ topped up ${toFund.length} wallets; sent ${ethers.formatEther(sentWei)} ETH, gas ${ethers.formatEther(gasWei)} ETH.`);
    return { count: toFund.length, sentWei, gasWei };
  }

  // ── fixed / even: send an equal `each` to `count` wallets ──
  let count, each;
  if (mode === "even") {
    count = recipients.length;
    const reserve = BigInt(count) * gasPer;
    const distributable = balance > reserve ? balance - reserve : 0n;
    each = count > 0 ? distributable / BigInt(count) : 0n;
    if (each <= 0n) { log(`balance ${ethers.formatEther(balance)} ETH too low to even-split across ${count} after gas.`); return NONE; }
  } else {
    each = amountEach;
    const perRecipientCost = each + gasPer;
    count = perRecipientCost > 0n ? Number(balance / perRecipientCost) : 0;
    if (count > recipients.length) count = recipients.length;
    if (count <= 0) { log(`balance ${ethers.formatEther(balance)} ETH — not enough for one wallet (${ethers.formatEther(each)} + gas).`); return NONE; }
  }

  const list = recipients.slice(0, count);
  const txsNeeded = Math.ceil(count / batch);
  log(`[${mode}] Dispersing ${ethers.formatEther(each)} ETH to ${count}/${recipients.length} wallets in ${txsNeeded} tx${txsNeeded === 1 ? "" : "s"} (batch ${batch}, ${ethers.formatUnits(gasPrice, "gwei")} gwei)…`);
  let sentWei = 0n, gasWei = 0n;
  for (let start = 0; start < count; start += batch) {
    const slice = list.slice(start, start + batch);
    const value = each * BigInt(slice.length);
    const tx = await disperse.disperseEqual(slice, each, { type: 0, gasPrice, value, gasLimit: batchGasLimit(slice.length) });
    const rc = await tx.wait();
    sentWei += value; gasWei += rc.gasUsed * (rc.gasPrice ?? gasPrice);
    log(`  [${Math.min(start + batch, count)}/${count}] gas ${rc.gasUsed}  ${tx.hash}`);
  }
  log(`✓ sent ${ethers.formatEther(sentWei)} ETH to ${count} wallets; gas ${ethers.formatEther(gasWei)} ETH.` + (mode === "even" ? "" : " Leftover stays in your wallet."));
  return { count, sentWei, gasWei };
}

module.exports = { distributeOnce };
