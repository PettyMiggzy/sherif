const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinCurveV4 — the "no-pool-forever" checkpoint path (noPoolForever=true). Mirrors
// RobinCurveV4.graduation.test.js's setup exactly, but the curve is constructed with
// noPoolForever=true so graduate() takes the branch that withdraws only a bps-slice of the
// curve's own liquidity instead of the whole position, never mints a permanent LP, and never
// registers anything with LockVault. This proves the CURVE-level mechanics locally (real
// PoolManager, no hook attached — same scope as the existing local graduation test, which is
// also hookless). The hook's own permanent-liquidity-lock property (onGraduated is never called,
// so RobinFeeHook.PoolConfig.graduated stays false forever for a noPoolForever pool) needs a real
// mined hook and is a fork-test-level concern, deferred here exactly as the sibling test already
// defers full-graduation hook interaction to the fork suite.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const TOKEN = 0;
const abi = ethers.AbiCoder.defaultAbiCoder();

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("RobinCurveV4 — no-pool-forever checkpoint (real PoolManager, mock posm/permit2)", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n;
  const RESERVE = 1000n * 10n ** 18n;
  const VISIBILITY_WITHDRAW_BPS = 1000; // 10% of curveL withdrawn at checkpoint, 90% stays live forever
  let owner, platform, creator, trader;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ds, floor, curve, key, poolId, curveAddr;

  async function deployCurve(noPoolForever, visibilityWithdrawBps) {
    return (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address,
      noPoolForever, visibilityWithdrawBps
    );
  }

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

    curve = await deployCurve(true, VISIBILITY_WITHDRAW_BPS);
    curveAddr = await curve.getAddress();

    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);

    ds = await (await ethers.getContractFactory("DualStaking")).deploy(tokAddr, ZERO, owner.address, 0, ZERO, ethers.ZeroHash, TOKEN);
    await ds.setRewarder(curveAddr, true);
    await ds.listReward(TOKEN, tokAddr, 7 * 86400);
    await curve.connect(platform).setStaking(await ds.getAddress());

    floor = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
      // [MERGE/H-5] the merged vault REJECTS a zero episodeBaseWei (a zero base parks a healthy pad's very
      // first episode), so this fixture carries the same 1e14 base its sibling curve tests use.
      ZERO, tokAddr, FEE, SPACING, ZERO, GRAD, 10, 10n ** 14n
    );
    await curve.connect(platform).setFloor(await floor.getAddress());
  });

  it("rejects a bad visibilityWithdrawBps at construction (0, or over the hard cap) — fail closed, not at first checkpoint", async () => {
    await expect(deployCurve(true, 0)).to.be.revertedWithCustomError(
      await ethers.getContractFactory("RobinCurveV4"), "BadVisibilityBps"
    );
    await expect(deployCurve(true, 5001)).to.be.revertedWithCustomError(
      await ethers.getContractFactory("RobinCurveV4"), "BadVisibilityBps"
    );
    // a legacy (non-noPoolForever) curve is unaffected by visibilityWithdrawBps entirely, including 0
    await expect(deployCurve(false, 0)).to.not.be.reverted;
  });

  it("buys the curve out to the ceiling", async () => {
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6000") }
    );
    expect(await curve.ready()).to.equal(true);
  });

  it("checkpoints: withdraws only the bps-slice, leaves most of curveL live, never mints an LP or touches LockVault", async () => {
    const curveLBefore = await curve.curveL();
    const idBefore = await posm.nextTokenId();

    const rc = await (await curve.graduate()).wait();

    expect(await curve.graduated()).to.equal(true);

    // no permanent LP was ever minted — the PositionManager's token-id counter never advanced, and LockVault
    // has nothing registered for it (registration requires a real, minted tokenId).
    expect(await posm.nextTokenId()).to.equal(idBefore);
    expect((await lockVault.locks(idBefore)).stakingRecipient).to.equal(ZERO);

    // curveL shrank by roughly the configured bps (exact vs. the fee-realization poke's zero-delta not
    // touching principal) and the remainder is still > 0 — this IS the "stays the permanent market" property.
    const curveLAfter = await curve.curveL();
    expect(curveLAfter).to.be.gt(0n);
    expect(curveLAfter).to.be.lt(curveLBefore);
    const expectedWithdrawn = (curveLBefore * BigInt(VISIBILITY_WITHDRAW_BPS)) / 10000n;
    expect(curveLBefore - curveLAfter).to.equal(expectedWithdrawn);

    const checkpoint = rc.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "NoPoolCheckpoint");
    expect(checkpoint, "NoPoolCheckpoint emitted").to.not.equal(undefined);
    expect(checkpoint.args.liquidityWithdrawn).to.equal(expectedWithdrawn);
    expect(checkpoint.args.liquidityRetained).to.equal(curveLAfter);
    // [MILESTONE] the would-be permanent-LP ETH leg is the creator's half of the milestone payout — the
    // platform's other half is never separately booked (it's swept up by the end-of-graduate() catch-all,
    // checked below via platformEthOwed).
    expect(checkpoint.args.toCreatorEth).to.be.gt(0n);
    const creatorEthOwedAfter = await curve.creatorEthOwed();
    expect(creatorEthOwedAfter).to.be.gte(checkpoint.args.toCreatorEth); // + the separate sell-tax waterfall reward

    // the reward waterfall still ran, proportional to the (much smaller) withdrawn slice — same split logic as
    // the legacy path, just applied to a bps-slice of the raise instead of the whole thing.
    expect(await curve.ambushEthOwed()).to.be.gt(0n);

    // the platform's milestone half landed too — it's never explicitly booked mid-function, only swept in by
    // the end-of-graduate() catch-all, so this is the real proof it wasn't silently lost.
    expect(await curve.platformEthOwed()).to.be.gt(0n);

    // this fixture is hookless (see file header) — the buy-tax buffer that used to independently feed staking
    // only exists when a real fee hook is attached, so with lpEth now going to creator/platform instead of
    // stakingEthOwed, NOTHING funds staking here anymore. Both the book and the staking pool's real balance
    // correctly stay at 0, rather than ds silently receiving money it was never actually owed by a separate path.
    expect(await curve.stakingEthOwed()).to.equal(0n);
    expect(await ethers.provider.getBalance(await ds.getAddress())).to.equal(0n);
  });

  it("the curve is still a live, tradeable market after checkpoint — sellers trade against the RETAINED liquidity", async () => {
    // Sell (token-in, ETH-out) pushes price UP from the ceiling back toward startTick, into the position that
    // was deliberately left in place. If this reverts, the "permanent market" claim is false.
    const tokBefore = await tok.balanceOf(trader.address);
    await tok.connect(owner).transfer(trader.address, 10n * 10n ** 18n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);

    const ethBefore = await ethers.provider.getBalance(trader.address);
    const tx = await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(1n * 10n ** 18n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    await tx.wait();

    // sold 1 token against the retained position and got real ETH back — the curve is genuinely still an AMM,
    // not a drained shell.
    expect(await tok.balanceOf(trader.address)).to.equal(tokBefore + 10n * 10n ** 18n - 1n * 10n ** 18n);
    const slot0 = await stateView.getSlot0(poolId);
    expect(slot0[1]).to.be.gt(GRAD); // spot moved UP off the ceiling, into the retained range
  });

  it("collectFees keeps working after checkpoint — the retained position keeps earning platform fees", async () => {
    const before = await curve.platformEthOwed();
    // one more buy against the (now more expensive, since the last test sold into it) retained position to
    // generate fresh LP fees on it
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("0.1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT + 1n },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("0.1") }
    );
    await expect(curve.collectFees()).to.not.be.reverted;
    expect(await curve.platformEthOwed()).to.be.gt(before);
  });

  it("still cannot be checkpointed twice", async () => {
    await expect(curve.graduate()).to.be.revertedWithCustomError(curve, "AlreadyGraduated");
  });
});

