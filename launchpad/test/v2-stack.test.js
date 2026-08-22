const { expect } = require("chai");
const { ethers } = require("hardhat");

// ── THE v2 PAD ────────────────────────────────────────────────────────────────────────────────────────────
//
// v2 is a SECOND factory deployed ALONGSIDE the live one, not a replacement. The live factory keeps serving the
// coin already launched on it; new launches go to v2. Two contracts are new (BondDeployer + CurvePadFactory) and
// everything else in the stack is reused live, which is the whole reason this is cheap — and also the whole
// reason it is risky, because the reused pieces are FROZEN and v2 has to match their expectations exactly.
//
// This file pins the three things that would break silently:
//   1. the Bounty wall band, now a per-Bond immutable, and its validation;
//   2. `BondDeployer.deploy(...)`'s signature, which the already-deployed CurvePool bytecode calls;
//   3. the anti-snipe guard being genuinely, completely OFF — not merely set to small numbers.
//
// The full launch path needs a real Uniswap v3 pool, so it lives in the fork suite.

const ONE = 10n ** 18n;
const NEAR = 9000, FAR = 15600;            // shipped (BondGeometry)
const LEGACY_NEAR = 200, LEGACY_FAR = 6800; // what is live today

describe("[v2] the second pad: deep wall, no guard, frozen interfaces", () => {
  let dep, platform, dev, other;

  before(async () => { [dep, platform, dev, other] = (await ethers.getSigners()).slice(-4); });

  // ── 1. the wall band ──────────────────────────────────────────────────────────────────────────────────────

  it("BondDeployer stamps its own band into every Bond it builds", async () => {
    const bd = await (await ethers.getContractFactory("BondDeployer")).connect(dep).deploy(NEAR, FAR);
    expect(await bd.bountyNear()).to.equal(NEAR);
    expect(await bd.bountyFar()).to.equal(FAR);
    // retuning the wall is a ONE-CONTRACT deploy — this is the property that makes it retunable at all
    const legacy = await (await ethers.getContractFactory("BondDeployer")).connect(dep).deploy(LEGACY_NEAR, LEGACY_FAR);
    expect(await legacy.bountyNear()).to.equal(LEGACY_NEAR);
    expect(await bd.bountyNear()).to.equal(NEAR); // and it does not disturb the first one
  });

  it("the shipped band is DEEP — past the measured profitability crossover, and honestly not a dip-buyer", async () => {
    const geo = await (await ethers.getContractFactory("BondGeometryProbe")).connect(dep).deploy();
    expect(await geo.near()).to.equal(NEAR);
    expect(await geo.far()).to.equal(FAR);
    // the attack sweep put the crossover at ~6000 ticks and saturation at ~12000; ship inside that margin
    expect(Number(await geo.near())).to.be.greaterThan(6000);
    expect(Number(await geo.near())).to.be.lessThan(12000);
    // ...which means the wall engages ~59% down. Anything promising "buys every dip" is now false copy.
    const depth = 1 - Math.pow(1.0001, -NEAR);
    expect(depth).to.be.greaterThan(0.55).and.lessThan(0.62);
    expect(FAR - NEAR).to.equal(LEGACY_FAR - LEGACY_NEAR); // same wall WIDTH, just moved down
  });

  // ── 2. the frozen interface ───────────────────────────────────────────────────────────────────────────────

  it("BondDeployer.deploy's SIGNATURE is unchanged — the live CurvePool bytecode calls it", async () => {
    // The deployed CurvePool is reused by every factory (the pool deployer is shared and stateless) and its
    // bytecode calls bondDeployer.deploy(address,address,address,address,address). If v2 changed that selector,
    // every v2 coin would launch fine and then BRICK at graduation, with the raise already committed. Pin it.
    const f = (await ethers.getContractFactory("BondDeployer")).interface.getFunction("deploy");
    expect(f.format("sighash")).to.equal("deploy(address,address,address,address,address)");
    // hardcoded on purpose: the format check above would still pass if someone changed the arg list AND this
    // test's expectation together, whereas a frozen literal has to be edited deliberately
    expect(ethers.id(f.format("sighash")).slice(0, 10)).to.equal("0x9937a678");
    // and the geometry really did NOT leak into that signature — it is on the deployer, not the call
    expect(f.inputs.length).to.equal(5);
  });

  it("CurvePool still asks for the bondDeployer by address only, so a new one drops straight in", async () => {
    const cp = (await ethers.getContractFactory("CurvePoolDeployer")).interface.getFunction("deploy");
    const bondArg = cp.inputs[5];
    expect(bondArg.name).to.equal("bondDeployer");
    expect(bondArg.type).to.equal("address");
  });

  // ── 3. the guard is OFF, not small ────────────────────────────────────────────────────────────────────────

  const ZERO_GUARD = { deadSecs: 0, phase1Secs: 0, antiSnipeSecs: 0, maxTxBps1: 0, maxWalletBps1: 0, maxTxBps2: 0, maxWalletBps2: 0, cooldownSecs: 0 };

  async function zeroGuardToken() {
    const tok = await (await ethers.getContractFactory("LaunchToken")).connect(dep)
      .deploy("V2", "V2", 1_000_000n * ONE, dep.address, ZERO_GUARD);
    return tok;
  }

  it("a zero GuardConfig turns the guard completely off from the launch block", async () => {
    const tok = await zeroGuardToken();
    // `pool` stands in for the AMM; buys are transfers FROM it, which is the only guarded direction
    await tok.connect(dep).enableTrading(other.address, ethers.ZeroAddress, (await ethers.provider.getBlock("latest")).timestamp);
    expect(await tok.antiSnipeActive(), "no window at all").to.equal(false);
    expect(await tok.maxTxNow()).to.equal(ethers.MaxUint256);
    expect(await tok.maxWalletNow()).to.equal(ethers.MaxUint256);
    expect(await tok.cooldownNow()).to.equal(0);
    expect(await tok.windowEndsAt()).to.equal(await tok.launchTime());
  });

  it("the first buy in the launch block succeeds at ANY size, with no cooldown between buys", async () => {
    const tok = await zeroGuardToken();
    const pool = other; // acts as the AMM
    await tok.connect(dep).transfer(pool.address, 900_000n * ONE);
    await tok.connect(dep).enableTrading(pool.address, ethers.ZeroAddress, (await ethers.provider.getBlock("latest")).timestamp);

    // 50% of supply to one wallet, immediately — under the old guard this was MaxTx AND MaxWallet AND DeadWindow
    await expect(tok.connect(pool).transfer(dev.address, 500_000n * ONE)).to.not.be.reverted;
    // and again straight away, same wallet: no per-wallet cooldown
    await expect(tok.connect(pool).transfer(dev.address, 100_000n * ONE)).to.not.be.reverted;
    expect(await tok.balanceOf(dev.address)).to.equal(600_000n * ONE);
  });

  it("the blocklist is permanently unreachable on a no-guard coin — do not reach for it later", async () => {
    const tok = await zeroGuardToken();
    await tok.connect(dep).enableTrading(other.address, ethers.ZeroAddress, (await ethers.provider.getBlock("latest")).timestamp);
    // seedBlocklist is frozen once the window is past, and the window was never open
    await expect(tok.connect(dep).seedBlocklist([dev.address])).to.be.revertedWithCustomError(tok, "WindowOver");
  });

  it("sells and ordinary transfers were never guarded, and still are not (anti-honeypot)", async () => {
    const tok = await zeroGuardToken();
    const pool = other;
    await tok.connect(dep).enableTrading(pool.address, ethers.ZeroAddress, (await ethers.provider.getBlock("latest")).timestamp);
    await tok.connect(dep).transfer(dev.address, 1000n * ONE);
    await expect(tok.connect(dev).transfer(pool.address, 1000n * ONE)).to.not.be.reverted; // sell
  });

  // ── 4. the factory really ships with it off ───────────────────────────────────────────────────────────────

  it("the v2 factory hardcodes the zero guard — no launch can opt back in", async () => {
    const src = require("fs").readFileSync(__dirname + "/../contracts/CurvePadFactory.sol", "utf8");
    const block = /GuardConfig\(\{([\s\S]*?)\}\)/.exec(src)[1];
    for (const field of ["deadSecs", "phase1Secs", "antiSnipeSecs", "maxTxBps1", "maxWalletBps1", "maxTxBps2", "maxWalletBps2", "cooldownSecs"]) {
      expect(block, field).to.match(new RegExp(`${field}:\\s*0\\b`));
    }
    // and there is no parameter or setter that could reintroduce one
    expect(src).to.not.match(/function setGuard|GuardConfig calldata|GuardConfig memory g_/);
  });

  it("the factory exposes NO blocklist entrypoint — it could only ever revert", async () => {
    // seedBlocklist was an owner pass-through that only worked inside an anti-snipe window. With no window it
    // would revert WindowOver on every call, so it is removed rather than left advertising a dead protection.
    const iface = (await ethers.getContractFactory("CurvePadFactory")).interface;
    expect(iface.fragments.some((f) => f.name === "seedBlocklist")).to.equal(false);
  });

  it("the dev buy is uncapped by supply, by construction", async () => {
    const src = require("fs").readFileSync(__dirname + "/../contracts/CurvePadFactory.sol", "utf8");
    expect(src).to.match(/no supply cap on the dev buy/);
    // the only thing bounding it is the curve ceiling and the ETH sent — no bps-of-supply term anywhere in _devBuy
    const devBuy = /function _devBuy[\s\S]*?\n    }/.exec(src)[0];
    expect(devBuy).to.not.match(/maxWalletBps|maxTxBps|TOTAL_SUPPLY|totalSupply/);
  });
});
