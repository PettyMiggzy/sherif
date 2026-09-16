/*
 * Robin V4 wiring check — SIMPLIFIED FEE MODEL (Arc / [SIMPLE-FEES] pads)
 *
 * Sibling of check-wiring.js, for pads launched under the simplified fee model (see
 * ARC-FEES-AND-NOTES.md): floor and ambush are deliberately retired — curve.setFloor,
 * curve.setAmbush, and hook.setFloorRecipient are NEVER called for these pads, on purpose. Running
 * the ORIGINAL check-wiring.js against one of these pads would misreport all three as "UNSET —
 * problem", when actually that's the correct, intended state. This script checks only what still
 * matters for this fee model:
 *
 *   curve.setStaking(pool)   where the shared trader-rebate/referral pool's ETH ends up (both the
 *                            buy-side buffer carve and the sell-side carve join stakingEthOwed via
 *                            _fundStakingEth() — see RobinFeeHook.sol's [SIMPLE-FEES v2] comments).
 *                            If unset, that money just parks in stakingEthOwed, retriable via
 *                            flushStakingEth() once staking IS wired — not lost, just delayed.
 *
 * bufferRecipient (the hook's half of this) needs NO separate check: the factory wires it
 * automatically in the same launch transaction (RobinFeeHook.setBufferRecipient, factory-only),
 * unlike floor/ambush which were always separate, easy-to-forget, platform-triggered follow-up calls.
 *
 * curve.setFloor / curve.setAmbush / hook.setFloorRecipient / lockVault.setStakingRecipient are all
 * checked here too, but reported as INFORMATIONAL (expected-unset), not problems — so a stray
 * accidental wiring shows up (worth knowing) without a correct, deliberately-unwired pad failing
 * the gate.
 *
 * Read-only. Exits non-zero only if curve.staking is unset.
 *
 * Usage:
 *   CURVE=0x… npx hardhat run scripts/check-wiring-simple.js --network localhost   (or --network arc)
 */
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const info = (s) => `\x1b[36m·\x1b[0m ${s}`;

const CURVE_ABI = [
  "function staking() view returns (address)",
  "function floor() view returns (address)",
  "function ambush() view returns (address)",
  "function graduated() view returns (bool)",
  "function noPoolForever() view returns (bool)",
];

async function main() {
  const curveAddr = process.env.CURVE;
  if (!curveAddr) throw new Error("set CURVE=0x… (the pad's RobinCurveV4)");

  const curve = new ethers.Contract(curveAddr, CURVE_ABI, ethers.provider);
  const [staking, floor, ambush, graduated, noPoolForever] = await Promise.all([
    curve.staking(), curve.floor(), curve.ambush(), curve.graduated(), curve.noPoolForever(),
  ]);

  console.log(`\ncurve ${curveAddr}  (graduated: ${graduated}, noPoolForever: ${noPoolForever})`);
  if (!noPoolForever) {
    console.log(info("this pad has noPoolForever=false — it's a LEGACY pad, not a [SIMPLE-FEES] one."));
    console.log(info("run scripts/check-wiring.js instead (floor/ambush ARE expected to be wired there)."));
  }

  let problem = false;
  if (staking === ZERO) {
    console.log(bad("curve.setStaking — UNSET (the trader-rebate/referral pool's ETH has nowhere to go yet)"));
    console.log(bad("  not lost — parks in stakingEthOwed, retriable via flushStakingEth() once this is wired"));
    problem = true;
  } else {
    console.log(ok(`curve.setStaking → ${staking}`));
  }

  // Expected-unset for a [SIMPLE-FEES] pad — informational only, never fails the check. A nonzero
  // value here is unusual (not wrong, just worth a human's attention) since nothing in this fee
  // model wires them.
  const expectUnset = (label, addr) => {
    if (addr === ZERO) console.log(info(`${label} — unset (expected: floor/ambush are retired for this fee model)`));
    else console.log(info(`${label} → ${addr}  (unexpected for a [SIMPLE-FEES] pad — worth confirming this is deliberate)`));
  };
  expectUnset("curve.floor", floor);
  expectUnset("curve.ambush", ambush);

  if (problem) {
    console.log("\nwiring incomplete: curve.setStaking is missing");
    process.exitCode = 1;
  } else {
    console.log("\nall wiring this fee model needs is set");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
