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

  it("launch() -> live+tradeable Uniswap pool, NO opening guard -> buy out -> graduate into the Bond", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 207200, 35800, 19800
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
    // [v2] NO opening guard, ever — the factory launches every coin with a zero GuardConfig. This assertion is
    // inverted from v1 on purpose: it is the thing most likely to be reintroduced by accident, so it is pinned
    // against the LIVE chain rather than only in the unit tests.
    expect(await TOK.antiSnipeActive()).to.equal(false);
    expect(await TOK.maxTxNow()).to.equal(ethers.MaxUint256);
    expect(await TOK.maxWalletNow()).to.equal(ethers.MaxUint256);
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

    // ===== [v2] the buy that v1 REVERTED now succeeds — this is the removal, measured on live chain =====
    // Under v1 this exact call reverted: 0.5 WETH blew past the 1% wallet cap inside the opening window. On v2
    // there is no window and no cap, so it fills. Keeping the same amount makes the behaviour change explicit
    // rather than hiding it behind a rewritten test.
    const t0 = await TOK.balanceOf(buyer.address);
    await (await buy(ONE / 2n)).wait();
    const bigFill = (await TOK.balanceOf(buyer.address)) - t0;
    expect(bigFill).to.be.greaterThan(0n);

    // a small buy still trades fine too, and there is no per-wallet cooldown between the two
    await (await buy(ONE / 500n)).wait();
    expect((await TOK.balanceOf(buyer.address)) - t0).to.be.greaterThan(bigFill);

    // ===== buy out the curve (capped at the graduation price). No window to wait out any more. =====
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
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 207200, 35800, 19800
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
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    // production graduation geometry: the coin graduates only at the ceiling (~$76k mcap)
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 196200, 25800, 16400
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
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 196200, 25800, 16400
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

  it("INSTANT graduation in the launch tx posts a working Bond — poke() works, floor recycles (CP-2)", async () => {
    // Regression: a big dev buy fills the whole curve in the launch tx, so the coin graduates at t≈launchTime,
    // deep inside the 300s anti-snipe window. Bond.poke()'s pool.collect() moves the ~25% Ambush reserve back to
    // the Bond (reads as a "buy": from == pool). Before the fix the Bond was NOT guard-exempt, so that transfer
    // tripped maxTx/maxWallet and poke() reverted for the rest of the window. The fix exempts the Bond at
    // graduation. This proves the Bond is exempt AND poke() succeeds while the window is still active.
    const [dep, platform, dev] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // dev buy big enough to walk the whole curve to the ceiling in the launch tx (excess ETH is refunded)
    const rc = await (await factory.connect(dev).launch(
      { name: "Fast", symbol: "FAST", dev: dev.address, tax: NOTAX }, { value: 40n * ONE }
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);
    const curveC = await ethers.getContractAt("CurvePool", curve);

    // the dev buy filled the curve to the ceiling — graduatable immediately
    expect(await curveC.ready(), "ceiling reached by the dev buy").to.equal(true);
    // [v2] there is no window to be inside any more. What this case originally proved (the Bond survives a
    // graduation that lands mid-window) is now vacuous; what it still proves — an INSTANT graduation, in the
    // same breath as the launch, posts a working Bond — is the part worth keeping.
    expect(await TOK.antiSnipeActive(), "v2 launches carry no guard at all").to.equal(false);

    await (await curveC.graduate()).wait();
    expect(await curveC.graduated()).to.equal(true);
    const bondAddr = await curveC.bond();
    const bond = await ethers.getContractAt("Bond", bondAddr);
    expect(await bond.posted()).to.equal(true);

    // [V2-8] CurvePool still exempts the fresh Bond at graduation. With no guard the exemption cannot matter,
    // but the call is still made (try/catch, idempotent) — so assert it lands, because the same CurvePool has to
    // keep working for a future guarded factory. It is belt-and-braces now, not the fix it used to be.
    expect(await TOK.isExempt(bondAddr), "Bond still exempted at graduation, harmlessly").to.equal(true);

    // let the 15s poke TWAP build
    await ethers.provider.send("evm_increaseTime", [30]);
    await ethers.provider.send("evm_mine", []);

    // poke() moves the Ambush reserve (pool -> Bond), which reads as a "buy". Under v1 that needed the exemption
    // to survive maxTx/maxWallet; on v2 nothing gates it. Either way it must work on a just-graduated coin.
    await (await bond.poke()).wait();
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);
  });

  it("[FDV] launchWithSupply: a 10,000-token coin is a REAL coin — same valuation, same trade, as a 1B one", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 201600, 23000, 22800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // 100,000x less supply, priced ~100,000x higher per token (ln(1e5)/1e-4 ~ 115,100 ticks, aligned to 200)
    const SMALL_SUPPLY = 10_000n * ONE, SMALL_MAG = 201600 - 115200;
    const bigFdv = await factory.quoteFdvWei(1_000_000_000n * ONE, 201600);
    const smallFdv = await factory.quoteFdvWei(SMALL_SUPPLY, SMALL_MAG);
    // the two launches are the same size of company, to within the 200-tick spacing
    const drift = Number(smallFdv > bigFdv ? smallFdv - bigFdv : bigFdv - smallFdv) / Number(bigFdv);
    expect(drift, "same valuation at 100,000x different supply").to.be.lessThan(0.03);

    const rc = await (await factory.launchWithSupply(
      { name: "Tiny Supply", symbol: "TINY", dev: dev.address, tax: NOTAX }, SMALL_SUPPLY, SMALL_MAG
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    // a real, live, tradeable coin — not a degenerate one
    expect(await TOK.totalSupply()).to.equal(SMALL_SUPPLY);
    expect(await TOK.tradingEnabled()).to.equal(true);
    expect(await curveC.curveL()).to.be.greaterThan(0n);
    expect((await pool.slot0()).sqrtPriceX96).to.be.greaterThan(0n);
    // 75/25 curve/ambush split holds at any supply
    expect(await curveC.curveSupply()).to.equal((SMALL_SUPPLY * 7500n) / 10000n);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 10n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 10n * ONE)).wait();
    await ethers.provider.send("evm_increaseTime", [400]); // clear the anti-snipe window
    await ethers.provider.send("evm_mine", []);

    // 0.25 ETH buys a MEANINGFUL slice of the coin — the point of choosing your own supply is that the number
    // of tokens is cosmetic, so this must be a normal-looking percentage, not dust and not the whole float
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 4n)).wait();
    const got = await TOK.balanceOf(buyer.address);
    const ppm = (got * 1_000_000n) / SMALL_SUPPLY;
    expect(ppm, "0.25 ETH buys a real slice of a 10k-supply coin").to.be.greaterThan(1000n); // > 0.1%
    expect(ppm).to.be.lessThan(750_000n); // and does not eat the curve

    // and it still graduates: buy the rest of the curve up to the ceiling
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 9n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready(), "a 10,000-supply coin graduates like any other").to.equal(true);
  });

  it("[FDV] the band is enforced on the REAL launch path, not just in the quote", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 201600, 23000, 22800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const p = { name: "Dust", symbol: "DUST", dev: dev.address, tax: NOTAX };

    // 10,000 tokens at the DEFAULT price is a dust valuation: the curve would raise ~nothing and never graduate
    const fdv = await factory.quoteFdvWei(10_000n * ONE, 201600);
    await expect(factory.launchWithSupply(p, 10_000n * ONE, 0))
      .to.be.revertedWithCustomError(factory, "MarketCapOutOfRange").withArgs(fdv);
    // the default launch is always in band by construction
    await expect(factory.launch({ ...p, symbol: "OKAY" })).to.not.be.reverted;
  });

  it("graduate() corrects a MANIPULATED post-buyout price back to the ceiling — floor-drain closed, no DoS (CP-1)", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 207200, 35800, 19800
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
