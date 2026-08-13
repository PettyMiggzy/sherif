const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// RobinLockStaking — monthly-lock, drip-rewarded, self-filling holder staking.
// Proves: locks hold for a month; rewards DRIP from a finite reservoir (not 1:1, can't be drained); the 10%
// early-exit penalty recycles into the reservoir; the accounting invariant balanceOf == totalStaked + rewardsBalance
// holds across every op; parked rewards start dripping only once a staker arrives.

const E = (x) => ethers.parseEther(String(x));
const LOCK = 30 * 86400;
const DUR = 30 * 86400;

describe("RobinLockStaking", () => {
  let owner, alice, bob, carol, tok, st;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(E(10_000_000));
    st = await (await ethers.getContractFactory("RobinLockStaking")).deploy(await tok.getAddress(), LOCK, DUR);
    // fund the players
    for (const u of [alice, bob, carol]) await tok.connect(owner).transfer(u.address, E(100_000));
    for (const u of [owner, alice, bob, carol]) await tok.connect(u).approve(await st.getAddress(), ethers.MaxUint256);
  });

  const inv = async () => {
    const bal = await tok.balanceOf(await st.getAddress());
    expect(bal).to.equal((await st.totalStaked()) + (await st.rewardsBalance())); // balance == staked + rewards
  };

  it("rejects an out-of-bounds lock/drip duration", async () => {
    const F = await ethers.getContractFactory("RobinLockStaking");
    await expect(F.deploy(await tok.getAddress(), 86400, DUR)).to.be.revertedWithCustomError(st, "BadDuration"); // < 7d
    await expect(F.deploy(await tok.getAddress(), 200 * 86400, DUR)).to.be.revertedWithCustomError(st, "BadDuration"); // > 90d
  });

  it("locks the position for a month; stakeInfo reflects the lock", async () => {
    await st.connect(alice).stake(E(100));
    const [staked, , unlockAt, locked] = await st.stakeInfo(alice.address);
    expect(staked).to.equal(E(100));
    expect(locked).to.equal(true);
    const now = BigInt(await time.latest());
    expect(unlockAt).to.be.closeTo(now + BigInt(LOCK), 5n);
    expect(await st.timeUntilUnlock(alice.address)).to.be.gt(0n);
    await inv();
  });

  it("drips rewards over the window — NOT 1:1, and never more than was funded", async () => {
    await st.connect(alice).stake(E(100));
    await st.fund(E(1000)); // 1000 tokens dripped over 30 days
    expect(await st.earned(alice.address)).to.equal(0n);

    await time.increase(DUR / 2);
    const mid = await st.earned(alice.address);
    expect(mid).to.be.closeTo(E(500), E(2)); // half the drip after half the window (paced, not instant)

    await time.increase(DUR / 2 + 10);
    const end = await st.earned(alice.address);
    expect(end).to.be.closeTo(E(1000), E(2)); // full drip after the window
    expect(end).to.be.lte(E(1000)); // NEVER pays out more than was funded — the pool can't be over-drained
    await inv();
  });

  it("splits the drip proportionally to stake (not equally, not 1:1)", async () => {
    await st.connect(alice).stake(E(100));
    await st.connect(bob).stake(E(300));
    await st.fund(E(4000));
    await time.increase(DUR + 10);
    const a = await st.earned(alice.address);
    const b = await st.earned(bob.address);
    expect(a).to.be.closeTo(E(1000), E(5)); // 1/4 of the pool
    expect(b).to.be.closeTo(E(3000), E(10)); // 3/4 of the pool
    await inv();
  });

  it("parks rewards funded while nobody is staked, then drips them once a staker arrives", async () => {
    await st.fund(E(600)); // no stakers yet
    let [, , rate, , parked] = await st.poolInfo();
    expect(rate).to.equal(0n);
    expect(parked).to.equal(E(600)); // parked, not dripping (not wasted)

    await st.connect(alice).stake(E(100)); // first staker flushes the parked reward into a fresh drip
    [, , rate, , parked] = await st.poolInfo();
    // [C-1] the flush now CARRIES the integer-division remainder instead of stranding it (I-1(5)). That residue
    // is `amount mod rewardsDuration`, so it is strictly below rewardsDuration wei — dust against a 600e18
    // tranche, and it is credited to the next tranche rather than lost. This assertion used to be `equal(0)`,
    // which encoded the stranding as intended behaviour.
    expect(parked).to.be.lt(DUR);
    expect(rate).to.be.gt(0n);
    await time.increase(DUR + 10);
    expect(await st.earned(alice.address)).to.be.closeTo(E(600), E(2));
    await inv();
  });

  it("early withdraw takes a 10% penalty that recycles into the reward pool (self-filling)", async () => {
    await st.connect(alice).stake(E(1000));
    const before = await tok.balanceOf(alice.address);
    await st.connect(alice).withdraw(E(1000)); // still locked → 10% penalty
    const got = (await tok.balanceOf(alice.address)) - before;
    expect(got).to.equal(E(900)); // received 90%
    // the 10% penalty stayed in the contract as reward (parked, since the pool is now empty)
    expect(await st.rewardsBalance()).to.equal(E(100));
    const [, , , , parked] = await st.poolInfo();
    expect(parked).to.equal(E(100)); // recycled into the reservoir
    await inv();
  });

  it("no penalty after the lock matures", async () => {
    await st.connect(alice).stake(E(1000));
    await time.increase(LOCK + 10);
    const before = await tok.balanceOf(alice.address);
    await st.connect(alice).withdraw(E(1000));
    expect((await tok.balanceOf(alice.address)) - before).to.equal(E(1000)); // full principal, no penalty
    await inv();
  });

  it("getReward claims accrued rewards without touching principal; exit does both", async () => {
    await st.connect(alice).stake(E(100));
    await st.fund(E(1000));
    await time.increase(LOCK + 10); // past lock AND past the drip window
    const bemid = await tok.balanceOf(alice.address);
    await st.connect(alice).getReward();
    const rewardOnly = (await tok.balanceOf(alice.address)) - bemid;
    expect(rewardOnly).to.be.closeTo(E(1000), E(2));
    expect(await st.balanceOf(alice.address)).to.equal(E(100)); // principal untouched

    await st.connect(alice).exit(); // withdraw all + claim remainder
    expect(await st.balanceOf(alice.address)).to.equal(0n);
    await inv();
  });

  it("fundTokenPushed credits tokens PUSHED to the contract (curve integration)", async () => {
    await st.connect(alice).stake(E(100));
    // simulate the curve streaming reserve tokens: transfer in, then poke
    await tok.connect(owner).transfer(await st.getAddress(), E(500));
    const pushed = await st.fundTokenPushed.staticCall(0, await tok.getAddress());
    expect(pushed).to.equal(E(500));
    await st.fundTokenPushed(0, await tok.getAddress());
    expect(await st.rewardsBalance()).to.equal(E(500));
    await time.increase(DUR + 10);
    expect(await st.earned(alice.address)).to.be.closeTo(E(500), E(2));
    await inv();
    // a push of nothing is a harmless no-op
    expect(await st.fundTokenPushed.staticCall(0, await tok.getAddress())).to.equal(0n);
  });

  it("total earned across all stakers never exceeds what was funded (anti-drain guarantee)", async () => {
    await st.connect(alice).stake(E(50));
    await st.connect(bob).stake(E(50));
    await st.fund(E(1000));
    await time.increase(DUR * 2); // long after the window closes
    const total = (await st.earned(alice.address)) + (await st.earned(bob.address));
    expect(total).to.be.lte(E(1000)); // cannot drain beyond the reservoir
    expect(total).to.be.closeTo(E(1000), E(3));
    await inv();
  });

  // [audit pass #3] empty-pool leak: if the pool empties MID-DRIP (last staker exits penalty-free), the drip must
  // PAUSE and bank its remainder — otherwise the rewards scheduled for the empty window are stranded forever.
  it("banks the remaining drip when the pool empties mid-window (nothing stranded)", async () => {
    const SHORT = 7 * 86400; // lock < the 30d drip, so alice can exit penalty-free while the drip is still live
    const s2 = await (await ethers.getContractFactory("RobinLockStaking")).deploy(await tok.getAddress(), SHORT, DUR);
    for (const u of [owner, alice, bob]) await tok.connect(u).approve(await s2.getAddress(), ethers.MaxUint256);
    const bal = async () => expect(await tok.balanceOf(await s2.getAddress())).to.equal((await s2.totalStaked()) + (await s2.rewardsBalance()));

    await s2.connect(alice).stake(E(100));
    await s2.connect(owner).fund(E(1000)); // drip 1000 over 30d
    await time.increase(8 * 86400);        // day 8: past alice's 7d lock, drip still live (22d remain)

    const a0 = await tok.balanceOf(alice.address);
    await s2.connect(alice).getReward();
    const aliceReward = (await tok.balanceOf(alice.address)) - a0;
    await s2.connect(alice).withdraw(E(100)); // penalty-free exit empties the pool

    expect(await s2.totalStaked()).to.equal(0n);
    expect(await s2.rewardRate()).to.equal(0n);       // the drip PAUSED (not left running over an empty pool)
    expect(await s2.pendingRewards()).to.be.gt(E(600)); // ~22/30 of 1000 banked, not stranded
    await bal();

    await time.increase(10 * 86400); // pool sits EMPTY for 10 days — this window would leak ~E(333) without the fix

    await s2.connect(bob).stake(E(100)); // restarts the drip from pendingRewards
    expect(await s2.rewardRate()).to.be.gt(0n);
    await time.increase(DUR + 100);
    const b0 = await tok.balanceOf(bob.address);
    await s2.connect(bob).getReward();
    const bobReward = (await tok.balanceOf(bob.address)) - b0;

    // NOTHING stranded: alice + bob together received ~the whole E(1000), and the reservoir drained to dust
    expect(aliceReward + bobReward).to.be.closeTo(E(1000), E(3));
    expect(await s2.rewardsBalance()).to.be.closeTo(0n, E(3));
    await bal();
  });

  it("[audit] a dust fund during an active drip can't push periodFinish out (anti-grief)", async () => {
    await st.connect(alice).stake(E(1000));
    await st.connect(owner).fund(E(1000)); // start a 30-day drip
    const finishAfterStart = await st.periodFinish();
    await time.increase(2 * 86400); // 2 days into the window

    // a griefer dust-funds 1 wei repeatedly — this used to reset periodFinish to now+30d and re-stretch the reservoir
    for (let i = 0; i < 5; i++) await st.connect(bob).fund(1n);
    expect(await st.periodFinish()).to.equal(finishAfterStart); // window NOT extended — grief neutralised

    // the drip still finishes on the ORIGINAL schedule and alice can claim ~the whole reservoir
    await time.increase(DUR); // past the original periodFinish
    const a0 = await tok.balanceOf(alice.address);
    await st.connect(alice).getReward();
    expect((await tok.balanceOf(alice.address)) - a0).to.be.closeTo(E(1000), E(3)); // full reservoir dripped on time
  });
});
