// REGRESSION TEST for M-25 (see AUDITOR-HANDOFF.md). `RobinLockStaking.fundTokenPushed` ignored the `asset` it
// was handed and measured its OWN token balance instead, so a curve wired to another pad's staking sink pushed
// the whole graduation reservoir (~9.7% of supply), got 0 back WITHOUT a revert, and emitted StakingFunded.
// `setStaking` is a one-shot with no rescue path, so the fix guards both ends: the sink now honours its
// parameters, and the setter refuses a sink whose stake asset isn't this pad's token.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const poolIdOf = (k) => ethers.keccak256(
  abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
);

// Hardhat keeps chain state across test FILES, so a suite that moves large balances would otherwise leave
// later files short of ETH. Each describe below snapshots before it deploys and restores when it is done.
describe("M-25 mis-wired staking sink, replayed against the patched contracts", () => {
  // Snapshot the whole file's worth of state, not each test's, so balances this file spends are handed back.
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  let owner, platform, creator;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, other, curve, tokAddr;

  beforeEach(async () => {
    [owner, platform, creator] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    th = await (await ethers.getContractFactory("TickHelper")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());

    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    other = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n); // ANOTHER pad's coin
    tokAddr = await tok.getAddress();
    const key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
    );
  });

  const lockStakingFor = async (t) =>
    (await ethers.getContractFactory("RobinLockStaking")).deploy(await t.getAddress(), 30 * 86400, 30 * 86400);
  const dualStakingFor = async (t) =>
    (await ethers.getContractFactory("DualStaking")).deploy(await t.getAddress(), ZERO, owner.address, 0, ZERO, ethers.ZeroHash, 0);

  it("setStaking REJECTS another pad's RobinLockStaking", async () => {
    const foreign = await lockStakingFor(other);
    await expect(curve.connect(platform).setStaking(await foreign.getAddress()))
      .to.be.revertedWithCustomError(curve, "StakingAssetMismatch");
    expect(await curve.staking()).to.equal(ZERO); // the one-shot was NOT spent
  });

  it("setStaking REJECTS another pad's DualStaking", async () => {
    const foreign = await dualStakingFor(other);
    await expect(curve.connect(platform).setStaking(await foreign.getAddress()))
      .to.be.revertedWithCustomError(curve, "StakingAssetMismatch");
    expect(await curve.staking()).to.equal(ZERO);
  });

  it("setStaking REJECTS a contract that answers neither probe (no silent accept)", async () => {
    // any contract without token()/tokenAsset() — the fee registry will do
    await expect(curve.connect(platform).setStaking(await reg.getAddress()))
      .to.be.revertedWithCustomError(curve, "StakingAssetMismatch");
    expect(await curve.staking()).to.equal(ZERO);
  });

  it("[R3-N2] setStaking REJECTS this pad's own RobinTokenTreasury — the splitter shape, despite passing the asset probe", async () => {
    // The treasury exposes token() == THIS pad's token, so the stake-asset probe alone would accept it — and the
    // graduation reservoir would then run through the 70/30 split, silently burning 30% of the dump. The splitter
    // guard (TO_STAKING_BPS() probe) must catch it.
    const ds = await dualStakingFor(tok); // a real pool, only so the treasury constructor has a staking target
    const treasury = await (await ethers.getContractFactory("RobinTokenTreasury")).deploy(
      tokAddr, await ds.getAddress(), creator.address
    );
    await expect(curve.connect(platform).setStaking(await treasury.getAddress()))
      .to.be.revertedWithCustomError(curve, "StakingAssetMismatch");
    expect(await curve.staking()).to.equal(ZERO); // the one-shot was NOT spent — the pool can still be wired
    await curve.connect(platform).setStaking(await ds.getAddress()); // and the REAL pool still passes
    expect(await curve.staking()).to.equal(await ds.getAddress());
  });

  it("setStaking still ACCEPTS both correctly-wired sinks, and the one-shot stays one-shot", async () => {
    const good = await lockStakingFor(tok);
    await curve.connect(platform).setStaking(await good.getAddress());
    expect(await curve.staking()).to.equal(await good.getAddress());
    await expect(curve.connect(platform).setStaking(await (await dualStakingFor(tok)).getAddress()))
      .to.be.revertedWithCustomError(curve, "AlreadySet");
  });

  it("setStaking accepts a correctly-wired DualStaking (the tokenAsset() probe path)", async () => {
    const good = await dualStakingFor(tok);
    await curve.connect(platform).setStaking(await good.getAddress());
    expect(await curve.staking()).to.equal(await good.getAddress());
  });

  it("fundTokenPushed no longer answers 0-for-success on a foreign asset", async () => {
    const stk = await lockStakingFor(tok);
    // the exact call the curve makes, but naming another pad's coin — used to return 0 and emit success
    await expect(stk.fundTokenPushed(0, await other.getAddress()))
      .to.be.revertedWithCustomError(stk, "BadAsset");
    await expect(stk.fundTokenPushed(1, tokAddr)) // single book: there is no Side.STOCK here
      .to.be.revertedWithCustomError(stk, "BadSide");
    // the honest call still works and still credits the measured push
    await tok.transfer(await stk.getAddress(), 1000n);
    expect(await stk.fundTokenPushed.staticCall(0, tokAddr)).to.equal(1000n);
  });
});
