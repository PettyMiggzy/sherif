// Proves the fix for the round-2 griefing finding: an attacker pushes spot into the empty zone ABOVE the
// curve ceiling (used to make graduate() revert forever); graduate() must now nudge it back and succeed.
const { ethers } = require("hardhat");
const { expect } = require("chai");

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

describe("Graduation grief — spot shoved above the ceiling must not block graduation", function () {
  this.timeout(180000);
  it("attacker pushes spot past the ceiling; graduate() nudges back and still posts the Bond", async () => {
    const [dep, platform, dev, buyer, attacker] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress,
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH);
    await (await router.setFactory(await factory.getAddress())).wait();

    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Grief", symbol: "GRF", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const gradTick = Number(await curveC.gradTick());

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt([
      "function deposit() payable", "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ], WETH);
    for (const who of [buyer, attacker]) {
      await ethers.provider.send("hardhat_setBalance", [who.address, "0x" + (10n ** 24n).toString(16)]);
      await (await wethW.connect(who).deposit({ value: 80n * ONE })).wait();
      await (await wethW.connect(who).approve(await probe.getAddress(), 1n << 250n)).wait();
    }
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // buy the curve all the way to the ceiling → graduation-eligible, spot sits AT the ceiling
    const ceiling = await curveC.gradSqrtPriceX96();
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, ceiling)).wait();
    expect(await curveC.ready(), "eligible at the ceiling").to.equal(true);

    // GRIEF: attacker buys a dust amount of token with NO limit → spot flies into the empty zone above the ceiling
    await (await probe.connect(attacker).swapExactIn(poolAddr, WETH, 1000n)).wait();
    const tickAfterGrief = Number((await pool.slot0()).tick);
    const tokenIsToken0 = await curveC.tokenIsToken0();
    const aboveCeil = tokenIsToken0 ? tickAfterGrief > gradTick + 50 : tickAfterGrief < gradTick - 50;
    console.log(`      grief pushed tick to ${tickAfterGrief} (gradTick=${gradTick}); aboveCeil=${aboveCeil}`);
    expect(aboveCeil, "grief must actually push spot above the ceiling").to.equal(true);

    // graduate() must now SUCCEED (nudges spot back to the ceiling first) instead of reverting
    const grc = await (await curveC.graduate()).wait();
    const gev = grc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    expect(gev, "Graduated event emitted").to.not.equal(undefined);
    const raisedWeth = Number(ethers.formatEther(gev.args.raisedWeth));
    const tickAtGrad = Number((await pool.slot0()).tick);
    console.log(`      graduate() SUCCEEDED despite the grief. raisedWeth(to Bond)=${raisedWeth.toFixed(4)} ETH, tick now ${tickAtGrad}`);
    expect(raisedWeth, "Bond funded (raise not stranded)").to.be.greaterThan(2.5);
    expect(await curveC.graduated()).to.equal(true);

    // post-graduation the pool still trades (buy + sell both work)
    const pre = await wethW.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE)).wait();
    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], await curveC.token());
    const gotTok = await TOK.balanceOf(buyer.address);
    await (await TOK.connect(buyer).approve(await probe.getAddress(), 1n << 250n)).wait();
    await (await probe.connect(buyer).swapExactIn(poolAddr, await curveC.token(), gotTok / 2n)).wait();
    console.log(`      post-grad buy+sell both succeeded — pool trades normally after a griefed graduation`);
    expect(true).to.equal(true);
  });

  it("HARDER: attacker plants REAL liquidity above the ceiling, then shoves — graduate() still powers through", async () => {
    const [dep, platform, dev, buyer, attacker] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress,
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH);
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Grief2", symbol: "GR2", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const gradTick = Number(await curveC.gradTick());
    const tokenIsToken0 = await curveC.tokenIsToken0();

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const atk = await (await ethers.getContractFactory("LiquidityAttacker")).deploy();
    const wethW = await ethers.getContractAt([
      "function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);
    for (const who of [buyer, attacker]) {
      await ethers.provider.send("hardhat_setBalance", [who.address, "0x" + (10n ** 24n).toString(16)]);
      await (await wethW.connect(who).deposit({ value: 80n * ONE })).wait();
      await (await wethW.connect(who).approve(await probe.getAddress(), 1n << 250n)).wait();
    }
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // attacker grabs a token bag with a small partial buy (to fund their planted liquidity), THEN the buyer
    // completes the curve up to the ceiling (only ~4.2 ETH total reaches it, so only one actor can park there)
    const ceiling = await curveC.gradSqrtPriceX96();
    await (await probe.connect(attacker).swapExactIn(poolAddr, WETH, 1n * ONE)).wait();
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, ceiling)).wait();
    expect(await curveC.ready(), "eligible at the ceiling").to.equal(true);

    // ATTACK: attacker mints a REAL v3 position spanning just above the ceiling (thick liquidity), then shoves
    // spot up into it. A 1-wei nudge would be eaten by this liquidity; the balance-sized nudge must power through.
    await (await wethW.connect(attacker).approve(await atk.getAddress(), 1n << 250n)).wait();
    await (await TOK.connect(attacker).approve(await atk.getAddress(), 1n << 250n)).wait();
    // band on the "above the ceiling" side (tokenIsToken0 => above = higher ticks; else lower)
    const lo = tokenIsToken0 ? gradTick + 200 : gradTick - 600;
    const hi = tokenIsToken0 ? gradTick + 600 : gradTick - 200;
    await (await atk.connect(attacker).mint(poolAddr, lo, hi, 5n * 10n ** 15n)).wait();
    // shove spot into the planted band (buy the token past the ceiling)
    await (await probe.connect(attacker).swapExactIn(poolAddr, WETH, 5n * ONE)).wait();
    const shoved = Number((await pool.slot0()).tick);
    const aboveCeil = tokenIsToken0 ? shoved > gradTick + 50 : shoved < gradTick - 50;
    console.log(`      attacker planted liquidity [${lo},${hi}] + shoved spot to ${shoved} (gradTick=${gradTick}); aboveCeil=${aboveCeil}`);
    expect(aboveCeil, "spot must be above the ceiling inside the planted liquidity").to.equal(true);

    // graduate() must power the balance-sized nudge THROUGH the attacker's liquidity down to the ceiling and post
    const grc = await (await curveC.graduate()).wait();
    const gev = grc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
    expect(gev, "Graduated event emitted despite planted liquidity").to.not.equal(undefined);
    expect(await curveC.graduated()).to.equal(true);
    const tickAtGrad = Number((await pool.slot0()).tick);
    const devAfter = tickAtGrad > gradTick ? tickAtGrad - gradTick : gradTick - tickAtGrad;
    console.log(`      graduate() POWERED THROUGH planted liquidity. Bond raise=${Number(ethers.formatEther(gev.args.raisedWeth)).toFixed(4)} ETH, tick pulled to ${tickAtGrad} (dev ${devAfter} from ceiling)`);
    expect(devAfter, "spot pulled back to the ceiling before the Bond posted").to.be.at.most(50);
    expect(Number(ethers.formatEther(gev.args.raisedWeth)), "raise preserved").to.be.greaterThan(2.5);
  });
});
