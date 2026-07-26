// Shared distribution pass used by watch.js and disperse-once.js.
// Pays a fixed `amountEach` ($0.0000814) to as many recipients as the funding
// wallet affords, through the Disperse contract, in the FEWEST txs that stay
// under the gas cap (one tx when the wallets already exist). Gas is pinned to
// baseFee. Anything not spent stays in your wallet — it's yours to collect.
const { safeGetBalance, baseFeeOverrides, baseFeeGasPrice, ethers } = require("./lib");

// Stay comfortably under the 2^24 (16,777,216) per-tx gas cap.
const SAFE_GAS = BigInt(process.env.SAFE_GAS || 14_000_000);

// Probe real per-recipient gas (adapts to fresh ~35k vs existing ~10k wallets),
// then pick the largest batch that fits SAFE_GAS.
async function chooseBatch(disperse, from, recipients, amountEach) {
  const probeN = Math.min(64, recipients.length);
  let perGas = 40000n;
  try {
    const g = await disperse.disperseEqual.estimateGas(
      recipients.slice(0, probeN), amountEach,
      { value: amountEach * BigInt(probeN), from }
    );
    perGas = g / BigInt(probeN);
  } catch { /* keep conservative default */ }
  if (perGas < 1n) perGas = 1n;
  let batch = Number(SAFE_GAS / perGas);
  if (batch < 1) batch = 1;
  if (batch > recipients.length) batch = recipients.length;
  return { batch, perGas };
}

/**
 * Run one distribution pass. Returns { count, sentWei, gasWei }.
 */
async function distributeOnce({ provider, wallet, disperse, recipients, amountEach, log }) {
  const balance = await safeGetBalance(provider, wallet.address);
  if (balance === 0n) { log(`balance 0 — nothing to do.`); return { count: 0, sentWei: 0n, gasWei: 0n }; }

  const { batch, perGas } = await chooseBatch(disperse, wallet.address, recipients, amountEach);
  const gasPrice = await baseFeeGasPrice(provider);

  // Per-recipient cost = the value + its gas. Fund as many as the balance covers,
  // capped at the recipient count (fixed: one $0.0000814 each).
  const perRecipientCost = amountEach + perGas * gasPrice;
  let count = perRecipientCost > 0n ? Number(balance / perRecipientCost) : 0;
  if (count > recipients.length) count = recipients.length;
  if (count <= 0) {
    log(`balance ${ethers.formatEther(balance)} ETH — not enough for one wallet (${ethers.formatEther(amountEach)} + gas).`);
    return { count: 0, sentWei: 0n, gasWei: 0n };
  }

  const list = recipients.slice(0, count);
  const txsNeeded = Math.ceil(count / batch);
  log(`Dispersing ${ethers.formatEther(amountEach)} ETH to ${count}/${recipients.length} wallets ` +
      `in ${txsNeeded} tx${txsNeeded === 1 ? "" : "s"} (batch ${batch}, ~${perGas} gas/wallet, ${ethers.formatUnits(gasPrice, "gwei")} gwei)…`);

  let sentWei = 0n, gasWei = 0n;
  for (let start = 0; start < count; start += batch) {
    const slice = list.slice(start, start + batch);
    const value = amountEach * BigInt(slice.length);
    const ov = await baseFeeOverrides(provider, { value });
    const tx = await disperse.disperseEqual(slice, amountEach, ov);
    const rc = await tx.wait();
    sentWei += value;
    gasWei += rc.gasUsed * (rc.gasPrice ?? ov.gasPrice);
    log(`  [${Math.min(start + batch, count)}/${count}] gas ${rc.gasUsed}  ${tx.hash}`);
  }
  log(`✓ sent ${ethers.formatEther(sentWei)} ETH to ${count} wallets; gas ${ethers.formatEther(gasWei)} ETH. Leftover stays in your wallet.`);
  return { count, sentWei, gasWei };
}

module.exports = { distributeOnce, chooseBatch, SAFE_GAS };
