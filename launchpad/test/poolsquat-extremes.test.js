const { expect } = require("chai");
const { ethers } = require("hardhat");
// [BRAND] see poolsquat.test.js — the squat target must be a MINED `1ab5` address, from the shared miner.
const { mineFor } = require("./helpers/brand");
const V3F = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_FEE = 10000, START = 201600, WIDTH = 35800, MINGRAD = 19800;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

describe("[F-1] the repair walks back from either end of the tick range", function () {
  this.timeout(300000);
  const NOTAX = (dev) => ({ buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });
  it("walks from the extreme end of the tick range", async () => {
    const [dep, platform, dev, attacker] = await ethers.getSigners();
    const v3 = await (new ethers.ContractFactory(V3F.abi, V3F.bytecode, dep)).deploy(); await v3.waitForDeployment();
    const V3_FACTORY = await v3.getAddress();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const WETH = await weth.getAddress();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd  = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, START, WIDTH, MINGRAD);
    await (await router.setFactory(await factory.getAddress())).wait();
    const SUPPLY = 1_000_000_000n * 10n ** 18n;

    for (const [label, price] of [["MIN_SQRT_RATIO", MIN_SQRT], ["MAX_SQRT_RATIO-1", MAX_SQRT - 1n], ["baseline(none)", null]]) {
      const { salt, addr: token } = await mineFor(
        factory, dev.address, { name: "R" + label, symbol: "R" }, SUPPLY, "mined-" + label);
      if (price !== null) {
        await (await v3.createPool(token, WETH, POOL_FEE)).wait();
        const p = await ethers.getContractAt("IUniswapV3Pool", await v3.getPool(token, WETH, POOL_FEE));
        await (await p.connect(attacker).initialize(price)).wait();
      }
      try {
        const rc = await (await factory.connect(dev).launchWithSalt({ name:"R"+label, symbol:"R", dev: dev.address, tax: NOTAX(dev.address) }, salt)).wait();
        console.log(label.padEnd(18), "OK   gas:", rc.gasUsed.toString());
      } catch (e) { console.log(label.padEnd(18), "REVERT:", e.shortMessage || e.message); }
    }
  });
});
