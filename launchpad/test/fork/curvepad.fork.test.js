const { expect } = require("chai");
const { ethers } = require("hardhat");

// End-to-end DEX-day-one launch via CurvePadFactory, against real Uniswap v3 on Robinhood Chain.
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/curvepad.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("CurvePadFactory — one-call DEX-day-one launch", function () {
  this.timeout(240000);

  it("launch() -> live+tradeable Uniswap pool with opening guard -> buy out -> graduate into the Bond", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress()
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    // plain default 1% here (the above-default split is covered in padrouter.fork.test.js)
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // ===== ONE CALL: token + real pool + seeded curve + trading on =====
    const rc = await (await factory.launch({ name: "Sheriff Meme", symbol: "MEME", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;

    const TOK = await ethers.getContractAt("LaunchToken", token);
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    // live on a real Uniswap pool from block one
    expect(await TOK.totalSupply()).to.equal(1_000_000_000n * ONE);
    expect(await TOK.tradingEnabled()).to.equal(true);
    expect(await TOK.antiSnipeActive()).to.equal(true); // opening guard is on
    expect(await curveC.curveL()).to.be.greaterThan(0n); // curve position seeded
    expect((await pool.slot0()).sqrtPriceX96).to.be.greaterThan(0n);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 60n * ONE)).wait();
    const buy = (amt, limit) =>
      limit ? probe.connect(buyer).swapExactInLimit(poolAddr, WETH, amt, limit)
            : probe.connect(buyer).swapExactIn(poolAddr, WETH, amt);

    await ethers.provider.send("evm_increaseTime", [5]); // past the 2s dead window, into phase 1
    await ethers.provider.send("evm_mine", []);

    // ===== the opening guard is real: an oversized first-window buy reverts =====
    await expect(buy(ONE / 2n)).to.be.reverted; // 0.5 WETH would blow past the 1% wallet cap -> revert

    // ===== but a small buy trades fine — DEX day one, pre-graduation =====
    const t0 = await TOK.balanceOf(buyer.address);
    await (await buy(ONE / 500n)).wait(); // 0.002 WETH, within the cap
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t0);

    // ===== after the window, buy out the curve (capped at the graduation price) =====
    await ethers.provider.send("evm_increaseTime", [400]); // guard fully expired
    await ethers.provider.send("evm_mine", []);
    expect(await TOK.antiSnipeActive()).to.equal(false);
    await (await buy(55n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready()).to.equal(true);

    // ===== graduate into the Bond =====
    await (await curveC.graduate()).wait();
    expect(await curveC.graduated()).to.equal(true);
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);

    // still trades after graduation
    const t1 = await TOK.balanceOf(buyer.address);
    await (await buy(ONE / 2n)).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t1);
  });

  it("launch() with ETH -> executes the dev's own buy (<=2%) atomically, before anyone else can trade", async () => {
    const [dep, platform, dev] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress()
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    // plain default 1% here (the above-default split is covered in padrouter.fork.test.js)
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // dev funds their own opening buy in the SAME launch tx
    const spend = ONE / 100n; // 0.01 ETH
    const before = await ethers.provider.getBalance(dev.address);
    const rc = await (await factory.connect(dev).launch(
      { name: "Sheriff Dev", symbol: "SDEV", dev: dev.address, tax: NOTAX }, { value: spend }
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, devBought } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);

    // the dev received real tokens, atomically, ahead of the field — and never more than 2%
    const cap = (1_000_000_000n * ONE * 200n) / 10_000n; // 2% of supply
    expect(devBought).to.be.greaterThan(0n);
    expect(devBought).to.be.at.most(cap);
    expect(await TOK.balanceOf(dev.address)).to.equal(devBought);

    // dev spent no more than they sent (unused ETH is refunded), minus gas
    const after = await ethers.provider.getBalance(dev.address);
    const gas = rc.gasUsed * rc.gasPrice;
    expect(before - after - gas).to.be.at.most(spend);
    // factory holds no leftover ETH/WETH/token dust
    const weth = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], WETH);
    expect(await weth.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await TOK.balanceOf(await factory.getAddress())).to.equal(0n);
  });
});
