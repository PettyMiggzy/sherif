const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { predictPadToken, brandedTokenSalt } = require("../helpers/brand");

// CurvePadFactoryV4 — factory/pad-type wiring for the "no-pool-forever" pad. Everything below runs LOCALLY
// against a real Uniswap v4 PoolManager (deployable anywhere) + mock PositionManager/Permit2 (the real ones are
// pinned to solc 0.8.17 and only run on a fork — same convention as RobinCurveV4.graduation.test.js), so this
// exercises a REAL factory launch — real mined hook, real PadToken, real CurvePadFactoryV4.launch() — rather
// than RobinCurveV4.noPoolForever.test.js's direct-deploy-with-MockCurveFactory scope.
//
// What this proves that the direct-deploy unit test can't: the creator-facing knob is a plain bool
// (`cfg.noPoolForever`), the ACTUAL bps a launch gets is never creator-supplied — it's read from
// RobinV4FeeConfig.visibilityWithdrawBpsDefault() at launch time, exactly like every other economic parameter
// — and the pad type is off by default, so every pre-existing classic-pad deploy/test is unaffected until an
// owner explicitly opts a RobinV4FeeConfig instance in.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAG_MASK = 0x3fffn, HOOK_FLAGS = 0x28ccn;
const abi = ethers.AbiCoder.defaultAbiCoder();

const START = 6000, GRAD = 3000, SPACING = 60, FEE = 10000, MINGRAD = 1800;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000,
  referralShareBps: 0, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
  lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
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
  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, curveDep, feeCfg, lockVault, factory };
}

function baseCfg(creator, noPoolForever) {
  return {
    name: "Robin NP", symbol: "NP", decimals: 18,
    supply: 2000n * 10n ** 18n, curveSupply: 1000n * 10n ** 18n, reserveSupply: 1000n * 10n ** 18n,
    tickSpacing: SPACING, startTickMag: 0, creator: creator.address,
    noPoolForever, lpFee: 10000,
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
  return { token: ret[0], hook: ret[1], curveAddr: ret[2], poolId: ret[3], tokenSalt, hookSalt, curveSalt };
}

describe("CurvePadFactoryV4 — noPoolForever pad-type wiring", () => {
  let deployer, platform, creator, trader, S;

  beforeEach(async () => {
    [deployer, platform, creator, trader] = await ethers.getSigners();
    S = await deployStack(deployer, platform);
  });

  it("reverts NoPoolForeverDisabled when a creator asks for it but the FeeConfig hasn't opted the pad type in", async () => {
    expect(await S.feeCfg.noPoolForeverEnabled()).to.equal(false); // disabled by default
    const cfg = baseCfg(creator, true);
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("np-disabled"));
    await expect(S.factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(S.factory, "NoPoolForeverDisabled");
  });

  it("a classic launch (noPoolForever=false) is unaffected even once the pad type is enabled", async () => {
    await S.feeCfg.setNoPoolForeverDefaults(true, 4000);
    const cfg = baseCfg(creator, false);
    const { curveAddr } = await launchThroughFactory(S, cfg, "np-classic");
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
    expect(await curve.noPoolForever()).to.equal(false);
    expect(await curve.visibilityWithdrawBps()).to.equal(0n);
  });

  it("stamps the GOVERNED bps onto the curve — the creator only ever supplies the bool, never the bps", async () => {
    await S.feeCfg.setNoPoolForeverDefaults(true, 4000);
    const cfg = baseCfg(creator, true);
    const { curveAddr } = await launchThroughFactory(S, cfg, "np-enabled");
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
    expect(await curve.noPoolForever()).to.equal(true);
    expect(await curve.visibilityWithdrawBps()).to.equal(4000n);

    // retune the governed default — a NEW launch picks up the new bps, this one stays as it was stamped
    await S.feeCfg.setNoPoolForeverDefaults(true, 2500);
    const cfg2 = baseCfg(creator, true);
    const { curveAddr: curveAddr2 } = await launchThroughFactory(S, cfg2, "np-enabled-2");
    const curve2 = await ethers.getContractAt("RobinCurveV4", curveAddr2);
    expect(await curve2.visibilityWithdrawBps()).to.equal(2500n);
    expect(await curve.visibilityWithdrawBps()).to.equal(4000n); // unchanged, immutable per pad
  });

  it("full flow through the real factory: launch as noPoolForever, buy to ceiling, checkpoint — no permanent LP, no LockVault registration", async () => {
    await S.feeCfg.setNoPoolForeverDefaults(true, 4000);
    const cfg = baseCfg(creator, true);
    const { token, hook, curveAddr } = await launchThroughFactory(S, cfg, "np-e2e");
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
    const tok = await ethers.getContractAt("PadToken", token);
    expect(await tok.balanceOf(creator.address)).to.equal(0n); // no premine

    const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: SPACING, hooks: hook };
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await S.pm.getAddress());
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1000") }
    );
    expect(await curve.ready()).to.equal(true);

    const idBefore = await S.posm.nextTokenId();
    await (await curve.graduate()).wait();

    expect(await curve.graduated()).to.equal(true);
    expect(await S.posm.nextTokenId()).to.equal(idBefore); // no permanent LP ever minted
    // LockVault never saw this pad — its one-shot registrar slot only ever pointed at this factory in general,
    // never at THIS curve's tokenId (which never existed); the curve's own accounting is proven independently
    // in RobinCurveV4.noPoolForever.test.js. Here we only need: the real factory path reaches the same branch.
    expect(await curve.stakingEthOwed()).to.be.gt(0n); // the would-be LP ETH folded into the reward pool instead

    // still a live, tradeable market post-checkpoint through the SAME real pool/hook
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await expect(
      sw.connect(trader).swap(
        key, { zeroForOne: false, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x"
      )
    ).to.not.be.reverted;
  });
});
