const { ethers } = require("hardhat");
const { expect } = require("chai");

// [audit M1] Graduation anti-grief. A third party can plant Uniswap-v4 liquidity BELOW gradTick so that
// graduate()'s reserve-budgeted nudge (≤1% of the reserve) can't buy spot back to the ceiling → it reverts
// CeilingNotRestored and the raise is temporarily stuck. restoreCeiling() lets ANYONE push spot back up using
// their OWN token (never the reserve), after which graduate() proceeds. This proves the fix end to end.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const poolIdOf = (k) => ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));

describe("RobinCurveV4 — graduation grief recovery (restoreCeiling)", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n, RESERVE = 1000n * 10n ** 18n;
  const GRAD_REWARD = ethers.parseEther("0.5");
  let owner, platform, creator, trader, attacker;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ml, ds, floor, curve, key, poolId, curveAddr;

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
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, GRAD_REWARD, creator.address
    );
    curveAddr = await curve.getAddress();
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

    // fund the players with token
    await tok.connect(owner).transfer(trader.address, ethers.parseEther("2000"));
    await tok.connect(owner).transfer(attacker.address, ethers.parseEther("100000"));
  });

  it("buys the curve out (spot overshoots below the ceiling)", async () => {
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6000") }
    );
    expect(await curve.ready()).to.equal(true);
    expect(Number((await stateView.getSlot0(poolId))[1])).to.be.lessThan(GRAD - 120); // spot well below the ceiling
  });

  it("a griefer plants deep liquidity below the ceiling → graduate() reverts CeilingNotRestored", async () => {
    await tok.connect(attacker).approve(await ml.getAddress(), ethers.MaxUint256);
    // Deep band just under the ceiling. Spot is below it, so the band is 100% ETH (token0); the router pulls
    // the ETH from msg.value and refunds the rest. Crossing it UP (the nudge/restore direction) then needs FAR
    // more token than the 1% reserve nudge (~10 tok) can supply.
    await ml.connect(attacker).modifyLiquidity(
      key, { tickLower: GRAD - 120, tickUpper: GRAD, liquidityDelta: ethers.parseEther("10000"), salt: ethers.ZeroHash },
      "0x", { value: ethers.parseEther("200") }
    );
    await expect(curve.graduate()).to.be.revertedWithCustomError(curve, "CeilingNotRestored");
  });

  it("anyone restores the ceiling with their OWN token, then graduate() succeeds", async () => {
    await tok.connect(trader).approve(curveAddr, ethers.MaxUint256);
    const tBefore = await tok.balanceOf(trader.address);
    const eBefore = await ethers.provider.getBalance(trader.address);

    const tx = await curve.connect(trader).restoreCeiling(ethers.parseEther("2000"));
    await tx.wait();

    // spot is back exactly at the ceiling, and the caller was refunded (spent some token, got ETH back)
    expect(Number((await stateView.getSlot0(poolId))[1])).to.equal(GRAD);
    const tokenSpent = tBefore - (await tok.balanceOf(trader.address));
    expect(tokenSpent).to.be.gt(0n);
    expect(tokenSpent).to.be.lt(ethers.parseEther("2000")); // unused token refunded, not all consumed
    expect(await curve.graduated()).to.equal(false);

    // graduation now goes through — spot is at the ceiling so the nudge branch is a no-op
    await curve.graduate();
    expect(await curve.graduated()).to.equal(true);
    expect((await stateView.getSlot0(poolId))[1]).to.equal(GRAD);
    expect(await posm.ownerOf(await posm.nextTokenId() - 1n)).to.equal(await lockVault.getAddress());
  });
});
