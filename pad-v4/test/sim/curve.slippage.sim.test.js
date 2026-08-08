const { ethers } = require("hardhat");
const { expect } = require("chai");

// SIM — kill the "50% slippage" ghost. Proves that on the V4 single-sided curve a normal buy's round-trip
// (buy then immediately sell back) loses only ~the LP fee, NOT tens of percent — the V3 50% was the wide-curve
// FDV≫liquidity soft-mark, not pool slippage. Also measures round-trip for a whale buy to size the geometry.
// Real Uniswap v4 PoolManager, local (no fork).

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;

describe("SIM — curve round-trip slippage is ~fees, not 50%", () => {
  let owner, factory, trader, platform, pm, stateView, th, reg, tok, sw, curve, key;
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000; // 0.3% LP fee; ~1.35x start→ceiling (deep, narrow)
  const CURVE_SUPPLY = 100000n * 10n ** 18n; // a deep curve so a normal buy is a small fraction

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
    await pm.initialize(key, await th.sqrt(START));
    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), owner.address, owner.address, await stateView.getAddress(),
      owner.address, factory.address, await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 0, owner.address
    );
    await tok.connect(owner).transfer(await curve.getAddress(), CURVE_SUPPLY);
    await curve.connect(factory).seed();
  });

  async function roundTrip(ethIn) {
    // buy ethIn worth of token, then immediately sell 100% of it back; return the % lost
    const tokBefore = await tok.balanceOf(trader.address);
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(ethIn), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(ethIn) }
    );
    const bought = (await tok.balanceOf(trader.address)) - tokBefore;
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    const ethBefore = await ethers.provider.getBalance(trader.address);
    const rc = await (await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -bought, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    )).wait();
    const ethOut = (await ethers.provider.getBalance(trader.address)) - ethBefore + rc.gasUsed * rc.gasPrice;
    const paid = ethers.parseEther(ethIn);
    return Number((paid - ethOut) * 10000n / paid) / 100; // % lost
  }

  it("a normal buy round-trips for ~the fee (<3%), nowhere near 50%", async () => {
    const lossSmall = await roundTrip("0.1"); // small buyer
    const lossMed = await roundTrip("2"); // medium buyer
    // 0.3% LP fee each way ⇒ ~0.6% floor; price impact on a deep curve is tiny and symmetric (recovered on exit)
    expect(lossSmall).to.be.lt(3);
    expect(lossMed).to.be.lt(3);
    expect(lossSmall).to.be.gt(0); // it does cost the fee — not free
  });

  it("even a WHALE buy round-trips well under 50% (impact is symmetric, only fees stick)", async () => {
    const lossWhale = await roundTrip("50");
    expect(lossWhale).to.be.lt(10); // the V3 disaster was ~50%; a deep V4 curve stays single digits
  });
});
