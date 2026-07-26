// Shared distribution pass used by watch.js and disperse-once.js.
// Pays a fixed `amountEach` ($0.0000814) to as many recipients as the funding
// wallet affords, through the Disperse contract, in batches under the gas cap.
// Gas is pinned to baseFee. Anything not spent stays in your wallet — yours.
//
// This chain's RPC can't eth_estimateGas reliably ("missing revert data"), so we
// NEVER estimate: every send carries an explicit gasLimit derived from a fixed
// per-recipient budget.
const { safeGetBalance, baseFeeGasPrice, ethers } = require("./lib");

// Fixed per-recipient gas budget. A first-ever payment to a fresh wallet is
// ~35k (incl. account creation); existing wallets ~10k. 45k is a safe ceiling.
const GAS_PER_RECIPIENT = BigInt(process.env.GAS_PER_RECIPIENT || 45000);
const BATCH_OVERHEAD = 60000n;               // intrinsic + refund headroom per tx
const GAS_CAP = BigInt(process.env.SAFE_GAS || 16_000_000); // stay under 2^24
let BATCH = Number(process.env.DISPERSE_BATCH || 300);

function batchGasLimit(n) { return BigInt(n) * GAS_PER_RECIPIENT + BATCH_OVERHEAD; }

/**
 * Run one distribution pass. Returns { count, sentWei, gasWei }.
 */
async function distributeOnce({ provider, wallet, disperse, recipients, amountEach, log }) {
  const balance = await safeGetBalance(provider, wallet.address);
  if (balance === 0n) { log("balance 0 — nothing to do."); return { count: 0, sentWei: 0n, gasWei: 0n }; }

  const gasPrice = await baseFeeGasPrice(provider);

  // Shrink the batch until its gasLimit fits under the per-tx cap.
  let batch = BATCH;
  while (batch > 1 && batchGasLimit(batch) > GAS_CAP) batch = Math.floor(batch / 2);

  // Fund as many wallets as the balance covers (value + gas), capped at the list.
  const perRecipientCost = amountEach + GAS_PER_RECIPIENT * gasPrice;
  let count = perRecipientCost > 0n ? Number(balance / perRecipientCost) : 0;
  if (count > recipients.length) count = recipients.length;
  if (count <= 0) {
    log(`balance ${ethers.formatEther(balance)} ETH — not enough for one wallet (${ethers.formatEther(amountEach)} + gas).`);
    return { count: 0, sentWei: 0n, gasWei: 0n };
  }

  const list = recipients.slice(0, count);
  const txsNeeded = Math.ceil(count / batch);
  log(`Dispersing ${ethers.formatEther(amountEach)} ETH to ${count}/${recipients.length} wallets ` +
      `in ${txsNeeded} tx${txsNeeded === 1 ? "" : "s"} (batch ${batch}, ${ethers.formatUnits(gasPrice, "gwei")} gwei)…`);

  let sentWei = 0n, gasWei = 0n;
  for (let start = 0; start < count; start += batch) {
    const slice = list.slice(start, start + batch);
    const value = amountEach * BigInt(slice.length);
    const gasLimit = batchGasLimit(slice.length);
    const tx = await disperse.disperseEqual(slice, amountEach, { type: 0, gasPrice, value, gasLimit });
    const rc = await tx.wait();
    sentWei += value;
    gasWei += rc.gasUsed * (rc.gasPrice ?? gasPrice);
    log(`  [${Math.min(start + batch, count)}/${count}] gas ${rc.gasUsed}  ${tx.hash}`);
  }
  log(`✓ sent ${ethers.formatEther(sentWei)} ETH to ${count} wallets; gas ${ethers.formatEther(gasWei)} ETH. Leftover stays in your wallet.`);
  return { count, sentWei, gasWei };
}

module.exports = { distributeOnce };
