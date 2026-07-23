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
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    // plain default 1% here (the above-default split is covered in padrouter.fork.test.js)
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // ===== ONE CALL: token + real pool + seeded curve + trading on =====
    const rc = await (await factory.launch({ name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX })).wait();
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
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
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
    const devWethBefore = await wethW.balanceOf(dev.address);
    const gradRc = await (await curveC.graduate()).wait();
    expect(await curveC.graduated()).to.equal(true);
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);

    // creator's graduation reward: the dev received a FIXED 0.5 WETH (the launch incentive), and the Bond was
    // still funded with the rest (asserted by the nonzero Sherwood/Bounty above). At a ~4 ETH raise the reward
    // is exactly 0.5 (capped at raise/4 for smaller raises).
    const devGain = (await wethW.balanceOf(dev.address)) - devWethBefore;
    expect(devGain).to.equal(ethers.parseEther("0.5"));

    // still trades after graduation
    const t1 = await TOK.balanceOf(buyer.address);
    await (await buy(ONE / 2n)).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t1);
  });

  it("launch() with ETH -> executes the dev's own uncapped buy atomically, before anyone else can trade", async () => {
    const [dep, platform, dev] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    // plain default 1% here (the above-default split is covered in padrouter.fork.test.js)
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // dev funds a LARGE opening buy in the SAME launch tx — big enough to blow past the old 2% cap
    const spend = ONE / 2n; // 0.5 ETH
    const before = await ethers.provider.getBalance(dev.address);
    const rc = await (await factory.connect(dev).launch(
      { name: "Robin Dev", symbol: "SDEV", dev: dev.address, tax: NOTAX }, { value: spend }
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, devBought } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);

    // the dev received real tokens, atomically, ahead of the field — with NO 2% cap now:
    // 0.5 ETH buys well over 2% of supply, and it's delivered in full.
    const oldCap = (1_000_000_000n * ONE * 200n) / 10_000n; // 2% of supply
    expect(devBought).to.be.greaterThan(oldCap); // cap is gone — dev got more than the old 2% limit
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

  it("graduating at the ceiling posts a real Bond floor (thick buy-wall)", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    // production graduation geometry: the coin graduates only at the ceiling (~$76k mcap)
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 40n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 40n * ONE)).wait();

    // The ONLY graduation point is the ceiling: buy all the way up to it, then graduate and check the Bond floor.
    const rc = await (await factory.launch({ name: "RIDE", symbol: "RIDE", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    // not graduatable until the ceiling is reached
    expect(await curveC.ready(), "not graduatable before the ceiling").to.equal(false);
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 20n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready(), "graduatable at the ceiling").to.equal(true);
    const gradRc = await (await curveC.graduate()).wait();
    const gev = gradRc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    // the raise posted a real Bond with a live buy-wall / floor
    expect(await bond.posted()).to.equal(true);
    expect(await bond.bountyL(), "a real buy-wall floor").to.be.greaterThan(0n);
    expect(gev.args.raisedWeth, "the ceiling raise funds the Bond").to.be.greaterThan(0n);
  });

  it("graduation ONLY at the full ceiling — no early path, no 7-day timeout; below the ceiling it never graduates", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Auto", symbol: "AUTO", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 60n * ONE)).wait();
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // (a) before any buy the coin is NOT graduatable
    expect(await curveC.ready(), "not graduatable before the ceiling").to.equal(false);

    // (b) buy only PART-WAY up the curve (a sqrt limit strictly below the ceiling). The coin stays NOT
    // graduatable and graduate() reverts — and there is NO timeout/abandon path: warping 7+ days changes nothing.
    const ceilSqrt = BigInt(await curveC.gradSqrtPriceX96());
    const curSqrt = BigInt((await pool.slot0()).sqrtPriceX96);
    const partwaySqrt = curSqrt + (ceilSqrt - curSqrt) / 2n; // halfway to the ceiling in sqrt space (below it)
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 30n * ONE, partwaySqrt)).wait();
    expect(await curveC.ready(), "part-way up the curve is NOT graduatable").to.equal(false);
    await expect(curveC.graduate()).to.be.revertedWithCustomError(curveC, "NotReady");
    // no 7-day timeout: still not graduatable after warping well past a week
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
    await ethers.provider.send("evm_mine", []);
    expect(await curveC.ready(), "no timeout path: still not graduatable after 7+ days").to.equal(false);
    await expect(curveC.graduate()).to.be.revertedWithCustomError(curveC, "NotReady");

    // (c) buy the REST of the way to the ceiling: now ready() is true and graduate() succeeds (permissionless),
    // paying the creator the fixed 0.5 WETH.
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 30n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready(), "reaching the ceiling IS graduatable").to.equal(true);
    const devBefore = await wethW.balanceOf(dev.address);
    await (await curveC.connect(buyer).graduate()).wait(); // buyer (not the dev) can graduate — it's permissionless
    expect(await curveC.graduated()).to.equal(true);
    expect((await wethW.balanceOf(dev.address)) - devBefore, "creator earns 0.5 at the ceiling").to.equal(ethers.parseEther("0.5"));
  });

  it("graduate() corrects a MANIPULATED post-buyout price back to the ceiling — floor-drain closed, no DoS (CP-1)", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    const rc = await (await factory.launch({ name: "Manip", symbol: "MNP", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 60n * ONE)).wait();

    await ethers.provider.send("evm_increaseTime", [400]); // clear the anti-snipe window
    await ethers.provider.send("evm_mine", []);

    // buy out the curve with the graduation-price cap -> price parked AT gradTick, curve is ready
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 55n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready()).to.equal(true);
    const gradTick = await curveC.gradTick();
    const atGrad = (await pool.slot0()).tick;
    expect(atGrad > gradTick ? atGrad - gradTick : gradTick - atGrad).to.be.at.most(50n); // within tolerance

    // ATTACK: shove spot far past gradTick into the empty region beyond the curve (free — no liquidity there).
    // Direction depends on token ordering; measure the ABSOLUTE deviation (what graduate() actually gates on).
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 1000n)).wait();
    const shoved = (await pool.slot0()).tick;
    const dev0 = shoved > gradTick ? shoved - gradTick : gradTick - shoved;
    expect(dev0).to.be.greaterThan(50n); // price is now well past the graduation tick (beyond the tolerance)

    // graduate() must NOT be blocked by the manipulation (that would be a griefing DoS). Instead it nudges spot
    // back to the honest ceiling and posts the Bond THERE — so the floor-drain vector stays closed (the Bond is
    // never posted around the shoved price) AND graduation can't be held hostage.
    await (await curveC.graduate()).wait();
    expect(await curveC.graduated()).to.equal(true);
    const afterTick = (await pool.slot0()).tick;
    const devAfter = afterTick > gradTick ? afterTick - gradTick : gradTick - afterTick;
    expect(devAfter).to.be.at.most(50n); // spot was pulled back to the ceiling before the Bond posted (not honored)
  });
});
