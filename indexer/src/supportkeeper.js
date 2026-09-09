// ─────────────────────────────────────────────────────────────────────────────
// Support keeper — keeps each v4 pad's FLOOR and MARKET-MAKER vaults actually working.
//
// WHY THIS EXISTS
// The support apparatus is permissionless but not automatic. The floor wall, the two-sided ambush band
// and the unsold-supply sell band all sit idle until somebody calls a poke on them:
//   • carve arrives as ETH and PARKS until addFloor() / seedAmbush() places it,
//   • unsold supply PARKS until seedSellBand() places it,
//   • LP fees accrue inside the position until collectFees() realizes and forwards them
//     (ambush: ETH -> floor, token -> staking; floor: ETH -> platform, token -> staking).
// "Anyone can call it" is not a plan. The live v3 stack proves it: graduate() has been permissionless
// and bounty-paying since launch and has NEVER fired in production — 9 coins, 46k trades, 0 graduated,
// because nobody was actually running the loop. With 15% of every raise now seeding the market maker,
// an unpoked vault means the floor silently never grows.
//
// WHAT IT DOES per pad, per pass:
//   read the pad's floor/ambush from its curve → STATE-DRIVEN seeds (only when something is parked,
//   so we never burn gas on a no-op) → TIME-DRIVEN fee collects on a slow cadence → each call is
//   staticCall'd first and skipped if it would revert, so a doomed tx is never broadcast.
//
// SAFETY: every function here is permissionless, takes no arguments, and can only move money to sinks
// that were already wired one-shot at launch. The keeper cannot choose a destination, cannot withdraw,
// and cannot pass a price or size. The worst case for a bad poke is a wasted transaction.
//
// OFF unless SUPPORT_KEEPER_KEY (or KEEPER_KEY) and SUPPORT_CURVES are set and SUPPORT_KEEPER != 0.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { beat } from "./heartbeat.js";

