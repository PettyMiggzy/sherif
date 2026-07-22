const { expect } = require("chai");
const { ethers } = require("hardhat");

// Independent edge-case sim (own file, does not touch existing tests). Real Uniswap v3
// fork of Robinhood Chain, production calibration from scripts/deploy.js.
//   START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800
// Cases:
//   (1) 1-wei buy + dust sell
//   (2) whale buys the ENTIRE curve in one tx (graduatable? others still sell?)
//   (3) sell the ENTIRE bag back in one tx (out<=in, no revert)
//   (4) graduate then immediately trade (Bond posted, rewards paid, pool trades)
//   (5) 7-day timeout path (warp, graduate at the minimum)
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ETH_USD = 1920;

const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;
const NOTAX = (dev) => ({ buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });

const suite = process.env.FORK_RPC ? describe : describe.skip;

async function freshCoin(name, symbol) {
  const [dep, platform, dev, ...rest] = await ethers.getSigners();
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
    START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
  );
  await (await router.setFactory(await factory.getAddress())).wait();

  const rc = await (await factory.launch({ name, symbol, dev: dev.address, tax: NOTAX(dev.address) })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;

  const curveC = await ethers.getContractAt("CurvePool", curve);
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
  const TOK = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);
  const wethW = await ethers.getContractAt(
    ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
  const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
  const probeAddr = await probe.getAddress();

  const tokenIsToken0 = await curveC.tokenIsToken0();
  const gradSqrt = await curveC.gradSqrtPriceX96();
  const minGradSqrt = await curveC.minGradSqrtPriceX96();

  await ethers.provider.send("evm_increaseTime", [400]);
  await ethers.provider.send("evm_mine", []);

  return { dep, platform, dev, rest, token, curve, poolAddr, curveC, pool, TOK, wethW,
           probe, probeAddr, tokenIsToken0, gradSqrt, minGradSqrt };
}

async function fund(ctx, actor, ethAmt) {
  const MAX = (1n << 250n);
  await ethers.provider.send("hardhat_setBalance", [actor.address, "0x" + (10n ** 27n).toString(16)]);
  await (await ctx.wethW.connect(actor).deposit({ value: ethAmt })).wait();
  await (await ctx.wethW.connect(actor).approve(ctx.probeAddr, MAX)).wait();
  await (await ctx.TOK.connect(actor).approve(ctx.probeAddr, MAX)).wait();
}

const f = (x) => Number(ethers.formatEther(x));
function mcapUsd(tick, tokenIsToken0) {
  const p1per0 = Math.pow(1.0001, Number(tick));
  const wethPerToken = tokenIsToken0 ? p1per0 : 1 / p1per0;
  return wethPerToken * 1e9 * ETH_USD;
}

