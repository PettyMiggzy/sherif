const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mineFor } = require("./helpers/brand");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

// NEW FEATURES (see /home/user/sherif/V3-AUCTION-SPEC.md):
//   1) CREATION_FEE — every launch now requires >= 0.001 ETH, spent immediately as a protocol buy-and-burn
//      against the freshly seeded curve, so the very first outside buyer isn't trading against a perfectly
//      virgin, zero-depth position.
//   2) poolFee choice — a creator can launch on the 0.05% (500) tier instead of the default 1% (10000).
//      0.3% (3000) is deliberately NOT offered — see CurvePool.POOL_FEE's doc comment for why.
//
// Uses the REAL @uniswap/v3-core bytecode (not the repo's mock), same as poolsquat.test.js — the mock cannot
// mint the concentrated positions CurvePool/Bond seed, and feeAmountTickSpacing must be the real protocol
// mapping for the fee-tier assertions here to mean anything.

const START = 201600, WIDTH = 23000, MINGRAD = 22800;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const CREATION_FEE = ethers.parseEther("0.001");

describe("Creation fee + LP fee-tier choice", function () {
  this.timeout(180000);

  let dep, platform, dev, weth, v3, factory, router;

  const NOTAX = () => ({ buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address });

  before(async () => {
    [dep, platform, dev] = (await ethers.getSigners()).slice(-4, -1);
    const at = async (n, ...a) => (await ethers.getContractFactory(n)).connect(dep).deploy(...a).then((c) => c.getAddress());
    weth = await at("MockWETH9");
    v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep).deploy().then((c) => c.getAddress());
    const ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd, ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(await factory.getAddress())).wait();
  });

  const launched = (rc) => rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Launched");

  it("a launch with NO ETH at all reverts CreationFeeRequired", async () => {
    const { salt } = await mineFor(factory, dev.address, { name: "NoFee", symbol: "NOFEE" }, 0n, "creationfee-none");
    await expect(
      factory.connect(dev).launchWithSalt({ name: "NoFee", symbol: "NOFEE", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 }, salt)
    ).to.be.revertedWithCustomError(factory, "CreationFeeRequired");
  });

  it("a launch with LESS than the creation fee also reverts CreationFeeRequired", async () => {
    const { salt } = await mineFor(factory, dev.address, { name: "Short", symbol: "SHORT" }, 0n, "creationfee-short");
    await expect(
      factory.connect(dev).launchWithSalt(
        { name: "Short", symbol: "SHORT", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
        salt, { value: CREATION_FEE - 1n }
      )
    ).to.be.revertedWithCustomError(factory, "CreationFeeRequired");
  });

  it("exactly the creation fee, no dev buy: launch succeeds and seeds real WETH + burns real tokens", async () => {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "SeedOnly", symbol: "SEED" }, 0n, "creationfee-exact");
    const devBefore = await ethers.provider.getBalance(dev.address);
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "SeedOnly", symbol: "SEED", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
      salt, { value: CREATION_FEE }
    )).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const ev = launched(rc);
    expect(ev.args.token).to.equal(token);
    expect(ev.args.devBought).to.equal(0n); // no dev buy — the whole msg.value WAS the creation fee

    // the dev paid exactly CREATION_FEE + gas, nothing more
    const devAfter = await ethers.provider.getBalance(dev.address);
    expect(devBefore - devAfter).to.equal(CREATION_FEE + gas);

    // real WETH landed inside the curve's Uniswap v3 position (the seed buy actually executed)
    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", ev.args.pool);
    const [lo, hi] = [await curve.curveLo(), await curve.curveHi()];
    // burn(0) pokes fees without moving principal; read owed via a static staticCall-style probe instead —
    // simplest real signal: price moved off the exact start tick (a buy consumed curve liquidity).
    const tickNow = (await pool.slot0())[1];
    expect(tickNow).to.not.equal(await curve.startTick());

    // the bought tokens were burned, not stranded in the factory or credited to the dev
    const DEAD = "0x000000000000000000000000000000000000dEaD";
    const TOK = await ethers.getContractAt("LaunchToken", token);
    expect(await TOK.balanceOf(DEAD)).to.be.gt(0n);
    expect(await TOK.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await TOK.balanceOf(dev.address)).to.equal(0n);
  });

  it("creation fee + a real dev buy together: both spend correctly, dev gets tokens, nothing double-counted", async () => {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "SeedPlus", symbol: "SEEDP" }, 0n, "creationfee-plus-devbuy");
    const devBuy = ethers.parseEther("1");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "SeedPlus", symbol: "SEEDP", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
      salt, { value: CREATION_FEE + devBuy }
    )).wait();
    const ev = launched(rc);
    expect(ev.args.devBought).to.be.gt(0n); // the dev buy actually happened, separately from the seed buy

    const TOK = await ethers.getContractAt("LaunchToken", token);
    expect(await TOK.balanceOf(dev.address)).to.equal(ev.args.devBought);
    const DEAD = "0x000000000000000000000000000000000000dEaD";
    expect(await TOK.balanceOf(DEAD)).to.be.gt(0n); // the seed buy STILL burned its own separate output
  });

  it("poolFee 3000 (0.3%) is rejected — only 500 and 10000 are offered", async () => {
    const { salt } = await mineFor(factory, dev.address, { name: "ThreeK", symbol: "3K" }, 0n, "poolfee-3000");
    await expect(
      factory.connect(dev).launchWithSalt(
        { name: "ThreeK", symbol: "3K", dev: dev.address, tax: NOTAX(), poolFee: 3000, auctionDays: 0 },
        salt, { value: CREATION_FEE }
      )
    ).to.be.revertedWithCustomError(factory, "BadValue");
  });

  it("poolFee 500 (0.05%) launches on a GENUINELY DIFFERENT Uniswap pool than the default 1% tier", async () => {
    const { salt: saltDefault, addr: tokDefault } =
      await mineFor(factory, dev.address, { name: "DefaultTier", symbol: "DEF" }, 0n, "poolfee-default");
    const rcDefault = await (await factory.connect(dev).launchWithSalt(
      { name: "DefaultTier", symbol: "DEF", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
      saltDefault, { value: CREATION_FEE }
    )).wait();
    const evDefault = launched(rcDefault);
    const curveDefault = await ethers.getContractAt("CurvePool", evDefault.args.curve);
    expect(await curveDefault.POOL_FEE()).to.equal(10000n);
    expect(await curveDefault.SPACING()).to.equal(200n);

    const { salt: saltCheap, addr: tokCheap } =
      await mineFor(factory, dev.address, { name: "CheapTier", symbol: "CHEAP" }, 0n, "poolfee-500");
    const rcCheap = await (await factory.connect(dev).launchWithSalt(
      { name: "CheapTier", symbol: "CHEAP", dev: dev.address, tax: NOTAX(), poolFee: 500, auctionDays: 0 },
      saltCheap, { value: CREATION_FEE }
    )).wait();
    const evCheap = launched(rcCheap);
    const curveCheap = await ethers.getContractAt("CurvePool", evCheap.args.curve);
    expect(await curveCheap.POOL_FEE()).to.equal(500n);
    expect(await curveCheap.SPACING()).to.equal(10n); // the REAL Uniswap fee->spacing mapping, read live

    expect(evDefault.args.pool).to.not.equal(evCheap.args.pool); // genuinely different pools, not just labels
    const v3c = new ethers.Contract(v3, V3_FACTORY_ART.abi, dep);
    expect(await v3c.getPool(tokDefault, weth, 10000)).to.equal(evDefault.args.pool);
    expect(await v3c.getPool(tokCheap, weth, 500)).to.equal(evCheap.args.pool);
  });

  it("a 500-tier coin graduates normally, and the Bond posts into the SAME 500-fee pool", async () => {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "GradCheap", symbol: "GCHP" }, 0n, "poolfee-500-grad");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "GradCheap", symbol: "GCHP", dev: dev.address, tax: NOTAX(), poolFee: 500, auctionDays: 0 },
      salt, { value: CREATION_FEE }
    )).wait();
    const ev = launched(rc);
    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", ev.args.pool);

    // buy the WHOLE curve out (cap sized generously; the router refunds/consumes only what the curve can take)
    // [AUTO-GRAD] this buy also graduates the curve, in the same transaction — no separate call needed, and
    // one would now revert AlreadyGraduated().
    await ethers.provider.send("hardhat_setBalance", [dev.address, "0x" + (10n ** 24n).toString(16)]);
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dev).buy(token, 0, { value: ethers.parseEther("2000") })).wait();
    expect(await curve.graduated()).to.equal(true);
    const bondAddr = await curve.bond();
    const bond = await ethers.getContractAt("Bond", bondAddr);
    expect(await bond.POOL_FEE()).to.equal(500n);
    expect(await bond.pool()).to.equal(await pool.getAddress());
    expect(await bond.posted()).to.equal(true);

    // the wall geometry survived unaligned-to-200 spacing correctly (the whole reason 3000 was excluded is
    // that THIS would NOT hold for spacing 60 without re-deriving the constants — confirm it holds for 10)
    const [lo, hi] = [await bond.ambushLo(), await bond.ambushHi()];
    expect(lo % 10n).to.equal(0n);
    expect(hi % 10n).to.equal(0n);
  });

  // ── [AUTO-GRAD] the buy that pushes a coin to the ceiling graduates it in the SAME transaction — no
  // separate curve.graduate() call, no keeper, needed for this to happen. ──
  it("[AUTO-GRAD] the buy that reaches the ceiling graduates the coin in that same transaction", async () => {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "AutoGrad", symbol: "AGRD" }, 0n, "autograd-buy");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "AutoGrad", symbol: "AGRD", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
      salt, { value: CREATION_FEE }
    )).wait();
    const ev = launched(rc);
    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);

    await ethers.provider.send("hardhat_setBalance", [dev.address, "0x" + (10n ** 24n).toString(16)]);
    const routerC = await ethers.getContractAt("PadRouter", router);
    const devWethBefore = await (await ethers.getContractAt("IERC20", await curve.WETH())).balanceOf(dev.address);
    const buyRc = await (await routerC.connect(dev).buy(token, 0, { value: ethers.parseEther("2000") })).wait();

    // no separate graduate() call anywhere in this test — this is the whole point
    expect(await curve.graduated(), "graduated() must already be true right after the buy, with no second tx").to.equal(true);
    expect(await curve.bond()).to.not.equal(ethers.ZeroAddress);
    const bond = await ethers.getContractAt("Bond", await curve.bond());
    expect(await bond.posted()).to.equal(true);

    // graduate()'s own event fired inside the SAME transaction receipt as the buy — not a second tx
    const gradEv = buyRc.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    expect(gradEv, "Graduated must be emitted in the buy's own tx receipt").to.not.equal(null);

    // and the creator really did receive GRAD_REWARD as part of that one transaction — auto-grad is not a
    // no-op stand-in, it runs the real payout
    const devWethAfter = await (await ethers.getContractAt("IERC20", await curve.WETH())).balanceOf(dev.address);
    expect(devWethAfter - devWethBefore).to.equal(await curve.GRAD_REWARD());
  });

  it("[AUTO-GRAD] an ordinary buy that does NOT reach the ceiling is completely unaffected", async () => {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "SmallBuy", symbol: "SMB" }, 0n, "autograd-smallbuy");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "SmallBuy", symbol: "SMB", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
      salt, { value: CREATION_FEE }
    )).wait();
    const ev = launched(rc);
    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const routerC = await ethers.getContractAt("PadRouter", router);

    // a small, ordinary buy — nowhere near the ceiling
    const rcSmall = await (await routerC.connect(dev).buy(token, 0, { value: ethers.parseEther("0.01") })).wait();
    expect(await curve.ready()).to.equal(false);
    expect(await curve.graduated()).to.equal(false);
    const gradEv = rcSmall.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    expect(gradEv, "no Graduated event on an ordinary buy that doesn't reach the ceiling").to.equal(undefined);
  });
});