const KEY = process.env.SUPPORT_KEEPER_KEY || process.env.KEEPER_KEY || "";
const CURVES = (process.env.SUPPORT_CURVES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ENABLED = !!KEY && CURVES.length > 0 && process.env.SUPPORT_KEEPER !== "0";

const POLL_MS = Number(process.env.SUPPORT_POLL_MS || 120_000);
const FEE_MS = Number(process.env.SUPPORT_FEE_MS || 3_600_000); // fee-collect cadence per pad
const GAS_MULT = Number(process.env.SUPPORT_GAS_MULT || 1.2);
const GAS_CAP = (() => {
  try { const v = BigInt(process.env.SUPPORT_GAS_CAP || 4_000_000); return v > 0n ? v : 4_000_000n; }
  catch { return 4_000_000n; }
})();
const MIN_BALANCE_WEI = (() => {
  try { return ethers.parseEther(process.env.SUPPORT_MIN_BALANCE || "0.005"); }
  catch { return ethers.parseEther("0.005"); }
})();

const CURVE_ABI = [
  "function floor() view returns (address)",
  "function ambush() view returns (address)",
  "function graduated() view returns (bool)",
];
const AMBUSH_ABI = [
  "function parkedEth() view returns (uint256)",
  "function sellPrincipal() view returns (uint256)",
  "function seedAmbush() returns (uint128)",
  "function seedSellBand() returns (uint128)",
  "function collectFees()",
];
const FLOOR_ABI = [
  "function parkedQuote() view returns (uint256)",
  "function tokenSink() view returns (address)",
  "function addFloor() returns (uint128)",
  "function collectFloorFees()",
  "function sweepTokenFees() returns (uint256)",
];

const lastFeeAt = new Map(); // pad -> ms
const stats = { passes: 0, sent: 0, skipped: 0, errors: 0 };

/// Fire a no-arg poke, but only after a staticCall proves it would not revert. These are all
/// permissionless and destination-fixed, so the only thing at risk is the gas.
async function poke(label, contract, fn, gasPrice) {
  try {
    await contract[fn].staticCall();
  } catch {
    stats.skipped++;
    return false; // would revert (nothing to do / not ready) — never broadcast it
  }
  let gas = GAS_CAP;
  try { gas = (await contract[fn].estimateGas()) * 125n / 100n; } catch {}
  if (gas > GAS_CAP) gas = GAS_CAP;
  try {
    const tx = await contract[fn]({ type: 0, gasPrice, gasLimit: gas });
    stats.sent++;
    console.log(`[support] ${label} ${fn}() — tx ${tx.hash}`);
    tx.wait(1, 20_000).catch(() => {});
    return true;
  } catch (e) {
    stats.errors++;
    console.log(`[support] ${label} ${fn}() send failed: ${(e && e.shortMessage) || (e && e.message) || e}`);
    return false;
  }
}

async function servicePad(p, signer, curveAddr, gasPrice) {
  const label = curveAddr.slice(0, 10);
  const curve = new ethers.Contract(curveAddr, CURVE_ABI, p);

  // Pre-graduation there is nothing to service: the carve is still booked on the curve, the vaults are
  // not deployed yet, and the curve IS the floor (no liquidity exists below the launch price).
  try { if (!(await curve.graduated())) return; } catch { return; }

  let floorAddr = ethers.ZeroAddress, ambushAddr = ethers.ZeroAddress;
  try { floorAddr = await curve.floor(); } catch {}
  try { ambushAddr = await curve.ambush(); } catch {}

  if (ambushAddr !== ethers.ZeroAddress) {
    const a = new ethers.Contract(ambushAddr, AMBUSH_ABI, signer);
    // STATE-DRIVEN: only place what is actually parked, so a quiet pad costs nothing.
    try { if ((await a.parkedEth()) > 0n) await poke(label, a, "seedAmbush", gasPrice); } catch {}
    try { if ((await a.sellPrincipal()) > 0n) await poke(label, a, "seedSellBand", gasPrice); } catch {}
  }
  if (floorAddr !== ethers.ZeroAddress) {
    const f = new ethers.Contract(floorAddr, FLOOR_ABI, signer);
    try { if ((await f.parkedQuote()) > 0n) await poke(label, f, "addFloor", gasPrice); } catch {}
  }

  // TIME-DRIVEN: realizing LP fees has no cheap "is there anything there" view, so it runs on a slow
  // cadence rather than every pass. Gas is pennies on this L2; spamming it every two minutes is not.
  const due = (lastFeeAt.get(curveAddr) || 0) + FEE_MS < Date.now();
  if (!due) return;
  lastFeeAt.set(curveAddr, Date.now());
  if (ambushAddr !== ethers.ZeroAddress) {
    const a = new ethers.Contract(ambushAddr, AMBUSH_ABI, signer);
    await poke(label, a, "collectFees", gasPrice); // ETH -> floor, token -> staking
  }
  if (floorAddr !== ethers.ZeroAddress) {
    const f = new ethers.Contract(floorAddr, FLOOR_ABI, signer);
    await poke(label, f, "collectFloorFees", gasPrice); // ETH -> platform, token parks in-vault
    try {
      // only worth a tx once a sink exists, else it reverts NoTokenSink every time
      if ((await f.tokenSink()) !== ethers.ZeroAddress) await poke(label, f, "sweepTokenFees", gasPrice);
    } catch {}
  }
}

export async function runSupportKeeper(provider) {
  if (!ENABLED) {
    console.log("[support] disabled (needs SUPPORT_KEEPER_KEY + SUPPORT_CURVES, and SUPPORT_KEEPER != 0)");
    return;
  }
  const p = provider || new ethers.JsonRpcProvider(CFG.rpcUrl);
  const signer = new ethers.Wallet(KEY, p); // plain wallet: a failed send consumes no nonce
  console.log(`[support] armed — wallet ${signer.address} servicing ${CURVES.length} pad(s)`);

  for (;;) {
    try {
      stats.passes++;
      const bal = await p.getBalance(signer.address);
      if (bal <= MIN_BALANCE_WEI) {
        console.log(`[support] low balance (${ethers.formatEther(bal)} ETH) — skipping pass`);
      } else {
        const fee = await p.getFeeData();
        const gasPrice = BigInt(Math.floor(Number(fee.gasPrice || 0n) * GAS_MULT)) || fee.gasPrice || 0n;
        for (const c of CURVES) {
          try { await servicePad(p, signer, c, gasPrice); }
          catch (e) { console.log(`[support] ${c.slice(0, 10)} pass error: ${(e && e.message) || e}`); }
        }
      }
    } catch (e) {
      console.log(`[support] poll error: ${(e && e.shortMessage) || (e && e.message) || e}`);
    }
    beat("support");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function supportStats() {
  return { enabled: ENABLED, pads: CURVES.length, ...stats };
}

if (import.meta.url === `file://${process.argv[1]}`) runSupportKeeper();
