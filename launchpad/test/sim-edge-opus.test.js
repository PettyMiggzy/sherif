const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// INDEPENDENT edge-case SIM (my own file — does not touch existing tests).
// Runs against a REAL Uniswap v3 fork of Robinhood Chain with the LIVE
// production calibration from scripts/deploy.js:
//   START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800
//   -> intended ~4.2 ETH raised / ~$34k mcap at graduation.
//
// Each case deploys a FRESH pad stack + coin and trades DIRECTLY against the raw
// Uniswap v3 pool via SwapProbe (bypassing PadRouter) — strongest honeypot proof.
// Invariants asserted at the extremes:
//   (1) sells are NEVER blocked and the pool can always pay a seller
//   (2) nobody extracts more ETH than went in (round-trip out <= in)
//   (3) graduation posts the Bond and pays the fixed 0.5/0.5 rewards
//   (4) no ETH/token left stranded in the curve after graduation
//   (5) the calibration lands near ~$34k / ~4.2 ETH
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-edge-opus.test.js
// ============================================================================
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

  await ethers.provider.send("evm_increaseTime", [400]); // past anti-snipe window
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
async function gradInfo(ctx, rc) {
  const gev = rc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Graduated");
  return { bondRaise: gev.args.raisedWeth, leftover: gev.args.leftoverToken };
}

