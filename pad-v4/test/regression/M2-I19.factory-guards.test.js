const { ethers } = require("hardhat");
const { expect } = require("chai");
const { brandedTokenSalt } = require("../helpers/brand");

// [M-2] + [I-1(19)] — negative regression tests for the two CurvePadFactoryV4 wiring guards the verify pass found
// were code-correct but UNCOVERED (every existing test wires the SAME position manager + registers the SAME factory,
// so the guards' failing branches never fired — deleting either guard left the suite green). These assert the
// FAILING branch directly, so an accidental future removal of either guard is caught by CI.
//
//   • M-2      launch() reverts NotRegistrar when the LockVault's one registrar slot points elsewhere (mis-wired
//              shared vault → every launch here would collect a raise then brick at graduate() step 5).
//   • I-1(19)  the constructor reverts LockVaultMismatch when the factory's positionManager != the LockVault's
//              (graduation would lock the LP in the vault via curve.PM while LockVault.collectFees calls a PM that
//              never held the token).

const ZERO = ethers.ZeroAddress;
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;

const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000,
  referralShareBps: 0, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
  lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
};

async function base(deployer, platform) {
  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
  const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
  const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
  const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
  const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, DEFAULTS);
  return { pm, stateView, dep, reg, permit2, posm, curveDep, feeCfg };
}

async function deployFactory(B, posmAddr, lockVaultAddr) {
  return (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await B.pm.getAddress(), posmAddr, await B.permit2.getAddress(), await B.stateView.getAddress(),
    await B.dep.getAddress(), await B.curveDep.getAddress(), await B.feeCfg.getAddress(),
    await B.reg.getAddress(), lockVaultAddr
  );
}

describe("[M-2 / I-1(19)] CurvePadFactoryV4 wiring guards — failing branches", () => {
  let deployer, platform, creator, B;
  beforeEach(async () => {
    [deployer, platform, creator] = await ethers.getSigners();
    B = await base(deployer, platform);
  });

  it("[I-1(19)] constructor reverts LockVaultMismatch when the factory PM != the LockVault's PM", async () => {
    // LockVault bound to posm; deploy a DIFFERENT position manager and point the factory at it.
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await B.posm.getAddress(), await B.reg.getAddress());
    const posm2 = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await B.pm.getAddress(), await B.permit2.getAddress());
    expect(await posm2.getAddress()).to.not.equal(await B.posm.getAddress());
    const F = await ethers.getContractFactory("CurvePadFactoryV4");
    await expect(deployFactory(B, await posm2.getAddress(), await lockVault.getAddress()))
      .to.be.revertedWithCustomError(F, "LockVaultMismatch");
  });

  it("[I-1(19)] constructor SUCCEEDS when the PMs match (happy path still works)", async () => {
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await B.posm.getAddress(), await B.reg.getAddress());
    const factory = await deployFactory(B, await B.posm.getAddress(), await lockVault.getAddress());
    expect(await factory.getAddress()).to.properAddress;
  });

  it("[M-2] launch() reverts NotRegistrar when the LockVault's registrar is not this factory", async () => {
    // Build a valid factory (PMs match → ctor passes), but the LockVault's factory slot is left UNSET (address(0)),
    // so lockVault.factory() != this factory → launch must revert at its first line, before any deployment.
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await B.posm.getAddress(), await B.reg.getAddress());
    const factory = await deployFactory(B, await B.posm.getAddress(), await lockVault.getAddress());
    // deliberately DO NOT call lockVault.setFactory(factory)
    const cfg = {
      name: "Robin X", symbol: "X", decimals: 18,
      supply: 10n ** 24n, curveSupply: 7n * 10n ** 23n, reserveSupply: 3n * 10n ** 23n,
      tickSpacing: TS, creator: creator.address,
    };
    // [brand] mine a VALID branded tokenSalt so the only thing left to reject this launch is the M-2 guard —
    // an unmined salt would revert BadTokenSuffix and the test would pass for the wrong reason.
    const tokenSalt = await brandedTokenSalt(
      await B.dep.getAddress(), await factory.getAddress(), cfg, ethers.id("t")
    );
    await expect(factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(factory, "NotRegistrar");
  });

  it("[M-2] launch() reverts NotRegistrar when the vault is wired to a DIFFERENT factory", async () => {
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await B.posm.getAddress(), await B.reg.getAddress());
    const factory = await deployFactory(B, await B.posm.getAddress(), await lockVault.getAddress());
    await lockVault.setFactory(platform.address); // one-shot claimed by a NON-factory address
    const cfg = {
      name: "Robin X", symbol: "X", decimals: 18,
      supply: 10n ** 24n, curveSupply: 7n * 10n ** 23n, reserveSupply: 3n * 10n ** 23n,
      tickSpacing: TS, creator: creator.address,
    };
    // [brand] valid mined salt — see the sibling test: the M-2 guard must be the ONLY reason this reverts.
    const tokenSalt = await brandedTokenSalt(
      await B.dep.getAddress(), await factory.getAddress(), cfg, ethers.id("t")
    );
    await expect(factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(factory, "NotRegistrar");
  });

  it("[L-1] launch() reverts BadGeometry when the geometry's raise floors below MIN_RAISE_WEI", async () => {
    // Production tick geometry (START 201600, WIDTH 23000, ts 100). At this HIGH launch tick a tiny curveSupply makes
    // the [gradTick,startTick] integral truncate below the 1e12 safety floor — the exact "raise → ~0 → EmptyRaise
    // brick" L-1 targets. (~100 tokens ⇒ ~5.5e11 wei < 1e12.) The reserve-margin check passes here (reserve==curve at
    // this width), so the revert is genuinely the L-1 raise floor, reached before any deployment.
    const PROD = { ...DEFAULTS, lpFee: FEE, startTickMag: 201600, curveWidth: 23000, minGradWidth: 22800 };
    const feeCfgProd = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, PROD);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await B.posm.getAddress(), await B.reg.getAddress());
    const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      await B.pm.getAddress(), await B.posm.getAddress(), await B.permit2.getAddress(), await B.stateView.getAddress(),
      await B.dep.getAddress(), await B.curveDep.getAddress(), await feeCfgProd.getAddress(), await B.reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
    const tiny = {
      name: "Robin Dust", symbol: "DUST", decimals: 18,
      supply: 200n * 10n ** 18n, curveSupply: 100n * 10n ** 18n, reserveSupply: 100n * 10n ** 18n,
      tickSpacing: 100, creator: creator.address,
    };
    // [brand] valid mined salt so the revert can only be the L-1 raise floor, never BadTokenSuffix.
    const tokenSalt = await brandedTokenSalt(
      await B.dep.getAddress(), await factory.getAddress(), tiny, ethers.id("t")
    );
    await expect(factory.launch(tiny, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(factory, "BadGeometry");
  });
});