suite("Edge-case sim RUN — production calibration on a real Uniswap v3 fork", function () {
  this.timeout(600000);

  it("CASE 1: 1-wei buy and dust sell", async () => {
    const ctx = await freshCoin("Dust", "DUST");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 5n * ONE);

    let oneWeiBuyReverted = false, tokFrom1Wei = 0n;
    const wBefore1 = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 1n, ctx.gradSqrt)).wait();
      tokFrom1Wei = await ctx.TOK.balanceOf(buyer.address);
    } catch { oneWeiBuyReverted = true; }
    const wethSpent1 = wBefore1 - (await ctx.wethW.balanceOf(buyer.address));

    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, ONE / 2n, ctx.gradSqrt)).wait();
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag).to.be.greaterThan(0n);

    let dustSellReverted = false, dustOut = 0n;
    const wBeforeDust = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, 1n)).wait();
      dustOut = (await ctx.wethW.balanceOf(buyer.address)) - wBeforeDust;
    } catch { dustSellReverted = true; }

    const smallAmt = bag / 1_000_000n > 0n ? bag / 1_000_000n : bag;
    const wBeforeSmall = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, smallAmt)).wait();
    const smallOut = (await ctx.wethW.balanceOf(buyer.address)) - wBeforeSmall;

    console.log(`\n      CASE1 1weiBuy reverted=${oneWeiBuyReverted} weth_spent=${wethSpent1} tok=${tokFrom1Wei}`);
    console.log(`      CASE1 1weiSell reverted=${dustSellReverted} weth_out=${dustOut}`);
    console.log(`      CASE1 tinySell amt=${smallAmt} weth_out=${smallOut}`);

    expect(dustSellReverted).to.equal(false);
    expect(smallOut).to.be.greaterThan(0n);
    expect(wethSpent1).to.be.lessThanOrEqual(1n);
  });

  it("CASE 2: whale buys the ENTIRE curve in one tx", async () => {
    const ctx = await freshCoin("Whale", "WHALE");
    const [small, whale] = ctx.rest;
    await fund(ctx, small, 5n * ONE);
    await fund(ctx, whale, 200n * ONE);

    await (await ctx.probe.connect(small).swapExactInLimit(ctx.poolAddr, WETH, ONE / 4n, ctx.gradSqrt)).wait();
    const smallBag = await ctx.TOK.balanceOf(small.address);
    expect(smallBag).to.be.greaterThan(0n);

    const wWhaleBefore = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactInLimit(ctx.poolAddr, WETH, 150n * ONE, ctx.gradSqrt)).wait();
    const whaleSpent = wWhaleBefore - (await ctx.wethW.balanceOf(whale.address));
    const whaleBag = await ctx.TOK.balanceOf(whale.address);

    const tick = (await ctx.pool.slot0()).tick;
    const ready = await ctx.curveC.ready();
    console.log(`\n      CASE2 whaleSpent=${f(whaleSpent).toFixed(4)}ETH bag=${f(whaleBag).toExponential(3)} tick=${tick} ready=${ready} mcap=$${mcapUsd(tick, ctx.tokenIsToken0).toFixed(0)}`);
    expect(ready).to.equal(true);

    const wSmallBefore = await ctx.wethW.balanceOf(small.address);
    await (await ctx.probe.connect(small).swapExactIn(ctx.poolAddr, ctx.token, smallBag)).wait();
    const smallOut = (await ctx.wethW.balanceOf(small.address)) - wSmallBefore;
    expect(smallOut).to.be.greaterThan(0n);

    const wWhaleSellBefore = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactIn(ctx.poolAddr, ctx.token, whaleBag / 2n)).wait();
    const whaleOut = (await ctx.wethW.balanceOf(whale.address)) - wWhaleSellBefore;
    expect(whaleOut).to.be.greaterThan(0n);
    console.log(`      CASE2 smallSellOut=${f(smallOut).toExponential(3)}ETH whaleHalfDumpOut=${f(whaleOut).toFixed(4)}ETH`);
  });

  it("CASE 3: sell the ENTIRE bought supply back in one tx", async () => {
    const ctx = await freshCoin("RoundTrip", "RT");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 50n * ONE);

    const wBefore = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 20n * ONE, ctx.gradSqrt)).wait();
    const spent = wBefore - (await ctx.wethW.balanceOf(buyer.address));
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag).to.be.greaterThan(0n);

    const wPreSell = await ctx.wethW.balanceOf(buyer.address);
    let reverted = false;
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, bag)).wait();
    } catch { reverted = true; }
    const out = (await ctx.wethW.balanceOf(buyer.address)) - wPreSell;

    console.log(`\n      CASE3 bought=${f(bag).toExponential(3)}tok for ${f(spent).toFixed(4)}ETH`);
    console.log(`      CASE3 fullSell reverted=${reverted} out=${f(out).toFixed(6)}ETH in=${f(spent).toFixed(6)} retention=${(f(out)/f(spent)*100).toFixed(2)}%`);

    expect(reverted).to.equal(false);
    expect(out).to.be.greaterThan(0n);
    expect(out).to.be.lessThanOrEqual(spent);
    expect(await ctx.TOK.balanceOf(buyer.address)).to.equal(0n);
  });

  it("CASE 4: trigger graduation then immediately trade", async () => {
    const ctx = await freshCoin("GradNow", "GN");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 200n * ONE);

    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 120n * ONE, ctx.gradSqrt)).wait();
    expect(await ctx.curveC.ready()).to.equal(true);

    const devBefore = await ctx.wethW.balanceOf(ctx.dev.address);
    const platBefore = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth;
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devBefore;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * ethers.parseEther("0.5");

    console.log(`\n      CASE4 gross=${f(grossRaise).toFixed(4)}ETH intoBond=${f(bondRaise).toFixed(4)}ETH creator=${f(devGain).toFixed(4)} platform=${f(platGain).toFixed(4)}`);

    expect(devGain).to.equal(ethers.parseEther("0.5"));
    expect(platGain).to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));

    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);

    expect(await ctx.wethW.balanceOf(ctx.curve)).to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve)).to.equal(0n);
    expect(await ctx.pool.liquidity()).to.be.greaterThan(0n);

    const tokBefore = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokBefore;
    expect(gotTok).to.be.greaterThan(0n);

    const wPreSell = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    const gotWeth = (await ctx.wethW.balanceOf(buyer.address)) - wPreSell;
    expect(gotWeth).to.be.greaterThan(0n);
    console.log(`      CASE4 postGrad buy=${f(gotTok).toExponential(3)}tok sell=${f(gotWeth).toFixed(6)}ETH`);

    let reGrad = false;
    try { await (await ctx.curveC.graduate()).wait(); } catch { reGrad = true; }
    expect(reGrad).to.equal(true);
  });

  it("CASE 5: 7-day timeout path — buy to MINIMUM, warp, graduate at floor", async () => {
    const ctx = await freshCoin("Timeout", "TO");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 200n * ONE);

    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 120n * ONE, ctx.minGradSqrt)).wait();
    const tickAtMin = (await ctx.pool.slot0()).tick;
    const readyBefore = await ctx.curveC.ready();
    console.log(`\n      CASE5 atMin tick=${tickAtMin} ready(beforeWarp)=${readyBefore}`);
    expect(readyBefore).to.equal(false);

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 60]);
    await ethers.provider.send("evm_mine", []);
    const readyAfter = await ctx.curveC.ready();
    console.log(`      CASE5 ready(after7dWarp)=${readyAfter}`);
    expect(readyAfter).to.equal(true);

    const devBefore = await ctx.wethW.balanceOf(ctx.dev.address);
    const platBefore = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth;
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devBefore;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * ethers.parseEther("0.5");
    console.log(`      CASE5 timeoutGrad gross=${f(grossRaise).toFixed(4)}ETH intoBond=${f(bondRaise).toFixed(4)}ETH creator=${f(devGain).toFixed(4)} platform=${f(platGain).toFixed(4)}`);

    expect(devGain).to.equal(ethers.parseEther("0.5"));
    expect(platGain).to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));
    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await ctx.wethW.balanceOf(ctx.curve)).to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve)).to.equal(0n);

    const tokBefore = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokBefore;
    const wPre = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    expect((await ctx.wethW.balanceOf(buyer.address)) - wPre).to.be.greaterThan(0n);
  });
});
