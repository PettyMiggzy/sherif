const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { predictPadToken, brandedTokenSalt } = require("../helpers/brand");

// CurvePadFactoryV4 — creator-chosen LP fee (see ICurvePadFactoryV4.LaunchConfig's [LP-FEE] doc comment).
// Every OTHER economic parameter on a launch is governed-only, read from RobinV4FeeConfig and never taken
// from the caller — lpFee is the one deliberate exception, bounded to [0, feeConfig.MAX_LP_FEE()]. This
// proves the creator's literal choice (including 0 — no LP fee at all) genuinely lands on the real Uniswap
// v4 pool, independent of whatever the governed DEFAULT lpFee happens to be, and that 0/max/rejected values
// all behave correctly through a real factory launch (mirrors CurvePadFactoryV4.noPoolForever.test.js's
// real-PoolManager, real-mined-hook scope — not a direct-deploy unit shortcut).

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const DYNAMIC_FEE_FLAG = 0x800000;

const START = 6000, GRAD = 3000, SPACING = 60, GOVERNED_FEE = 10000, MINGRAD = 1800;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000,
  referralShareBps: 0, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
  lpFee: GOVERNED_FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
  minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n,
};

async function deployStack(deployer, platform) {
  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
  const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
  const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
  const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
  const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, DEFAULTS);
  const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
  // [EIP-170] the factory forwards hook deploys to FeeHookDeployer instead of inlining the creationCode.
  const fhd = await (await ethers.getContractFactory("FeeHookDeployer")).deploy(await dep.getAddress());
  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress(),
    ethers.ZeroAddress, await fhd.getAddress()
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, curveDep, feeCfg, lockVault, factory };
}

function baseCfg(creator, lpFee) {
  return {
    name: "Robin LPF", symbol: "LPF", decimals: 18,
    supply: 2000n * 10n ** 18n, curveSupply: 1000n * 10n ** 18n, reserveSupply: 1000n * 10n ** 18n,
    tickSpacing: SPACING, startTickMag: 0, creator: creator.address,
    noPoolForever: false, lpFee, auctionDays: 0,
  };
}

async function launchThroughFactory(S, cfg, tag) {
  const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id(tag));
  const TokenF = await ethers.getContractFactory("PadToken");
  const predictedToken = predictPadToken(await S.dep.getAddress(), await S.factory.getAddress(), cfg, tokenSalt, TokenF.bytecode);
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    await S.dep.getAddress(),
    hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predictedToken)
  );
  const curveSalt = ethers.id(tag + "-curve");
  const ret = await S.factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  await (await S.factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  return { token: ret[0], hook: ret[1], curveAddr: ret[2], poolId: ret[3] };
}

describe("CurvePadFactoryV4 — creator-chosen LP fee", () => {
  let deployer, platform, creator, trader, S;

  beforeEach(async () => {
    [deployer, platform, creator, trader] = await ethers.getSigners();
    S = await deployStack(deployer, platform);
  });

  it("rejects an lpFee above the governed MAX_LP_FEE ceiling", async () => {
    const max = await S.feeCfg.MAX_LP_FEE();
    const cfg = baseCfg(creator, max + 1n);
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("lpf-over"));
    await expect(S.factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(S.factory, "BadConfig");
  });

  it("rejects an lpFee carrying the Uniswap dynamic-fee flag", async () => {
    const cfg = baseCfg(creator, BigInt(DYNAMIC_FEE_FLAG));
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("lpf-dynamic"));
    await expect(S.factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(S.factory, "BadConfig");
  });

  it("accepts lpFee at exactly the governed MAX_LP_FEE ceiling (boundary, not off-by-one)", async () => {
    const max = await S.feeCfg.MAX_LP_FEE();
    const cfg = baseCfg(creator, max);
    const { poolId } = await launchThroughFactory(S, cfg, "lpf-atmax");
    expect(poolId).to.not.equal(ethers.ZeroHash);
  });

  it("lpFee: 0 — a genuinely fee-free pool, independent of the governed default (which is 1%)", async () => {
    expect(DEFAULTS.lpFee).to.equal(GOVERNED_FEE); // sanity: the governed default is NOT zero
    const cfg = baseCfg(creator, 0n);
    const { token, hook, curveAddr, poolId } = await launchThroughFactory(S, cfg, "lpf-zero");

    // the curve's own immutable `fee` must match what was ACTUALLY used to init the pool — RobinCurveV4
    // rebuilds the same PoolKey internally, so a mismatch here would mean it's reconstructing a DIFFERENT
    // pool than the one the factory initialized (silently breaking every future curve action).
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
    expect(await curve.fee()).to.equal(0n);

    // real swap against the real 0-fee pool
    const key = { currency0: ZERO, currency1: token, fee: 0, tickSpacing: SPACING, hooks: hook };
    const computedId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint24,int24,address)"],
        [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
      )
    );
    expect(computedId).to.equal(poolId); // confirms fee:0 IS the key that was actually initialized
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await S.pm.getAddress());
    await expect(
      sw.connect(trader).swap(
        key, { zeroForOne: true, amountSpecified: -ethers.parseEther("10"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("10") }
      )
    ).to.not.be.reverted;
  });

  it("two coins from the SAME factory can carry different lpFees — it's per-launch, not global", async () => {
    const cfgA = baseCfg(creator, 0n);
    const { curveAddr: curveA } = await launchThroughFactory(S, cfgA, "lpf-multi-a");
    const cfgB = baseCfg(creator, 5000n); // 0.5%
    const { curveAddr: curveB } = await launchThroughFactory(S, cfgB, "lpf-multi-b");

    const cA = await ethers.getContractAt("RobinCurveV4", curveA);
    const cB = await ethers.getContractAt("RobinCurveV4", curveB);
    expect(await cA.fee()).to.equal(0n);
    expect(await cB.fee()).to.equal(5000n);

    // the governed default in feeConfig is untouched by either choice — confirms lpFee truly bypasses it
    // rather than temporarily overwriting it
    expect((await S.feeCfg.defaults()).lpFee).to.equal(BigInt(GOVERNED_FEE));
  });

  it("a 0-fee coin sells out and graduates normally — the LP fee choice doesn't break the curve lifecycle", async () => {
    const cfg = baseCfg(creator, 0n);
    const { token, hook, curveAddr } = await launchThroughFactory(S, cfg, "lpf-zero-grad");
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
    const key = { currency0: ZERO, currency1: token, fee: 0, tickSpacing: SPACING, hooks: hook };
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await S.pm.getAddress());
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1000") }
    );
    expect(await curve.ready()).to.equal(true);
    await expect(curve.connect(trader).graduate()).to.not.be.reverted;
    expect(await curve.graduated()).to.equal(true);
  });
});
