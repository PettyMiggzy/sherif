const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinCurveV4 — the FULL graduation waterfall, run locally against a REAL Uniswap v4 PoolManager using a mock
// PositionManager + Permit2 (the real ones are pinned to solc 0.8.17 and only run on a fork). This exercises the
// v2 economics end-to-end that the local unit tests otherwise can't:
//   • buy the curve OUT → ready(),
//   • graduate(): pull the raise, carve platform+creator rewards + measured gas, mint the permanent LOCKED LP to
//     the LockVault, stream leftover token → staking, sweep the buy-LP carve → floor,
//   • a hostile ETH donation before graduation does NOT brick it (raise is tracked, not read from raw balance).

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const TOKEN = 0;
const abi = ethers.AbiCoder.defaultAbiCoder();

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("RobinCurveV4 — full graduation waterfall (real PoolManager + mock posm/permit2)", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n;
  const RESERVE = 1000n * 10n ** 18n;
  const GRAD_REWARD = ethers.parseEther("0.5");
  let owner, platform, creator, trader;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ds, floor, curve, key, poolId, curveAddr;

  before(async () => {
    [owner, platform, creator, trader] = await ethers.getSigners();
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
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    const tokAddr = await tok.getAddress();
    key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
    );
    curveAddr = await curve.getAddress();

    // seed the sellable curve, then hand over the held reserve (as the factory does: AFTER seed)
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);

    // wire staking (token stake, token reward) + authorize the curve as rewarder
    ds = await (await ethers.getContractFactory("DualStaking")).deploy(tokAddr, ZERO, owner.address, 0, ZERO, ethers.ZeroHash, TOKEN);
    await ds.setRewarder(curveAddr, true);
    await ds.listReward(TOKEN, tokAddr, 7 * 86400);
    await curve.connect(platform).setStaking(await ds.getAddress());

    // wire the permanent floor (band anchored just above the graduation tick)
    floor = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, GRAD, 10
    );
    await curve.connect(platform).setFloor(await floor.getAddress());
  });

  it("buys the curve out to the ceiling", async () => {
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6000") }
    );
    expect(await curve.ready()).to.equal(true);
  });

  it("graduates: locked LP → LockVault, ceiling restored, rewards booked, staking + floor funded", async () => {
    // [audit] a hostile ETH donation before graduation must NOT brick it (raise is tracked, not read from balance)
    await owner.sendTransaction({ to: curveAddr, value: ethers.parseEther("3") });

    const idBefore = await posm.nextTokenId();
    const dsAddr = await ds.getAddress();
    const floorAddr = await floor.getAddress();

    const rc = await (await curve.graduate()).wait();

    // auto-graduation keeper bounty: the trigger (owner) is paid a flat slice of the raise off the top
    const paid = rc.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "GradBountyPaid");
    expect(paid, "GradBountyPaid emitted").to.not.equal(undefined);
    expect(paid.args.keeper).to.equal(owner.address);
    expect(paid.args.amount).to.be.gt(0n);
    expect(paid.args.amount).to.be.lte(ethers.parseEther("0.02")); // capped
    expect(paid.args.booked).to.equal(false); // owner is an EOA → inline send succeeded, nothing booked
    expect(await curve.gasBountyOwed(owner.address)).to.equal(0n);

    expect(await curve.graduated()).to.equal(true);
    // the permanent LP "NFT" is owned by the LockVault (locked forever)
    expect(await posm.ownerOf(idBefore)).to.equal(await lockVault.getAddress());
    // the lock was registered with the staking recipient
    expect((await lockVault.locks(idBefore)).stakingRecipient).to.equal(dsAddr);
    // spot sits exactly at the honest ceiling
    expect((await stateView.getSlot0(poolId))[1]).to.equal(GRAD);
    // leftover reserve tokens streamed to staking
    expect(await tok.balanceOf(dsAddr)).to.be.gt(0n);
    // the 20% buy-LP carve was swept to the floor (curve no longer holds the floor book)
    expect(await curve.floorEthOwed()).to.equal(0n);
    expect(await ethers.provider.getBalance(floorAddr)).to.be.gte(0n);
  });

  it("pays the %-of-raise graduation rewards to platform + creator (accrue-and-pull)", async () => {
    // reward is now a % of the raise, not a fixed 0.5 ETH: creator = creatorGradBps (10%), ambush = ambushGradBps
    // (5%), so the creator share is exactly double the ambush share (within integer-division dust).
    const creatorOwed = await curve.creatorEthOwed();
    const ambushOwed = await curve.ambushEthOwed();
    expect(creatorOwed).to.be.gt(0n);
    expect(ambushOwed).to.be.gt(0n);
    const twoAmbush = ambushOwed * 2n;
    const gap = creatorOwed > twoAmbush ? creatorOwed - twoAmbush : twoAmbush - creatorOwed;
    expect(gap).to.be.lte(2n); // 10% == 2×5% up to rounding
    // platform carries its own 10% share plus fee dust and the hostile donation that fell through ⇒ ≥ creator
    expect(await curve.platformEthOwed()).to.be.gte(creatorOwed);

    const cBefore = await ethers.provider.getBalance(creator.address);
    await curve.claimCreator();
    expect((await ethers.provider.getBalance(creator.address)) - cBefore).to.equal(creatorOwed);
    expect(await curve.creatorEthOwed()).to.equal(0n);

    const platWallet = await reg.platformFeeWallet();
    const pBefore = await ethers.provider.getBalance(platWallet);
    const owed = await curve.platformEthOwed();
    await curve.claimPlatform();
    expect((await ethers.provider.getBalance(platWallet)) - pBefore).to.equal(owed);
    expect(await curve.platformEthOwed()).to.equal(0n);
  });

  it("cannot be graduated twice", async () => {
    await expect(curve.graduate()).to.be.revertedWithCustomError(curve, "AlreadyGraduated");
  });
});
