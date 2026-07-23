const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// EDGE-CASE SIMULATION (independent re-verification) against a REAL Uniswap v3
// fork of Robinhood Chain, using the LIVE production "let it ride" calibration
// from scripts/deploy.js:  START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800
//   -> intended graduation at ~4.2 ETH raised / ~$34k mcap.
//
// Each case deploys a FRESH stack + coin and trades DIRECTLY against the raw
// Uniswap v3 pool via SwapProbe (bypassing PadRouter) — the strongest anti-honeypot
// proof (no router fee/tax logic can "explain away" a stuck seller).
//
// Operator invariants asserted at the extremes:
//   (1) sells can NEVER be blocked (no honeypot) and the pool can always pay a seller
//   (2) nobody extracts more ETH than was put in (solvency: out <= in)
//   (3) graduation posts the Bond and pays the fixed rewards (0.5 + 0.5) correctly
//   (4) calibration lands ~$34k / ~4.2 ETH
//   (5) no ETH / token is stranded in the curve after graduation
//
// Cases: (1) 1-wei buy + dust sell  (2) whale buys entire curve in one tx
//        (3) sell entire bag back in one tx  (4) graduate then immediately trade
//        (5) 7-day timeout path (warp, graduate at the minimum)
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-edge-opus48-verify.test.js
// ============================================================================
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ETH_USD = 1920;
const HALF = ethers.parseEther("0.5");

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

