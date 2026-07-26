// Shared distribution pass used by watch.js and disperse-once.js.
//
// Two modes (env DISPERSE_MODE):
//   fixed (default) — send a flat `amountEach` ($0.0000814) to each wallet; the
//                     rest of the balance stays in your wallet.
//   even            — split the WHOLE balance across the wallets (drain it);
//                     each wallet gets (balance − gas) / walletCount.
//
// Use MAX_WALLETS to spread across fewer wallets (so each gets more).
//
// This chain's RPC can't eth_estimateGas reliably ("missing revert data"), so we
// NEVER estimate: every send carries an explicit gasLimit.
const { safeGetBalance, baseFeeGasPrice, ethers } = require("./lib");

// Per-recipient gas budget (ceiling + reserve). Existing wallets cost ~10k, fresh
// ~35k. 45k is a safe ceiling; lower it (env) to drain more in even mode when you
// know the wallets already exist.
const GAS_PER_RECIPIENT = BigInt(process.env.GAS_PER_RECIPIENT || 45000);
const BATCH_OVERHEAD = 60000n;
const GAS_CAP = BigInt(process.env.SAFE_GAS || 16_000_000);
const BATCH = Number(process.env.DISPERSE_BATCH || 300);

function batchGasLimit(n) { return BigInt(n) * GAS_PER_RECIPIENT + BATCH_OVERHEAD; }

/**
 * Run one distribution pass. `amountEach` is used only in fixed mode.
 * @returns { count, sentWei, gasWei }
 */
async function distributeOnce({ provider, wallet, disperse, recipients, amountEach, log }) {
  const mode = (process.env.DISPERSE_MODE || "fixed").toLowerCase();
  const balance = await safeGetBalance(provider, wallet.address);
  if (balance === 0n) { log("balance 0 — nothing to do."); return { count: 0, sentWei: 0n, gasWei: 0n }; }

  const gasPrice = await baseFeeGasPrice(provider);
  let batch = BATCH;
  while (batch > 1 && batchGasLimit(batch) > GAS_CAP) batch = Math.floor(batch / 2);

  let count, each;
  if (mode === "even") {
    // Drain the whole balance across every recipient, minus a gas reserve.
    count = recipients.length;
    const reserve = BigInt(count) * GAS_PER_RECIPIENT * gasPrice;
    const distributable = balance > reserve ? balance - reserve : 0n;
    each = count > 0 ? distributable / BigInt(count) : 0n;
    if (each <= 0n) {
      log(`balance ${ethers.formatEther(balance)} ETH too low to even-split across ${count} wallets after gas.`);
      return { count: 0, sentWei: 0n, gasWei: 0n };
    }
  } else {
    each = amountEach; // fixed
    const perRecipientCost = each + GAS_PER_RECIPIENT * gasPrice;
    count = perRecipientCost > 0n ? Number(balance / perRecipientCost) : 0;
    if (count > recipients.length) count = recipients.length;
    if (count <= 0) {
      log(`balance ${ethers.formatEther(balance)} ETH — not enough for one wallet (${ethers.formatEther(each)} + gas).`);
      return { count: 0, sentWei: 0n, gasWei: 0n };
    }
  }

  const list = recipients.slice(0, count);
  const txsNeeded = Math.ceil(count / batch);
  log(`[${mode}] Dispersing ${ethers.formatEther(each)} ETH to ${count}/${recipients.length} wallets ` +
      `in ${txsNeeded} tx${txsNeeded === 1 ? "" : "s"} (batch ${batch}, ${ethers.formatUnits(gasPrice, "gwei")} gwei)…`);

  let sentWei = 0n, gasWei = 0n;
  for (let start = 0; start < count; start += batch) {
    const slice = list.slice(start, start + batch);
    const value = each * BigInt(slice.length);
    const gasLimit = batchGasLimit(slice.length);
    const tx = await disperse.disperseEqual(slice, each, { type: 0, gasPrice, value, gasLimit });
    const rc = await tx.wait();
    sentWei += value;
    gasWei += rc.gasUsed * (rc.gasPrice ?? gasPrice);
    log(`  [${Math.min(start + batch, count)}/${count}] gas ${rc.gasUsed}  ${tx.hash}`);
  }
  log(`✓ sent ${ethers.formatEther(sentWei)} ETH to ${count} wallets; gas ${ethers.formatEther(gasWei)} ETH.` +
      (mode === "even" ? "" : " Leftover stays in your wallet."));
  return { count, sentWei, gasWei };
}

module.exports = { distributeOnce };
