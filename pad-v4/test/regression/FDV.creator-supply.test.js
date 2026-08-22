const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { brandedTokenSalt } = require("../helpers/brand");
const { startTickForFdv, assertInBand, approxStartTick } = require("../../scripts/valuation");

// [FDV] CREATOR-CHOSEN SUPPLY.
//
// A creator picks their own supply — 10,000 tokens or 10,000,000,000, the pad does not care — and their own
// launch valuation. What the factory bounds is neither of those numbers alone but their PRODUCT: the implied
// fully-diluted value at launch, checked against the owner-governed [minFdvWei, maxFdvWei] band.
//
// The claim this file has to earn is the non-obvious one: that supply is genuinely COSMETIC. A 10k-supply coin
// and a 1B-supply coin launched at the same valuation must be the same investment — 1 ETH buys the same
// percentage of the coin and moves the chart by the same amount. If that were not true, "pick your supply"
// would be a trap that quietly changes the economics under the creator.
//
// The band itself is the fail-closed half: a dust valuation (where the curve's raise truncates toward zero and
// graduation bricks on EmptyRaise) and an absurd one both revert BEFORE any state is written.

const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const ONE = 10n ** 18n;

// PRODUCTION geometry (scripts/deploy-curve.js), not a toy: ts 100, start tick 201600, 23000-tick curve.
const TS = 100, START = 201600, WIDTH = 23000, MINGRAD = 22800, FEE = 10000;
const MIN_FDV = ethers.parseEther("0.05");
const MAX_FDV = ethers.parseEther("100");

