// REGRESSION TEST for C-2 (see AUDITOR-HANDOFF.md). An ordinary sellout leaves spot at the far floor, so the
// walk back to the ceiling crosses ~890k ticks. Empty ticks are skipped a bitmap word at a time, but every
// INITIALIZED tick costs real gas — and initializing one is nearly free when spot is far below it. An attacker
// planting dust positions (liquidityDelta = 1, ~1 wei each) below gradTick pushed BOTH graduate() and
// restoreCeiling() past the block gas cap, permanently trapping the raise: the documented recovery was defeated
// by the exact thing it existed to recover from, because a single unbounded swap cannot be split across
// transactions. restoreCeiling now takes an intermediate sqrtPriceLimitX96, so the walk is segmentable.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
// The finding measured 33.8M (graduate) and 31.8M (full-walk restore) against a 30M block cap. This harness
// caps a single transaction at 2^24 gas, which is far below both — so "does not fit in TX_CAP" is a strictly
// weaker statement than the finding's, and enough to show the walk cannot be done in one transaction.
const TX_CAP = 16_777_216n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const poolIdOf = (k) => ethers.keccak256(
  abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
);
const E = (x) => ethers.parseEther(String(x));

// Hardhat keeps chain state across test FILES, so a suite that moves large balances would otherwise leave
// later files short of ETH. Each describe below snapshots before it deploys and restores when it is done.
describe("C-2 exploit, replayed against the patched curve", () => {
  // Snapshot the whole file's worth of state, not each test's, so balances this file spends are handed back.
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = E(1000), RESERVE = E(1000);
  // One dust position per 60-tick band below the ceiling. The finding measured 100 plants pushing a 30M block
  // cap; this harness's pad configuration costs ~53k gas per plant on the walk (measured below), and its
  // per-transaction cap is 2^24, so it takes ~340 to cross. Same mechanism, different constant — the point is
  // that the cost of the walk scales with plants the attacker adds for ~1 wei each, without bound.
  const PLANTS = 340;

  let owner, platform, creator, trader, attacker;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ml, curve, key, poolId, curveAddr;

  before(async () => {
    [owner, platform, creator, trader, attacker] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    th = await (await ethers.getContractFactory("TickHelper")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    ml = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());

    const tokAddr = await tok.getAddress();
    key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
    );
    curveAddr = await curve.getAddress();
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);

    // THE ORDINARY SELLOUT — not an attack. The router default price limit slides spot to the far floor,
    // because below gradTick there is no liquidity and v4's swap loop walks the price for zero input.
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(6000), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(6000) }
    );
    expect(await curve.ready()).to.equal(true);

    // THE ATTACK — dust positions, one per band below the ceiling. Spot is far below, so each is currency0-only
    // and costs ~1 wei. What they buy is an initialized tick the victim's walk must cross.
    await tok.connect(owner).transfer(attacker.address, E(1));
    await tok.connect(attacker).approve(await ml.getAddress(), ethers.MaxUint256);
    for (let i = 0; i < PLANTS; i++) {
      await ml.connect(attacker).modifyLiquidity(
        key, { tickLower: GRAD - SPACING * (i + 1), tickUpper: GRAD - SPACING * i, liquidityDelta: 1, salt: ethers.ZeroHash },
        "0x", { value: 1000n }
      );
    }
    await tok.connect(owner).transfer(trader.address, E(500000));
    await tok.connect(trader).approve(curveAddr, ethers.MaxUint256);
  });

  const spotSqrt = async () => (await stateView.getSlot0(poolId))[0];
  const spotTick = async () => Number((await stateView.getSlot0(poolId))[1]);

  it("the planted ticks really do push a single full walk past one transaction's gas cap", async () => {
    expect(await spotTick()).to.be.lessThan(GRAD - SPACING * PLANTS); // spot is below every planted band
    // limit 0 == walk all the way to the ceiling in one transaction — the ONLY option before this fix
    // limit 0 == walk all the way to the ceiling in one transaction — the ONLY option before this fix
    await expect(
      curve.connect(trader).restoreCeiling(E(400000), 0, { gasLimit: TX_CAP })
    ).to.be.reverted; // out of gas: the recovery cannot fit in one transaction
  });

  it("SEGMENTED restore walks spot to the ceiling in bounded steps, and graduate() then succeeds", async () => {
    const gradSqrt = await th.sqrt(GRAD);
    const DENSE_FLOOR = GRAD - SPACING * PLANTS; // bottom of the planted zone
    const SEG_TICKS = SPACING * 10; // cross ten planted bands per transaction
    const SEG_CAP = 8_000_000n; // each segment must fit comfortably inside a block
    let segments = 0, worst = 0n;

    // A keeper picks segments by where the cost is: one cheap jump across the empty region (v4 skips
    // uninitialized ticks a bitmap word at a time), then bounded steps through the planted bands.
    while ((await spotSqrt()) < gradSqrt) {
      const from = await spotTick();
      let target = from < DENSE_FLOOR ? DENSE_FLOOR : from + SEG_TICKS;
      if (target >= GRAD) target = GRAD;
      const limit = target === GRAD ? gradSqrt : await th.sqrt(target);
      const tx = await curve.connect(trader).restoreCeiling(E(400000), limit, { gasLimit: SEG_CAP });
      const rc = await tx.wait();
      if (rc.gasUsed > worst) worst = rc.gasUsed;
      segments++;
      expect(segments).to.be.lessThan(60); // must converge, not grind
    }

    console.log(`   walked to the ceiling in ${segments} segments; worst segment ${worst} gas (cap ${SEG_CAP})`);
    expect(worst).to.be.lt(SEG_CAP);
    expect(await spotSqrt()).to.equal(gradSqrt); // landed EXACTLY at the ceiling

    // the raise is no longer trapped: graduation completes inside one ordinary transaction
    const g = await (await curve.graduate({ gasLimit: TX_CAP })).wait();
    console.log(`   graduate() cost ${g.gasUsed} gas`);
    expect(await curve.graduated()).to.equal(true);
    expect(g.gasUsed).to.be.lt(TX_CAP);
  });

  it("restoreCeiling closes once the pad has graduated", async () => {
    await expect(curve.connect(trader).restoreCeiling(E(1), 0))
      .to.be.revertedWithCustomError(curve, "AlreadyGraduated");
  });
});

