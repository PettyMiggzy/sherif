const { expect } = require("chai");
const { ethers } = require("hardhat");

// [FDV] CREATOR-CHOSEN SUPPLY on the live v3 pad.
//
// `launch()` mints a fixed 1,000,000,000 at a fixed factory-wide price. `launchWithSupply()` lets a creator pick
// both: any supply, any launch price. Supply is bounded by NOTHING — the factory instead bounds supply x launch
// price, the implied fully-diluted value, against an owner-governed [minFdvWei, maxFdvWei] band.
//
// SCOPE OF THIS FILE: everything that happens BEFORE the factory touches Uniswap — the valuation math, the band,
// its governance, and the fact that an out-of-band or malformed launch reverts before a single byte of state is
// written. The full launch needs a real Uniswap v3 pool and lives in test/fork/curvepad.fork.test.js; a mock v3
// factory cannot mint the concentrated position CurvePool seeds, so it cannot stand in here.
//
// NOTE: none of this reaches the DEPLOYED factory at 0x8aa9…, whose code is fixed. It ships with the next one.

const ONE = 10n ** 18n;
const DEFAULT_SUPPLY = 1_000_000_000n * ONE;
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

describe("[FDV] v3 pad — creators choose supply; the factory bounds the valuation", () => {
  let dep, platform, dev, other, factory;

  // This suite shares ONE chain with every other file and there is no global fixture, so gas spent here is gas
  // a later file does not have: by the time these run the low-index accounts are nearly empty and several
  // existing files already fail with "sender doesn't have enough funds". Two things keep that unchanged —
  // every tx here is signed by an account NOTHING else touches (the last four signers, still untouched at their
  // genesis balance), and the whole stack is deployed once, with only the state-mutating case paying for a
  // second factory.
  let stack;
  const as = (c) => c.connect(dep);
  before(async () => {
    [dep, platform, dev, other] = (await ethers.getSigners()).slice(-4);
    const at = async (name, ...args) => (await ethers.getContractFactory(name)).connect(dep).deploy(...args).then((c) => c.getAddress());
    const weth = await at("MockWETH9");
    const v3 = await at("MockUniswapV3Factory");
    const ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer");
    const router = await at("PadRouter", weth, dep.address);
    stack = [weth, v3, platform.address, dep.address, router, ltd, cpd, bd, ethers.ZeroAddress, START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH];
    factory = await newFactory();
  });

  const newFactory = async () => (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(...stack);

  const NOTAX = () => ({ buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address });
  const params = () => ({ name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX() });

  it("prices the shipped geometry the way the calibration says it does (~1.76 ETH at 1B supply)", async () => {
    const fdv = await factory.quoteFdvWei(DEFAULT_SUPPLY, START_TICK_MAG);
    // independent check: FDV = supply / 1.0001^tick, computed in floating point from the tick alone
    const expected = Number(DEFAULT_SUPPLY) / Math.pow(1.0001, START_TICK_MAG);
    expect(Math.abs(Number(fdv) - expected) / expected).to.be.lessThan(1e-6);
    expect(Number(ethers.formatEther(fdv))).to.be.closeTo(1.758, 0.01);
  });

  it("seeds the band around this factory's OWN default launch, so launch() is in band by construction", async () => {
    const fdv = await factory.quoteFdvWei(DEFAULT_SUPPLY, START_TICK_MAG);
    expect(await factory.minFdvWei()).to.equal(fdv / 32n);
    expect(await factory.maxFdvWei()).to.equal(fdv * 32n);
    expect(fdv).to.be.gte(await factory.minFdvWei()).and.to.be.lte(await factory.maxFdvWei());
  });

  it("a 10,000-token supply priced into the band CLEARS the valuation check", async () => {
    const supply = 10_000n * ONE;
    // 100,000x less supply ⇒ needs a ~100,000x pricier token: ln(1e5)/1e-4 ≈ 115,100 ticks lower
    const mag = 201600 - 115200; // 86400, a multiple of 200
    const fdv = await factory.quoteFdvWei(supply, mag);
    expect(fdv).to.be.gte(await factory.minFdvWei()).and.to.be.lte(await factory.maxFdvWei());
    // It gets PAST the band: the token deploys and the pool is created, and the call only dies further down,
    // where the MOCK pool cannot mint CurvePool's concentrated seed position (an ERC20 balance error from the
    // mock, not a factory error). Passing the band is the whole claim here; the real seed is a fork test.
    await expect(as(factory).launchWithSupply(params(), supply, mag))
      .to.not.be.revertedWithCustomError(factory, "MarketCapOutOfRange");
    await expect(as(factory).launchWithSupply(params(), supply, mag))
      .to.not.be.revertedWithCustomError(factory, "BadValue");
  });

  it("REVERTS MarketCapOutOfRange on a dust valuation, before any state is written", async () => {
    const supply = 10_000n * ONE; // at the DEFAULT price this is ~1.8e-14 ETH of coin
    const fdv = await factory.quoteFdvWei(supply, START_TICK_MAG);
    expect(fdv).to.be.lt(await factory.minFdvWei());
    await expect(as(factory).launchWithSupply(params(), supply, 0))
      .to.be.revertedWithCustomError(factory, "MarketCapOutOfRange").withArgs(fdv);
    await expect(factory.allTokens(0)).to.be.reverted; // nothing was registered
  });

  it("REVERTS MarketCapOutOfRange on an absurd valuation", async () => {
    const mag = 201600 - 115200; // ~100,000x pricier per token, at the FULL default supply
    const fdv = await factory.quoteFdvWei(DEFAULT_SUPPLY, mag);
    expect(fdv).to.be.gt(await factory.maxFdvWei());
    await expect(as(factory).launchWithSupply(params(), 0, mag))
      .to.be.revertedWithCustomError(factory, "MarketCapOutOfRange").withArgs(fdv);
  });

  it("REJECTS a malformed launch price (negative, unaligned, or past the usable range)", async () => {
    for (const mag of [-201600, 201601, 887200]) {
      await expect(as(factory).launchWithSupply(params(), 0, mag)).to.be.revertedWithCustomError(factory, "BadValue");
    }
  });

  it("the band is owner-governed: retunable, and a nonsense band is refused", async () => {
    const f = await newFactory(); // retunes the band, so it gets its OWN factory — the shared one stays pristine
    const lo = ethers.parseEther("0.05"), hi = ethers.parseEther("100");
    await expect(f.connect(other).setFdvBand(lo, hi)).to.be.reverted; // not the owner
    await expect(as(f).setFdvBand(0, hi)).to.be.revertedWithCustomError(f, "BadValue");
    await expect(as(f).setFdvBand(hi, lo)).to.be.revertedWithCustomError(f, "BadValue");
    // and a constant rail the owner cannot tune past — loose enough never to block a real retune
    const hard = await f.HARD_MAX_FDV_WEI();
    expect(hard).to.equal(ethers.parseEther("1000000"));
    await expect(as(f).setFdvBand(lo, hard + 1n)).to.be.revertedWithCustomError(f, "BadValue");
    await expect(as(f).setFdvBand(lo, hard)).to.not.be.reverted;
    await expect(as(f).setFdvBand(lo, hi)).to.emit(f, "FdvBandChanged").withArgs(lo, hi);
    expect(await f.minFdvWei()).to.equal(lo);
    expect(await f.maxFdvWei()).to.equal(hi);
    // and the retune BITES: a valuation that was in band under the seeded band is now out of it
    const tight = ethers.parseEther("2");
    await as(f).setFdvBand(tight, tight * 2n);
    const fdv = await f.quoteFdvWei(DEFAULT_SUPPLY, START_TICK_MAG); // ~1.758 ETH, now below the floor
    await expect(as(f).launchWithSupply(params(), 0, 0))
      .to.be.revertedWithCustomError(f, "MarketCapOutOfRange").withArgs(fdv);
  });

  it("launch() and launchWithSupply(p,0,0) are the same call", async () => {
    // both must fail identically deep inside the mock pool — never at the band, never at BadValue
    for (const call of [as(factory).launch(params()), as(factory).launchWithSupply(params(), 0, 0)]) {
      await expect(call).to.not.be.revertedWithCustomError(factory, "MarketCapOutOfRange");
      await expect(call).to.not.be.revertedWithCustomError(factory, "BadValue");
    }
  });
});