suite("EDGE SIM (opus48 verify) — production calibration on real Uniswap v3 fork", function () {
  this.timeout(600000);

  it("CASE 1: 1-wei buy + dust sell — sell never blocked, no funds stranded", async () => {
    const ctx = await freshCoin("Dust", "DUST");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 5n * ONE);

    let oneWeiReverted = false, tok1 = 0n;
    const wBefore1 = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 1n, ctx.gradSqrt)).wait();
      tok1 = await ctx.TOK.balanceOf(buyer.address);
    } catch { oneWeiReverted = true; }
    const spent1 = wBefore1 - (await ctx.wethW.balanceOf(buyer.address));

    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, ONE / 2n, ctx.gradSqrt)).wait();
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag, "real buy delivers tokens").to.be.greaterThan(0n);

    let dustSellReverted = false, dustOut = 0n;
    const wPre = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, 1n)).wait();
      dustOut = (await ctx.wethW.balanceOf(buyer.address)) - wPre;
    } catch { dustSellReverted = true; }

    const smallAmt = bag / 1_000_000n > 0n ? bag / 1_000_000n : bag;
    const wPre2 = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, smallAmt)).wait();
    const smallOut = (await ctx.wethW.balanceOf(buyer.address)) - wPre2;

    console.log(`\n   C1 1-wei buy: reverted=${oneWeiReverted} spent=${spent1} tok=${tok1}`);
    console.log(`   C1 1-wei sell: reverted=${dustSellReverted} out=${dustOut}`);
    console.log(`   C1 tiny sell(${smallAmt}): out=${smallOut}`);

    expect(dustSellReverted, "1-wei dust sell must NOT revert (anti-honeypot)").to.equal(false);
    expect(smallOut, "non-dust tiny sell must pay > 0").to.be.greaterThan(0n);
    expect(spent1, "1-wei buy cannot consume > 1 wei").to.be.lessThanOrEqual(1n);
  });

  it("CASE 2: whale buys the ENTIRE curve in one tx — graduatable and others can still sell", async () => {
    const ctx = await freshCoin("Whale", "WHALE");
    const [small, whale] = ctx.rest;
    await fund(ctx, small, 5n * ONE);
    await fund(ctx, whale, 200n * ONE);

    await (await ctx.probe.connect(small).swapExactInLimit(ctx.poolAddr, WETH, ONE / 4n, ctx.gradSqrt)).wait();
    const smallBag = await ctx.TOK.balanceOf(small.address);
    expect(smallBag, "small holder holds tokens").to.be.greaterThan(0n);

    const wWhaleBefore = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactInLimit(ctx.poolAddr, WETH, 150n * ONE, ctx.gradSqrt)).wait();
    const whaleSpent = wWhaleBefore - (await ctx.wethW.balanceOf(whale.address));
    const whaleBag = await ctx.TOK.balanceOf(whale.address);

    const tick = (await ctx.pool.slot0()).tick;
    const ready = await ctx.curveC.ready();
    const mcap = mcapUsd(tick, ctx.tokenIsToken0);
    console.log(`\n   C2 whale spent ${f(whaleSpent).toFixed(4)} ETH, got ${f(whaleBag).toExponential(3)} tok`);
    console.log(`   C2 tick=${tick} ready=${ready} mcap≈$${mcap.toFixed(0)}`);

    expect(ready, "buying entire curve to ceiling is graduatable").to.equal(true);

    const wSmallBefore = await ctx.wethW.balanceOf(small.address);
    await (await ctx.probe.connect(small).swapExactIn(ctx.poolAddr, ctx.token, smallBag)).wait();
    const smallOut = (await ctx.wethW.balanceOf(small.address)) - wSmallBefore;
    expect(smallOut, "small holder can still sell after whale buyout").to.be.greaterThan(0n);

    const wWhaleSellBefore = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactIn(ctx.poolAddr, ctx.token, whaleBag / 2n)).wait();
    const whaleOut = (await ctx.wethW.balanceOf(whale.address)) - wWhaleSellBefore;
    expect(whaleOut, "whale can dump back too").to.be.greaterThan(0n);
    // whale round-trip solvency: cannot profit selling back half its bag for more than it paid
    expect(whaleOut, "whale half-dump out <= whale total spent (solvency)").to.be.lessThanOrEqual(whaleSpent);
    console.log(`   C2 small sell out=${f(smallOut).toExponential(3)} ETH; whale half-dump out=${f(whaleOut).toFixed(4)} ETH`);
    // record ceiling mcap for the calibration check (whale bought to the ceiling)
    console.log(`   C2 CEILING mcap≈$${mcap.toFixed(0)}`);
  });

  it("CASE 3: sell the ENTIRE bought supply back in one tx — no revert, out<=in", async () => {
    const ctx = await freshCoin("RoundTrip", "RT");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 50n * ONE);

    const wBefore = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 20n * ONE, ctx.gradSqrt)).wait();
    const spent = wBefore - (await ctx.wethW.balanceOf(buyer.address));
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag, "buyer holds bought supply").to.be.greaterThan(0n);

    const wPreSell = await ctx.wethW.balanceOf(buyer.address);
    let reverted = false;
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, bag)).wait();
    } catch { reverted = true; }
    const out = (await ctx.wethW.balanceOf(buyer.address)) - wPreSell;

    console.log(`\n   C3 bought ${f(bag).toExponential(3)} tok for ${f(spent).toFixed(4)} ETH`);
    console.log(`   C3 full sell: reverted=${reverted} out=${f(out).toFixed(6)} (in=${f(spent).toFixed(6)}) retention=${(f(out)/f(spent)*100).toFixed(2)}%`);

    expect(reverted, "full-bag sell must NOT revert").to.equal(false);
    expect(out, "full-bag sell pays out > 0").to.be.greaterThan(0n);
    expect(out, "round-trip out <= in (solvency)").to.be.lessThanOrEqual(spent);
    expect(await ctx.TOK.balanceOf(buyer.address), "bag fully dumped").to.equal(0n);
  });

  it("CASE 4: graduate then immediately trade — Bond posted, rewards paid, pool trades, calibration checks", async () => {
    const ctx = await freshCoin("GradNow", "GN");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 200n * ONE);

    const wBefore = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 120n * ONE, ctx.gradSqrt)).wait();
    const raisedIntoCurve = wBefore - (await ctx.wethW.balanceOf(buyer.address));
    expect(await ctx.curveC.ready(), "graduatable at ceiling").to.equal(true);

    const tickAtGrad = (await ctx.pool.slot0()).tick;
    const mcapAtGrad = mcapUsd(tickAtGrad, ctx.tokenIsToken0);

    const devBefore = await ctx.wethW.balanceOf(ctx.dev.address);
    const platBefore = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth;
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devBefore;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * HALF;

    console.log(`\n   C4 gross raise=${f(grossRaise).toFixed(4)} ETH  into Bond=${f(bondRaise).toFixed(4)} ETH`);
    console.log(`   C4 creator=${f(devGain).toFixed(4)}  platform=${f(platGain).toFixed(4)}`);
    console.log(`   C4 CALIBRATION: raise≈${f(grossRaise).toFixed(2)} ETH  grad mcap≈$${mcapAtGrad.toFixed(0)} (curve WETH in=${f(raisedIntoCurve).toFixed(3)})`);

    expect(devGain, "creator reward = 0.5 ETH").to.equal(HALF);
    expect(platGain, "platform reward ≈ 0.5 ETH").to.be.closeTo(HALF, ethers.parseEther("0.01"));

    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted(), "Bond posted").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP > 0").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor > 0").to.be.greaterThan(0n);

    expect(await ctx.wethW.balanceOf(ctx.curve), "no WETH stranded").to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve), "no token stranded").to.equal(0n);
    expect(await ctx.pool.liquidity(), "pool tradeable post-grad").to.be.greaterThan(0n);

    // CALIBRATION assertions (soft-ish bands around the ~4.2 ETH / ~$34k target)
    expect(f(grossRaise), "gross raise in a sane band ~4.2 ETH").to.be.within(3.0, 6.0);
    expect(mcapAtGrad, "grad mcap in a sane band ~$34k").to.be.within(25000, 45000);

    // immediate post-grad trade
    const tokBefore = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokBefore;
    expect(gotTok, "post-grad buy delivers tokens").to.be.greaterThan(0n);

    const wPreSell = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    const gotWeth = (await ctx.wethW.balanceOf(buyer.address)) - wPreSell;
    expect(gotWeth, "post-grad sell pays WETH (not a honeypot)").to.be.greaterThan(0n);
    console.log(`   C4 post-grad buy ${f(gotTok).toExponential(3)} tok; sell got ${f(gotWeth).toFixed(6)} ETH`);

    let reGrad = false;
    try { await (await ctx.curveC.graduate()).wait(); } catch { reGrad = true; }
    expect(reGrad, "double-graduate reverts").to.equal(true);
  });

  it("CASE 5: 7-day timeout path — buy to MINIMUM, warp, graduate at the floor", async () => {
    const ctx = await freshCoin("Timeout", "TO");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 200n * ONE);

    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 120n * ONE, ctx.minGradSqrt)).wait();
    const tickAtMin = (await ctx.pool.slot0()).tick;
    const readyBefore = await ctx.curveC.ready();
    console.log(`\n   C5 at minimum: tick=${tickAtMin} ready(before warp)=${readyBefore} mcap≈$${mcapUsd(tickAtMin, ctx.tokenIsToken0).toFixed(0)}`);
    expect(readyBefore, "at min but pre-timeout must NOT be graduatable").to.equal(false);

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 60]);
    await ethers.provider.send("evm_mine", []);
    const readyAfter = await ctx.curveC.ready();
    console.log(`   C5 ready(after 7d warp)=${readyAfter}`);
    expect(readyAfter, "after 7-day timeout, reaching the minimum is enough").to.equal(true);

    const devBefore = await ctx.wethW.balanceOf(ctx.dev.address);
    const platBefore = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth;
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devBefore;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * HALF;
    console.log(`   C5 timeout grad: gross=${f(grossRaise).toFixed(4)} into Bond=${f(bondRaise).toFixed(4)}  creator=${f(devGain).toFixed(4)} platform=${f(platGain).toFixed(4)}`);

    expect(devGain, "creator reward = 0.5 ETH").to.equal(HALF);
    expect(platGain, "platform reward ≈ 0.5 ETH").to.be.closeTo(HALF, ethers.parseEther("0.01"));
    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted(), "Bond posted on timeout grad").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP > 0").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor > 0").to.be.greaterThan(0n);
    expect(await ctx.wethW.balanceOf(ctx.curve), "no WETH stranded").to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve), "no token stranded").to.equal(0n);

    const tokBefore = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokBefore;
    const wPre = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    expect((await ctx.wethW.balanceOf(buyer.address)) - wPre, "post-timeout-grad sell pays out").to.be.greaterThan(0n);
  });
});
