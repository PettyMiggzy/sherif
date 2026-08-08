const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinCurveV4 — the single-sided free bonding curve, driven against the REAL Uniswap v4 PoolManager deployed
// locally (no fork). This proves the trickiest V4 bits WITHOUT a fork RPC:
//   • seed pulls ZERO ETH (pure currency1/token position at the top tick),
//   • buyers (zeroForOne, ETH-in) walk the tick DOWN to the ceiling ⇒ ready() flips,
//   • collectFees routes the curve's LP fees to the platform (the locked "all LP → platform" model).
// Graduation's permanent-LP mint needs the real PositionManager → covered in the fork test.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;

describe("RobinCurveV4 — single-sided free curve on live-local PoolManager", () => {
  let owner, factory, trader, platform;
  let pm, stateView, th, reg, tok, sw, curve, key, curveAddr;
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n; // 1,000 tokens — small depth so a test buy can reach the ceiling

  beforeEach(async () => {
    [owner, factory, trader, platform] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    th = await (await ethers.getContractFactory("TickHelper")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    const tokAddr = await tok.getAddress();
    key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    await pm.initialize(key, await th.sqrt(START)); // init exactly at the curve top

    // positionManager/permit2/lockVault are only used at graduation → dummy non-zero here
    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), owner.address, owner.address, await stateView.getAddress(),
      owner.address, factory.address, await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 0
    );
    curveAddr = await curve.getAddress();
  });

  it("seeds a token-only position pulling NO ETH", async () => {
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await curve.connect(factory).seed();

    expect(await tok.balanceOf(curveAddr)).to.equal(0n); // all tokens went into the position
    expect(await ethers.provider.getBalance(curveAddr)).to.equal(0n); // NOT ONE WEI of ETH was required
    expect(await curve.curveL()).to.be.gt(0n);
    expect(await curve.seeded()).to.equal(true);
    expect(await curve.ready()).to.equal(false); // spot at the top, far from the ceiling
  });

  it("seed is factory-only and one-shot", async () => {
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await expect(curve.connect(trader).seed()).to.be.revertedWithCustomError(curve, "NotFactory");
    await curve.connect(factory).seed();
    await expect(curve.connect(factory).seed()).to.be.revertedWithCustomError(curve, "AlreadySeeded");
  });

  it("buys walk the tick down; collectFees routes LP fees to platform; ceiling ⇒ ready()", async () => {
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await curve.connect(factory).seed();

    const buy = (amt) => sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(amt) }
    );

    const t0 = (await stateView.getSlot0(await poolId()))[1];
    await buy("5");
    const t1 = (await stateView.getSlot0(await poolId()))[1];
    expect(t1).to.be.lt(t0); // tick moved DOWN (buy)

    // collectFees → the platform wallet receives the ETH-side LP fees
    const before = await ethers.provider.getBalance(platform.address);
    await curve.collectFees();
    expect(await ethers.provider.getBalance(platform.address)).to.be.gt(before);
    expect(await curve.ready()).to.equal(false); // still mid-curve

    // a large buy consumes the rest of the curve and lands at the ceiling
    await buy("5000");
    expect(await curve.ready()).to.equal(true);
  });

  async function poolId() {
    // PoolId = keccak256(abi.encode(PoolKey)); StateView takes the id. Derive it via the same encoding v4 uses.
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
      )
    );
  }
});
