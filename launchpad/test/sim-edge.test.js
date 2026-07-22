const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// EDGE-CASE SIM on a REAL Uniswap v3 fork of Robinhood Chain. Production
// "let it ride" calibration from scripts/deploy.js:
//   START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800
//   -> intended ~4.2 ETH raised / ~$34k mcap at graduation.
//
// Each case deploys a FRESH pad stack + coin and trades DIRECTLY against the raw
// Uniswap v3 pool via SwapProbe (bypassing PadRouter) — the strongest anti-honeypot
// proof. We assert the operator's invariants hold at the extremes:
//   (1) sells are NEVER blocked and the pool can always pay a seller
//   (2) nobody extracts more ETH than was put in (solvency: out <= in)
//   (3) graduation posts the Bond and pays the fixed rewards correctly
//   (4) no ETH / token is left stranded in the curve after graduation
//
// Cases:
//   (1) a 1-wei buy and a dust sell
//   (2) a single whale buys the ENTIRE curve in one tx (graduatable? others still sell?)
//   (3) sell the ENTIRE bought supply back in one tx
//   (4) trigger graduation then immediately trade
//   (5) the 7-day timeout path (warp, graduate at the MINIMUM)
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-edge.test.js
// ============================================================================
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ETH_USD = 1920;

const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;
const NOTAX = (dev) => ({ buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });

const suite = process.env.FORK_RPC ? describe : describe.skip;

// deploy a fresh pad stack + launch a plain 1% coin; return every handle a case needs
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

  // past the anti-snipe window so this is a normal live coin
  await ethers.provider.send("evm_increaseTime", [400]);
  await ethers.provider.send("evm_mine", []);

  return { dep, platform, dev, rest, token, curve, poolAddr, curveC, pool, TOK, wethW,
           probe, probeAddr, tokenIsToken0, gradSqrt, minGradSqrt };
}

// give an actor WETH + max approvals for both tokens
async function fund(ctx, actor, ethAmt) {
  const MAX = (1n << 250n);
  await ethers.provider.send("hardhat_setBalance", [actor.address, "0x" + (10n ** 27n).toString(16)]);
  await (await ctx.wethW.connect(actor).deposit({ value: ethAmt })).wait();
  await (await ctx.wethW.connect(actor).approve(ctx.probeAddr, MAX)).wait();
  await (await ctx.TOK.connect(actor).approve(ctx.probeAddr, MAX)).wait();
}

const f = (x) => Number(ethers.formatEther(x));

// mcap in USD from the pool's current tick, 1B supply
function mcapUsd(tick, tokenIsToken0) {
  const p1per0 = Math.pow(1.0001, Number(tick));
  const wethPerToken = tokenIsToken0 ? p1per0 : 1 / p1per0;
  return wethPerToken * 1e9 * ETH_USD;
}

