// ─────────────────────────────────────────────────────────────────────────────
// Buyback & burn — the on-chain work
//
// Two ways it burns:
//   • ROBIN sent directly to the wallet → burned as-is (transfer to DEAD).
//   • ETH in the wallet → buys ROBIN through the router, then burns it — but only
//     when the price is DIPPING (below its moving average by DIP_PCT).
//
// Robinhood Chain has NO EIP-1559, so every write is a legacy (type-0) tx with an
// explicit gasPrice. buy() works both on-curve and post-graduation.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers';
import { ADDR, ABI, DEAD, CHAIN } from './config.js';

export function makeProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc, { chainId: CHAIN.id, name: 'robinhood' }, { staticNetwork: true });
}

/** Legacy tx overrides, guarded against a null gasPrice. */
export async function legacyOv(provider, extra = {}) {
  const fee = await provider.getFeeData();
  if (fee.gasPrice == null) throw new Error('RPC returned no gasPrice (a legacy chain must supply one)');
  let gp = fee.gasPrice;
  // Floor above the chain's moving base fee so a tick-up can't underprice the tx
  // ("max fee per gas less than block base fee"). 1.2x base; gas here is ~0.07 gwei.
  try {
    const blk = await provider.getBlock('latest');
    const floor = ((blk?.baseFeePerGas ?? 0n) * 12n) / 10n;
    if (floor > gp) gp = floor;
  } catch { /* keep suggested price on block-read failure */ }
  return { type: 0, gasPrice: gp, ...extra };
}

export function tokenContract(addr, runner) { return new ethers.Contract(addr, ABI.erc20, runner); }

/** Send the wallet's ENTIRE token balance to DEAD. Returns {tokensBurned, hash} or null if none. */
export async function burnHeld(signer, provider, token) {
  const erc = tokenContract(token, signer);
  const bal = await erc.balanceOf(await signer.getAddress());
  if (bal <= 0n) return null;
  const tx = await erc.transfer(DEAD, bal, await legacyOv(provider));
  await tx.wait(1, 180_000);
  return { tokensBurned: bal, hash: tx.hash };
}

/**
 * Price probe: quote how many tokens `probeWei` of ETH buys, and return a price
 * scalar (ETH-per-token, lower = cheaper = a dip). Pure read, no funds needed.
 */
export async function probePrice(provider, token, probeWei) {
  const router = new ethers.Contract(ADDR.router, ABI.router, provider);
  const out = await router.buy.staticCall(token, 0n, { value: probeWei });
  if (out <= 0n) throw new Error('price probe returned ~0 tokens');
  return Number(probeWei) / Number(out); // dimensionless ratio, consistent across cycles
}

/**
 * Buy `spendWei` of ETH worth of `token` through the router, then send everything
 * bought to DEAD. Two legacy txs (buy, then burn-transfer).
 * Returns { ethSpent, tokensBurned, buyHash, burnHash }.
 */
export async function buybackBurn(signer, provider, { token, spendWei, slippagePct }) {
  const me = await signer.getAddress();
  const router = new ethers.Contract(ADDR.router, ABI.router, signer);
  const value = BigInt(spendWei);

  // Quote first so we can set a real slippage floor; abort on revert or a ~0 quote.
  let quoted;
  try { quoted = await router.buy.staticCall(token, 0n, { value }); }
  catch (e) { throw new Error('quote failed (curve/pool state) — ' + (e.shortMessage || e.message)); }
  if (quoted <= 0n) throw new Error('quote returned ~0 tokens — skipping this cycle');
  const minOut = (quoted * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;

  const buyTx = await router.buy(token, minOut, await legacyOv(provider, { value }));
  await buyTx.wait(1, 180_000);

  const erc = tokenContract(token, signer);
  const bal = await erc.balanceOf(me);
  if (bal <= 0n) throw new Error('bought 0 tokens (nothing to burn)');
  const burnTx = await erc.transfer(DEAD, bal, await legacyOv(provider));
  await burnTx.wait(1, 180_000);

  return { ethSpent: value, tokensBurned: bal, buyHash: buyTx.hash, burnHash: burnTx.hash };
}

/** How much ETH to spend this cycle, honoring 'max', the gas reserve, and the min balance. */
export function spendAmount({ balanceWei, buyback, gasReserveWei, minBalanceWei }) {
  if (balanceWei < minBalanceWei) return 0n;
  const spendable = balanceWei > gasReserveWei ? balanceWei - gasReserveWei : 0n;
  if (buyback === 'max') return spendable;
  const want = ethers.parseEther(buyback);
  return want <= spendable ? want : spendable; // never spend into the gas reserve
}

/** Prune a price-history array to the last `windowHrs` and return the kept slice. */
export function pruneHistory(history, nowSec, windowHrs) {
  const cutoff = nowSec - windowHrs * 3600;
  return (history || []).filter((h) => h.ts >= cutoff);
}

/** Average price across a history window (the dip reference), or null if empty. */
export function dipReference(history) {
  if (!history || !history.length) return null;
  return history.reduce((s, h) => s + h.price, 0) / history.length;
}

/**
 * Is `price` a dip vs the rolling reference? dipPct=0 always buys. With no
 * reference yet (fresh start) we do NOT buy on the gate — we wait for a baseline,
 * unless the gate is off.
 */
export function isDip(price, reference, dipPct) {
  if (dipPct === 0) return true;
  if (reference == null) return false;
  return price <= reference * (1 - dipPct / 100);
}
