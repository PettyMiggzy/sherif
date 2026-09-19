const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { MAX_SQRT_LIMIT, E, f, buildLab, ledger, sizePush } = require("../helpers/h5-lab");

// REGRESSION for ROUND-3 EXTERNAL FINDING H-5 (floor forced-fill) — the attack, the two one-constant
// mitigations that do NOT close it, and the structural closure that does. Independently reproduced from
// scratch; the external auditor never committed their PoCs.
//
// THE ATTACK. On a pad that has dumped past the fixed band the carve parks. An attacker buys token to shove the
// tick momentarily below `floorTickLower`, pokes `addFloor` and sells straight back, force-committing the carve
// into the deploy-anchored band at launch-era prices while true spot is far below — then sweeps that fresh ETH
// wall with the sell-back. Repeat. WHY IT IS EXTRACTION, NOT GRIEFING: the identical loop with NO carve nets
// negative (case 1b). Profit exists only when there is a committable carve to skim.
//
// WHAT DOES NOT WORK, both proven below on real contract code:
//   • COMMIT_COOLDOWN > MIN_DWELL (the external auditor's own recommendation) — INERT. Bit-identical attacker
//     PnL; only the wall clock stretches. The attacker is token-flat between commits, so waiting is free.
//   • COMMIT_COOLDOWN > MAX_OBSERVED_GAP (the round-3 interim fix) — closes the token-flat round-trip loop ONLY.
//     [R3 N-A] The SUSTAINED-HOLD variant walks straight through it: the attacker picks the poke cadence, keeps
//     `lastObserved` fresh, and `belowSince` never re-arms. Measured on that build: +10.48 ETH, 83% of the carve.
//
// WHAT DOES WORK — the shipped closure (FLOOR-H5-CLOSURE-SPEC.md, OTG-2), exercised from case 3 onward:
//   P1 the hook stamps `aboveLowerTs` on EVERY swap whose PRE-swap tick is at/above the band, and a commit needs
//      MIN_BELOW_DURATION of continuous, swap-witnessed below-band price. The attacker's own push stamps the
//      watermark in the same transaction, so the round-trip loop can never commit at all.
//   P2 an episode-scoped, NON-REFILLING allowance caps what one episode can commit at EPISODE_BASE_WEI plus the
//      ETH that arrived during that episode — so the sustained hold buys one ~1bp slice, not the backlog.
//   [R3 N-B] the episode is anchored on ANY touch of the band (`aboveLowerTs`), not only on the deep
//      `floorTickUpper` crossing — otherwise a dump that stalls inside the band inherits an uncapped allowance.
//
// The pre-fix baselines are REAL contracts, byte-identical to the shipped vault except the one constant
// (contracts/test/H5PreFixVault.sol = 10 min, H5CooldownVariantVault.sol = 30 min).

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

// [R3 N-A] The SUSTAINED-HOLD variant. The attacker pushes the tick below the band ONCE and HOLDS it there,
// poking on a cadence HE chooses, then unwinds through every wall he minted at the end. This is the variant
// that defeated the round-3 interim fix; P1+P2 are what stop it.
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
    commits, carve0, floorL: await vault.floorLiquidity(), banded: await vault.bandQuoteWei(),
  };
}

