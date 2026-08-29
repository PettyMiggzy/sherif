const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mineFor } = require("./helpers/brand");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

// [FDV] THE CREATE PAGE'S MATHS, CHECKED AGAINST THE FACTORY.
//
// The pad now lets a creator pick their own token count and their own starting value. Neither is what the
// contract takes: `launchWithSupplyAndSalt` wants a supply and a TICK MAGNITUDE, and it bounds supply x launch
// price against a band. So the site has to convert, and if its conversion disagrees with the factory by even
// one tick step the creator sees one number and gets another — or the launch reverts MarketCapOutOfRange
// after they have already signed.
//
// This imports pad/assets/fdv.mjs — the actual file the site runs, not a transcription of it — and checks it
// against `quoteFdvWei`, against the band, and finally against a real launch that has to land where the site
// said it would.
const START = 201600, WIDTH = 23000, MINGRAD = 22800;
const ONE = 10n ** 18n;

describe("[FDV] the create page's supply/value maths agrees with the factory", function () {
  this.timeout(300000);

  let dep, platform, dev, weth, v3, factory, fdv;

  before(async () => {
    // pad/assets/fdv.mjs is an ES module and this suite is CommonJS — load it the same way the brand suite
    // loads the miner, so the thing under test is the shipped file.
    fdv = await import("../../pad/assets/fdv.mjs");
    [dep, platform, dev] = (await ethers.getSigners()).slice(-3);
    const at = async (n, ...a) => (await ethers.getContractFactory(n)).connect(dep).deploy(...a).then((c) => c.getAddress());
    weth = await at("MockWETH9");
    v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep).deploy().then((c) => c.getAddress());
    const ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    const router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd, ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(await factory.getAddress())).wait();
  });

  it("reproduces the factory's own default launch exactly", async () => {
    // The strongest single check available: the factory's default is a (supply, magnitude) pair chosen by the
    // deploy, so asking the site's maths for that supply at that value must hand back that magnitude.
    const supply = await factory.TOTAL_SUPPLY();
    const defaultFdv = await factory.quoteFdvWei(supply, START);
    expect(fdv.tickMagFor(supply, defaultFdv)).to.equal(START);
  });

  it("round-trips: what the site asks for is what the factory quotes back", async () => {
    // Across four orders of magnitude of supply and a wide spread of values, the magnitude the site computes
    // must quote back to (very nearly) the value the creator typed. Not exactly — the magnitude is forced to a
    // multiple of 200, which is a 2% price step — so the tolerance is that step, and the direction is pinned
    // below.
    const supplies = [10_000n, 1_000_000n, 100_000_000n, 1_000_000_000n].map((n) => n * ONE);
    const values = ["0.1", "0.5", "1.758", "5", "40"].map((v) => ethers.parseEther(v));
    for (const s of supplies) {
      for (const want of values) {
        const mag = fdv.tickMagFor(s, want);
        if (!fdv.magInRange(mag, WIDTH)) continue; // the site refuses these up front; nothing to round-trip
        const got = await factory.quoteFdvWei(s, mag);
        const drift = Number(got) / Number(want);
        expect(drift, `${ethers.formatUnits(s, 18)} tokens @ ${ethers.formatEther(want)} ETH`).to.be.within(1, 1.0202);
      }
    }
  });

  it("rounds a coin DEARER, never cheaper — so a choice at the band floor cannot round out of the band", async () => {
    // This is the reason tickMagFor floors the MAGNITUDE rather than rounding it to nearest. At the bottom of
    // the band, rounding the other way puts the launch under minFdvWei and the contract reverts
    // MarketCapOutOfRange on a value the page had just called acceptable.
    const supply = await factory.TOTAL_SUPPLY();
    const min = await factory.minFdvWei();
    const mag = fdv.tickMagFor(supply, min);
    expect(fdv.magInRange(mag, WIDTH)).to.equal(true);
    const quoted = await factory.quoteFdvWei(supply, mag);
    expect(quoted).to.be.gte(min); // in band...
    expect(quoted).to.be.lt((min * 103n) / 100n); // ...and only just, i.e. it really is the floor
  });

  // [PINNED BAND] Every launch is meant to target the same ~4.2 ETH raise no matter what token count the
  // creator picks. The raise is a fixed multiple of the launch PRICE, and price x supply is the FDV, so
  // pinning every launch to one FDV pins every launch to one raise — supply becomes purely cosmetic.
  //
  // The catch is that the factory only accepts tick magnitudes in steps of 200, about 2.02% of price apart,
  // so no supply can hit an exact FDV. This proves a band that tight is still reachable from any supply
  // anyone would plausibly type, using the site's own rounding, checked against the factory's own quote.
  it("a band pinned to one target is reachable from every supply, so supply stops changing the raise", async () => {
    const TARGET = (await factory.quoteFdvWei(1_000_000_000n * ONE, START)); // today's default launch
    const lo = TARGET * 98n / 100n, hi = TARGET * 103n / 100n;
    // The factory is shared across this file, so put the wide band back before leaving or every later test
    // launches against a band it was not written for.
    const [wasLo, wasHi] = [await factory.minFdvWei(), await factory.maxFdvWei()];
    await (await factory.connect(dep).setFdvBand(lo, hi)).wait();

    const supplies = [1_000n, 10_000n, 100_000n, 1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n,
                      10_000_000_000n, 100_000_000_000n, 1_000_000_000_000n, 3_700_000n, 123_456_789n];
    let worst = 0;
    for (const st of supplies) {
      const supplyWei = st * ONE;
      const mag = fdv.tickMagFor(supplyWei, TARGET);
      expect(fdv.magInRange(mag, WIDTH), `no usable tick for ${st}`).to.equal(true);
      const quoted = await factory.quoteFdvWei(supplyWei, mag);
      // Inside the band means the factory will actually accept this launch.
      expect(quoted, `${st} below band`).to.be.gte(lo);
      expect(quoted, `${st} above band`).to.be.lte(hi);
      const driftBps = Number((quoted - TARGET) * 10_000n / TARGET);
      worst = Math.max(worst, Math.abs(driftBps));
    }
    await (await factory.connect(dep).setFdvBand(wasLo, wasHi)).wait();
    console.log(`   every supply from 1e3 to 1e12 lands within ${(worst / 100).toFixed(2)}% of the same starting value`);
    expect(worst).to.be.lte(300); // 3%, so the raise varies by 3% at most rather than 32x
  });

  it("refuses the combinations the factory would refuse, instead of letting them revert", async () => {
    for (const [supply, value, why] of [
      [1_000n * ONE, ethers.parseEther("5000"), "a token worth more than an ETH each"],
      [0n, ethers.parseEther("1"), "no supply"],
      [1_000_000n * ONE, 0n, "no value"],
    ]) {
      const mag = fdv.tickMagFor(supply, value);
      expect(fdv.magInRange(mag, WIDTH), why).to.equal(false);
    }
  });

  it("a value the site accepts really launches, and the coin opens where it said", async () => {
    // The end of the chain. Everything above compares numbers; this spends gas on them.
    const supplyTokens = 10_000n * ONE; // a deliberately tiny token count — the case that used to be broken
    // The band is pinned to one starting valuation now, so this asks for the pad's target rather than an
    // arbitrary number: the whole point is that ten thousand tokens opens exactly where a billion does.
    const want = await factory.quoteFdvWei(1_000_000_000n * ONE, START);
    const mag = fdv.tickMagFor(supplyTokens, want);
    expect(fdv.magInRange(mag, WIDTH)).to.equal(true);

    const quoted = await factory.quoteFdvWei(supplyTokens, mag);
    expect(quoted).to.be.gte(await factory.minFdvWei()).and.to.be.lte(await factory.maxFdvWei());

    const p = { name: "Robin Tiny", symbol: "TINY", dev: dev.address,
      tax: { buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address } };
    const { salt, addr } = await mineFor(factory, dev.address, p, supplyTokens, "fdv-site-tiny");

    const [token] = await factory.connect(dev).launchWithSupplyAndSalt.staticCall(p, supplyTokens, mag, salt);
    expect(token).to.equal(addr); // the mined address survives the custom supply

    await (await factory.connect(dev).launchWithSupplyAndSalt(p, supplyTokens, mag, salt)).wait();
    const tok = await ethers.getContractAt("LaunchToken", addr);
    expect(await tok.totalSupply()).to.equal(supplyTokens); // the creator's token count, not the default
    expect(addr.toLowerCase().endsWith("1ab5")).to.equal(true);
    console.log(`   10,000 tokens opened at ${ethers.formatEther(quoted)} ETH (asked for ${ethers.formatEther(want)}), CA ${addr}`);
  });
});
