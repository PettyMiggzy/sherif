/*
 * Robin V4 wiring check — [M-7] / [M-11]
 *
 * A curve pad is only fully wired after FIVE separate, platform-held, ONE-SHOT calls. They are spread across
 * three contracts, none of them requires the others, and every one of them fails SILENTLY when missed: the
 * money simply accrues somewhere else, or to nobody, and nothing on chain complains.
 *
 *   curve.setStaking(pool)                        the graduation reservoir + sell-side LP fee stream
 *   curve.setFloor(vault)                         the BUY-side LP carve, swept to the floor at graduation
 *   curve.setAmbush(vault)                        the ambushGradBps slice of the raise
 *   hook.setFloorRecipient(poolId, vault)         the SELL-TAX carve — a SECOND, independent floor wiring
 *   lockVault.setStakingRecipient(lpTokenId, …)   only needed if setStaking was missed before graduate()
 *
 * The two that were missing from the shipped runbook are the ones this script exists for. `curve.setFloor`
 * and `hook.setFloorRecipient` are BOTH called "the floor" and route different money; nothing requires them
 * to name the same address. Miss the hook one and every sell's floor carve accrues into hook.floorOwed with
 * claimFloor reverting NoFloorRecipient.
 *
 * ORDERING, and why it is not a preference: graduate() copies curve.staking into LockVault.registerLaunch as
 * the locked LP's token-leg fee recipient. Call curve.setStaking BEFORE graduate() and that wiring is correct
 * and permanent. Call it after and the lock registers with address(0) — LockVault.claimStaking then has no
 * recipient, which since [M-11] reverts NoStakingRecipient rather than silently paying the platform, and
 * repairing it needs the separate one-shot setStakingRecipient.
 *
 * Read-only. Exits non-zero if anything is unset, so it can gate a deploy.
 *
 * Usage:
 *   CURVE=0x… [HOOK=0x…] [POOL_ID=0x…] [LOCK_VAULT=0x…] [LP_TOKEN_ID=…] \
 *     npx hardhat run scripts/check-wiring.js --network robinhood
 */
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m·\x1b[0m ${s}`;

const CURVE_ABI = [
  "function staking() view returns (address)",
  "function floor() view returns (address)",
  "function ambush() view returns (address)",
  "function graduated() view returns (bool)",
  "function token() view returns (address)",
];
const HOOK_ABI = [
  "function config(bytes32) view returns (bool registered, bool quoteIsStock, uint16 buyTaxBps, uint16 sellTaxBps, uint16 sellFloorShareBps, uint16 buyBufferShareBps, uint16 referralShareBps, uint32 guardWindow, address currency0, address currency1, address creator, address pendingCreator, address floorRecipient, address bufferRecipient, address guardAdapter)",
];
const LOCK_ABI = [
  "function locks(uint256) view returns (bool registered, address currency0, address currency1, address stakingRecipient)",
];

async function main() {
  const curveAddr = process.env.CURVE;
  if (!curveAddr) throw new Error("set CURVE=0x… (the pad's RobinCurveV4)");

  const curve = new ethers.Contract(curveAddr, CURVE_ABI, ethers.provider);
  const [staking, floor, ambush, graduated] = await Promise.all([
    curve.staking(), curve.floor(), curve.ambush(), curve.graduated(),
  ]);

  const problems = [];
  console.log(`\ncurve ${curveAddr}  (graduated: ${graduated})`);

  const one = (label, addr, note) => {
    if (addr === ZERO) {
      console.log(bad(`${label} — UNSET${note ? ` (${note})` : ""}`));
      problems.push(label);
    } else {
      console.log(ok(`${label} → ${addr}`));
    }
  };

  one("curve.setStaking", staking, "graduation reservoir + sell-side LP fee have nowhere to go");
  one("curve.setFloor", floor, "the buy-side LP carve stays booked on the curve (flushFloor retries)");
  one("curve.setAmbush", ambush, "the ambush slice of the raise stays booked on the curve");

  // the one the runbook used to omit entirely
  if (process.env.HOOK && process.env.POOL_ID) {
    const hook = new ethers.Contract(process.env.HOOK, HOOK_ABI, ethers.provider);
    const cfg = await hook.config(process.env.POOL_ID);
    if (!cfg.registered) {
      console.log(bad("hook.registerPool — this poolId is NOT registered on that hook"));
      problems.push("hook.registerPool");
    }
    one("hook.setFloorRecipient", cfg.floorRecipient, "every sell's floor carve accrues to nobody");
    if (cfg.floorRecipient !== ZERO && floor !== ZERO && cfg.floorRecipient.toLowerCase() !== floor.toLowerCase()) {
      console.log(warn(`the two floor wirings name DIFFERENT addresses: curve.floor=${floor} hook.floorRecipient=${cfg.floorRecipient}`));
      console.log(warn("  that is legal on chain and may be deliberate — confirm it is."));
    }
  } else {
    console.log(warn("hook.setFloorRecipient — not checked (pass HOOK=0x… POOL_ID=0x…)"));
  }

  if (process.env.LOCK_VAULT && process.env.LP_TOKEN_ID) {
    const lv = new ethers.Contract(process.env.LOCK_VAULT, LOCK_ABI, ethers.provider);
    const lk = await lv.locks(process.env.LP_TOKEN_ID);
    if (!lk.registered) {
      console.log(warn("lockVault.registerLaunch — not registered yet (the pad has not graduated)"));
    } else if (lk.stakingRecipient === ZERO) {
      console.log(bad("lockVault stakingRecipient — UNSET (claimStaking reverts NoStakingRecipient until set)"));
      console.log(warn("  this means setStaking was called AFTER graduate(); repair with setStakingRecipient"));
      problems.push("lockVault.setStakingRecipient");
    } else {
      console.log(ok(`lockVault stakingRecipient → ${lk.stakingRecipient}`));
    }
  } else {
    console.log(warn("lockVault stakingRecipient — not checked (pass LOCK_VAULT=0x… LP_TOKEN_ID=…)"));
  }

  if (problems.length) {
    console.log(`\n${problems.length} wiring step(s) missing: ${problems.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nall checked wirings are set");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