// [NO-POOL audit fix, HISTORICAL] Originally a regression for a real finding from this session's own
// adversarial security-audit pass (see pad-v4/NO-POOL-FOREVER.md): stakingEthOwed was missing from both
// sweepToPlatform()'s `booked` total and graduate()'s step-9 platformEthOwed formula. Back when noPoolForever
// folded the WHOLE would-be-permanent-LP ETH leg into stakingEthOwed, an unwired staking contract at checkpoint
// time meant that large sum could get double-booked: claimed by platformEthOwed AND still claimed by
// stakingEthOwed. The exclusion fix in both formulas (still present, still correct) is what prevented that.
//
// [MILESTONE] That specific large-sum-through-stakingEthOwed scenario is now impossible by construction — lpEth
// no longer routes through stakingEthOwed at all (see the milestone-payout change in graduate()'s noPoolForever
// branch); it splits directly to creatorEthOwed/platformEthOwed, neither of which has a "not wired yet" state to
// get stuck in. This block now tests the property that actually matters post-change: the creator's milestone
// half is booked and claimable independent of whether staking happens to be wired, so the whole class of bug
// this test used to guard against can't recur through this path. The stakingEthOwed exclusion formulas remain
// in place defensively (they still protect the smaller buy-tax-buffer case on a hook-having pad), so this block
// also keeps a basic sanity check that stakingEthOwed stays correctly at 0 here (hookless — nothing else feeds it).
describe("RobinCurveV4 — no-pool-forever checkpoint with staking NOT yet wired", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n;
  const RESERVE = 1000n * 10n ** 18n;
  const VISIBILITY_WITHDRAW_BPS = 4000; // large slice, so the would-be-staking amount is large and any
                                         // mis-booking would be easy to see, not lost in dust/rounding
  let owner, platform, creator, trader;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ds, curve, key, curveAddr;

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
    await pm.initialize(key, await th.sqrt(START));

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address,
      true, VISIBILITY_WITHDRAW_BPS
    );
    curveAddr = await curve.getAddress();

    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);
    // deliberately do NOT call setStaking — this is the whole point of the test

    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6000") }
    );
    expect(await curve.ready()).to.equal(true);
  });

  it("checkpoints with staking unwired: creator's milestone half is still booked, conservation holds", async () => {
    const rc = await (await curve.graduate()).wait();

    // [MILESTONE] the creator's half lands in creatorEthOwed regardless of staking wiring — no "not wired yet"
    // state exists for this path anymore, which is the actual fix: there's nothing large left to double-book.
    const checkpoint = rc.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "NoPoolCheckpoint");
    expect(checkpoint.args.toCreatorEth).to.be.gt(0n);
    const creatorOwed = await curve.creatorEthOwed();
    expect(creatorOwed).to.be.gte(checkpoint.args.toCreatorEth);

    // hookless setup (see file header) — nothing feeds stakingEthOwed here anymore, so it stays exactly 0
    // rather than parking a large unclaimed sum the way the old lpEth-fold-in used to.
    const stakingOwed = await curve.stakingEthOwed();
    expect(stakingOwed).to.equal(0n);

    const platformOwed = await curve.platformEthOwed();
    const ambushOwed = await curve.ambushEthOwed();
    const balance = await ethers.provider.getBalance(curveAddr);

    // conservation: every book together must not exceed what the contract actually holds. The exclusion
    // formulas (graduate() step 9, sweepToPlatform()) still guard this even though stakingOwed is 0 here.
    expect(platformOwed + creatorOwed + ambushOwed + stakingOwed).to.be.lte(balance);
  });

  it("the creator's milestone half is claimable immediately, with no staking dependency at all", async () => {
    const creatorOwedBefore = await curve.creatorEthOwed();
    expect(creatorOwedBefore).to.be.gt(0n);

    // platform claims their share too — proves neither claim path was silently starved by the other, the
    // property the old test used to check via the staking angle.
    await expect(curve.claimPlatform()).to.not.be.reverted;

    const creatorBalBefore = await ethers.provider.getBalance(creator.address);
    const tx = await curve.connect(creator).claimCreator();
    const rc = await tx.wait();
    const gasCost = rc.gasUsed * rc.gasPrice;
    const creatorBalAfter = await ethers.provider.getBalance(creator.address);

    expect(await curve.creatorEthOwed()).to.equal(0n);
    expect(creatorBalAfter - creatorBalBefore + gasCost).to.equal(creatorOwedBefore);
  });
});
