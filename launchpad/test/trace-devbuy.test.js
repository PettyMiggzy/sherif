// One-shot: what is the FDV right after a $1400 dev buy at launch (new calibration)?
const { ethers } = require("hardhat");
const { expect } = require("chai");
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;
const ETH_USD = 1920;
const TOTAL = 1_000_000_000;
const SMAG = 207800, CW = 31200, MGW = 31000;

describe("dev-buy FDV", function () {
  this.timeout(180000);
  it("dev buy size -> resulting mcap (find what reaches $10k)", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    console.log(`\n      ===== DEV BUY vs RESULTING MCAP  (start ~$1816, grad ~$41k, 750M curve) =====`);
    console.log(`      spent$    ETH      dev tokens     %ofSupply   FDV after`);
    for (const buyUsd of [1400, 2000, 2800, 3500]) {
      const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
      const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
      const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
      const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
      const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
        WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
        await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), SMAG, CW, MGW);
      await (await router.setFactory(await factory.getAddress())).wait();
      const buyEth = ethers.parseEther((buyUsd / ETH_USD).toFixed(6));
      await ethers.provider.send("hardhat_setBalance", [dep.address, "0x" + (10n ** 24n).toString(16)]);
      const rc = await (await factory.launch({ name: "Dev", symbol: "DEV", dev: dev.address, tax: NOTAX }, { value: buyEth })).wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "Launched");
      const { token, curve, pool: poolAddr } = ev.args;
      const curveC = await ethers.getContractAt("CurvePool", curve);
      const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
      const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], token);
      const tokenIsToken0 = await curveC.tokenIsToken0();
      const s = await pool.slot0();
      const sp = Number(s.sqrtPriceX96) / 2 ** 96;
      const p10 = sp * sp;
      const wethPerToken = tokenIsToken0 ? p10 : 1 / p10;
      const fdv = wethPerToken * TOTAL * ETH_USD;
      const devTok = Number(ethers.formatEther(await TOK.balanceOf(dev.address)));
      console.log(`      $${String(buyUsd).padEnd(6)} ${(buyUsd/ETH_USD).toFixed(3)}   ${(devTok/1e6).toFixed(1).padStart(7)}M      ${(devTok/TOTAL*100).toFixed(1).padStart(5)}%    $${fdv.toFixed(0)}`);
    }
    console.log(`      ===========================================================================`);
    expect(true).to.equal(true);
  });
});
