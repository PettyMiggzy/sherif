// REGRESSION for the auction changes to PresaleVault:
//   (1) minRaise / target split — a raise that does not fill the cap still launches, instead of refunding.
//       Guarded so a PARTIAL raise can only finalize AFTER the deadline: the split must not hand the salt
//       preimage-holder an option to close the raise early on contributors who are still arriving.
//   (2) the platform's 10% is charged on DEPLOYED capital, not on the whole raise. [M-1] already stopped the
//       over-capacity part of a raise being taxed inside the swap, but the platform cut was still taken on
//       totalRaised — so ETH that never reached the curve, and came straight back through the ethBack path,
//       was charged a launch fee anyway.
//   (3) inline graduation — a pooled buy that fills the curve outright graduates in the same transaction,
//       and the graduation keeper bounty the curve pays this vault is booked rather than stranded.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { brandedTokenSalt, predictPadToken } = require("../helpers/brand");

const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;
const PLATFORM_FEE_BPS = 1000n, BPS = 10000n;

describe("[AUCTION regression] partial raises launch, the fee tracks deployed capital, graduation is inline", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  let deployer, platform, creator, a, b, c;
  let pm, dep, reg, factory, presaleFactory, hookF, curveF;
  let factoryAddr, depAddr, pmAddr, regAddr;
  let tagN = 0;

  before(async () => {
    [deployer, platform, creator, a, b, c] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
    const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000,
      buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
      minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n,
    });
    factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(),
      await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
    const impl = await (await ethers.getContractFactory("PresaleVault")).deploy();
    presaleFactory = await (await ethers.getContractFactory("PresaleVaultFactory")).deploy(
      await factory.getAddress(), await impl.getAddress()
    );
    factoryAddr = await factory.getAddress();
    depAddr = await dep.getAddress();
    pmAddr = await pm.getAddress();
    regAddr = await reg.getAddress();
    hookF = await ethers.getContractFactory("RobinFeeHook");
    curveF = await ethers.getContractFactory("RobinCurveV4");
  });

  // deep: a few ETH cannot fill it, so the curve does NOT graduate — isolates the window logic.
  const deepCfg = (tag) => mk(tag, 100000n * 10n ** 18n);
  // shallow: capacity is a fraction of a 3 ETH raise, so the buy fills the curve outright.
  const shallowCfg = (tag) => mk(tag, 2n * 10n ** 17n);
  function mk(tag, n) {
    return {
      name: "Robin " + tag, symbol: tag, decimals: 18,
      supply: n * 2n, curveSupply: n, reserveSupply: n, tickSpacing: TS, startTickMag: 0, creator: creator.address,
    };
  }

  async function prepareSalts(tag, cfg) {
    const tokenSalt = await brandedTokenSalt(depAddr, factoryAddr, cfg, ethers.id("tok-" + tag));
    const curveSalt = ethers.id("curve-" + tag);
    const TokenF = await ethers.getContractFactory("PadToken");
    const predictedToken = predictPadToken(depAddr, factoryAddr, cfg, tokenSalt, TokenF.bytecode);
    const { salt: hookSalt } = mineHookSalt(depAddr, hookInitCode(hookF.bytecode, pmAddr, factoryAddr, regAddr, predictedToken));
    const commitment = ethers.keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [tokenSalt, hookSalt, curveSalt]));
    return { tokenSalt, hookSalt, curveSalt, commitment, predictedToken };
  }

  async function open({ target, minRaise, deep = true, grace = 86400n }) {
    const tag = "AUC" + (tagN++);
    const cfg = deep ? deepCfg(tag) : shallowCfg(tag);
    const salts = await prepareSalts(tag, cfg);
    const deadline = BigInt(await time.latest()) + 2n * 86400n;
    const args = [cfg, salts.commitment, target, minRaise, deadline, target, E("0.01"), grace];
    const vaultAddr = await presaleFactory.createPresale.staticCall(...args);
    await (await presaleFactory.createPresale(...args)).wait();
    return { vault: await ethers.getContractAt("PresaleVault", vaultAddr), salts, deadline, cfg };
  }
  const fin = (v, s) => v.finalize(s.tokenSalt, s.hookSalt, s.curveSalt);

  describe("[PROBE] totalRaised mod 10 == 9 on a deep (under-capacity) partial raise", () => {
    for (const r of [0n, 5n, 8n, 9n]) {
      it(`totalRaised = 1 ETH + ${r} wei`, async () => {
        const { vault, salts, deadline } = await open({ target: E(3), minRaise: E("0.01") });
        await vault.connect(a).deposit({ value: E(1) + r });
        await time.increaseTo(deadline + 1n);
        await fin(vault, salts);
        const R = await vault.totalRaised();
        const S = await vault.pooledEthSpent();
        const F = await vault.platformFee();
        const B = await ethers.provider.getBalance(await vault.getAddress());
        console.log(`      R=${R} S=${S} fee=${F} S+fee=${S + F} bal=${B} R-S-fee=${R - S - F}`);
        let previewOk = true, claimOk = true;
        try { await vault.previewClaim(a.address); } catch (e) { previewOk = false; }
        try { await vault.connect(a).claim.staticCall(); } catch (e) { claimOk = false; console.log("      claim revert:", e.shortMessage || e.message); }
        let wOk = true;
        try { await vault.withdrawPlatformFee.staticCall(); } catch (e) { wOk = false; console.log("      withdrawPlatformFee revert:", e.shortMessage || e.message); }
        console.log(`      previewClaim ok=${previewOk} claim ok=${claimOk} withdrawPlatformFee ok=${wOk}`);
      });
    }
  });
});
