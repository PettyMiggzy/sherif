// Robinhood-Chain gas cap: the chain rejects/undersizes a tx that needs more than 2^24 = 16,777,216 gas
// (eth_estimateGas clamps there). The two heaviest txs in the system MUST fit under it, or they can't be
// sent by a normal wallet: launch() (token CREATE2 + pool create + seed + optional dev-buy) and graduate()
// (above-ceiling nudge swap + burn/collect + Bond CREATE + THREE v3 mints). If graduate() didn't fit, a
// coin that reached the ceiling could never post its Bond and the whole raise (~3.2 ETH) would be stuck.
// This measures the real fork gas and asserts a safety margin under the cap.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const CAP = 16777216n; // 2^24
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;
const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Gas cap — launch() and graduate() fit under the 2^24 (16.77M) chain cap", function () {
  this.timeout(240000);

  async function stack() {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH);
    await (await router.setFactory(await factory.getAddress())).wait();
    await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 25n).toString(16)]);
    await ethers.provider.send("hardhat_setBalance", [dev.address, "0x" + (10n ** 25n).toString(16)]);
    return { dep, platform, dev, buyer, factory };
  }
  const NOTAX = (dev) => ({ buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });
  const curveOf = (factory, rc) => {
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    return ev.args;
  };
  const pct = (g) => `${g} gas (${(Number(g) / Number(CAP) * 100).toFixed(1)}% of the 16.77M cap)`;

  it("launch() — with and without a dev buy — is well under the cap", async () => {
    const { dev, factory } = await stack();
    const plain = await (await factory.launch({ name: "Gas", symbol: "GAS", dev: dev.address, tax: NOTAX(dev.address) })).wait();
    console.log(`      launch (no dev buy):   ${pct(plain.gasUsed)}`);
    const withBuy = await (await factory.connect(dev).launch(
      { name: "GasB", symbol: "GSB", dev: dev.address, tax: NOTAX(dev.address) }, { value: ONE / 2n })).wait();
    console.log(`      launch (0.5 ETH buy):  ${pct(withBuy.gasUsed)}`);
    expect(plain.gasUsed).to.be.lessThan(CAP);
    expect(withBuy.gasUsed).to.be.lessThan(CAP);
    // leave real headroom (estimators + chain overhead): under 80% of the cap
    expect(withBuy.gasUsed).to.be.lessThan((CAP * 8n) / 10n);
  });

  it("graduate() at the ceiling — the heaviest tx (Bond CREATE + 3 mints) — fits under the cap", async () => {
    const { dev, buyer, factory } = await stack();
    const rc = await (await factory.launch({ name: "Grad", symbol: "GRD", dev: dev.address, tax: NOTAX(dev.address) })).wait();
    const { curve, pool } = curveOf(factory, rc);
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const poolC = await ethers.getContractAt("IUniswapV3Pool", pool);
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 100n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 1n << 250n)).wait();
    await ethers.provider.send("evm_increaseTime", [400]); await ethers.provider.send("evm_mine", []);
    // buy all the way to the ceiling — this leaves the MOST unsold curve tokens to roll into the Bond nudge
    await (await probe.connect(buyer).swapExactInLimit(pool, WETH, 60n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready(), "at the ceiling").to.equal(true);
    const g = await (await curveC.graduate()).wait();
    console.log(`      graduate (at ceiling): ${pct(g.gasUsed)}`);
    expect(g.gasUsed).to.be.lessThan(CAP);
    expect(g.gasUsed).to.be.lessThan((CAP * 8n) / 10n); // < 80% of cap — comfortable headroom
    // sanity: the Bond really posted
    expect(await curveC.graduated()).to.equal(true);
    void poolC;
  });
});
