const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, buildLab, poolIdOf, ZERO } = require("../helpers/h5-lab");

// [H-5] Unit tests for the observation machinery added to `RobinFeeHook` — the swap-witnessed watermarks that
// are the floor gate's PRIMARY control, and the bucketed tick accumulator that backs the (defence-in-depth)
// TWAP conjunct. The write sits on the hot swap path of every pad, so "it can never revert and can never be
// steered by the caller" is as load-bearing here as the gate logic itself.

const TWAP_UNAVAILABLE = (1n << 255n) - 1n; // type(int256).max

async function buy(L, wei, targetTick) {
  const { sw, key, trader, sqrtAt } = L;
  return sw.connect(trader).swap(
    key, { zeroForOne: true, amountSpecified: -wei, sqrtPriceLimitX96: await sqrtAt(targetTick) },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: wei }
  );
}
async function sell(L, amt, targetTick) {
  const { sw, key, trader, sqrtAt } = L;
  return sw.connect(trader).swap(
    key, { zeroForOne: false, amountSpecified: -amt, sqrtPriceLimitX96: await sqrtAt(targetTick) },
    { takeClaims: false, settleUsingBurn: false }, "0x"
  );
}

describe("[H-5] RobinFeeHook — the swap-witnessed observation", function () {
  this.timeout(900000);

  it("the extsload(bytes32) selector the read is pinned to is 0x1e2eaeaf", () => {
    expect(ethers.id("extsload(bytes32)").slice(0, 10)).to.equal("0x1e2eaeaf");
  });

  it("registerPool seeds the record in the launch tx, so the accumulator has a real anchor from block zero", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    const s = await L.hook.oracleState(L.poolId);
    expect(s.ts).to.be.gt(0n);
    expect(s.tickCumulative).to.equal(0n);
    expect(s.index).to.equal(0n);
  });

  it("the observation is taken off the PRE-swap tick, not the post-swap tick", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    await time.increase(60);
    await sell(L, 10n ** 22n, 700); // move the tick well away from 0
    const mid = await L.nowTick();
    expect(mid).to.be.gt(0);

    await time.increase(60);
    await sell(L, 10n ** 22n, 2000); // a SECOND move: its pre-swap tick is `mid`
    const s = await L.hook.oracleState(L.poolId);
    expect(Number(s.lastTick)).to.equal(mid); // the PRE-swap tick of the latest swap
    expect(await L.nowTick()).to.be.gt(mid); // …and the pool has since moved past it
  });

  it("[stale-lastTick regression] a pushed tick that is bought straight back is not credited forward", async () => {
    // This is the bug the research brief's snippet contains: crediting the STORED `lastTick` rather than the
    // current swap's pre-swap tick reopens H-5 at zero holding cost (push, latch, sell back, idle, one swap).
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    await time.increase(60);
    await sell(L, 10n ** 22n, 5000); // PUSH the tick far up
    const pushed = await L.nowTick();
    await time.increase(1);
    await buy(L, 1n, 0); // 1-wei latch in the next second (pre-swap tick == pushed)
    await buy(L, E(60), 0); // …and buy it straight back down to the launch tick
    const recovered = await L.nowTick();
    expect(recovered).to.be.lt(pushed - 1000);

    await time.increase(4 * 60 * 60); // idle for well past the window
    await buy(L, 1n, -100); // one swap closes the interval — at the RECOVERED tick
    const tw = await L.hook.consultTick(L.poolId, 195 * 60);
    expect(tw).to.not.equal(TWAP_UNAVAILABLE);
    // the long idle interval dominates, and it is credited at the recovered tick, not the pushed one
    expect(Number(tw)).to.be.lt(pushed / 2);
  });

  it("a same-second swap (dt == 0) writes no accumulator delta but DOES stamp the watermark", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: E(1), dumpTick: null, hookTaxBps: 100 });
    await time.increase(600);
    await sell(L, 10n ** 22n, 700); // tick now inside the band [60,1260]
    expect(await L.nowTick()).to.be.gte(L.bandLower);

    // two swaps inside ONE timestamp: the second has dt == 0, and its pre-swap tick is inside the band
    await ethers.provider.send("evm_setAutomine", [false]);
    const before = await L.hook.oracleState(L.poolId);
    await buy(L, 1n, -800);
    await buy(L, 1n, -800);
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_setAutomine", [true]);
    const after = await L.hook.oracleState(L.poolId);
    const blk = await ethers.provider.getBlock("latest");
    expect(after.aboveLowerTs).to.equal(BigInt(blk.timestamp)); // stamped, dt == 0 notwithstanding
    expect(after.ts).to.be.gte(before.ts);
  });

  it("an UNREGISTERED pool naming the same hook writes no oracle state at all", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    const key2 = { ...L.key, fee: 500 }; // same hook, a different (unregistered) pool
    const id2 = poolIdOf(key2);
    // [MERGE/L-25] beforeInitialize is factory-only on this branch — stand the second pool up as the factory.
    await L.pm.connect(L.factorySigner).initialize(key2, 79228162514264337593543950336n);
    await L.mod.connect(L.lp).modifyLiquidity(
      key2, { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash }, "0x",
      { value: E(50) }
    );
    await L.sw.connect(L.trader).swap(
      key2, { zeroForOne: true, amountSpecified: -E(1), sqrtPriceLimitX96: await L.sqrtAt(-800) },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(1) }
    );
    const s = await L.hook.oracleState(id2);
    expect(s.ts).to.equal(0n);
    expect(s.tickCumulative).to.equal(0n);
  });

  it("ring stuffing is impossible: many swaps inside one bucket append at most one snapshot", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    await time.increase(200); // cross one bucket boundary so the ring has a real starting index
    await buy(L, 1n, -800);
    const i0 = (await L.hook.oracleState(L.poolId)).index;
    const t0 = (await ethers.provider.getBlock("latest")).timestamp;
    const SWAPS = 150; // each hardhat block advances the clock 1s, so ~150 seconds of wall time
    for (let i = 0; i < SWAPS; i++) await buy(L, 1n, -800);
    const t1 = (await ethers.provider.getBlock("latest")).timestamp;
    const i1 = (await L.hook.oracleState(L.poolId)).index;
    // Appends are gated on BUCKET ROLLOVER, not on swap count: 150 swaps append exactly as many times as the
    // elapsed span crosses a 180-second boundary, and never more. Swap rate buys an attacker nothing.
    const crossings = Math.floor(t1 / 180) - Math.floor(t0 / 180);
    expect(Number(i1) - Number(i0)).to.equal(crossings);
    expect(crossings).to.be.lte(Math.ceil((t1 - t0) / 180));
    expect(crossings).to.be.lt(SWAPS / 10); // orders of magnitude fewer appends than swaps
  });

  it("the ring survives a full wrap and still answers the TWAP_WINDOW query", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    for (let i = 0; i < 200; i++) { await time.increase(200); await buy(L, 1n, -800); } // 200 rollovers > OBS_N
    const tw = await L.hook.consultTick(L.poolId, 195 * 60);
    expect(tw).to.not.equal(TWAP_UNAVAILABLE); // (OBS_N-1)*OBS_BUCKET - (OBS_BUCKET-1) = 22,681 >= 11,700
    expect(Number(tw)).to.be.within(-100, 100); // the pad never moved
  });

  it("a cold ring, a zero window, and a span stretched past MAX_SPAN_MULT all read TWAP_UNAVAILABLE", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    expect(await L.hook.consultTick(L.poolId, 0)).to.equal(TWAP_UNAVAILABLE); // zero window
    expect(await L.hook.consultTick(L.poolId, 195 * 60)).to.equal(TWAP_UNAVAILABLE); // cold (no swaps yet)

    // one swap now and one far in the future => the only available span is enormous relative to the window
    await time.increase(300);
    await buy(L, 1n, -800);
    await time.increase(195 * 60 * 8);
    await buy(L, 1n, -800);
    expect(await L.hook.consultTick(L.poolId, 195 * 60)).to.equal(TWAP_UNAVAILABLE); // span > 4 * W
  });

  it("armFloorGate is platform-only, one-shot, and hard-reverts on a band/pool mismatch", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    await expect(L.hook.connect(L.trader).armFloorGate(L.poolId)).to.be.revertedWithCustomError(L.hook, "NotPlatform");
    await expect(L.hook.connect(L.platform).armFloorGate(L.poolId))
      .to.be.revertedWithCustomError(L.hook, "FloorGateAlreadyArmed"); // buildLab already armed it

    // a second pool on the same hook, wired to a vault that belongs to a DIFFERENT pool => FloorGateMismatch
    const key2 = { ...L.key, fee: 500 };
    const id2 = poolIdOf(key2);
    const [, , , , , , factorySigner] = await ethers.getSigners();
    // [MERGE/L-25] beforeInitialize is factory-only on this branch — stand the second pool up as the factory.
    await L.pm.connect(factorySigner).initialize(key2, 79228162514264337593543950336n);
    await L.hook.connect(factorySigner).registerPool(id2, {
      currency0: ZERO, currency1: await L.tok.getAddress(), creator: L.owner.address, floorRecipient: ZERO,
      guardAdapter: ZERO, buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
      buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
    });
    await expect(L.hook.connect(L.platform).armFloorGate(id2))
      .to.be.revertedWithCustomError(L.hook, "NoFloorRecipient");
    await L.hook.connect(L.platform).setFloorRecipient(id2, await L.vault.getAddress()); // the OTHER pool's vault
    await expect(L.hook.connect(L.platform).armFloorGate(id2))
      .to.be.revertedWithCustomError(L.hook, "FloorGateMismatch");
  });

  it("hot-path gas: the observation's marginal cost stays inside its documented budget", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: 0n, dumpTick: null, hookTaxBps: 100 });
    await time.increase(200);
    await (await buy(L, E(1), -800)).wait(); // warm the ring slot
    await time.increase(5);
    const steady = (await (await buy(L, E(1), -800)).wait()).gasUsed; // same bucket: no append
    await time.increase(200);
    const rollover = (await (await buy(L, E(1), -800)).wait()).gasUsed; // crosses a bucket: one append
    console.log(`   beforeSwap gas — steady ${steady}, bucket rollover ${rollover} (+${rollover - steady})`);
    expect(rollover - steady).to.be.lt(35_000n); // one cold ring-slot write, per the budget in ORACLE.md
  });
});
