const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// [TIER] Locked-tier staking: longer term = bigger share, early exit costs 15% + all pending, and holding
// 10M staked $ROBIN boosts every pool.
//
// The properties worth testing here are not "does staking work" — they are the ones where getting it wrong
// loses somebody's money quietly:
//   • an early exit must ALWAYS be possible (a lock is a price, not a cage)
//   • the tax AND the forfeited rewards must both reach the stayers — not vanish into the contract
//   • a leaver must not receive a share of their own tax
//   • the boost must not be claimable by borrowing $ROBIN for one block
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const TIER = { FLEX: 0, D7: 1, D30: 2, D60: 3, D90: 4, D180: 5, D365: 6 };

describe("[TIER] locked-tier staking", function () {
  this.timeout(120000);

  let owner, alice, bob, carol, robin, pool;

  async function fixture() {
    [owner, alice, bob, carol] = (await ethers.getSigners()).slice(-4);
    robin = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000_000));
    pool = await (await ethers.getContractFactory("RobinTierStaking"))
      .connect(owner).deploy(await robin.getAddress(), owner.address, ethers.ZeroAddress);
    // The flagship pool is its OWN boost source: staked $ROBIN is what qualifies you. It cannot be set in the
    // constructor because the address does not exist yet, which is why the parameter accepts zero.
    await (await pool.connect(owner).setBoost(await pool.getAddress(), E(10_000_000), 2500)).wait();
    for (const w of [alice, bob, carol]) {
      await (await robin.connect(owner).transfer(w.address, E(50_000_000))).wait();
      await (await robin.connect(w).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await robin.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  }

  beforeEach(fixture);

  it("a longer term earns a bigger share of the same reward", async () => {
    // Same money, different terms. The only thing that can make the payouts differ is the multiplier.
    await (await pool.connect(alice).stake(E(1000), TIER.FLEX)).wait();   // 1.00x
    await (await pool.connect(bob).stake(E(1000), TIER.D365)).wait();     // 5.00x

    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(600))).wait();
    await time.increase(30 * DAY); // let the whole 7-day stream finish

    const a = await pool.earned(alice.address, await robin.getAddress());
    const b = await pool.earned(bob.address, await robin.getAddress());
    expect(b).to.be.gt(a);
    // 1x vs 5x on equal principal ⇒ bob takes five sixths.
    expect(Number(b) / Number(a)).to.be.closeTo(5, 0.01);
    console.log(`   flexible ${ethers.formatEther(a)}  vs  365-day ${ethers.formatEther(b)}`);
  });

  it("staking more earns more, with no separate size bonus", async () => {
    await (await pool.connect(alice).stake(E(1000), TIER.D90)).wait();
    await (await pool.connect(bob).stake(E(3000), TIER.D90)).wait();
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(400))).wait();
    await time.increase(30 * DAY);
    const a = await pool.earned(alice.address, await robin.getAddress());
    const b = await pool.earned(bob.address, await robin.getAddress());
    // Exactly 3x — proportional to stake and nothing more. A size TIER on top would show up as >3 here, and
    // would be a second advantage handed to whoever already has the most.
    expect(Number(b) / Number(a)).to.be.closeTo(3, 0.01);
  });

  it("a locked position can ALWAYS be exited — it costs 15%, it is never blocked", async () => {
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    const before = await robin.balanceOf(alice.address);
    // One day into a 365-day lock. This must not revert: the term prices impatience, it does not trap money.
    await time.increase(DAY);
    await (await pool.connect(alice).withdraw(0)).wait();
    const back = (await robin.balanceOf(alice.address)) - before;
    expect(back).to.equal(E(850)); // 1000 - 15%
  });

  it("a matured position pays out in full and KEEPS its pending rewards", async () => {
    await (await pool.connect(alice).stake(E(1000), TIER.D7)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D7)).wait();
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(200))).wait();
    await time.increase(8 * DAY); // past both the lock and the stream

    const pending = await pool.earned(alice.address, await robin.getAddress());
    expect(pending).to.be.gt(0);

    const before = await robin.balanceOf(alice.address);
    await (await pool.connect(alice).withdraw(0)).wait();
    expect((await robin.balanceOf(alice.address)) - before).to.equal(E(1000)); // no tax

    // Waiting out the term means the rewards are still there to claim afterwards — forfeiture is the price of
    // leaving EARLY, not the price of leaving.
    expect(await pool.earned(alice.address, await robin.getAddress())).to.be.gte(pending);
    await (await pool.connect(alice).claim(await robin.getAddress())).wait();
  });

  it("an early exit's tax AND forfeited rewards both reach the stayers", async () => {
    // The bug this exists to catch: zeroing a leaver's rewards without redistributing them leaves those
    // tokens in the contract owed to nobody, and nothing else in the system would ever notice.
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(400))).wait();
    await time.increase(8 * DAY); // stream finished; both have accrued

    const aliceForfeits = await pool.earned(alice.address, await robin.getAddress());
    const bobBefore = await pool.earned(bob.address, await robin.getAddress());
    expect(aliceForfeits).to.be.gt(0);

    await (await pool.connect(alice).withdraw(0)).wait();

    const bobAfter = await pool.earned(bob.address, await robin.getAddress());
    const gained = bobAfter - bobBefore;
    // Bob is the only stayer, so he receives ALL of it: alice's forfeited rewards plus her 150 tax.
    expect(gained).to.equal(aliceForfeits + E(150));
    console.log(`   stayer gained ${ethers.formatEther(gained)} = forfeited ${ethers.formatEther(aliceForfeits)} + tax 150.0`);
  });

  it("a leaver takes no share of their own tax", async () => {
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D365)).wait();
    await time.increase(DAY);
    await (await pool.connect(alice).withdraw(0)).wait();
    // Alice is out. Her tax funded the pool AFTER her weight left the denominator, so none of it is hers.
    expect(await pool.earned(alice.address, await robin.getAddress())).to.equal(0);
    expect(await pool.weightOf(alice.address)).to.equal(0);
  });

  it("10M staked $ROBIN boosts by 25%, and losing the position removes the boost", async () => {
    // Bob qualifies, alice does not. Equal principal, equal term.
    await (await pool.connect(alice).stake(E(1_000_000), TIER.D90)).wait();
    await (await pool.connect(bob).stake(E(10_000_000), TIER.D90)).wait();
    expect(await pool.boosted(bob.address)).to.equal(true);
    expect(await pool.boosted(alice.address)).to.equal(false);

    // weight = principal x 2.00 (90d) x 1.25 (boost)
    expect(await pool.weightOf(bob.address)).to.equal(E(10_000_000) * 200n / 100n * 125n / 100n);
    expect(await pool.weightOf(alice.address)).to.equal(E(1_000_000) * 200n / 100n);

    // Drop below the threshold and anyone may correct it — the person losing the boost will not do it.
    await time.increase(91 * DAY);
    await (await pool.connect(bob).withdraw(0)).wait();
    await (await pool.connect(bob).stake(E(9_000_000), TIER.D90)).wait();
    await (await pool.connect(carol).syncBoost(bob.address)).wait();
    expect(await pool.boosted(bob.address)).to.equal(false);
  });

  it("the boost cannot be taken by holding $ROBIN for one instant", async () => {
    // The reason the source is STAKED $ROBIN rather than a wallet balance. Carol holds 50M in her wallet the
    // entire time and still does not qualify — a balance is buyable for one block, a staked position is not.
    expect(await robin.balanceOf(carol.address)).to.be.gte(E(10_000_000));
    await (await pool.connect(carol).stake(E(100), TIER.D30)).wait();
    expect(await pool.boosted(carol.address)).to.equal(false);
    expect(await pool.qualifiesForBoost(carol.address)).to.equal(false);
  });

  it("the owner cannot raise the boost past its hard ceiling", async () => {
    await expect(pool.connect(owner).setBoost(await pool.getAddress(), E(1), 10_001))
      .to.be.revertedWithCustomError(pool, "BadBoost");
    await (await pool.connect(owner).setBoost(await pool.getAddress(), E(1), 10_000)).wait();
  });

  it("a position keeps the multiplier it was opened at", async () => {
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    const [p] = await pool.positionsOf(alice.address);
    expect(p.mulBps).to.equal(50_000);
    expect(p.tier).to.equal(TIER.D365);
    expect(p.unlockAt).to.be.gt(0);
  });

  it("open positions are capped, so a user can never gas themselves out of their own exit", async () => {
    const max = Number(await pool.MAX_POSITIONS());
    for (let i = 0; i < max; i++) await (await pool.connect(alice).stake(E(1), TIER.FLEX)).wait();
    await expect(pool.connect(alice).stake(E(1), TIER.FLEX)).to.be.revertedWithCustomError(pool, "TooManyPositions");
    // And the exit still works at the cap — which is the thing the cap exists to protect.
    await (await pool.connect(alice).withdraw(0)).wait();
  });

  it("rewards that arrive while nobody is staked are parked, not lost", async () => {
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(100))).wait();
    expect((await pool.rewardInfo(await robin.getAddress())).pending).to.equal(E(100));
    await (await pool.connect(alice).stake(E(1000), TIER.D30)).wait();
    await time.increase(30 * DAY);
    // The parked reward streamed to the first staker rather than stranding.
    expect(await pool.earned(alice.address, await robin.getAddress())).to.be.closeTo(E(100), E(0.001));
  });

  it("closing ONE position early does not forfeit what the others earned", async () => {
    // The trap this closes: forfeiting the whole account would mean someone with a big matured position and a
    // small immature one loses a year of rewards by closing the small one a day early.
    await (await pool.connect(alice).stake(E(1000), TIER.D7)).wait();   // small, will go early
    await (await pool.connect(alice).stake(E(9000), TIER.D365)).wait(); // big, untouched
    await (await pool.connect(bob).stake(E(1000), TIER.D7)).wait();     // someone to receive the forfeit
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(500))).wait();
    await time.increase(8 * DAY);

    const before = await pool.earned(alice.address, await robin.getAddress());
    expect(before).to.be.gt(0);

    // Close the 365-day one early (index 1). Its weight share is 9000x5 / (1000x1.1 + 9000x5) ≈ 97.6%.
    await (await pool.connect(alice).withdraw(1)).wait();
    const after = await pool.earned(alice.address, await robin.getAddress());

    expect(after).to.be.gt(0); // NOT wiped out — the 7-day position's share survives
    const kept = Number(after) / Number(before);
    const expectedKept = 1100 / (1100 + 45000);
    expect(kept).to.be.closeTo(expectedKept, 0.01);
    console.log(`   kept ${(kept * 100).toFixed(1)}% of pending — the share the untouched position earned`);
  });

  it("closing the ONLY position early still forfeits all of its rewards", async () => {
    // Pro-rata must not become a loophole: with one position, its share is 100%.
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(400))).wait();
    await time.increase(8 * DAY);
    expect(await pool.earned(alice.address, await robin.getAddress())).to.be.gt(0);
    await (await pool.connect(alice).withdraw(0)).wait();
    expect(await pool.earned(alice.address, await robin.getAddress())).to.equal(0);
  });

  it("the contract always holds enough to cover principal AND reward claims", async () => {
    // stakeToken doubles as a reward asset (the exit tax is paid in it), so principal and rewards come out of
    // one balance. If that accounting were off, the shortfall would surface as somebody's withdrawal reverting
    // long after the cause.
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(bob).stake(E(2000), TIER.D30)).wait();
    await (await pool.connect(owner).notifyReward(await robin.getAddress(), E(300))).wait();
    await time.increase(10 * DAY);
    await (await pool.connect(alice).withdraw(0)).wait();  // early: pays tax, forfeits
    await time.increase(30 * DAY);
    await (await pool.connect(bob).claim(await robin.getAddress())).wait();
    await (await pool.connect(bob).withdraw(0)).wait();    // matured: full principal

    const dust = await robin.balanceOf(await pool.getAddress());
    expect(await pool.totalStaked()).to.equal(0);
    expect(await pool.totalWeight()).to.equal(0);
    // Everyone got out; whatever remains is unclaimed/rounding, never negative — the balance covered it all.
    console.log(`   both exited, ${ethers.formatEther(dust)} left in the contract (unclaimed + rounding)`);
  });

  it("a whale cannot refund their own exit penalty back to themselves", async () => {
    // THE EXPLOIT this closes. The penalty is shared among current stakers — and a staker with OTHER
    // positions is still one of them when their own penalty is handed out. At 99% of the pool they would
    // receive ~99% of their own tax straight back, so the 15% would effectively stop applying to precisely
    // the holders it exists to price.
    await (await pool.connect(alice).stake(E(1_000_000), TIER.D365)).wait(); // the one she closes early
    await (await pool.connect(alice).stake(E(1_000_000), TIER.D365)).wait(); // keeps her ~99% of the pool
    await (await pool.connect(bob).stake(E(1), TIER.D365)).wait();           // a token minority
    await time.increase(DAY);

    const before = await pool.earned(alice.address, await robin.getAddress());
    await (await pool.connect(alice).withdraw(0)).wait();
    const after = await pool.earned(alice.address, await robin.getAddress());

    // She must gain NOTHING from her own 150,000 tax, despite still being nearly the whole pool.
    expect(after).to.equal(before);
    // ...and the minority staker receives the entire thing.
    expect(await pool.earned(bob.address, await robin.getAddress())).to.be.closeTo(E(150_000), E(1));
    console.log(`   whale kept ${ethers.formatEther(after - before)} of her own 150,000 tax; the 1-token staker got it all`);
  });

  it("an unknown tier is refused", async () => {
    await expect(pool.connect(alice).stake(E(1), 7)).to.be.revertedWithCustomError(pool, "BadTier");
  });
});
