// REGRESSION TEST for H-5 (see AUDITOR-HANDOFF.md). addFloor()'s entire protection was one live slot0 read
// gating the irreversible commitment of the WHOLE on-hand carve. In M-15's state — the pad has dumped, spot
// sits at or above the band and the carve has been parking — anyone could buy to force the tick below
// floorTickLower, call addFloor(), and sell back, flipping the carve from "mint nothing" to "mint everything
// at a stale band" inside one transaction. The fix targets the park→commit FLIP, not the timing: a commit now
// needs the tick settled below the band for MIN_DWELL (so the attack cannot be atomic) and moves at most
// MAX_COMMIT_BPS of the balance per COMMIT_COOLDOWN (so a fixed push cost buys a bounded slice).
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const poolIdOf = (k) => ethers.keccak256(
  abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
);
const E = (x) => ethers.parseEther(String(x));

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("H-5 — a forced tick can no longer flip the whole parked carve into the band", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const FEE = 3000, TS = 60;
  const CARVE = E(50); // the parked carve an attacker wants to force in
  let owner, lp, attacker, platform, pm, stateView, tok, sw, mod, vault, key, poolId, reg;

  beforeEach(async () => {
    [owner, lp, attacker, platform] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1); // tick 0

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 25n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 21n, salt: ethers.ZeroHash }, "0x",
      { value: E(1000) }
    );

    // [L-11] floor vault takes the timelocked registry; platformFeeWallet() resolves to `platform`.
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    vault = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), FEE, TS, ZERO, 0 /* anchor */, 10 /* width */
    );

    // M-15's state: the pad has DUMPED — spot sits above the band — and the carve has been parking
    await tok.connect(owner).transfer(attacker.address, E(500000));
    await tok.connect(attacker).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(attacker).swap(
      key, { zeroForOne: false, amountSpecified: -E(40), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    await owner.sendTransaction({ to: await vault.getAddress(), value: CARVE });
    await vault.addFloor(); // parks — spot is above the band, which is the honest, correct outcome
    expect(await vault.floorLiquidity()).to.equal(0n);
    expect(await vault.parkedQuote()).to.equal(CARVE);
  });

  const tick = async () => Number((await stateView.getSlot0(poolId))[1]);

  it("the atomic push→addFloor→sell-back commits NOTHING", async () => {
    const lower = Number(await vault.floorTickLower());
    expect(await tick()).to.be.gte(lower); // parked because spot is above the band

    // the push: buy to force the tick below floorTickLower (this is the attacker's fixed cost)
    await sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -E(50), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(50) }
    );
    expect(await tick()).to.be.lt(lower); // the guard's single slot0 read is satisfied — it used to be enough

    await vault.addFloor();
    expect(await vault.floorLiquidity()).to.equal(0n); // the flip does not happen on a just-arrived tick
    expect(await vault.parkedQuote()).to.equal(CARVE); // the carve is intact

    // sell back out; the carve is still whole and still parked
    await sw.connect(attacker).swap(
      key, { zeroForOne: false, amountSpecified: -E(40), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    await vault.addFloor();
    expect(await vault.floorLiquidity()).to.equal(0n);
    expect(await vault.parkedQuote()).to.equal(CARVE);
  });

  it("holding the push for the full dwell still only commits a bounded slice", async () => {
    await sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -E(50), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(50) }
    );
    await vault.addFloor(); // starts the dwell clock
    await time.increase(Number(await vault.MIN_DWELL()) + 1); // the attacker must hold the price down this long
    await vault.addFloor();

    const committed = CARVE - (await vault.parkedQuote());
    const capBps = await vault.MAX_COMMIT_BPS();
    console.log(`   held the push for the full dwell and committed ${ethers.formatEther(committed)} of ${ethers.formatEther(CARVE)} ETH ` +
      `(cap ${Number(capBps) / 100}%) — was 100%`);
    expect(await vault.floorLiquidity()).to.be.gt(0n); // a slice does go in
    expect(committed).to.be.lte((CARVE * BigInt(capBps)) / 10000n + 1n); // but only the capped slice
    expect(committed * 2n).to.be.lt(CARVE); // and nowhere near the whole carve

    // and a second commit in the same breath is refused by the cooldown
    const after = await vault.parkedQuote();
    await vault.addFloor();
    expect(await vault.parkedQuote()).to.equal(after);
  });

  it("a tick that leaves the band resets the dwell — the attacker cannot bank progress", async () => {
    await sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -E(50), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(50) }
    );
    await vault.addFloor(); // clock starts
    await time.increase(Number(await vault.MIN_DWELL()) - 60); // ...almost there
    // price drifts back above the band before the dwell completes
    await sw.connect(attacker).swap(
      key, { zeroForOne: false, amountSpecified: -E(40), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    await vault.addFloor(); // observation: not below → reset
    expect(await vault.belowSince()).to.equal(0n);

    // push again and poke: the clock restarts from zero, so the near-complete dwell bought nothing
    await sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -E(50), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(50) }
    );
    await vault.addFloor();
    await time.increase(60);
    await vault.addFloor();
    expect(await vault.floorLiquidity()).to.equal(0n); // still nothing committed
  });

  it("the HONEST path is unaffected: a tick that has always been below the band commits every poke", async () => {
    // fresh pad, spot below the band from the start — the normal case the vault was built for
    const v2 = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), FEE, TS, ZERO, 0, 10
    );
    await sw.connect(attacker).swap( // put spot below the band and leave it there
      key, { zeroForOne: true, amountSpecified: -E(50), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(50) }
    );
    await owner.sendTransaction({ to: await v2.getAddress(), value: E(10) });
    await v2.addFloor(); // records the observation
    await time.increase(Number(await v2.MIN_DWELL()) + 1);

    let last = 0n;
    for (let i = 0; i < 6; i++) {
      await v2.addFloor();
      const L = await v2.floorLiquidity();
      expect(L).to.be.gt(last); // every poke past the dwell commits its slice, no further waiting
      last = L;
      await time.increase(Number(await v2.COMMIT_COOLDOWN()) + 1);
    }
    expect(await v2.parkedQuote()).to.be.lt(E(4)); // most of the carve is in the wall
  });
});
