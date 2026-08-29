const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const TIER = { FLEX: 0, D7: 1, D30: 2, D60: 3, D90: 4, D180: 5, D365: 6 };

// The early-exit tax goes back to the stakers of the pool it came from — never to a wallet. It gets
// there by a route with no wallet on it: pool -> StakingFeeder -> the same pool's reward stream.
//
// Handing the tax straight back out by weight failed audit three times, so the point of these tests is
// not that the tax reaches stakers (it plainly does) but that it reaches them WITHOUT reopening any of
// the three holes: the leaver recapturing it, a stranger sandwiching it, or a whale front-running it.
describe("[TAX] the early-exit tax goes home to the pool, not to a wallet", function () {
  this.timeout(180000);

  async function setup() {
    const [owner, alice, bob, whale] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(100_000_000));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    const FE = await ethers.getContractFactory("StakingFeeder");
    const feeder = await FE.deploy(owner.address, await factory.getAddress());
    await (await factory.setFeeder(await feeder.getAddress())).wait();
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);
    for (const w of [alice, bob, whale]) {
      await (await coin.transfer(w.address, E(100_000))).wait();
      await (await coin.connect(w).approve(pool, ethers.MaxUint256)).wait();
    }
    return { owner, alice, bob, whale, coin, factory, feeder, pool, p };
  }

  it("the tax is aimed at the feeder, which has no way to reach any wallet", async () => {
    const { feeder, p } = await setup();
    expect(await p.strandedSink()).to.equal(await feeder.getAddress());
  });

  it("goes the whole way home: leaver pays 15%, the stayer earns it", async () => {
    const { alice, bob, coin, feeder, pool, p } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();   // the stayer
    await (await p.connect(alice).stake(E(1000), TIER.D365)).wait(); // the leaver
    await (await p.connect(alice).withdraw(0)).wait();               // -15% = 150

    expect(await p.stranded(await coin.getAddress())).to.equal(E(150));
    await (await p.connect(alice).sweepStranded(await coin.getAddress())).wait();
    expect(await coin.balanceOf(await feeder.getAddress())).to.equal(E(150));

    // Anyone may send it home — this must not depend on our keeper being alive.
    await (await feeder.connect(bob).returnTax(pool)).wait();
    expect(await coin.balanceOf(await feeder.getAddress())).to.equal(0n);

    await time.increase(30 * 24 * 3600);
    const earned = await p.earned(bob.address, await coin.getAddress());
    expect(earned).to.be.gt(E(149));
    console.log(`   leaver paid 150 · stayer earned ${ethers.formatEther(earned)}`);
  });

  it("HOLE #1 the leaver cannot recapture it by re-staking flexible", async () => {
    const { alice, bob, coin, feeder, pool, p } = await setup();
    const before = await coin.balanceOf(alice.address); // her true starting balance, before she stakes
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).withdraw(0)).wait();
    await (await p.connect(alice).sweepStranded(await coin.getAddress())).wait();

    // Alice re-enters with zero-cost weight and tries to earn her own tax back.
    await (await p.connect(alice).stake(E(850), TIER.FLEX)).wait();
    await (await feeder.connect(alice).returnTax(pool)).wait();
    await time.increase(30 * 24 * 3600);
    await (await p.connect(alice).claim(await coin.getAddress())).wait();
    await (await p.connect(alice).withdraw(0)).wait(); // flexible, matured, no tax

    const after = await coin.balanceOf(alice.address);
    const net = before - after; // what breaking the lock actually cost her, round trip
    console.log(`   leaver ended down ${ethers.formatEther(net)} — she paid 150 and clawed back ${ethers.formatEther(E(150) - net)}`);
    // The old design let her end up down ~0.0000000000005 against an advertised 150. What she can claw
    // back now is only her honest share as one staker among others, which is bounded by her weight —
    // 850 flexible against Bob's 1000 locked for a year at 5x, so ~14.5% of the stream at most.
    expect(net).to.be.gt(E(120));
    expect(net).to.be.lte(E(150));
  });

  it("HOLE #2 a 1-wei second wallet cannot hand the leaver the tax back", async () => {
    const { alice, bob, coin, feeder, pool, p } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).withdraw(0)).wait();
    await (await p.connect(alice).sweepStranded(await coin.getAddress())).wait();

    await (await p.connect(alice).stake(1n, TIER.FLEX)).wait(); // 1 wei of weight
    await (await feeder.connect(alice).returnTax(pool)).wait();
    await time.increase(30 * 24 * 3600);
    const got = await p.earned(alice.address, await coin.getAddress());
    console.log(`   1-wei sybil recaptured ${ethers.formatEther(got)} of 150`);
    expect(got).to.be.lt(E("0.0001"));
  });

  // MEASURED, not asserted. The first version of this test read `earned` in the same block and called
  // the hole closed. That only ever proved the whale cannot take the tax ATOMICALLY. Holding the
  // position through the stream — which costs the whale nothing but time — is the actual attack, and
  // it works: streaming does not stop a flexible whale, it only makes it wait.
  it("a flexible whale DOES take most of the tax by holding the stream out", async () => {
    const { alice, bob, whale, coin, feeder, pool, p } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).withdraw(0)).wait();
    await (await p.connect(alice).sweepStranded(await coin.getAddress())).wait();

    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();
    await (await feeder.connect(whale).returnTax(pool)).wait();

    const instant = await p.earned(whale.address, await coin.getAddress());
    expect(instant).to.equal(0n); // atomic capture is genuinely dead

    await time.increase(7 * 24 * 3600); // hold the window it started
    const held = await p.earned(whale.address, await coin.getAddress());
    const stayer = await p.earned(bob.address, await coin.getAddress());
    console.log(`   whale: 0 instantly, ${ethers.formatEther(held)} of 150 after holding 7 days (${(Number(held) / 1.5e20 * 100).toFixed(1)}%, was 90.9% before the cap)`);
    console.log(`   the locked stayer got ${ethers.formatEther(stayer)}`);

    // This is the honest number and it is why the page must not promise the tax to "the stayers".
    // The tax is shared by weight like every other reward, so more capital takes more of it — bounded
    // now by the whale cap, which is the only reason this reads 66.7% instead of the 90.9% it did before.
    expect(held).to.be.gt(E(90));
    expect(held).to.be.lt(E(105));
    // What DOES hold: per token staked, a 365-day lock earns far more than flexible capital. Bob is
    // outnumbered 50:1 in principal and still takes ~9%, which is the 5x lock multiplier working.
    const perTokenWhale = held / 50_000n;
    const perTokenBob = stayer / 1_000n;
    expect(perTokenBob).to.be.gt(perTokenWhale * 4n);
    console.log(`   per token staked, the 365-day locker earned ${(Number(perTokenBob) / Number(perTokenWhale)).toFixed(1)}x the flexible whale`);
  });

  // The honest residual, measured rather than assumed. This is the case that broke every previous
  // design, so it is written down here rather than left for someone to discover.
  it("RESIDUAL: a SOLE staker can earn her own tax back — but only by locking again and waiting", async () => {
    const { alice, coin, feeder, pool, p } = await setup();
    const before = await coin.balanceOf(alice.address);
    await (await p.connect(alice).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(alice).withdraw(0)).wait();
    await (await p.connect(alice).sweepStranded(await coin.getAddress())).wait();

    // Nobody else is staked, so whatever she re-stakes takes the whole stream. The old design let her
    // do this with FLEXIBLE weight in the same block. Now the stream only pays over time, so she is
    // exposed to the coin for the whole reward window and anyone else who stakes dilutes her.
    await (await p.connect(alice).stake(E(850), TIER.D7)).wait();
    await (await feeder.connect(alice).returnTax(pool)).wait();

    const sameBlock = await p.earned(alice.address, await coin.getAddress());
    expect(sameBlock).to.equal(0n); // she cannot take it and leave

    await time.increase(30 * 24 * 3600);
    await (await p.connect(alice).claim(await coin.getAddress())).wait();
    await (await p.connect(alice).withdraw(0)).wait();
    const net = before - (await coin.balanceOf(alice.address));
    console.log(`   sole staker: instantly recovered ${ethers.formatEther(sameBlock)}; after 30 days locked, net cost ${ethers.formatEther(net)}`);
  });

  it("returnTax cannot move ETH, and cannot pay a pool the coin does not belong to", async () => {
    const { owner, coin, factory, feeder, pool } = await setup();
    const T = await ethers.getContractFactory("MockERC20");
    const other = await T.deploy(E(1_000_000));
    await (await factory.createPool(await other.getAddress(), false)).wait();
    const otherPool = await factory.poolOf(await other.getAddress());

    // Fee revenue (ETH) sitting in the feeder, plus coin A's tax.
    await (await owner.sendTransaction({ to: await feeder.getAddress(), value: E(10) })).wait();
    await (await coin.transfer(await feeder.getAddress(), E(150))).wait();

    const ethBefore = await ethers.provider.getBalance(await feeder.getAddress());
    // Pointing it at the WRONG pool moves that pool's own token (zero of it), never coin A's tax.
    await expect(feeder.returnTax(otherPool)).to.be.reverted;
    await (await feeder.returnTax(pool)).wait();

    expect(await ethers.provider.getBalance(await feeder.getAddress())).to.equal(ethBefore); // ETH untouched
    expect(await coin.balanceOf(await feeder.getAddress())).to.equal(0n);
  });

  it("still refuses a look-alike pool the registry does not know", async () => {
    const { owner, coin, feeder } = await setup();
    const F2 = await ethers.getContractFactory("RobinTierStakingFactory");
    const rogueFactory = await F2.deploy(owner.address);
    await (await rogueFactory.createPool(await coin.getAddress(), true)).wait();
    const rogue = await rogueFactory.poolOf(await coin.getAddress());
    await (await coin.transfer(await feeder.getAddress(), E(150))).wait();
    await expect(feeder.returnTax(rogue)).to.be.revertedWithCustomError(feeder, "NotAPool");
  });
});

