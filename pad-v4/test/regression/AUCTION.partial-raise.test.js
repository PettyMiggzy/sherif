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

  describe("(1) a partial raise launches, but only once the deadline has passed", () => {
    it("THE CHANGE: under the cap but over the floor, past the deadline, it launches", async () => {
      const { vault, salts, deadline } = await open({ target: E(3), minRaise: E("0.01") });
      await vault.connect(a).deposit({ value: E(1) }); // one third of the cap
      await time.increaseTo(deadline + 1n);
      await expect(fin(vault, salts)).to.emit(vault, "Finalized");
      expect(await vault.state()).to.equal(1); // Launched, not Failed
      await expect(vault.connect(a).claim()).to.emit(vault, "Claimed");
      expect(await vault.totalTokensBought()).to.be.gt(0n);
    });

    it("but NOT before the deadline — the split must not become an early-close option on live contributors", async () => {
      const { vault, salts } = await open({ target: E(3), minRaise: E("0.01") });
      await vault.connect(a).deposit({ value: E(1) });
      await expect(fin(vault, salts)).to.be.revertedWithCustomError(vault, "BeforeDeadline");
      expect(await vault.state()).to.equal(0); // still Open — the revert rolled everything back
    });

    it("a FULL raise still finalizes immediately, exactly as before the split", async () => {
      const { vault, salts } = await open({ target: E(3), minRaise: E("0.01") });
      await vault.connect(a).deposit({ value: E(3) });
      expect(await vault.filledAt()).to.be.gt(0n);
      await expect(fin(vault, salts)).to.emit(vault, "Finalized"); // no time travel needed
    });

    it("below the FLOOR it still fails at the deadline and refunds 100% — the never-trapped path survives", async () => {
      const { vault, deadline } = await open({ target: E(3), minRaise: E(2) });
      await vault.connect(a).deposit({ value: E(1) }); // over the cap's third, under the floor
      await time.increaseTo(deadline + 1n);
      await expect(vault.fail()).to.emit(vault, "Failed").withArgs(1);
      const before = await ethers.provider.getBalance(a.address);
      const rc = await (await vault.connect(a).refund()).wait();
      const back = (await ethers.provider.getBalance(a.address)) - before + rc.gasUsed * rc.gasPrice;
      expect(back).to.equal(E(1)); // the WHOLE deposit, no fee on a failed raise
    });

    it("minRaise == target is bit-identical to the old all-or-nothing contract", async () => {
      const { vault, salts } = await open({ target: E(3), minRaise: E(3) });
      await vault.connect(a).deposit({ value: E(1) });
      await expect(fin(vault, salts)).to.be.revertedWithCustomError(vault, "TargetNotMet");
      await expect(vault.fail()).to.be.revertedWithCustomError(vault, "BeforeDeadline");
    });

    it("a partial raise's grace window is anchored to the DEADLINE — never to filledAt, which never stamps", async () => {
      const grace = 3600n;
      const { vault, salts, deadline } = await open({ target: E(3), minRaise: E("0.01"), grace });
      await vault.connect(a).deposit({ value: E(1) });
      expect(await vault.filledAt()).to.equal(0n); // never filled, so the old anchor would have been 0
      await time.increaseTo(deadline + grace + 2n);
      // the launch option has expired; only the refund hatch is live. Exactly one of the two, as [L-20] requires.
      await expect(fin(vault, salts)).to.be.revertedWithCustomError(vault, "AfterDeadline");
      await expect(vault.fail()).to.emit(vault, "Failed").withArgs(2);
    });
  });

  describe("(2) the platform's cut tracks deployed capital", () => {
    it("an over-capacity raise is NOT charged 10% on ETH that never reached the curve", async () => {
      const TARGET = E(3);
      const { vault, salts } = await open({ target: TARGET, minRaise: E("0.01"), deep: false });
      await vault.connect(a).deposit({ value: TARGET });
      await fin(vault, salts);

      const spent = await vault.pooledEthSpent();
      const fee = await vault.platformFee();
      expect(spent).to.be.lt(TARGET);                       // the defect's precondition: capacity < raise
      expect(fee).to.be.lt((TARGET * PLATFORM_FEE_BPS) / BPS); // strictly less than the old charge
      // and it is 1/9 of what was deployed, i.e. 10% of (deployed + fee) — the slice actually put to work
      expect(fee).to.be.closeTo((spent * PLATFORM_FEE_BPS) / (BPS - PLATFORM_FEE_BPS), 10n ** 12n);
    });

    it("CONSERVATION: every wei the vault holds after the buy is owed to a contributor or the platform", async () => {
      const TARGET = E(3);
      const { vault, salts } = await open({ target: TARGET, minRaise: E("0.01"), deep: false });
      for (const w of [a, b, c]) await vault.connect(w).deposit({ value: TARGET / 3n });
      await fin(vault, salts);

      let owed = await vault.platformFee();
      for (const w of [a, b, c]) owed += (await vault.previewClaim(w.address)).ethBack;
      expect(owed).to.equal(await ethers.provider.getBalance(await vault.getAddress()));

      // and it really pays out — the LAST claimer must not revert for want of a wei
      for (const w of [a, b, c]) await vault.connect(w).claim();
      await vault.withdrawPlatformFee();
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    });
  });

  describe("(3) inline graduation", () => {
    it("a buy that fills the curve graduates in the SAME transaction as finalize", async () => {
      const { vault, salts } = await open({ target: E(3), minRaise: E("0.01"), deep: false });
      await vault.connect(a).deposit({ value: E(3) });
      const rc = await (await fin(vault, salts)).wait();
      const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "Finalized");
      const curve = curveF.attach(ev.args.curve);
      expect(await curve.graduated()).to.equal(true); // no keeper, no second transaction
    });

    it("the graduation bounty the curve pays this vault is BOOKED, not stranded", async () => {
      const { vault, salts } = await open({ target: E(3), minRaise: E("0.01"), deep: false });
      await vault.connect(a).deposit({ value: E(3) });
      await fin(vault, salts);
      // conservation must still hold with the bounty folded in — this is the whole reason it is folded
      const owed = (await vault.platformFee()) + (await vault.previewClaim(a.address)).ethBack;
      expect(owed).to.equal(await ethers.provider.getBalance(await vault.getAddress()));
      await vault.connect(a).claim();
      await vault.withdrawPlatformFee();
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    });

    it("the receive() is NOT a general donation surface — stray ETH still reverts", async () => {
      const { vault } = await open({ target: E(3), minRaise: E("0.01") });
      await expect(a.sendTransaction({ to: await vault.getAddress(), value: E(1) })).to.be.reverted;
    });
  });
});
