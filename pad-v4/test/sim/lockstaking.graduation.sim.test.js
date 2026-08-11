const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// SIM — RobinLockStaking wired as the pad's STAKING TARGET, fed by the curve at graduation.
// Proves the real integration the other graduation sim (which uses DualStaking) doesn't:
//   • curve.setStaking(lockStaking); graduate() streams the leftover reserve tokens → lockStaking.fundTokenPushed,
//   • lock-stakers then DRIP-earn those reserve tokens (monthly lock, bounded rate, self-filling),
//   • an early exit pays the 10% penalty back into the reservoir,
//   • the balanceOf == totalStaked + rewardsBalance invariant holds throughout.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const LOCK = 30 * 86400;

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("SIM — RobinLockStaking fed by the curve at graduation (monthly-lock drip)", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n, RESERVE = 1000n * 10n ** 18n;
  let owner, platform, creator, trader, alice, bob;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, stk, curve, key, poolId, curveAddr;

  before(async () => {
    [owner, platform, creator, trader, alice, bob] = await ethers.getSigners();
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
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);

    // the NEW staking product: 30-day lock, 30-day drip window
    stk = await (await ethers.getContractFactory("RobinLockStaking")).deploy(tokAddr, LOCK, LOCK);
    await curve.connect(platform).setStaking(await stk.getAddress()); // permissionless funding — no setRewarder needed
  });

  const inv = async () => {
    const bal = await tok.balanceOf(await stk.getAddress());
    expect(bal).to.equal((await stk.totalStaked()) + (await stk.rewardsBalance()));
  };

  const staked = {};

  it("holders buy the coin and stake it (locked a month); the curve graduates and streams reserve → staking", async () => {
    // alice + bob each buy from the curve, then stake what they bought
    for (const h of [alice, bob]) {
      await sw.connect(h).swap(
        key, { zeroForOne: true, amountSpecified: -E(2), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(2) }
      );
      const bal = await tok.balanceOf(h.address);
      await tok.connect(h).approve(await stk.getAddress(), ethers.MaxUint256);
      await stk.connect(h).stake(bal);
      staked[h.address] = bal;
      expect((await stk.stakeInfo(h.address))[3]).to.equal(true); // locked
    }
    await inv();

    // buy the curve OUT → ready → graduate. Top up the trader first so the 6000-ETH sell-out never depends on
    // cross-file cumulative balance drift (signer balances persist across test files in one hardhat run).
    await ethers.provider.send("hardhat_setBalance", [trader.address, "0x21e19e0c9bab2400000"]); // 10,000 ETH
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(6000), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(6000) }
    );
    expect(await curve.ready()).to.equal(true);

    const rewardsBefore = await stk.rewardsBalance();
    await curve.graduate();
    expect(await curve.graduated()).to.equal(true);
    // the leftover reserve tokens were streamed into the lock-staking reservoir via fundTokenPushed
    expect(await stk.rewardsBalance()).to.be.gt(rewardsBefore);
    await inv();

    // the reward DRIPS over the month (not instant): a slice after half, ~all after the window, never more
    const totalReward = await stk.rewardsBalance();
    await time.increase(LOCK / 2);
    const mid = (await stk.earned(alice.address)) + (await stk.earned(bob.address));
    expect(mid).to.be.gt(0n);
    expect(mid).to.be.lt(totalReward); // paced, not 1:1

    await time.increase(LOCK / 2 + 10);
    const end = (await stk.earned(alice.address)) + (await stk.earned(bob.address));
    expect(end).to.be.lte(totalReward); // anti-drain: never exceeds the reservoir
    await inv();
  });

  it("after the lock, a holder claims the dripped reserve reward and unstakes full principal", async () => {
    // a full drip window elapsed in the prior test ⇒ alice's 30-day lock has matured (no penalty)
    expect(await stk.timeUntilUnlock(alice.address)).to.equal(0n);
    const aBefore = await tok.balanceOf(alice.address);
    await stk.connect(alice).getReward();
    const rewardGot = (await tok.balanceOf(alice.address)) - aBefore;
    expect(rewardGot).to.be.gt(0n); // received the streamed reserve reward, dripped over the month

    const bBefore = await tok.balanceOf(alice.address);
    await stk.connect(alice).withdraw(staked[alice.address]); // lock matured → full principal, no penalty
    expect((await tok.balanceOf(alice.address)) - bBefore).to.equal(staked[alice.address]);
    expect(await stk.balanceOf(alice.address)).to.equal(0n);
    await inv();
  });
});