// The auditor's LOW: every funding call resets periodFinish, and returnTax is open to anyone, so a
// griefer donating dust could hold the finish line a full window away forever and thin the tail.
describe("[TAX] a dust top-up cannot restart the stream clock", function () {
  this.timeout(180000);

  it("five daily 1-wei pokes do not push the finish line out", async () => {
    const [owner, bob] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(100_000_000));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    const FE = await ethers.getContractFactory("StakingFeeder");
    const feeder = await FE.deploy(owner.address, await factory.getAddress());
    await (await factory.setFeeder(await feeder.getAddress())).wait();
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);

    await (await coin.transfer(bob.address, E(10_000))).wait();
    await (await coin.connect(bob).approve(pool, ethers.MaxUint256)).wait();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();

    await (await coin.transfer(await feeder.getAddress(), E(150))).wait();
    await (await feeder.returnTax(pool)).wait();
    const started = await p.rewardInfo(await coin.getAddress());
    const rate0 = started.rewardRate;

    for (let i = 0; i < 5; i++) {
      await time.increase(24 * 3600);
      await (await coin.transfer(await feeder.getAddress(), 1n)).wait(); // one wei
      await (await feeder.returnTax(pool)).wait();
    }
    const after = await p.rewardInfo(await coin.getAddress());
    const daysLeft = (Number(after.periodFinish) - (await time.latest())) / 86400;
    console.log(`   after 5 daily 1-wei pokes: ${daysLeft.toFixed(2)} days left (was 7), rate ${(Number(after.rewardRate) / Number(rate0) * 100).toFixed(0)}% of the original`);

    expect(daysLeft).to.be.lt(2.5);                    // the clock kept running; it was not reset
    expect(after.rewardRate).to.be.gte(rate0);         // and the tail was not thinned

    // The money is still all there — folded into the running window, not lost.
    await time.increase(7 * 24 * 3600);
    const earned = await p.earned(bob.address, await coin.getAddress());
    expect(earned).to.be.gt(E(149));
    console.log(`   sole locked staker still receives ${ethers.formatEther(earned)} of the 150`);
  });

  it("a real deposit still extends the window normally", async () => {
    const [owner, bob] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(100_000_000));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    const FE = await ethers.getContractFactory("StakingFeeder");
    const feeder = await FE.deploy(owner.address, await factory.getAddress());
    await (await factory.setFeeder(await feeder.getAddress())).wait();
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);
    await (await coin.transfer(bob.address, E(10_000))).wait();
    await (await coin.connect(bob).approve(pool, ethers.MaxUint256)).wait();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();

    await (await coin.transfer(await feeder.getAddress(), E(150))).wait();
    await (await feeder.returnTax(pool)).wait();
    await time.increase(3 * 24 * 3600);
    await (await coin.transfer(await feeder.getAddress(), E(150))).wait(); // a real second tax, 100%
    await (await feeder.returnTax(pool)).wait();

    const after = await p.rewardInfo(await coin.getAddress());
    const daysLeft = (Number(after.periodFinish) - (await time.latest())) / 86400;
    console.log(`   a full-size deposit reset the window to ${daysLeft.toFixed(2)} days, as it should`);
    expect(daysLeft).to.be.gt(6.9);
  });
});
