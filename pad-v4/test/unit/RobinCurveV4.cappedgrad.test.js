const { ethers } = require("hardhat");
const { expect } = require("chai");

// A buy CAPPED at the ceiling (sqrtPriceLimit == sqrtAtTick(gradTick)) — how the bench/router sells the curve
// out without the MIN_SQRT gas blow-up — lands spot at sqrtPrice == gradSqrt but tick == gradTick-1 (downward
// crossing). graduate()'s nudge must treat that as "already at the ceiling" (sqrtPrice-based guard) and SKIP,
// or it swaps with limit == current price and reverts PriceLimitAlreadyExceeded. This proves the fix.

const ZERO = ethers.ZeroAddress;

describe("RobinCurveV4 — graduation after a ceiling-CAPPED buy (no PriceLimitAlreadyExceeded)", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n, RESERVE = 1000n * 10n ** 18n;
  let owner, platform, creator, trader;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ds, floor, curve, key, poolId;

  before(async () => {
    [owner, platform, creator, trader] = await ethers.getSigners();
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

    const tokAddr = await tok.getAddress();
    key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address,address,uint24,int24,address)"], [[ZERO, tokAddr, FEE, SPACING, ZERO]]));
    await pm.initialize(key, await th.sqrt(START));

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, ethers.parseEther("0.5"), creator.address
    );
    const curveAddr = await curve.getAddress();
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);
    ds = await (await ethers.getContractFactory("DualStaking")).deploy(tokAddr, ZERO, owner.address, 0, ZERO, ethers.ZeroHash, 0);
    await ds.setRewarder(curveAddr, true);
    await ds.listReward(0, tokAddr, 7 * 86400);
    await curve.connect(platform).setStaking(await ds.getAddress());
    floor = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), platform.address, ZERO, tokAddr, FEE, SPACING, ZERO, GRAD, 10
    );
    await curve.connect(platform).setFloor(await floor.getAddress());
  });

  it("a buy capped at gradTick sells out to the ceiling (tick == gradTick-1, sqrtPrice == gradSqrt)", async () => {
    const cap = await th.sqrt(GRAD); // sqrtAtTick(gradTick) — the exact bench/router buy cap
    // way more than the curve can absorb: capped, it fills to the ceiling and stops (rest refunded).
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6000"), sqrtPriceLimitX96: cap },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6000") }
    );
    const [sqrtNow, tickNow] = await stateView.getSlot0(poolId);
    expect(await curve.ready()).to.equal(true);
    expect(Number(tickNow)).to.equal(GRAD - 1); // the off-by-one the old tick-based nudge tripped on
    expect(sqrtNow).to.equal(cap); // but sqrtPrice is exactly at the ceiling
  });

  it("graduate() succeeds — the sqrtPrice-based nudge correctly skips (no PriceLimitAlreadyExceeded)", async () => {
    await curve.graduate();
    expect(await curve.graduated()).to.equal(true);
    // permanent LP locked, spot honest at the ceiling sqrtPrice
    expect(await posm.ownerOf(await posm.nextTokenId() - 1n)).to.equal(await lockVault.getAddress());
    expect((await stateView.getSlot0(poolId))[0]).to.equal(await th.sqrt(GRAD));
  });
});
