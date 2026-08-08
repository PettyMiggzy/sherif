const { ethers } = require("hardhat");
const { expect } = require("chai");

// SIM — curve-phase economics against the REAL Uniswap v4 PoolManager (local, no fork). Proves:
//   • the single-sided raise accumulates as ETH inside the curve position (no ETH seeded),
//   • ALL curve LP fees (ETH from buys, token from sells) accrue to the platform book exactly,
//   • claimPlatform drains the book to zero and leaves NO un-booked value stuck on the controller,
//   • a full buyout lands at/below the ceiling ⇒ ready().
// Graduation's permanent-LP mint needs the real PositionManager → the fork test covers that leg.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;

describe("SIM — curve raise + LP fees conserve to platform", () => {
  it("buys/sells accrue all LP fees to the platform book; claim drains exactly; nothing stuck", async () => {
    const [owner, factory, trader, platform] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
    const tokAddr = await tok.getAddress();
    const key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    await pm.initialize(key, await th.sqrt(START));

    const curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), owner.address, owner.address, await stateView.getAddress(),
      owner.address, factory.address, await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 0
    );
    const curveAddr = await curve.getAddress();

    await tok.connect(owner).transfer(curveAddr, 1000n * 10n ** 18n);
    await curve.connect(factory).seed();
    expect(await ethers.provider.getBalance(curveAddr)).to.equal(0n); // no ETH seeded

    const buy = (amt) => sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(amt) }
    );
    const sell = (wei) => sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -wei, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );

    // a mix of buys and a sell, collecting fees along the way
    await buy("3");
    await curve.collectFees();
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sell(5n * 10n ** 17n); // sell 0.5 token back → token-side LP fee
    await curve.collectFees();
    await buy("4");
    await curve.collectFees();

    const ethOwed = await curve.platformEthOwed();
    const tokOwed = await curve.platformTokenOwed();
    expect(ethOwed).to.be.gt(0n); // ETH LP fees from buys
    expect(tokOwed).to.be.gt(0n); // token LP fees from the sell

    // the controller physically holds exactly the booked fees (raise is inside the pool, not here)
    expect(await ethers.provider.getBalance(curveAddr)).to.equal(ethOwed);
    expect(await tok.balanceOf(curveAddr)).to.equal(tokOwed);

    // claim drains the book to the platform EXACTLY; nothing stuck on the controller
    const ethBefore = await ethers.provider.getBalance(platform.address);
    const tokBefore = await tok.balanceOf(platform.address);
    await curve.claimPlatform();
    expect((await ethers.provider.getBalance(platform.address)) - ethBefore).to.equal(ethOwed);
    expect((await tok.balanceOf(platform.address)) - tokBefore).to.equal(tokOwed);
    expect(await curve.platformEthOwed()).to.equal(0n);
    expect(await curve.platformTokenOwed()).to.equal(0n);
    expect(await ethers.provider.getBalance(curveAddr)).to.equal(0n);
    expect(await tok.balanceOf(curveAddr)).to.equal(0n);

    // buy out the rest → ceiling reached
    await buy("6000");
    expect(await curve.ready()).to.equal(true);
  });
});
