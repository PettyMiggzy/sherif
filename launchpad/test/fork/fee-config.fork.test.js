const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fork tests for the v2 configurable fee system, against real Uniswap v3 on Robinhood Chain.
//  (b) CurvePool.collectFees WITH a real FeeConfig (lpCreatorBps=1000) splits the LP fee 10/90 creator/platform,
//      leaves the curve principal intact, and still graduates.
//  (c) PadRouter WITH feeConfig set splits a buy's fee 45/45/10 platform/creator/floor — and a buy still
//      succeeds even when feeConfig points at a broken contract (fallback: everything to the platform).
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/fee-config.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("v2 FeeConfig on a Robinhood Chain fork", function () {
  this.timeout(300000);

  it("CurvePool.collectFees with a real FeeConfig splits the LP fee 10/90 creator/platform, principal intact", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    // Real FeeConfig, default lpCreatorBps = 1000 (10% to the creator/dev, 90% to the platform).
    const feeConfig = await (await ethers.getContractFactory("FeeConfig")).deploy(dep.address);
    expect(await feeConfig.lpCreatorBps()).to.equal(1000);

    const CURVE = 750_000_000n * ONE, AMBUSH = 250_000_000n * ONE;
    const TOK = await (await ethers.getContractFactory("CurveToken")).deploy("Meme", "MEME", CURVE + AMBUSH, dep.address);
    const tokAddr = await TOK.getAddress();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();

    const tokenIsToken0 = BigInt(tokAddr) < BigInt(WETH);
    const startTick = tokenIsToken0 ? -207200 : 207200;
    const width = 35800, minGradWidth = 19800;

    // Pass the DEPLOYED FeeConfig (not ZeroAddress) — this is the only change from collect-fees.fork.test.js.
    const curve = await (await ethers.getContractFactory("CurvePool")).deploy(
      tokAddr, WETH, FACTORY, platform.address, dev.address, await bd.getAddress(), await feeConfig.getAddress(),
      CURVE, AMBUSH, startTick, width, minGradWidth
    );
    const curveAddr = await curve.getAddress();
    await (await TOK.connect(dep).transfer(curveAddr, CURVE + AMBUSH)).wait();
    await (await curve.seed()).wait();

    const poolAddr = await curve.pool();
    const weth = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    await (await weth.connect(buyer).deposit({ value: 30n * ONE })).wait();
    await (await weth.connect(buyer).approve(probeAddr, 30n * ONE)).wait();

    // a handful of real BUYS against the pool (each pays the 1% fee tier)
    for (let i = 0; i < 4; i++) {
      await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE)).wait();
    }

    const curveLbefore = await curve.curveL();
    const devWethBefore = await weth.balanceOf(dev.address);
    const platWethBefore = await weth.balanceOf(platform.address);

    // STREAM the 1% and SPLIT it 10/90 (creator/platform)
    await (await curve.collectFees()).wait();

    const devGained = (await weth.balanceOf(dev.address)) - devWethBefore;
    const platGained = (await weth.balanceOf(platform.address)) - platWethBefore;
    const total = devGained + platGained;

    expect(total).to.be.greaterThan(0n);           // real fees moved
    expect(devGained).to.be.greaterThan(0n);        // the creator got a cut
    expect(platGained).to.be.greaterThan(0n);       // the platform kept the rest

    // Exact split: toCreator = total * 1000 / 10000 (integer), platform = total - toCreator.
    const expectedDev = (total * 1000n) / 10_000n;
    expect(devGained).to.equal(expectedDev);        // exactly 10%
    expect(platGained).to.equal(total - expectedDev); // exactly the remainder (~90%)
    // sanity: platform is ~9x the creator
    expect(platGained).to.be.greaterThan(devGained * 8n);
    expect(platGained).to.be.lessThan(devGained * 10n);
    console.log(`      LP fee split -> dev ${ethers.formatEther(devGained)} (10%) / platform ${ethers.formatEther(platGained)} (90%)`);

    // curve PRINCIPAL untouched
    expect(await curve.curveL()).to.equal(curveLbefore);

    // graduation still works with a real FeeConfig wired in
    const gradSqrt = await curve.gradSqrtPriceX96();
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 55n * ONE, gradSqrt)).wait();
    expect(await curve.ready()).to.equal(true);
    await (await curve.collectFees()).wait(); // final pre-grad sweep, still split 10/90
    await (await curve.graduate()).wait();
    expect(await curve.graduated()).to.equal(true);
  });

  async function stack(dep, platform, feeConfigAddr) {
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), feeConfigAddr, 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    return { router, factory, bd };
  }

  it("PadRouter with feeConfig set splits a buy fee 45/45/10 platform/creator/floor", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const feeConfig = await (await ethers.getContractFactory("FeeConfig")).deploy(dep.address);
    const { router, factory } = await stack(dep, platform, await feeConfig.getAddress());

    // wire the router at the FeeConfig (owner-only; dep is the router owner)
    await (await router.setFeeConfig(await feeConfig.getAddress())).wait();
    expect(await router.feeConfig()).to.equal(await feeConfig.getAddress());

    // a 3% buy tax coin (so the fee is a clean 0.03 ETH on a 1 ETH buy)
    const tax = { buyBps: 300, sellBps: 300, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Cfg", symbol: "CFG", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token } = ev.args;

    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    const spend = ONE; // 1 ETH, well under graduation -> fully consumed, fee charged on the full value
    const fee = (spend * 300n) / 10_000n;          // 0.03 ETH
    const toFloor = (fee * 1000n) / 10_000n;       // 10%
    const toCreator = (fee * 4500n) / 10_000n;     // 45%
    const toPlatform = fee - toFloor - toCreator;  // 45% (absorbs rounding)

    const t0 = await ethers.getContractAt("LaunchToken", token);
    const bal0 = await t0.balanceOf(buyer.address);
    await (await router.connect(buyer).buy(token, 0, { value: spend })).wait();
    expect(await t0.balanceOf(buyer.address)).to.be.greaterThan(bal0); // trade went through

    // the configurable split landed 45/45/10 across platform / creator / floor
    expect(await router.platformEscrow()).to.equal(toPlatform);
    expect(await router.devEscrow(token)).to.equal(toCreator);
    expect(await router.floorEscrow(token)).to.equal(toFloor);
    // the v2 branch does NOT use the legacy buckets
    expect(await router.deferredEscrow(token)).to.equal(0n);
    expect(await router.platformCutEscrow()).to.equal(0n);
    expect(await router.burnEscrow(token)).to.equal(0n);
    console.log(`      router split -> platform ${toPlatform} / creator ${toCreator} / floor ${toFloor}`);
  });

  it("PadRouter with a BROKEN feeConfig never reverts a trade — fee falls through to all-platform", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    // launch stack with NO feeConfig on the curve side; the router points at a broken config below
    const { router, factory, bd } = await stack(dep, platform, ethers.ZeroAddress);

    // Point the router at a real contract that does NOT implement swapSplit() (the BondDeployer). setFeeConfig
    // only checks it's a contract; swapSplit() will revert at call time -> the try/catch fallback kicks in.
    await (await router.setFeeConfig(await bd.getAddress())).wait();
    expect(await router.feeConfig()).to.equal(await bd.getAddress());

    const tax = { buyBps: 300, sellBps: 300, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Broke", symbol: "BRK", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token } = ev.args;

    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    const spend = ONE;
    const fee = (spend * 300n) / 10_000n;

    const t0 = await ethers.getContractAt("LaunchToken", token);
    const bal0 = await t0.balanceOf(buyer.address);
    // the buy MUST NOT revert despite the broken config
    await (await router.connect(buyer).buy(token, 0, { value: spend })).wait();
    expect(await t0.balanceOf(buyer.address)).to.be.greaterThan(bal0);

    // fallback: the entire fee went to the platform, nothing to creator/floor
    expect(await router.platformEscrow()).to.equal(fee);
    expect(await router.devEscrow(token)).to.equal(0n);
    expect(await router.floorEscrow(token)).to.equal(0n);
    expect(await router.deferredEscrow(token)).to.equal(0n);
    console.log(`      broken-config fallback -> all ${fee} to platform, trade succeeded`);
  });
});
