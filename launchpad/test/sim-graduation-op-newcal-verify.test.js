const { expect } = require("chai");
const { ethers } = require("hardhat");

// SIMULATE graduation with the NEW calibration (START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800)
// against the REAL Uniswap v3 on a Robinhood-Chain fork. Deploy a fresh CurvePadFactory with that geometry,
// buy the curve to the ceiling so it graduates, and assert the calibration lands where the operator intends:
// ~4.2 ETH raised / ~$34k mcap, split 0.5 creator + 0.5 platform + ~3.2 ETH into the Bond, and the pool still
// trades (buy + sell) after graduation. Also exercises a mid-curve sell (anti-honeypot invariant #1).
//   (own file — does not modify existing tests)
//   FORK_RPC=<rpc> npx hardhat test test/sim-graduation-op-newcal-verify.test.js
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ETH_USD = 1920; // same $/ETH assumption the deploy calibration used

// NEW graduation calibration under test
const START_TICK_MAG = 201600;
const CURVE_WIDTH = 23000;
const MIN_GRAD_WIDTH = 22800;

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Graduation sim (op-newcal-verify) — NEW calibration 201600/23000/22800 → ~4.2 ETH / ~$34k", function () {
  this.timeout(240000);

  it("buys to the ceiling, graduates at the intended raise/mcap/split; sells never blocked; pool still trades", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    // ── deploy the pad stack with the NEW geometry ──────────────────────────────
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

    // ── launch a coin (no dev buy) ──────────────────────────────────────────────
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Sim", symbol: "SIM", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], token);
    const tokenIsToken0 = await curveC.tokenIsToken0();

    // ── buyer funding: WETH + approvals for the swap probe ──────────────────────
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt([
      "function deposit() payable",
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ], WETH);
    const tokErc = await ethers.getContractAt(["function approve(address,uint256) returns (bool)"], token);
    await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 24n).toString(16)]);
    await (await wethW.connect(buyer).deposit({ value: 100n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 1n << 250n)).wait();

    await ethers.provider.send("evm_increaseTime", [400]); // past the 5-min anti-snipe window
    await ethers.provider.send("evm_mine", []);

    // ── mid-curve anti-honeypot check: buy 1 ETH, then sell it back on the curve ─
    // (invariant #1: sells can NEVER be blocked and the pool can always pay a seller)
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE)).wait();
    const midTok = await TOK.balanceOf(buyer.address);
    expect(midTok, "mid-curve buy delivered tokens").to.be.greaterThan(0n);
    const sellBack = midTok / 3n;
    await (await tokErc.connect(buyer).approve(probeAddr, sellBack)).wait();
    const wethBeforeMidSell = await wethW.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, token, sellBack)).wait();
    expect(await wethW.balanceOf(buyer.address), "mid-curve sell paid WETH (no honeypot)").to.be.greaterThan(wethBeforeMidSell);

    // ── buy the curve ALL THE WAY to the ceiling → graduation at ~$34k ──────────
    const ceiling = await curveC.gradSqrtPriceX96(); // stop exactly at the curve ceiling
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, ceiling)).wait();
    expect(await curveC.ready(), "curve should be graduatable at the ceiling").to.equal(true);

    // ── graduate; capture creator/platform payouts + the Bond raise ─────────────
    const devBefore = await wethW.balanceOf(dev.address);
    const platBefore = await wethW.balanceOf(platform.address);
    const gradRc = await (await curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gev.args.raisedWeth; // WETH handed to the Bond (already net of the two 0.5 rewards)
    const devGain = (await wethW.balanceOf(dev.address)) - devBefore;
    const platGain = (await wethW.balanceOf(platform.address)) - platBefore;
    const grossRaise = bondRaise + 2n * ethers.parseEther("0.5"); // undo the 0.5 + 0.5 payout -> the gross raise

    // ── mcap from the post-graduation pool price ────────────────────────────────
    const tick = Number((await pool.slot0()).tick);
    const p1per0 = Math.pow(1.0001, tick); // token1 per token0
    const wethPerToken = tokenIsToken0 ? p1per0 : 1 / p1per0;
    const mcapEth = wethPerToken * 1e9; // 1B supply
    const mcapUsd = mcapEth * ETH_USD;

    const f = (x) => Number(ethers.formatEther(x));
    console.log(`\n      ── NEW calibration graduation result ──`);
    console.log(`      gross raise : ${f(grossRaise).toFixed(4)} ETH   (target ~4.2)`);
    console.log(`      into Bond   : ${f(bondRaise).toFixed(4)} ETH   (target ~3.2)`);
    console.log(`      creator     : ${f(devGain).toFixed(4)} ETH   (target 0.5)`);
    console.log(`      platform    : ${f(platGain).toFixed(4)} ETH   (target 0.5)`);
    console.log(`      mcap        : ${mcapEth.toFixed(2)} ETH  ≈ $${mcapUsd.toFixed(0)}  (target ~$34k)`);
    console.log(`      grad tick   : ${tick}\n`);

    // ── ASSERTIONS ──────────────────────────────────────────────────────────────
    // creator + platform each get a fixed 0.5 ETH (platform also sweeps a tiny WETH dust on top)
    expect(devGain, "creator reward").to.equal(ethers.parseEther("0.5"));
    expect(platGain, "platform reward").to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));

    // raise ~4.2 ETH (±15%), Bond ~3.2 ETH (±15%), mcap ~$34k (±15%)
    expect(f(grossRaise), "gross raise ~4.2 ETH").to.be.closeTo(4.2, 4.2 * 0.15);
    expect(f(bondRaise), "into Bond ~3.2 ETH").to.be.closeTo(3.2, 3.2 * 0.15);
    expect(mcapUsd, "mcap ~$34k").to.be.closeTo(34000, 34000 * 0.15);

    // Bond posted a real floor into the same pool; curve fully drained; pool has liquidity
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    expect(await bond.posted(), "Bond posted").to.equal(true);
    expect(await bond.sherwoodL(), "sherwood LP").to.be.greaterThan(0n);
    expect(await bond.bountyL(), "bounty floor").to.be.greaterThan(0n);
    expect(await wethW.balanceOf(curve), "no WETH stranded in curve").to.equal(0n);
    expect(await TOK.balanceOf(curve), "no token stranded in curve").to.equal(0n);
    expect(await pool.liquidity(), "pool tradeable").to.be.greaterThan(0n);

    // ── the pool STILL TRADES post-graduation: a buy and a sell both succeed ────
    const tokBefore = await TOK.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 2n)).wait();
    const tokAfterBuy = await TOK.balanceOf(buyer.address);
    expect(tokAfterBuy, "post-grad buy delivers tokens").to.be.greaterThan(tokBefore);

    // sell: token -> WETH  (sells must NEVER be blocked — anti-honeypot invariant)
    const sellAmt = (tokAfterBuy - tokBefore) / 2n;
    await (await tokErc.connect(buyer).approve(probeAddr, sellAmt)).wait();
    const wethBeforeSell = await wethW.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, token, sellAmt)).wait();
    expect(await wethW.balanceOf(buyer.address), "post-grad sell pays WETH").to.be.greaterThan(wethBeforeSell);
    console.log(`      mid-curve + post-graduation buy/sell all succeeded (pool trades, sells not blocked)\n`);
  });
});
