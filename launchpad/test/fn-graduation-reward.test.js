// Graduation reward rule: the creator's 0.5 ETH is earned ONLY by riding to the full ceiling (~4.2 ETH). If the
// creator lowers gradTarget to graduate EARLY, they forfeit the 0.5 (it stays in the raise -> thicker floor) and
// the platform still takes its cut. Also: with the default target now AT the ceiling, the coin can't graduate
// until it hits the ceiling.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;
const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Graduation reward — creator earns 0.5 only at the full ceiling", function () {
  this.timeout(240000);

  async function launch(minGradWidth = MIN_GRAD_WIDTH) {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), START_TICK_MAG, CURVE_WIDTH, minGradWidth);
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Grad", symbol: "GRD", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const curveC = await ethers.getContractAt("CurvePool", ev.args.curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", ev.args.pool);
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 25n).toString(16)]);
    await (await wethW.connect(buyer).deposit({ value: 100n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 1n << 250n)).wait();
    await ethers.provider.send("evm_increaseTime", [400]); await ethers.provider.send("evm_mine", []);
    return { dep, platform, dev, buyer, curveC, pool, probe, wethW };
  }
  const W = () => new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const f = (x) => Number(ethers.formatEther(x));

  it("default target is the ceiling; riding to it pays the creator 0.5 ETH", async () => {
    const { dev, platform, buyer, curveC, probe, pool } = await launch();
    expect(await curveC.gradTarget()).to.equal(await curveC.gradTick()); // default = ceiling
    expect(await curveC.ready(), "not graduatable before the ceiling").to.equal(false);
    await (await probe.connect(buyer).swapExactInLimit(await pool.getAddress(), WETH, 60n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready(), "graduatable at the ceiling").to.equal(true);

    const dPre = await W().balanceOf(dev.address), pPre = await W().balanceOf(platform.address);
    const rc = await (await curveC.graduate()).wait();
    const gev = rc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
    const creatorGot = f((await W().balanceOf(dev.address)) - dPre), platGot = f((await W().balanceOf(platform.address)) - pPre);
    console.log(`      FULL: raise->Bond ${f(gev.args.raisedWeth).toFixed(3)} ETH · creator +${creatorGot} · platform +${platGot}`);
    expect(creatorGot, "creator earns 0.5 at full ceiling").to.be.closeTo(0.5, 0.02);
    expect(platGot, "platform earns 0.5").to.be.closeTo(0.5, 0.02);
  });

  it("early graduation (dev lowers the target, stops below the ceiling) FORFEITS the creator 0.5", async () => {
    // wide window (min at width 14000 ~= 2 ETH) so 'early' is genuinely below the 4.2-ETH ceiling
    const { dev, platform, buyer, curveC, probe, pool } = await launch(14000);
    const minTick = await curveC.minGradTick();
    await (await curveC.connect(dev).setGradTarget(minTick)).wait(); // dev opts into EARLY graduation

    // buy only ~2.5 ETH — past the early target but well BELOW the ceiling (which needs ~4.2 ETH)
    await (await probe.connect(buyer).swapExactInLimit(await pool.getAddress(), WETH, ethers.parseEther("2.5"), await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready(), "graduatable at the early target").to.equal(true);
    const tickNow = Number((await pool.slot0()).tick), gradTick = Number(await curveC.gradTick());
    expect(Math.abs(tickNow - gradTick), "graduation tick must be genuinely below the ceiling").to.be.greaterThan(50);

    const dPre = await W().balanceOf(dev.address), pPre = await W().balanceOf(platform.address);
    const rc = await (await curveC.graduate()).wait();
    const gev = rc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
    const creatorGot = f((await W().balanceOf(dev.address)) - dPre), platGot = f((await W().balanceOf(platform.address)) - pPre);
    console.log(`      EARLY: raise->Bond ${f(gev.args.raisedWeth).toFixed(3)} ETH · creator +${creatorGot} (FORFEITED) · platform +${platGot}`);
    expect(creatorGot, "creator FORFEITS the 0.5 on early graduation").to.equal(0);
    expect(platGot, "platform still earns its cut").to.be.greaterThan(0);
  });
});
