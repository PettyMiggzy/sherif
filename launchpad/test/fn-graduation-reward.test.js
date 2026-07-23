// Graduation reward rule: a coin graduates ONLY by reaching the full ceiling (~4.2 ETH) — the single graduation
// path. There is no early graduation and no timeout, so graduation always pays the creator 0.5 + platform 0.5
// (no forfeit). Below the ceiling the coin simply keeps trading and never graduates.
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
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, START_TICK_MAG, CURVE_WIDTH, minGradWidth);
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
    // v2: graduate() also sweeps + splits the curve's pending LP fees. With feeConfig unset (ZeroAddress) the
    // creator's LP share is 0, so ALL the swept fees go to the platform on top of its 0.5 reward → platform > 0.5.
    expect(platGot, "platform earns its 0.5 reward PLUS the swept LP fees").to.be.greaterThan(0.5);
    expect(platGot, "platform (reward + LP fees) exceeds the creator (reward only)").to.be.greaterThan(creatorGot);
  });
});