describe("[FDV] creators choose their own supply; the FACTORY bounds the valuation", () => {
  let deployer, platform, creator, buyer, S, SW;

  before(async () => {
    [deployer, platform, creator, buyer] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
    const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
      // the REAL shipped band — this file is the one place that tests the product policy, not an open fixture
      minFdvWei: MIN_FDV, maxFdvWei: MAX_FDV,
    });
    const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
    SW = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    S = { pm, stateView, dep, reg, factory, feeCfg };
  });

  const cfgFor = (tag, supply, startTickMag) => ({
    name: "Robin " + tag, symbol: tag, decimals: 18,
    supply, curveSupply: (supply * 73n) / 100n, reserveSupply: supply - (supply * 73n) / 100n,
    tickSpacing: TS, startTickMag, creator: creator.address,
  });

  async function salts(cfg, tag) {
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("tok-" + tag));
    const TokenF = await ethers.getContractFactory("PadToken");
    const init = ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await S.factory.getAddress()]),
    ]);
    const predicted = ethers.getCreate2Address(await S.dep.getAddress(), tokenSalt, ethers.keccak256(init));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(
      await S.dep.getAddress(),
      hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predicted)
    );
    return { tokenSalt, hookSalt, curveSalt: ethers.id("curve-" + tag), predicted };
  }

  async function launch(tag, supply, startTickMag) {
    const cfg = cfgFor(tag, supply, startTickMag);
    const sa = await salts(cfg, tag);
    const [token, hook] = await S.factory.launch.staticCall(cfg, sa.tokenSalt, sa.hookSalt, sa.curveSalt);
    await (await S.factory.launch(cfg, sa.tokenSalt, sa.hookSalt, sa.curveSalt)).wait();
    const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
    const poolId = ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    return { cfg, token, hook, key, poolId, tok: await ethers.getContractAt("PadToken", token) };
  }

  const tickOf = async (poolId) => Number((await S.stateView.getSlot0(poolId))[1]);

  // ── 1. the headline: a 10,000-token coin, at the same valuation as a 1,000,000,000-token coin ────────────

  let BIG, SMALL, targetFdv, smallTick;

  it("launches a 1B-supply coin and a 10,000-supply coin at the SAME valuation", async () => {
    const bigSupply = 1_000_000_000n * ONE;
    const smallSupply = 10_000n * ONE;

    // the 1B coin just takes the governed default start tick (startTickMag 0 = "use the default")
    targetFdv = await S.factory.quoteFdvWei(bigSupply, START);
    await assertInBand(S.factory, targetFdv); // the shipped geometry sits inside the shipped band
    BIG = await launch("BIG", bigSupply, 0);
    expect(await tickOf(BIG.poolId)).to.equal(START); // the default really was inherited

    // the 10k coin has to launch ~100,000x higher per token, so it picks its own start tick
    const picked = await startTickForFdv(S.factory, smallSupply, targetFdv, TS);
    smallTick = picked.tick;
    expect(smallTick % TS).to.equal(0);
    expect(smallTick).to.be.lessThan(START); // fewer tokens per ETH == a far pricier token
    SMALL = await launch("SMALL", smallSupply, smallTick);
    expect(await tickOf(SMALL.poolId)).to.equal(smallTick);

    // the two valuations agree to within one tick-spacing of rounding (100 ticks ~ 1.005%)
    const fdvSmall = await S.factory.quoteFdvWei(smallSupply, smallTick);
    const drift = Number(fdvSmall > targetFdv ? fdvSmall - targetFdv : targetFdv - fdvSmall) / Number(targetFdv);
    expect(drift).to.be.lessThan(0.01);
    // sanity: these really are 100,000x apart in supply and both land near the same ~1.7 ETH valuation
    expect(bigSupply / smallSupply).to.equal(100_000n);
    expect(fdvSmall).to.be.gt(MIN_FDV).and.to.be.lt(MAX_FDV);
  });

  // ── 2. supply is COSMETIC: identical money in, identical share out, identical chart move ─────────────────

  it("the same ETH buys the same PERCENTAGE of each coin and moves each chart the same number of ticks", async () => {
    const spend = ethers.parseEther("0.25"); // exact-input, well inside both curves
    const results = [];
    for (const P of [BIG, SMALL]) {
      const before = await P.tok.balanceOf(buyer.address);
      const t0 = await tickOf(P.poolId);
      await SW.connect(buyer).swap(
        P.key, { zeroForOne: true, amountSpecified: -spend, sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: spend }
      );
      const got = (await P.tok.balanceOf(buyer.address)) - before;
      expect(got).to.be.gt(0n);
      // share of the whole coin, in millionths, so two supplies 100,000x apart are directly comparable
      results.push({ ppm: (got * 1_000_000n) / P.cfg.supply, ticks: t0 - (await tickOf(P.poolId)) });
    }
    const [big, small] = results;
    const shareDrift = Number(big.ppm > small.ppm ? big.ppm - small.ppm : small.ppm - big.ppm) / Number(big.ppm);
    expect(shareDrift).to.be.lessThan(0.01); // same slice of the coin for the same money
    expect(Math.abs(big.ticks - small.ticks)).to.be.lessThan(TS); // and the same move up the chart
    expect(big.ticks).to.be.greaterThan(0);
  });

  // ── 3. the band is fail-closed on both ends, before any state is written ─────────────────────────────────

  it("REVERTS MarketCapOutOfRange below the band — and creates nothing", async () => {
    // 1,000 tokens at the DEFAULT start tick is a dust valuation (~1.8e-15 ETH): the curve integral would
    // truncate toward zero and graduation would brick on EmptyRaise. This is the launch the band exists to stop.
    const supply = 1_000n * ONE;
    const fdv = await S.factory.quoteFdvWei(supply, START);
    expect(fdv).to.be.lt(MIN_FDV);
    const cfg = cfgFor("DUST", supply, 0);
    const sa = await salts(cfg, "DUST");
    await expect(S.factory.launch(cfg, sa.tokenSalt, sa.hookSalt, sa.curveSalt))
      .to.be.revertedWithCustomError(S.factory, "MarketCapOutOfRange").withArgs(fdv);
    expect(await S.factory.poolOf(sa.predicted)).to.equal(ethers.ZeroHash); // nothing half-created
    expect(await ethers.provider.getCode(sa.predicted)).to.equal("0x"); // the token was never even deployed
  });

  it("REVERTS MarketCapOutOfRange above the band", async () => {
    // same 1B supply, but launched ~100,000x pricier: a >100 ETH opening valuation
    const supply = 1_000_000_000n * ONE;
    const tick = START - 115000; // 115000 ticks == e^11.5 ~ 99,000x pricier per token
    const fdv = await S.factory.quoteFdvWei(supply, tick);
    expect(fdv).to.be.gt(MAX_FDV);
    const cfg = cfgFor("MOON", supply, tick);
    const sa = await salts(cfg, "MOON");
    await expect(S.factory.launch(cfg, sa.tokenSalt, sa.hookSalt, sa.curveSalt))
      .to.be.revertedWithCustomError(S.factory, "MarketCapOutOfRange").withArgs(fdv);
  });

  // ── 4. the start-tick override cannot be used to smuggle in a broken geometry ────────────────────────────

  it("a per-launch start tick must still be positive and tick-spacing aligned", async () => {
    const supply = 1_000_000_000n * ONE;
    for (const bad of [START + 50, -START]) {
      const cfg = cfgFor("BADG", supply, bad);
      const sa = await salts(cfg, "BADG" + bad);
      await expect(S.factory.launch(cfg, sa.tokenSalt, sa.hookSalt, sa.curveSalt))
        .to.be.revertedWithCustomError(S.factory, "BadGeometry");
    }
  });

  // ── 5. the band is governed, and a nonsense band is rejected at the source ───────────────────────────────

  it("RobinV4FeeConfig rejects a zero floor or an inverted band", async () => {
    const d = await S.feeCfg.defaults();
    const asObj = {
      buyTaxBps: d.buyTaxBps, sellTaxBps: d.sellTaxBps, sellFloorShareBps: d.sellFloorShareBps,
      buyLpFloorShareBps: d.buyLpFloorShareBps, buyBufferShareBps: d.buyBufferShareBps, referralShareBps: d.referralShareBps,
      platformGradBps: d.platformGradBps, creatorGradBps: d.creatorGradBps, ambushGradBps: d.ambushGradBps,
      lpFee: d.lpFee, startTickMag: d.startTickMag, curveWidth: d.curveWidth, minGradWidth: d.minGradWidth,
      minFdvWei: d.minFdvWei, maxFdvWei: d.maxFdvWei,
    };
    await expect(S.feeCfg.setDefaults({ ...asObj, minFdvWei: 0n }))
      .to.be.revertedWithCustomError(S.feeCfg, "BadParam");
    await expect(S.feeCfg.setDefaults({ ...asObj, minFdvWei: MAX_FDV, maxFdvWei: MIN_FDV }))
      .to.be.revertedWithCustomError(S.feeCfg, "BadParam");
    // the live band is readable by any client, so nothing has to hardcode it
    const [min, max] = await S.factory.fdvBand();
    expect(min).to.equal(MIN_FDV);
    expect(max).to.equal(MAX_FDV);
  });

  // ── 6. a presale cannot OPEN on a valuation that will be rejected at launch ──────────────────────────────

  it("createPresale refuses an out-of-band valuation up front instead of failing at finalize", async () => {
    const impl = await (await ethers.getContractFactory("PresaleVault")).deploy();
    const pf = await (await ethers.getContractFactory("PresaleVaultFactory")).deploy(
      await S.factory.getAddress(), await impl.getAddress()
    );
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const deadline = BigInt(now) + 7n * 86400n;
    const open = (cfg) => pf.createPresale(cfg, ethers.id("commit"), ethers.parseEther("3"), deadline, ethers.parseEther("2"), ethers.parseEther("0.1"), 86400n);

    // dust valuation: without the open-time check this presale takes deposits for a week, then finalize's
    // try/catch swallows MarketCapOutOfRange and burns the raise to Failed(3) "sniped"
    await expect(open(cfgFor("PDUST", 1_000n * ONE, 0))).to.be.revertedWithCustomError(impl, "BadParams");
    // the same shape at an in-band valuation opens fine, so the guard is the band and not the shape
    await expect(open(cfgFor("POK", 1_000_000_000n * ONE, 0))).to.not.be.reverted;
  });

  // ── 7. the creator-facing preset grid: every combination has to actually launch ──────────────────────────

  it("every supply x market-cap preset combination lands in band and produces a valid launch tick", async () => {
    const { SUPPLY_PRESETS, MARKET_CAP_PRESETS_USD, launchFieldsFor, fdvBandUsd } = require("../../scripts/valuation");
    const ETH_USD = 3000; // the client quotes this off-chain; the contract only ever sees wei
    const band = await fdvBandUsd(S.factory, ETH_USD);
    // the shipped band has to be wide enough to CONTAIN the presets, or the UI offers buttons that revert
    expect(band.minUsd).to.be.lessThan(Math.min(...MARKET_CAP_PRESETS_USD));
    expect(band.maxUsd).to.be.greaterThan(Math.max(...MARKET_CAP_PRESETS_USD));

    for (const whole of SUPPLY_PRESETS) {
      for (const usd of MARKET_CAP_PRESETS_USD) {
        const f = await launchFieldsFor(S.factory, whole, usd, ETH_USD, TS);
        expect(f.startTickMag % TS, `${whole} @ $${usd}`).to.equal(0);
        expect(f.startTickMag).to.be.greaterThan(0);
        // the realised market cap is within one tick-spacing of what the creator asked for
        expect(Math.abs(f.marketCapUsd - usd) / usd, `${whole} @ $${usd}`).to.be.lessThan(0.01);
        // and it is a launch the factory would actually accept, by the factory's own arithmetic
        expect(await S.factory.quoteFdvWei(f.supply, f.startTickMag)).to.equal(f.fdvWei);
      }
    }
  });

  it("the widest preset corner — 69,000,000,000 tokens at $25K — is a real, tradeable launch", async () => {
    const { launchFieldsFor } = require("../../scripts/valuation");
    const f = await launchFieldsFor(S.factory, 69_000_000_000n, 25_000, 3000, TS);
    const P = await launch("WIDE", f.supply, f.startTickMag);
    expect(await tickOf(P.poolId)).to.equal(f.startTickMag);

    // 690,000x the supply of the 10k coin, and the same 0.25 ETH still buys a comparable slice of it
    const spend = ethers.parseEther("0.25");
    await SW.connect(buyer).swap(
      P.key, { zeroForOne: true, amountSpecified: -spend, sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: spend }
    );
    const ppm = ((await P.tok.balanceOf(buyer.address)) * 1_000_000n) / f.supply;
    expect(ppm).to.be.greaterThan(0n);
    expect(ppm).to.be.lessThan(750_000n); // a real slice, not the whole float
  });

  // ── 8. the launch client's tick math is the CHAIN's tick math ────────────────────────────────────────────

  it("the JS valuation helper agrees with the on-chain check across supplies from 10k to 100bn", async () => {
    for (const whole of [10_000n, 1_000_000n, 1_000_000_000n, 100_000_000_000n]) {
      const supply = whole * ONE;
      const { tick, fdvWei } = await startTickForFdv(S.factory, supply, targetFdv, TS);
      expect(tick % TS).to.equal(0);
      expect(fdvWei).to.equal(await S.factory.quoteFdvWei(supply, tick)); // no second implementation of the math
      const drift = Number(fdvWei > targetFdv ? fdvWei - targetFdv : targetFdv - fdvWei) / Number(targetFdv);
      expect(drift).to.be.lessThan(0.01);
      // the float pass is only ever a rounding away from the chain-verified answer
      expect(Math.abs(approxStartTick(supply, targetFdv, TS) - tick)).to.be.lessThanOrEqual(TS);
    }
  });
});
