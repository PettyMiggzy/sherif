const { expect } = require("chai");
const { ethers } = require("hardhat");

// Independent verification of the NEW graduation calibration + 0.5 ETH dev buy against the REAL Uniswap v3
// on a Robinhood-Chain fork. Deploy a fresh CurvePadFactory with the new geometry
// (START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800), read the immutables straight back,
// launch a coin to read the on-chain curve ticks, and compute START + GRAD mcap purely from those ticks.
// Then launch a second coin with a 0.5 ETH dev buy and assert the dev receives ~30% of the curve supply.
//   FORK_RPC=<rpc> npx hardhat test test/sim-cal-report.test.js
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ETH_USD = 1920; // same $/ETH assumption the deploy calibration used
const SUPPLY = 1e9; // 1B total supply

const START_TICK_MAG = 201600;
const CURVE_WIDTH = 23000;
const MIN_GRAD_WIDTH = 22800;

// mcap (in ETH) implied by a raw Uniswap tick. p1per0 = token1 per token0.
function mcapEthFromTick(tick, tokenIsToken0) {
  const p1per0 = Math.pow(1.0001, tick);
  const wethPerToken = tokenIsToken0 ? p1per0 : 1 / p1per0;
  return wethPerToken * SUPPLY;
}

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Cal report — 201600/23000/22800: start/grad mcap + 0.5 ETH dev buy", function () {
  this.timeout(240000);

  async function deployStack(dep, platform) {
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
    return factory;
  }

  it("(a) reads back the calibration and reports start / grad mcap on-chain", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const factory = await deployStack(dep, platform);

    expect(Number(await factory.START_TICK_MAG())).to.equal(START_TICK_MAG);
    expect(Number(await factory.CURVE_WIDTH())).to.equal(CURVE_WIDTH);
    expect(Number(await factory.MIN_GRAD_WIDTH())).to.equal(MIN_GRAD_WIDTH);

    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Cal", symbol: "CAL", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const curveC = await ethers.getContractAt("CurvePool", ev.args.curve);

    const tokenIsToken0 = await curveC.tokenIsToken0();
    const startTick = Number(await curveC.startTick());
    const gradTick = Number(await curveC.gradTick());
    const minGradTick = Number(await curveC.minGradTick());

    const startMcapEth = mcapEthFromTick(startTick, tokenIsToken0);
    const gradMcapEth = mcapEthFromTick(gradTick, tokenIsToken0);
    const minGradMcapEth = mcapEthFromTick(minGradTick, tokenIsToken0);
    const startUsd = startMcapEth * ETH_USD;
    const gradUsd = gradMcapEth * ETH_USD;

    console.log(`\n      START_TICK_MAG=${START_TICK_MAG} CURVE_WIDTH=${CURVE_WIDTH} MIN_GRAD_WIDTH=${MIN_GRAD_WIDTH}`);
    console.log(`      tokenIsToken0=${tokenIsToken0} startTick=${startTick} minGradTick=${minGradTick} gradTick=${gradTick}`);
    console.log(`      START mcap : ${startMcapEth.toFixed(4)} ETH ~ $${startUsd.toFixed(0)}   (target ~$3.4k)`);
    console.log(`      MIN-GRAD   : ${minGradMcapEth.toFixed(4)} ETH ~ $${(minGradMcapEth * ETH_USD).toFixed(0)}`);
    console.log(`      GRAD mcap  : ${gradMcapEth.toFixed(4)} ETH ~ $${gradUsd.toFixed(0)}   (target ~$34k)\n`);

    global.__startUsd = startUsd;
    global.__gradUsd = gradUsd;

    expect(startUsd, "start mcap ~$3.4k").to.be.closeTo(3400, 3400 * 0.2);
    expect(gradUsd, "grad mcap ~$34k").to.be.closeTo(34000, 34000 * 0.2);
  });

  it("(b) a 0.5 ETH dev buy delivers ~30% of the curve supply to the dev", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const factory = await deployStack(dep, platform);

    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch(
      { name: "Dev", symbol: "DEV", dev: dev.address, tax: NOTAX },
      { value: ethers.parseEther("0.5") }
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const devBought = ev.args.devBought;

    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], ev.args.token);
    const devBal = await TOK.balanceOf(dev.address);
    expect(devBal, "event devBought matches dev balance").to.equal(devBought);

    const devTokens = Number(ethers.formatEther(devBought));
    const CURVE_SUPPLY = SUPPLY * 0.75; // 750M purchasable; 25% ambush withheld
    const pctOfTotal = (devTokens / SUPPLY) * 100;
    const pctOfCurve = (devTokens / CURVE_SUPPLY) * 100;
    console.log(`\n      dev received : ${devTokens.toLocaleString()} tokens`);
    console.log(`      % of 1B TOTAL supply   : ${pctOfTotal.toFixed(2)}%`);
    console.log(`      % of 750M CURVE supply : ${pctOfCurve.toFixed(2)}%   (target ~30% +/-5)\n`);

    global.__devPctCurve = pctOfCurve;
    global.__devPctTotal = pctOfTotal;

    expect(pctOfCurve, "dev buy ~30% of curve supply (+/-5)").to.be.closeTo(30, 5);
  });
});
