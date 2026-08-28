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

  it("an early exit's tax is really taken, and never comes back to the leaver", async () => {
    // Handing the pot back to stakers was tried three ways and broken three ways — most recently by
    // the leaver simply re-staking flexible and collecting it, which cost them 0.0000000000005 against
    // an advertised 150,000. What survives is the part that always worked: the 15% is taken and does
    // not return to the person who paid it.
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D30)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D30)).wait();

    const before = await robin.balanceOf(alice.address);
    await (await pool.connect(alice).withdraw(0)).wait();
    expect(await robin.balanceOf(alice.address) - before).to.equal(E(850)); // 1000 less the 15%
    expect(await pool.stranded(R)).to.equal(E(150));

    // Re-staking flexible — the exact move that defeated the previous design — earns her none of it.
    await (await pool.connect(alice).stake(E(1000), TIER.FLEX)).wait();
    await time.increase(30 * DAY);
    expect(await pool.earned(alice.address, R)).to.equal(0n);
    expect(await pool.stranded(R)).to.equal(E(150));
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
    const R = await robin.getAddress();
    await (await pool.connect(owner).notifyReward(R, E(500))).wait();   // nobody staked yet
    expect((await pool.rewardInfo(R)).pending).to.equal(E(500));

    await (await pool.connect(alice).stake(E(1000), TIER.D30)).wait();
    // Held back for PENDING_DELAY so being first is not decisive — see the empty-pool test below.
    await time.increase(2 * 3600);
    await (await pool.releasePending()).wait();
    await time.increase(30 * DAY);
    expect(await pool.earned(alice.address, R)).to.be.closeTo(E(500), E(0.01));
  });

  
  it("closing a position early forfeits NOTHING — the 15% is the only penalty", async () => {
    // The rule this replaced forfeited a position's share of pending rewards. It was removed because `claim`
    // never forfeited, so it only ever caught people who did not know to claim first.
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(alice).stake(E(1000), TIER.D7)).wait();
    await (await pool.connect(bob).stake(E(2000), TIER.D365)).wait();
    await (await pool.connect(owner).notifyReward(R, E(600))).wait();
    await time.increase(2 * DAY);

    const before = await pool.earned(alice.address, R);
    expect(before).to.be.gt(0n);
    await (await pool.connect(alice).withdraw(1)).wait(); // the 7-day one, early
    const after = await pool.earned(alice.address, R);
    // Not equality: the withdraw tx is itself a block, so a sliver more streams to her remaining position
    // while it executes. What must hold is that nothing was TAKEN.
    expect(after).to.be.gte(before);
    expect(after - before).to.be.lt(E(0.01));
    console.log(`   kept 100% of ${ethers.formatEther(before)} pending after an early exit`);
  });

  
  it("closing your ONLY position early still keeps every reward it earned", async () => {
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(owner).notifyReward(R, E(600))).wait();
    await time.increase(2 * DAY);

    const before = await pool.earned(alice.address, R);
    expect(before).to.be.gt(0n);
    await (await pool.connect(alice).withdraw(0)).wait(); // fully out, a year early
    const after = await pool.earned(alice.address, R);
    expect(after).to.be.gte(before);           // nothing taken (the withdraw block itself streams a sliver)
    expect(after - before).to.be.lt(E(0.01));
    // ...and she can still collect it after leaving. Claiming was never tied to being staked.
    const bal = await robin.balanceOf(alice.address);
    await (await pool.connect(alice).claim(R)).wait();
    expect(await robin.balanceOf(alice.address) - bal).to.equal(after);
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
    // THE ORIGINAL EXPLOIT, and its sybil variant. The penalty used to be shared among whoever held
    // weight in the exit block, so a staker who was 99% of the pool took back ~99% of their own
    // penalty — and when they were 100% of it, a one-wei SECOND WALLET collected the entire thing
    // (measured: 150,000 recaptured, 0 stranded). Nothing is paid in the exit block now, so neither
    // works: the leaver's weight at that instant buys them nothing at all.
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1_000_000), TIER.D365)).wait(); // closed early
    await (await pool.connect(alice).stake(E(1_000_000), TIER.D365)).wait(); // keeps her ~99% of the pool
    await (await pool.connect(bob).stake(1n, TIER.FLEX)).wait();             // the sybil's one wei
    await time.increase(DAY);

    const aliceBefore = await pool.earned(alice.address, R);
    const bobBefore = await pool.earned(bob.address, R);
    await (await pool.connect(alice).withdraw(0)).wait();                    // 150,000 tax

    expect(await pool.earned(alice.address, R)).to.equal(aliceBefore);       // she gains nothing
    expect(await pool.earned(bob.address, R)).to.equal(bobBefore);           // and neither does a sybil
    expect(await pool.stranded(R)).to.equal(E(150_000));
    console.log(`   150,000 tax went to the pot; leaver and 1-wei sybil both received 0`);
  });

  it("a flexible $ROBIN position does not buy the holder boost", async () => {
    // Flexible costs nothing to open and nothing to close, so a boost that counts it can be rented
    // for one transaction with borrowed money. Only a live lock counts.
    await (await pool.connect(owner).setBoost(await pool.getAddress(), E(10_000_000), 2500)).wait();
    await (await pool.connect(alice).stake(E(20_000_000), TIER.FLEX)).wait();
    expect(await pool.stakedOf(alice.address)).to.equal(E(20_000_000));
    expect(await pool.stakedLockedOf(alice.address)).to.equal(0n);
    expect(await pool.qualifiesForBoost(alice.address)).to.equal(false);

    await (await pool.connect(bob).stake(E(10_000_000), TIER.D30)).wait();
    expect(await pool.qualifiesForBoost(bob.address)).to.equal(true);
    // ...and it lapses when the lock matures, because a matured position is free to leave again.
    await time.increase(31 * DAY);
    expect(await pool.qualifiesForBoost(bob.address)).to.equal(false);
  });

  
  it("an unknown tier is refused", async () => {
    await expect(pool.connect(alice).stake(E(1), 7)).to.be.revertedWithCustomError(pool, "BadTier");
  });

  it("a SOLE staker cannot stream their own exit penalty back to themselves", async () => {
    // The same exploit as the whale case, hiding one branch deeper. Excluding the leaver from the
    // redistribution leaves nobody to pay when the leaver IS the pool, and parking the penalty for "the next
    // staker" hands it straight back to them — measured at 149.999 of 150 before this was closed.
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D30)).wait();
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait(); // she is still 100% of the pool
    await (await pool.connect(alice).withdraw(0)).wait();               // 15% of 1000 = 150

    expect((await pool.rewardInfo(R)).pending).to.equal(0n);
    expect(await pool.stranded(R)).to.equal(E(150));

    await (await pool.connect(alice).stake(E(1), TIER.FLEX)).wait();    // would have kickstarted it
    await time.increase(30 * DAY);
    expect(await pool.earned(alice.address, R)).to.equal(0n);
  });

  it("the pot is visible, and leaves only to the sink", async () => {
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D30)).wait();
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(alice).withdraw(0)).wait();

    const [assets, amounts] = await pool.strandedAll();
    expect(amounts[assets.indexOf(R)]).to.equal(E(150)); // a front end can show it growing

    await (await pool.connect(owner).setStrandedSink(carol.address)).wait();
    const before = await robin.balanceOf(carol.address);
    await (await pool.connect(bob).sweepStranded(R)).wait();   // permissionless: only one destination
    expect(await robin.balanceOf(carol.address) - before).to.equal(E(150));
    expect(await pool.stranded(R)).to.equal(0n);
    await expect(pool.connect(bob).sweepStranded(R)).to.be.revertedWithCustomError(pool, "NothingStranded");
  });

  
  it("the pot has exactly one destination, and it is not a caller's choice", async () => {
    // `sweepStranded` takes only the ASSET. The destination is storage the owner set, never an
    // argument, so a permissionless call cannot redirect it.
    const rel = pool.interface.getFunction("sweepStranded");
    expect(rel.inputs.map((i) => i.type)).to.deep.equal(["address"]);
    const names = pool.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(names).to.not.include("releaseStranded"); // the streamed-to-stakers path is gone for good
  });

  
  it("sweeping the pot never eats anyone's principal", async () => {
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D30)).wait();
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(alice).withdraw(0)).wait();          // strands 150
    await (await pool.connect(bob).stake(E(5000), TIER.D30)).wait();
    await (await pool.connect(owner).setStrandedSink(carol.address)).wait();
    await (await pool.connect(bob).sweepStranded(R)).wait();
    await time.increase(400 * DAY);
    for (const [w, n] of [[alice, 1000], [bob, 5000]]) {
      const bal = await robin.balanceOf(w.address);
      await (await pool.connect(w).withdraw(0)).wait();
      expect(await robin.balanceOf(w.address) - bal).to.equal(E(n));
    }
  });

  
  it("funding an EMPTY pool no longer hands the stream to whoever stakes first", async () => {
    // Measured before PENDING_DELAY: one wei, alone for a day, took a seventh of a 1,000,000 reward,
    // and through the real feeder path a sniper netted 9.9997 of 10 ETH seeded into a fresh pool.
    const R = await robin.getAddress();
    await (await pool.connect(owner).notifyReward(R, E(1_000_000))).wait();
    expect((await pool.rewardInfo(R)).pending).to.equal(E(1_000_000));

    await (await pool.connect(alice).stake(1n, TIER.FLEX)).wait();
    await time.increase(DAY);
    expect(await pool.earned(alice.address, R), "one wei must capture nothing").to.equal(0n);

    // It releases once the pool has genuinely held weight, and then it is shared by weight as normal.
    await (await pool.connect(bob).stake(E(1_000_000), TIER.D30)).wait();
    await (await pool.releasePending()).wait();
    await time.increase(30 * DAY);
    expect(await pool.earned(bob.address, R)).to.be.gt(E(900_000));
  });

  
  it("claim order does not matter any more — it used to decide whether you kept your rewards", async () => {
    // The regression guard for why the forfeit was dropped. Under the old rule these two wallets, doing the
    // same thing in a different order, walked away with different money. They must now match exactly.
    const R = await robin.getAddress();
    await (await pool.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await pool.connect(owner).notifyReward(R, E(600))).wait();
    await time.increase(30 * DAY);

    const aBefore = await robin.balanceOf(alice.address);
    await (await pool.connect(alice).claim(R)).wait();     // claim, THEN leave
    await (await pool.connect(alice).withdraw(0)).wait();

    const bBefore = await robin.balanceOf(bob.address);
    await (await pool.connect(bob).withdraw(0)).wait();    // leave, THEN claim
    await (await pool.connect(bob).claim(R)).wait();

    const aNet = await robin.balanceOf(alice.address) - aBefore;
    const bNet = await robin.balanceOf(bob.address) - bBefore;
    // Alice's exit taxed 150 into the pool while bob was still staked, so he collects a little more; the
    // point is that neither LOST rewards for pressing the buttons in the wrong order.
    expect(bNet).to.be.gte(aNet);
    expect(bNet - aNet).to.be.lt(E(160));
    console.log(`   claim-then-exit ${ethers.formatEther(aNet)} vs exit-then-claim ${ethers.formatEther(bNet)}`);
  });

  
  it("a boost source that burns all the gas cannot trap anyone's money", async () => {
    // `staticcall` stops a boost source writing state. It does NOT stop it BURNING GAS — it takes 63/64 of
    // the frame and leaves too little to finish, so `ok == false` looks handled while the whole transaction
    // dies out of gas. Uncapped, an owner-set address could therefore block every withdrawal in the pool,
    // which is the one thing this contract promises can never happen.
    await (await pool.connect(alice).stake(E(1000), TIER.FLEX)).wait();
    const gas = await (await ethers.getContractFactory("GasBurnerBoost")).deploy();
    await (await pool.connect(owner).setBoost(await gas.getAddress(), E(10_000_000), 2500)).wait();

    expect(await pool.qualifiesForBoost(alice.address)).to.equal(false);
    await expect(pool.connect(bob).stake(E(1000), TIER.FLEX, { gasLimit: 1_000_000 })).to.not.be.reverted;
    const bal = await robin.balanceOf(alice.address);
    await (await pool.connect(alice).withdraw(0, { gasLimit: 1_000_000 })).wait();
    expect(await robin.balanceOf(alice.address) - bal).to.equal(E(1000));
  });
});