// ── [J] graduate()'s pre-grad fee sweep must obey the SAME "ETH side is 100% platform" rule ────────────────
//
// collectFees() hardcodes 0 creator bps on the WETH leg — the comment right above it says why: the creator's
// LP-fee share is paid on the TOKEN side only, so the platform stays ETH-only. graduate() has an identical
// pre-graduation fee sweep, and it used to pass the LIVE (non-zero) creator bps on the WETH leg instead of
// the hardcoded 0 — a real leak, not a hypothetical: the source-text regression test guarding this
// (test/v2-stack.test.js, "[rev] the curve pays the ETH side...") only ever matched collectFees()'s call
// site by its local variable name (`wethFees`), never graduate()'s (`wFee`), and every OTHER test in this
// file deploys with `feeConfig = ethers.ZeroAddress`, which forces cbps to 0 and hides the divergence
// entirely regardless of which line is checked. This is a real balance-delta test against a REAL FeeConfig
// with its non-zero default (10%), not another source regex.
describe("[J] graduate()'s fee sweep: creator gets 0% of the WETH leg, same as collectFees()", function () {
  this.timeout(180000);

  it("a real accrued LP fee before graduation pays the creator EXACTLY GRAD_REWARD in WETH — no extra cut", async () => {
    const [dep, platform, dev] = (await ethers.getSigners()).slice(-7, -4);
    const at = async (n, ...a) => (await ethers.getContractFactory(n)).connect(dep).deploy(...a).then((c) => c.getAddress());
    const weth = await at("MockWETH9");
    const v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep).deploy().then((c) => c.getAddress());
    const ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    const router = await at("PadRouter", weth, dep.address);
    // The ONE difference from this file's shared fixture: a REAL FeeConfig, not ethers.ZeroAddress. Its
    // shipped default (lpCreatorBps = 1000 = 10%, see test/fn-fee-config.test.js) is exactly what makes the
    // WETH-leg leak observable — with feeConfig unset, cbps is forced to 0 regardless of which line runs.
    const feeConfig = await at("FeeConfig", dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd, feeConfig, START, WIDTH, MINGRAD
    );
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(await factory.getAddress())).wait();

    // Local to this test — `factory` here is a fresh instance, not the shared one the outer describe's own
    // `launched` closes over, so that helper can't be reused as-is.
    const launchedLocal = (rc) => rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");

    const NOTAX = { buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "FeeLeak", symbol: "FLK" }, 0n, "j-fee-leak-check");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "FeeLeak", symbol: "FLK", dev: dev.address, tax: NOTAX, poolFee: 0, auctionDays: 0 },
      salt, { value: CREATION_FEE }
    )).wait();
    const ev = launchedLocal(rc);
    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);

    // push the curve to the ceiling with a real buy — a real Uniswap v3 swap, which accrues a real WETH-side
    // LP fee on the curve's own position (the thing collectFees()/graduate()'s sweep exist to realize).
    // [AUTO-GRAD] this SAME buy also triggers graduation now, in the same transaction — snapshot dev's WETH
    // balance before it (not before a since-removed separate graduate() call) and read the buy's own receipt
    // for both the FeesCollected sweep and the Graduated event.
    await ethers.provider.send("hardhat_setBalance", [dev.address, "0x" + (10n ** 24n).toString(16)]);
    const devBefore = await (await ethers.getContractAt("IERC20", weth)).balanceOf(dev.address);
    const rcGrad = await (await (await ethers.getContractAt("PadRouter", router)).connect(dev).buy(token, 0, { value: ethers.parseEther("2000") })).wait();
    expect(await curve.graduated()).to.equal(true);
    const devAfter = await (await ethers.getContractAt("IERC20", weth)).balanceOf(dev.address);

    const GRAD_REWARD = await curve.GRAD_REWARD();
    // The fixture's geometry (same as the rest of this file) raises well past 2 ETH by graduation, so
    // Math.min(GRAD_REWARD, raisedWeth/4) hits the flat GRAD_REWARD cap, not the raise-scaled one — confirmed
    // by the assertion below being an EQUALITY, not a >=. If the WETH-leg leak ever comes back, this fails:
    // devAfter - devBefore would be GRAD_REWARD PLUS a nonzero creator cut of the pre-grad WETH fee sweep.
    expect(devAfter - devBefore).to.equal(GRAD_REWARD);

    // and confirm there WAS a real WETH fee to leak from, or this test would pass vacuously even with the bug
    const feesEv = rcGrad.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "FeesCollected");
    expect(feesEv, "graduate() must emit FeesCollected from its pre-grad sweep").to.not.equal(null);
    expect(feesEv.args.wethFees > 0n, "the swap above must have accrued a real nonzero WETH-side LP fee").to.equal(true);
    expect(feesEv.args.creatorBps).to.equal(1000n); // the live, non-zero bps — proves this run was not silently 0
  });
});
