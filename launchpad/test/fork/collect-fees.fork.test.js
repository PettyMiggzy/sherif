const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fork test: collectFees() — the NOXA model. Every trade pays the curve position the 1% fee tier,
// regardless of where it's executed; collectFees() streams that 1% to the platform WITHOUT touching the
// curve principal (the raise that becomes the Bond floor at graduation).
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/collect-fees.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("CurvePool.collectFees on a Robinhood Chain fork — the platform's live 1%", function () {
  this.timeout(240000);

  it("streams the 1% swap fee to the platform on every trade, leaving the curve principal intact", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const CURVE = 750_000_000n * ONE, AMBUSH = 250_000_000n * ONE;
    const TOK = await (await ethers.getContractFactory("CurveToken")).deploy("Meme", "MEME", CURVE + AMBUSH, dep.address);
    const tokAddr = await TOK.getAddress();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();

    const tokenIsToken0 = BigInt(tokAddr) < BigInt(WETH);
    const startTick = tokenIsToken0 ? -207200 : 207200;
    const width = 35800, minGradWidth = 19800;

    const curve = await (await ethers.getContractFactory("CurvePool")).deploy(
      tokAddr, WETH, FACTORY, platform.address, dev.address, await bd.getAddress(),
      CURVE, AMBUSH, startTick, width, minGradWidth
    );
    const curveAddr = await curve.getAddress();
    await (await TOK.connect(dep).transfer(curveAddr, CURVE + AMBUSH)).wait();
    await (await curve.seed()).wait();

    const poolAddr = await curve.pool();
    const weth = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    await (await weth.connect(buyer).deposit({ value: 30n * ONE })).wait();
    await (await weth.connect(buyer).approve(probeAddr, 30n * ONE)).wait();

    // ── a handful of real BUYS against the pool (each pays the 1% fee tier) ──
    const buyTotal = 4n * ONE; // 4 WETH of buys
    for (let i = 0; i < 4; i++) {
      await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE)).wait();
    }

    const curveLbefore = await curve.curveL();
    const platWethBefore = await weth.balanceOf(platform.address);
    const platTokBefore = await TOK.balanceOf(platform.address);

    // ── STREAM THE 1% to the platform mid-curve (no graduation needed) ──
    await (await curve.collectFees()).wait();

    const wethGained = (await weth.balanceOf(platform.address)) - platWethBefore;
    const tokGained = (await TOK.balanceOf(platform.address)) - platTokBefore;

    // Platform received real WETH fees — roughly 1% of buy notional (fee tier is 1%).
    expect(wethGained).to.be.greaterThan(0n);
    // sanity band: between 0.5% and 1.5% of the buy volume (slippage/rounding tolerance)
    expect(wethGained).to.be.greaterThan(buyTotal / 200n);   // > 0.5%
    expect(wethGained).to.be.lessThan(buyTotal / 66n);       // < 1.5%
    console.log(`      platform WETH fee: ${ethers.formatEther(wethGained)} (~${(Number(wethGained) / Number(buyTotal) * 100).toFixed(3)}% of ${ethers.formatEther(buyTotal)} buys)`);

    // The curve PRINCIPAL is untouched — fees are accounted separately from liquidity.
    expect(await curve.curveL()).to.equal(curveLbefore);

    // A second collect right after yields ~nothing (fees already swept) — no double dip, no revert.
    const before2 = await weth.balanceOf(platform.address);
    await (await curve.collectFees()).wait();
    expect((await weth.balanceOf(platform.address)) - before2).to.equal(0n);

    // ── the raise still builds and graduation still works (fees never came from the principal) ──
    const gradSqrt = await curve.gradSqrtPriceX96();
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 55n * ONE, gradSqrt)).wait();
    expect(await curve.ready()).to.equal(true);
    await (await curve.collectFees()).wait(); // sweep the fees from the buyout too, still pre-grad
    await (await curve.graduate()).wait();
    expect(await curve.graduated()).to.equal(true);

    // post-graduation collectFees is refused (position burned; fees already swept in graduate)
    await expect(curve.collectFees()).to.be.reverted;

    console.log(`      total token-side fees to platform: ${ethers.formatUnits(tokGained, 18)}`);
  });
});
