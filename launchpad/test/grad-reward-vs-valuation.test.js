const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mineFor } = require("./helpers/brand");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

// [B2] WHAT THE CREATOR ACTUALLY GETS AT GRADUATION, once creators pick their own valuation.
//
// `graduate()` pays `min(0.5 WETH, raise/4)` to the creator AND the same number to the platform. Every
// document in this repo says "0.5 ETH at graduation", and CurvePool's own comment used to say the creator
// "always earns their 0.5" — reasoning that graduation is ceiling-only, so the raise is always the ~4.2 ETH
// the calibration targets.
//
// That reasoning held while every launch shared one factory-wide price. `launchWithSupplyAndSalt` broke it:
// the ceiling is a fixed MULTIPLE of the creator's OWN launch price, so a cheaper launch has a cheaper
// ceiling and raises proportionally less. This file does not argue about that — it launches two coins, buys
// both curves out to their ceilings, graduates both, and prints the payouts.
//
// Runs against the REAL @uniswap/v3-core bytecode deployed locally (the repo's mock cannot mint the
// concentrated position CurvePool seeds, and a fork is far too slow).
const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE;
const START = 201600, WIDTH = 23000, MINGRAD = 22800;

// The same supply at a HIGHER tick magnitude is a cheaper token, so a lower FDV. 236000 sits just inside the
// band floor (min = default/32); the point is to measure the cheapest launch the factory will actually accept.
const CHEAP_MAG = 236000;

describe("[B2] the graduation reward tracks the creator's chosen valuation", function () {
  this.timeout(300000);

  let dep, platform, dev, buyer, weth, v3, factory, factoryAddr, probe, wethW;

  const NOTAX = () => ({ buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address });

  before(async () => {
    [dep, platform, dev, buyer] = (await ethers.getSigners()).slice(-4);
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
    factoryAddr = await factory.getAddress();
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(factoryAddr)).wait();

    probe = await (await ethers.getContractFactory("SwapProbe")).connect(dep).deploy();
    wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)",
       "function balanceOf(address) view returns (uint256)"], weth);
    for (const w of [dev, buyer]) {
      await ethers.provider.send("hardhat_setBalance", [w.address, "0x" + (10n ** 24n).toString(16)]);
    }
    await (await wethW.connect(buyer).deposit({ value: 200n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 1n << 250n)).wait();
  });

  /// Launch at `mag`, buy the curve out to its own ceiling, graduate, and report what everyone was paid.
  async function launchAndGraduate(name, symbol, mag, seed) {
    const p = { name, symbol, dev: dev.address, tax: NOTAX() };
    const { salt } = await mineFor(factory, dev.address, p, SUPPLY, seed);
    const rc = await (await factory.connect(dev).launchWithSupplyAndSalt(p, SUPPLY, mag, salt)).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);

    // Buy to the curve's OWN ceiling — never past it, or graduate() refuses (the zone above has no liquidity).
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    const ceiling = await curveC.gradSqrtPriceX96();
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, weth, 60n * ONE, ceiling)).wait();
    expect(await curveC.ready(), `${symbol}: curve should be graduatable at its ceiling`).to.equal(true);

    const devBefore = await wethW.balanceOf(dev.address);
    const platBefore = await wethW.balanceOf(platform.address);
    const grc = await (await curveC.graduate()).wait();
    const gev = grc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");

    return {
      symbol,
      fdvWei: await factory.quoteFdvWei(SUPPLY, mag),
      // Graduated emits the raise AFTER the two rewards are deducted; add them back for the gross.
      netRaise: gev.args.raisedWeth,
      toDev: (await wethW.balanceOf(dev.address)) - devBefore,
      toPlatform: (await wethW.balanceOf(platform.address)) - platBefore,
      token, curve,
    };
  }

  let normal, cheap;

  it("a default-valuation launch pays the advertised 0.5 to BOTH sides", async () => {
    normal = await launchAndGraduate("Robin Normal", "NORM", START, "b2-normal");
    console.log(`   NORM  fdv ${ethers.formatEther(normal.fdvWei)} ETH  ->  creator ${ethers.formatEther(normal.toDev)} / platform ${ethers.formatEther(normal.toPlatform)}`);
    expect(normal.toDev).to.equal(ethers.parseEther("0.5"));
    expect(normal.toPlatform).to.be.gte(ethers.parseEther("0.5")); // platform also sweeps WETH dust
  });

  it("the cheapest launch the band allows pays a FRACTION of it — to both sides equally", async () => {
    cheap = await launchAndGraduate("Robin Cheap", "CHEAP", CHEAP_MAG, "b2-cheap");
    console.log(`   CHEAP fdv ${ethers.formatEther(cheap.fdvWei)} ETH  ->  creator ${ethers.formatEther(cheap.toDev)} / platform ${ethers.formatEther(cheap.toPlatform)}`);

    // In band, and far cheaper than the default — this is a launch the factory accepts today.
    expect(cheap.fdvWei).to.be.gte(await factory.minFdvWei());
    expect(cheap.fdvWei).to.be.lt(normal.fdvWei / 20n);

    // THE FINDING: nowhere near the advertised 0.5.
    expect(cheap.toDev).to.be.lt(ethers.parseEther("0.5"));
    console.log(`   creator gets ${(Number(cheap.toDev) / Number(ethers.parseEther("0.5")) * 100).toFixed(1)}% of the advertised 0.5 ETH`);

    // ...and the cap is what pays it: min(0.5, raise/4). Graduated reports the raise NET of both rewards,
    // so gross = net + 2*reward, and reward == gross/4 exactly when the cap is not binding.
    const gross = cheap.netRaise + 2n * cheap.toDev;
    expect(cheap.toDev).to.equal(gross / 4n);
    console.log(`   CHEAP gross raise ${ethers.formatEther(gross)} ETH (vs the ~4.2 the calibration targets)`);
  });

  it("the platform is NOT insulated — it is paid the same reward as the creator", async () => {
    // Worth pinning, because it is the natural worry: does a small launch shortchange the creator while the
    // house still collects its 0.5? No. Both sides are paid the identical min(0.5, gross/4).
    for (const r of [normal, cheap]) {
      const gross = r.netRaise + 2n * r.toDev;
      const cap = ethers.parseEther("0.5");
      const expected = gross / 4n < cap ? gross / 4n : cap;
      expect(r.toDev, `${r.symbol}: creator reward`).to.equal(expected);
      // The platform receives the SAME reward plus the end-of-graduation WETH dust sweep — leftovers from the
      // LP seed, measured at ~1% of the raise on both launches. It is not a second fee, and it does not make
      // the platform whole on a launch that shortchanges the creator.
      const sweep = r.toPlatform - r.toDev;
      expect(sweep, `${r.symbol}: platform extra is the dust sweep, not a reward`).to.be.lt(gross / 50n);
      console.log(`   ${r.symbol.padEnd(5)} reward ${ethers.formatEther(expected)} each + ${ethers.formatEther(sweep)} dust to platform`);
    }
  });
});