describe("[R3 H-5] floor forced-fill — the attack, the inert fixes, and the shipped closure", function () {
  this.timeout(3600000);

  const LAB = { baseL: 10n ** 20n, carve: E(20), dumpTick: 12000 }; // dumped ~70%, 20 ETH parked carve
  const HOOKED = { ...LAB, hookTaxBps: 100 }; // every shipped pad runs 1% buy + 1% sell; 0/0 is contract-forbidden

  it("1a. PRE-FIX constants (cooldown 10m == dwell 10m): the attack is profitable and eats the carve", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB, vaultContract: "H5PreFixVault" }); // the shipped build BEFORE the fix
    const R = await runAttack(L, { rounds: 12, gapSec: 601 });
    console.log(`   pre-fix(dwell 10m == cooldown 10m): best +${f(R.best.pnl)} ETH @r${R.best.r}, carve consumed ${f(R.best.consumed)}/${f(R.carve0)}`);
    expect(R.best.pnl).to.be.gt(0n); // real extraction
    expect(R.best.consumed).to.be.gt(0n); // funded by the carve
    await snap.restore();
  });

  it("1b. CONTROL — the same loop with NO carve nets NEGATIVE (extraction, not griefing)", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB, vaultContract: "H5PreFixVault", carve: 0n });
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

  it("3. [P1] the AUDITOR'S PoC against the SHIPPED vault: the round-trip loop cannot commit at all", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab(HOOKED); // real hook, gate armed — the shipped wiring
    const R = await runAttack(L, { rounds: 8, taxBps: 100, gapSec: 3901 });
    console.log(`   shipped gate: best ${f(R.best.pnl)} ETH, carve consumed ${f(R.best.consumed)}/${f(R.carve0)}, floorLiquidity ${R.floorL}`);
    // P1: the attacker's own push is the swap that stamps `aboveLowerTs`, so his poke is always inside the
    // MIN_BELOW_DURATION shadow of his own transaction. No cadence he can choose escapes it.
    expect(R.floorL).to.equal(0n);
    expect(await L.vault.bandQuoteWei()).to.equal(0n);
    expect(R.best.consumed).to.equal(0n); // the carve is untouched
    expect(R.best.pnl).to.be.lt(0n); // he pays the round-trip fee and gets nothing
    await snap.restore();
  });

  it("3b. CONTROL — the same shipped-gate run with NO carve is indistinguishable (the attack is not extraction)", async () => {
    const snap = await takeSnapshot();
    const withCarve = await runAttack(await buildLab(HOOKED), { rounds: 4, taxBps: 100, gapSec: 3901 });
    await snap.restore();
    const snap2 = await takeSnapshot();
    const noCarve = await runAttack(await buildLab({ ...HOOKED, carve: 0n }), { rounds: 4, taxBps: 100, gapSec: 3901 });
    const delta = withCarve.best.pnl - noCarve.best.pnl;
    console.log(`   carve ${f(withCarve.best.pnl)} vs no-carve ${f(noCarve.best.pnl)} — delta ${f(delta, 9)} ETH`);
    expect(withCarve.best.pnl).to.be.lt(0n);
    expect(noCarve.best.pnl).to.be.lt(0n);
    // the presence of a 20 ETH carve changes the attacker's PnL by less than a milli-ETH: nothing is extracted
    expect(delta < 0n ? -delta : delta).to.be.lt(10n ** 15n);
    await snap2.restore();
  });

  it("4. [P2 / N-A] SUSTAINED HOLD — the variant that beat the interim fix now buys ONE ~1bp slice, at a loss", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab(HOOKED);
    const base = await L.vault.EPISODE_BASE_WEI();
    // poke every 30 min (inside MAX_OBSERVED_GAP, exactly the cadence that defeated the round-3 fix) for 12h
    const R = await runSustainedHold(L, { pokeSec: 1800, pokes: 24, taxBps: 100 });
    console.log(`   sustained hold: ${f(R.pnl)} ETH, ${R.commits} commits, committed ${f(R.banded, 6)} ETH of a ${f(R.carve0)} ETH carve (cap ${f(base, 6)})`);
    // P2: one episode, one non-refilling allowance. 12h of held pressure buys EPISODE_BASE_WEI, not the backlog.
    expect(R.banded).to.be.lte(base);
    expect(R.consumed).to.be.lte(base);
    expect(R.pnl).to.be.lt(0n); // and he still pays a full round trip for it
    // the round-trip cost dwarfs the prize by orders of magnitude
    expect(-R.pnl).to.be.gt(base * 100n);
    await snap.restore();
  });

  it("5. [R3 N-B] SHALLOW DUMP — a dump that stalls INSIDE the band does not inherit an uncapped allowance", async () => {
    const snap = await takeSnapshot();
    // dumpTick 700 sits inside the band [60, 1260] — below `floorTickUpper`, so the FIRST-draft episode anchor
    // (`aboveUpperTs`) would never have rolled and `episodeStartQuote` would have stayed at its 0 default,
    // making the allowance `cap + amt` — i.e. the whole 20 ETH backlog. This is the auditor's N-B must-fix.
    const L = await buildLab({ ...HOOKED, dumpTick: 700 });
    const base = await L.vault.EPISODE_BASE_WEI();
    expect(L.bandLower).to.equal(60);
    expect(L.bandUpper).to.equal(1260);
    const R = await runSustainedHold(L, { pokeSec: 1800, pokes: 24, taxBps: 100 });
    console.log(`   shallow dump (tick 700, mid-band): committed ${f(R.banded, 6)} ETH of ${f(R.carve0)} ETH (cap ${f(base, 6)}), PnL ${f(R.pnl)} ETH`);
    expect(R.banded).to.be.lte(base); // capped exactly as the deep-dump case — the N-B hole is closed
    expect(await L.vault.episodeStartQuote()).to.be.gt(0n); // the episode DID roll on the shallow touch
    expect(R.pnl).to.be.lt(0n);
    await snap.restore();
  });

  it("6. [P1] POST-CRASH BACK-RUN — a crash then an immediate push cannot force a fill, even in the same second", async () => {
    const snap = await takeSnapshot();
    // Healthy pad: no dump at build time, so the tick has never touched the band and the gate is fully warm.
    const L = await buildLab({ ...HOOKED, dumpTick: null, carve: E(20) });
    await time.increase(Number(await L.vault.MIN_BELOW_DURATION()) + 1);
    const { sw, key, vault, tok, attacker, sqrtAt } = L;

    // CRASH: one swap takes the tick from healthy straight through the band.
    await sw.connect(L.trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 24n), sqrtPriceLimitX96: await sqrtAt(8090) },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    expect(await L.nowTick()).to.be.gte(L.bandLower);

    // BACK-RUN in the SAME block/timestamp: push straight back below the band and poke. The push's PRE-swap
    // tick is above the band, so the watermark stamps in the attacker's own transaction — dt == 0 is
    // deliberately NOT a guard on the watermark write, only on the accumulator.
    await ethers.provider.send("evm_setAutomine", [false]);
    const X = await sizePush(L, 59, 100).catch(() => E(200));
    const tb = await tok.balanceOf(attacker.address);
    await sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -X, sqrtPriceLimitX96: await sqrtAt(59) },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: X }
    );
    await vault.connect(attacker).addFloor();
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_setAutomine", [true]);

    expect(await vault.floorLiquidity()).to.equal(0n); // PARKED — the stale-TWAP window that broke three designs
    expect(await vault.bandQuoteWei()).to.equal(0n);
    expect(await tok.balanceOf(attacker.address)).to.be.gt(tb); // he really did land the push
    await snap.restore();
  });

  it("7. HONEST PATH — a healthy pad still drains its carve into the wall, monotonically", async () => {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...HOOKED, dumpTick: null, carve: E(20) }); // never traded into the band
    const { vault } = L;
    await time.increase(Number(await vault.MIN_BELOW_DURATION()) + 1);
    const dwell = Number(await vault.MIN_DWELL()) + 1;
    let last = 0n;
    for (let i = 0; i < 40; i++) {
      await time.increase(dwell);
      await vault.addFloor();
      const L2 = await vault.floorLiquidity();
      expect(L2).to.be.gte(last); // add-only: never decreases
      last = L2;
    }
    const committed = await vault.bandQuoteWei();
    console.log(`   honest path: ${f(committed)} ETH of a ${f(E(20))} ETH carve deployed over 40 pokes, floorLiquidity ${last > 0n ? "> 0" : "0"}`);
    expect(last).to.be.gt(0n);
    // the episode never rolled (the pad never touched the band), so the allowance is inflow-equal and the
    // carve deploys exactly as it did before the gate — paced only by MAX_COMMIT_BPS / COMMIT_COOLDOWN.
    expect(await vault.episodeAnchor()).to.equal(0n);
    expect(committed).to.be.gt(E(10));
    await snap.restore();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // [RESTORED] The two cases below replace coverage this branch LOST. The H-5 merge deleted
  // `7. [R3-EXT-2] THE BASE BIND` and `5. [R3-EXT-2 CORRECTED]` (slot 7 was reused for HONEST PATH), and in
  // the SAME commit raised scripts/launch.js from `0n` to `seedEth / 10_000n` — the exact change the deleted
  // comment said not to make without re-running case 7. Nothing in the tree varied EPISODE_BASE_WEI
  // afterwards, so the shipped constant was bound by no test at all.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("8. [SAFETY / DEEP DUMP] the cap is pinned to LAUNCH depth — prove a far deeper dump is still unprofitable", async () => {
    const snap = await takeSnapshot();
    // WHY THIS EXISTS: EPISODE_BASE_WEI is immutable, fixed from depth AT LAUNCH, while the attacker's cost
    // scales with LIVE depth. Every other case in this file dumps to at most tick 12000. If live depth decays
    // far enough below launch depth, a fixed cap that was ~80x unprofitable at launch could approach — or
    // cross — break-even. That is a SAFETY question, not a liveness one, and it was never measured.
    for (const dumpTick of [50000, 59000]) {
      const L = await buildLab({ ...HOOKED, dumpTick, carve: E(20) });
      const R = await runAttack(L, { rounds: 8, taxBps: 100, gapSec: 3901 });
      console.log(`   deep dump tick ${dumpTick}: best ${f(R.best.pnl)} ETH, carve consumed ${f(R.best.consumed)}/${f(R.carve0)}`);
      // The attacker must still LOSE money. If this ever flips positive, the fixed-cap-vs-live-depth coupling
      // is real and EPISODE_BASE_WEI cannot stay pinned to launch depth.
      expect(R.best.pnl).to.be.lt(0n);
    }
    await snap.restore();
  });

  it("9. [LIVENESS / DISCLOSED LIMITATION] a CRASHED pad's banked carve does NOT redeploy at the shipped base", async () => {
    const snap = await takeSnapshot();
    // WHAT THIS PINS — and it is a limitation, not a closure. Case 7 proves the carve deploys on a pad that
    // NEVER touched its band (it asserts episodeAnchor() == 0). This is the opposite branch, and it is the one
    // every real pad is in once it has crashed: the allowance is `cap + (amt - episodeStartQuote)`
    // (RobinFloorVault ~:326), and `episodeStartQuote` snapshots the WHOLE banked carve when the episode opens
    // (~:259). So the inflow term is exactly 0 and the allowance collapses to the bare cap — permanently, until
    // the pad crashes again. The vault's own comment at ~:166 says as much: "a healthy pad never touches the
    // band, so it keeps episodeStartQuote == 0 and an inflow-equal allowance."
    //
    // The pre-merge tree DISCLOSED this in scripts/launch.js: "only ETH arriving DURING a below-band episode
    // deploys, so carve banked during a crash stays parked. That is a product limitation to disclose, not a
    // closure." The merge deleted that sentence. This test puts the fact back where it cannot be lost again.
    const base = 10n ** 14n; // the SHIPPED value: seedEth(1 ETH) / 10_000 — NOT the lab's depth-derived default
    const L = await buildLab({ ...HOOKED, dumpTick: 12000, carve: E(20), episodeBaseWei: base });
    const { vault } = L;
    await time.increase(Number(await vault.MIN_BELOW_DURATION()) + 1);
    const dwell = Number(await vault.MIN_DWELL()) + 1;
    for (let i = 0; i < 40; i++) {
      await time.increase(dwell);
      await vault.addFloor();
    }
    const committed = await vault.bandQuoteWei();
    const parked = await vault.parkedQuote();
    console.log(`   crashed pad @ shipped base ${f(base, 6)} ETH: deployed ${f(committed, 6)} of ${f(E(20))} ETH, still parked ${f(parked)}`);
    // Add-only is intact and nothing is lost — the carve is PARKED, not spent. This is the honest claim.
    expect(committed + parked).to.be.gte(E(20) - 1n);
    // And the deployed amount is bounded by the bare cap, NOT by the carve. If a future change makes a crashed
    // pad deploy its backlog, this assertion fails and that is a GOOD failure — update it deliberately.
    expect(committed).to.be.lte(base * 2n);
    await snap.restore();
  });
});
