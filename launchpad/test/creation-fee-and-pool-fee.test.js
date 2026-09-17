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
    await ethers.provider.send("hardhat_setBalance", [dev.address, "0x" + (10n ** 24n).toString(16)]);
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dev).buy(token, 0, { value: ethers.parseEther("2000") })).wait();
    expect(await curve.ready()).to.equal(true);

    await (await curve.connect(dev).graduate()).wait();
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
});