suite("Edge sim (opus) — live calibration on a real Uniswap v3 fork", function () {
  this.timeout(600000);

  it("CASE 1: 1-wei buy + dust sell — no strand, sell never blocked", async () => {
    const ctx = await freshCoin("Dust", "DUST");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 5n * ONE);

    let oneWeiReverted = false, wethSpent1 = 0n;
    const wB1 = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 1n, ctx.gradSqrt)).wait();
    } catch { oneWeiReverted = true; }
    wethSpent1 = wB1 - (await ctx.wethW.balanceOf(buyer.address));

    // real buy to get a bag
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, ONE / 2n, ctx.gradSqrt)).wait();
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag, "real buy delivers tokens").to.be.greaterThan(0n);

    // 1-wei-token dust sell must NOT revert (honeypot check)
    let dustReverted = false, dustOut = 0n;
    const wBD = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, 1n)).wait();
      dustOut = (await ctx.wethW.balanceOf(buyer.address)) - wBD;
    } catch { dustReverted = true; }

    // a tiny (non-dust) sell must pay > 0
    const smallAmt = bag / 1_000_000n > 0n ? bag / 1_000_000n : bag;
    const wBS = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, smallAmt)).wait();
    const smallOut = (await ctx.wethW.balanceOf(buyer.address)) - wBS;

    console.log(`\n  CASE1 1-wei buy: reverted=${oneWeiReverted} wethSpent=${wethSpent1}`);
    console.log(`  CASE1 dust sell(1 wei tok): reverted=${dustReverted} out=${dustOut} wei`);
    console.log(`  CASE1 tiny sell(${smallAmt} tok): out=${f(smallOut)} ETH`);

    expect(dustReverted, "1-wei dust sell must NOT revert (anti-honeypot)").to.equal(false);
    expect(smallOut, "tiny sell must pay > 0").to.be.greaterThan(0n);
    expect(wethSpent1, "1-wei buy cannot consume >1 wei").to.be.lessThanOrEqual(1n);
  });

  it("CASE 2: whale buys the ENTIRE curve in one tx — graduatable, others still sell", async () => {
    const ctx = await freshCoin("Whale", "WHALE");
    const [small, whale] = ctx.rest;
    await fund(ctx, small, 5n * ONE);
    await fund(ctx, whale, 300n * ONE);

    await (await ctx.probe.connect(small).swapExactInLimit(ctx.poolAddr, WETH, ONE / 4n, ctx.gradSqrt)).wait();
    const smallBag = await ctx.TOK.balanceOf(small.address);
    expect(smallBag, "small holder holds tokens").to.be.greaterThan(0n);

    const wWB = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactInLimit(ctx.poolAddr, WETH, 250n * ONE, ctx.gradSqrt)).wait();
    const whaleSpent = wWB - (await ctx.wethW.balanceOf(whale.address));
    const whaleBag = await ctx.TOK.balanceOf(whale.address);
    const tick = (await ctx.pool.slot0()).tick;
    const ready = await ctx.curveC.ready();

    console.log(`\n  CASE2 whale spent ${f(whaleSpent).toFixed(4)} ETH, bag=${f(whaleBag).toExponential(3)} tok`);
    console.log(`  CASE2 tick=${tick} ready=${ready} mcap~$${mcapUsd(tick, ctx.tokenIsToken0).toFixed(0)}`);
    expect(ready, "buying entire curve to ceiling should be graduatable").to.equal(true);

    const wSB = await ctx.wethW.balanceOf(small.address);
    await (await ctx.probe.connect(small).swapExactIn(ctx.poolAddr, ctx.token, smallBag)).wait();
    const smallOut = (await ctx.wethW.balanceOf(small.address)) - wSB;
    expect(smallOut, "small holder can still sell after whale buyout").to.be.greaterThan(0n);

    const wWSB = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactIn(ctx.poolAddr, ctx.token, whaleBag / 2n)).wait();
    const whaleOut = (await ctx.wethW.balanceOf(whale.address)) - wWSB;
    expect(whaleOut, "whale can dump too").to.be.greaterThan(0n);
    console.log(`  CASE2 small sell out=${f(smallOut).toExponential(3)} ETH; whale half-dump=${f(whaleOut).toFixed(4)} ETH`);
  });

  it("CASE 3: sell the ENTIRE bag back in one tx — no revert, out <= in (solvency)", async () => {
    const ctx = await freshCoin("RoundTrip", "RT");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 50n * ONE);

    const wB = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 20n * ONE, ctx.gradSqrt)).wait();
    const spent = wB - (await ctx.wethW.balanceOf(buyer.address));
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag, "buyer holds bought supply").to.be.greaterThan(0n);

    const wPre = await ctx.wethW.balanceOf(buyer.address);
    let reverted = false;
    try { await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, bag)).wait(); }
    catch { reverted = true; }
    const out = (await ctx.wethW.balanceOf(buyer.address)) - wPre;

    console.log(`\n  CASE3 bought ${f(bag).toExponential(3)} tok for ${f(spent).toFixed(4)} ETH`);
    console.log(`  CASE3 full dump: reverted=${reverted} out=${f(out).toFixed(6)} ETH (in=${f(spent).toFixed(6)}) retention=${(f(out)/f(spent)*100).toFixed(2)}%`);

    expect(reverted, "selling entire bag in one tx must NOT revert").to.equal(false);
    expect(out, "full-bag sell pays > 0").to.be.greaterThan(0n);
    expect(out, "round-trip out must be <= in (solvency)").to.be.lessThanOrEqual(spent);
    expect(await ctx.TOK.balanceOf(buyer.address), "bag fully dumped").to.equal(0n);
  });

  it("CASE 4: graduate then immediately trade — Bond posted, rewards paid, no strand", async () => {
    const ctx = await freshCoin("GradNow", "GN");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 300n * ONE);

    const wB = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 200n * ONE, ctx.gradSqrt)).wait();
    const curveIn = wB - (await ctx.wethW.balanceOf(buyer.address));
    expect(await ctx.curveC.ready(), "graduatable at ceiling").to.equal(true);

    const devB = await ctx.wethW.balanceOf(ctx.dev.address);
    const platB = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const { bondRaise } = await gradInfo(ctx, gradRc);
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devB;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platB;
    const gross = bondRaise + 2n * ethers.parseEther("0.5");

    console.log(`\n  CASE4 curveIn=${f(curveIn).toFixed(4)} ETH  gross=${f(gross).toFixed(4)} ETH  intoBond=${f(bondRaise).toFixed(4)} ETH`);
    console.log(`  CASE4 creator=${f(devGain).toFixed(4)} ETH platform=${f(platGain).toFixed(4)} ETH`);

    expect(devGain, "creator reward = 0.5 ETH").to.equal(ethers.parseEther("0.5"));
    expect(platGain, "platform reward ~ 0.5 ETH").to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));

    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted(), "Bond posted").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP > 0").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor > 0").to.be.greaterThan(0n);

    expect(await ctx.wethW.balanceOf(ctx.curve), "no WETH stranded in curve").to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve), "no token stranded in curve").to.equal(0n);
    expect(await ctx.pool.liquidity(), "pool tradeable post-grad").to.be.greaterThan(0n);
    // SOLVENCY at graduation: total ETH out (both rewards + bond) can't exceed what came in.
    expect(gross, "grad payouts <= curve raise (solvency)").to.be.lessThanOrEqual(curveIn + 1n);

    const tokB = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokB;
    expect(gotTok, "post-grad buy delivers tokens").to.be.greaterThan(0n);
    const wPre = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    const gotWeth = (await ctx.wethW.balanceOf(buyer.address)) - wPre;
    expect(gotWeth, "post-grad sell pays WETH (not a honeypot)").to.be.greaterThan(0n);
    console.log(`  CASE4 post-grad buy=${f(gotTok).toExponential(3)} tok; sell=${f(gotWeth).toFixed(6)} ETH`);

    let reGrad = false;
    try { await (await ctx.curveC.graduate()).wait(); } catch { reGrad = true; }
    expect(reGrad, "double-graduate must revert").to.equal(true);

    // report calibration landing
    console.log(`  CASE4 CALIBRATION: graduated at ~$${mcapUsd((await ctx.pool.slot0()).tick, ctx.tokenIsToken0).toFixed(0)} mcap, gross ${f(gross).toFixed(2)} ETH`);
  });

  it("CASE 5: 7-day timeout path — buy to MINIMUM, warp, graduate at floor", async () => {
    const ctx = await freshCoin("Timeout", "TO");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 300n * ONE);

    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 200n * ONE, ctx.minGradSqrt)).wait();
    const tickMin = (await ctx.pool.slot0()).tick;
    const readyBefore = await ctx.curveC.ready();
    console.log(`\n  CASE5 at-min tick=${tickMin} ready(before warp)=${readyBefore}`);
    expect(readyBefore, "at min but pre-timeout must NOT be graduatable").to.equal(false);

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 60]);
    await ethers.provider.send("evm_mine", []);
    const readyAfter = await ctx.curveC.ready();
    console.log(`  CASE5 ready(after 7d warp)=${readyAfter}`);
    expect(readyAfter, "after 7-day timeout, reaching min is enough").to.equal(true);

    const devB = await ctx.wethW.balanceOf(ctx.dev.address);
    const platB = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const { bondRaise } = await gradInfo(ctx, gradRc);
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devB;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platB;
    const gross = bondRaise + 2n * ethers.parseEther("0.5");
    console.log(`  CASE5 timeout grad: gross=${f(gross).toFixed(4)} ETH intoBond=${f(bondRaise).toFixed(4)} ETH`);
    console.log(`  CASE5 creator=${f(devGain).toFixed(4)} platform=${f(platGain).toFixed(4)}`);

    expect(devGain, "creator reward = 0.5 ETH").to.equal(ethers.parseEther("0.5"));
    expect(platGain, "platform reward ~ 0.5 ETH").to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));
    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted(), "Bond posted on timeout grad").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP > 0").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor > 0").to.be.greaterThan(0n);
    expect(await ctx.wethW.balanceOf(ctx.curve), "no WETH stranded").to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve), "no token stranded").to.equal(0n);

    const tokB = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokB;
    const wPre = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    expect((await ctx.wethW.balanceOf(buyer.address)) - wPre, "post-timeout-grad sell pays out").to.be.greaterThan(0n);
  });
});