suite("Edge-case sim — production calibration on a real Uniswap v3 fork", function () {
  this.timeout(600000);

  // ── CASE 1 ────────────────────────────────────────────────────────────────
  it("CASE 1: a 1-wei buy and a dust sell — neither breaks anything, sell not blocked", async () => {
    const ctx = await freshCoin("Dust", "DUST");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 5n * ONE);

    // 1-wei buy: acceptable to fill nothing; must NOT strand funds. Uniswap may revert a 1-wei
    // exact-in as a no-op (rounds output to 0) — that's a benign DEX quirk, not a honeypot.
    let oneWeiBuyReverted = false, tokFrom1Wei = 0n;
    const wBefore1 = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 1n, ctx.gradSqrt)).wait();
      tokFrom1Wei = await ctx.TOK.balanceOf(buyer.address);
    } catch { oneWeiBuyReverted = true; }
    const wethSpent1 = wBefore1 - (await ctx.wethW.balanceOf(buyer.address));

    // a real buy so we have a bag, then a DUST sell (1 wei of token). Must never revert (anti-honeypot).
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, ONE / 2n, ctx.gradSqrt)).wait();
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag, "real buy should deliver tokens").to.be.greaterThan(0n);

    let dustSellReverted = false, dustOut = 0n;
    const wBeforeDust = await ctx.wethW.balanceOf(buyer.address);
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, 1n)).wait();
      dustOut = (await ctx.wethW.balanceOf(buyer.address)) - wBeforeDust;
    } catch { dustSellReverted = true; }

    // a normal-size dust sell (0.0001% of bag) must ALSO go through and pay something back
    const smallAmt = bag / 1_000_000n > 0n ? bag / 1_000_000n : bag;
    const wBeforeSmall = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, smallAmt)).wait();
    const smallOut = (await ctx.wethW.balanceOf(buyer.address)) - wBeforeSmall;

    console.log(`\n      CASE 1 — 1-wei buy: reverted=${oneWeiBuyReverted} weth_spent=${wethSpent1} tok=${tokFrom1Wei}`);
    console.log(`      CASE 1 — 1-wei dust sell: reverted=${dustSellReverted} weth_out=${dustOut}`);
    console.log(`      CASE 1 — tiny sell (${smallAmt} tok): weth_out=${smallOut}`);

    // INVARIANTS: the 1-wei sell must not revert (no honeypot); the tiny sell must pay > 0.
    expect(dustSellReverted, "a 1-wei dust sell must NOT revert (anti-honeypot)").to.equal(false);
    expect(smallOut, "a tiny (non-dust) sell must pay out > 0").to.be.greaterThan(0n);
    // 1-wei buy either fills nothing or a trivial amount; never strands more weth than it took
    expect(wethSpent1, "1-wei buy cannot consume more than 1 wei").to.be.lessThanOrEqual(1n);
  });

  // ── CASE 2 ────────────────────────────────────────────────────────────────
  it("CASE 2: a whale buys the ENTIRE curve in one tx — it graduates and others can still sell", async () => {
    const ctx = await freshCoin("Whale", "WHALE");
    const [small, whale] = ctx.rest;
    await fund(ctx, small, 5n * ONE);
    await fund(ctx, whale, 200n * ONE);

    // a small holder buys FIRST so we can prove they can still exit after the whale
    await (await ctx.probe.connect(small).swapExactInLimit(ctx.poolAddr, WETH, ONE / 4n, ctx.gradSqrt)).wait();
    const smallBag = await ctx.TOK.balanceOf(small.address);
    expect(smallBag, "small holder should hold tokens").to.be.greaterThan(0n);

    // the whale slams the ENTIRE remaining curve in ONE tx, capped at the ceiling (can't overshoot)
    const wWhaleBefore = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactInLimit(ctx.poolAddr, WETH, 150n * ONE, ctx.gradSqrt)).wait();
    const whaleSpent = wWhaleBefore - (await ctx.wethW.balanceOf(whale.address));
    const whaleBag = await ctx.TOK.balanceOf(whale.address);

    const tick = (await ctx.pool.slot0()).tick;
    const ready = await ctx.curveC.ready();
    console.log(`\n      CASE 2 — whale spent ${f(whaleSpent).toFixed(4)} ETH, got ${f(whaleBag).toExponential(3)} tok`);
    console.log(`      CASE 2 — tick=${tick}  ready=${ready}  mcap≈$${mcapUsd(tick, ctx.tokenIsToken0).toFixed(0)}`);

    // buying the whole curve to the ceiling must make it graduatable
    expect(ready, "buying the entire curve to the ceiling should be graduatable").to.equal(true);

    // ── others can STILL SELL even after the curve is maxed out (not a honeypot) ──
    const wSmallBefore = await ctx.wethW.balanceOf(small.address);
    await (await ctx.probe.connect(small).swapExactIn(ctx.poolAddr, ctx.token, smallBag)).wait();
    const smallOut = (await ctx.wethW.balanceOf(small.address)) - wSmallBefore;
    expect(smallOut, "small holder must still be able to sell after the whale buyout").to.be.greaterThan(0n);

    // the whale can also dump part of its bag back
    const wWhaleSellBefore = await ctx.wethW.balanceOf(whale.address);
    await (await ctx.probe.connect(whale).swapExactIn(ctx.poolAddr, ctx.token, whaleBag / 2n)).wait();
    const whaleOut = (await ctx.wethW.balanceOf(whale.address)) - wWhaleSellBefore;
    expect(whaleOut, "whale can sell back too").to.be.greaterThan(0n);
    console.log(`      CASE 2 — small holder sell out=${f(smallOut).toExponential(3)} ETH; whale half-dump out=${f(whaleOut).toFixed(4)} ETH`);
  });

  // ── CASE 3 ────────────────────────────────────────────────────────────────
  it("CASE 3: sell the ENTIRE bought supply back in one tx — succeeds, out<=in, no revert", async () => {
    const ctx = await freshCoin("RoundTrip", "RT");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 50n * ONE);

    const wBefore = await ctx.wethW.balanceOf(buyer.address);
    // buy a big chunk of the curve (capped at the ceiling)
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 20n * ONE, ctx.gradSqrt)).wait();
    const spent = wBefore - (await ctx.wethW.balanceOf(buyer.address));
    const bag = await ctx.TOK.balanceOf(buyer.address);
    expect(bag, "buyer should hold the whole bought supply").to.be.greaterThan(0n);

    // dump the ENTIRE bag in one tx
    const wPreSell = await ctx.wethW.balanceOf(buyer.address);
    let reverted = false;
    try {
      await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, bag)).wait();
    } catch { reverted = true; }
    const out = (await ctx.wethW.balanceOf(buyer.address)) - wPreSell;

    console.log(`\n      CASE 3 — bought ${f(bag).toExponential(3)} tok for ${f(spent).toFixed(4)} ETH`);
    console.log(`      CASE 3 — full round-trip sell: reverted=${reverted} out=${f(out).toFixed(6)} ETH (in=${f(spent).toFixed(6)})`);
    console.log(`      CASE 3 — round-trip retention: ${(f(out) / f(spent) * 100).toFixed(2)}% (rest kept by pool/fees)`);

    expect(reverted, "selling the entire bag in one tx must NOT revert").to.equal(false);
    expect(out, "full-bag sell must pay out > 0").to.be.greaterThan(0n);
    // SOLVENCY: a round trip cannot profit — out must be <= in
    expect(out, "round-trip out must be <= in (solvency)").to.be.lessThanOrEqual(spent);
    // buyer should have essentially no tokens left
    const leftover = await ctx.TOK.balanceOf(buyer.address);
    expect(leftover, "buyer should have dumped the whole bag").to.equal(0n);
  });

  // ── CASE 4 ────────────────────────────────────────────────────────────────
  it("CASE 4: trigger graduation, then immediately trade — Bond posted, rewards paid, pool trades", async () => {
    const ctx = await freshCoin("GradNow", "GN");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 200n * ONE);

    // buy the curve up to the ceiling so it graduates
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 120n * ONE, ctx.gradSqrt)).wait();
    expect(await ctx.curveC.ready(), "should be graduatable at ceiling").to.equal(true);

    const devBefore = await ctx.wethW.balanceOf(ctx.dev.address);
    const platBefore = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth;
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devBefore;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * ethers.parseEther("0.5");

    console.log(`\n      CASE 4 — graduated. gross raise=${f(grossRaise).toFixed(4)} ETH  into Bond=${f(bondRaise).toFixed(4)} ETH`);
    console.log(`      CASE 4 — creator=${f(devGain).toFixed(4)} ETH  platform=${f(platGain).toFixed(4)} ETH`);

    // (3) rewards paid correctly: fixed 0.5 each (platform also sweeps tiny weth dust)
    expect(devGain, "creator reward = 0.5 ETH").to.equal(ethers.parseEther("0.5"));
    expect(platGain, "platform reward ≈ 0.5 ETH").to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));

    // (3) Bond posted with both legs
    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted(), "Bond posted").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP > 0").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor > 0").to.be.greaterThan(0n);

    // (4) nothing stranded in the curve
    expect(await ctx.wethW.balanceOf(ctx.curve), "no WETH stranded in curve").to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve), "no token stranded in curve").to.equal(0n);
    expect(await ctx.pool.liquidity(), "pool tradeable post-grad").to.be.greaterThan(0n);

    // ── IMMEDIATELY trade the graduated pool: a buy then a sell, both must succeed ──
    const tokBefore = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokBefore;
    expect(gotTok, "post-grad buy delivers tokens").to.be.greaterThan(0n);

    const wPreSell = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    const gotWeth = (await ctx.wethW.balanceOf(buyer.address)) - wPreSell;
    expect(gotWeth, "post-grad sell pays WETH (not a honeypot)").to.be.greaterThan(0n);
    console.log(`      CASE 4 — post-grad buy got ${f(gotTok).toExponential(3)} tok; sell got ${f(gotWeth).toFixed(6)} ETH`);

    // graduating twice must fail cleanly
    let reGrad = false;
    try { await (await ctx.curveC.graduate()).wait(); } catch { reGrad = true; }
    expect(reGrad, "double-graduate must revert (AlreadyGraduated)").to.equal(true);
  });

  // ── CASE 5 ────────────────────────────────────────────────────────────────
  it("CASE 5: the 7-day timeout path — buy to the MINIMUM, warp, graduate at the floor", async () => {
    const ctx = await freshCoin("Timeout", "TO");
    const [buyer] = ctx.rest;
    await fund(ctx, buyer, 200n * ONE);

    // buy up to the MINIMUM graduation price (below the dev's default target at min+40% of the band),
    // so normal graduation is NOT unlocked — only the 7-day abandon-proof fallback can graduate this.
    await (await ctx.probe.connect(buyer).swapExactInLimit(ctx.poolAddr, WETH, 120n * ONE, ctx.minGradSqrt)).wait();
    const tickAtMin = (await ctx.pool.slot0()).tick;
    const readyBefore = await ctx.curveC.ready();
    console.log(`\n      CASE 5 — at minimum: tick=${tickAtMin}  ready(before warp)=${readyBefore}`);
    // must NOT be graduatable yet: we're at the min but below the dev's target and the timeout hasn't passed
    expect(readyBefore, "at the minimum but pre-timeout it must NOT be graduatable").to.equal(false);

    // warp past the 7-day GRAD_TIMEOUT
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 60]);
    await ethers.provider.send("evm_mine", []);
    const readyAfter = await ctx.curveC.ready();
    console.log(`      CASE 5 — ready(after 7d warp)=${readyAfter}`);
    expect(readyAfter, "after the 7-day timeout, reaching the minimum is enough").to.equal(true);

    // graduate at the minimum floor
    const devBefore = await ctx.wethW.balanceOf(ctx.dev.address);
    const platBefore = await ctx.wethW.balanceOf(ctx.platform.address);
    const gradRc = await (await ctx.curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return ctx.curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth;
    const devGain = (await ctx.wethW.balanceOf(ctx.dev.address)) - devBefore;
    const platGain = (await ctx.wethW.balanceOf(ctx.platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * ethers.parseEther("0.5");
    console.log(`      CASE 5 — timeout graduation: gross=${f(grossRaise).toFixed(4)} ETH into Bond=${f(bondRaise).toFixed(4)} ETH`);
    console.log(`      CASE 5 — creator=${f(devGain).toFixed(4)}  platform=${f(platGain).toFixed(4)}`);

    expect(devGain, "creator reward = 0.5 ETH").to.equal(ethers.parseEther("0.5"));
    expect(platGain, "platform reward ≈ 0.5 ETH").to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));
    const bond = await ethers.getContractAt("Bond", await ctx.curveC.bond());
    expect(await bond.posted(), "Bond posted on timeout graduation").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP > 0").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor > 0").to.be.greaterThan(0n);
    expect(await ctx.wethW.balanceOf(ctx.curve), "no WETH stranded in curve").to.equal(0n);
    expect(await ctx.TOK.balanceOf(ctx.curve), "no token stranded in curve").to.equal(0n);

    // and the graduated pool trades: a post-timeout sell must pay out
    const tokBefore = await ctx.TOK.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, WETH, ONE / 2n)).wait();
    const gotTok = (await ctx.TOK.balanceOf(buyer.address)) - tokBefore;
    const wPre = await ctx.wethW.balanceOf(buyer.address);
    await (await ctx.probe.connect(buyer).swapExactIn(ctx.poolAddr, ctx.token, gotTok / 2n)).wait();
    expect((await ctx.wethW.balanceOf(buyer.address)) - wPre, "post-timeout-grad sell pays out").to.be.greaterThan(0n);
  });
});