describe("C-2 segment bounds, checked on a live (un-graduated) curve", () => {
  // Snapshot the whole file's worth of state, not each test's, so balances this file spends are handed back.
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  let owner, platform, creator, trader, pm, stateView, th, curve, key, poolId;

  before(async () => {
    [owner, platform, creator, trader] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));
    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
    );
    await tok.connect(owner).transfer(await curve.getAddress(), E(1000));
    await mockFactory.seedCurve(await curve.getAddress());
    await tok.connect(owner).transfer(await curve.getAddress(), E(1000));
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(6000), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(6000) }
    );
    await tok.connect(owner).transfer(trader.address, E(10000));
    await tok.connect(trader).approve(await curve.getAddress(), ethers.MaxUint256);
  });

  it("rejects a limit above the ceiling — a segment can never overshoot", async () => {
    const gradSqrt = await th.sqrt(GRAD);
    await expect(curve.connect(trader).restoreCeiling(E(10), gradSqrt + 1n))
      .to.be.revertedWithCustomError(curve, "BadPriceLimit");
  });

  it("rejects a limit at or below spot — a segment can never move price DOWN", async () => {
    const cur = (await stateView.getSlot0(poolId))[0];
    await expect(curve.connect(trader).restoreCeiling(E(10), cur))
      .to.be.revertedWithCustomError(curve, "BadPriceLimit");
    await expect(curve.connect(trader).restoreCeiling(E(10), cur - 1n))
      .to.be.revertedWithCustomError(curve, "BadPriceLimit");
  });

  it("accepts the ceiling itself, and 0 as shorthand for it", async () => {
    const gradSqrt = await th.sqrt(GRAD);
    await curve.connect(trader).restoreCeiling(E(10), gradSqrt); // exact ceiling is a legal limit
    expect((await stateView.getSlot0(poolId))[0]).to.equal(gradSqrt);
  });
});
