const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const T = { FLEX: 0, D30: 2, D365: 6 };

describe("[REAUDIT-POC] external re-audit findings — each fails on the pre-fix contract", function () {
  this.timeout(300000);
  let owner, alice, sniper, robin, pool, R, P;
  beforeEach(async () => {
    [owner, alice, sniper] = (await ethers.getSigners()).slice(-3);
    robin = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000_000));
    R = await robin.getAddress();
    pool = await (await ethers.getContractFactory("RobinTierStaking")).connect(owner).deploy(R, owner.address, ethers.ZeroAddress);
    P = await pool.getAddress();
    for (const w of [alice, sniper]) {
      await (await robin.connect(owner).transfer(w.address, E(50_000_000))).wait();
      await (await robin.connect(w).approve(P, ethers.MaxUint256)).wait();
    }
    await (await robin.connect(owner).approve(P, ethers.MaxUint256)).wait();
  });

  it("A: does a leaver get their own penalty back by re-staking flexible?", async () => {
    await (await pool.connect(alice).stake(E(1_000_000), T.D365)).wait();
    const before = await robin.balanceOf(alice.address);
    await (await pool.connect(alice).withdraw(0)).wait();         // pays 150,000
    expect(await pool.stranded(R)).to.equal(E(150_000));
    await (await pool.connect(alice).stake(E(1_000_000), T.FLEX)).wait(); // no lock, no fee
    await time.increase(30 * DAY);
    await (await pool.connect(alice).claim(R)).wait();
    await (await pool.connect(alice).withdraw(0)).wait();          // flexible: leaves free
    const net = (await robin.balanceOf(alice.address)) - before;
    const paid = E(1_000_000) - net;                               // what breaking the lock really cost
    console.log(`   advertised penalty 150,000 · ACTUALLY PAID ${ethers.formatEther(paid)}`);
    expect(paid, "the 15% must actually be paid").to.be.closeTo(E(150_000), E(1_000));
  });

  it("B: does a 1-wei stake capture a parked reward pot?", async () => {
    await (await pool.connect(owner).notifyReward(R, E(100_000))).wait(); // funded while empty -> parked
    await (await pool.connect(sniper).stake(1n, T.FLEX)).wait();          // 1 wei, no lock
    await time.increase(DAY);
    const grabbed = await pool.earned(sniper.address, R);
    console.log(`   1 wei captured ${ethers.formatEther(grabbed)} of a 100,000 parked pot`);
    expect(grabbed, "1 wei must not capture a pot").to.be.lt(E(100));
  });

  it("C: can a whale front-run the pot release with zero-cost flexible weight?", async () => {
    await (await pool.connect(alice).stake(E(1_000_000), T.D365)).wait();
    await (await pool.connect(alice).stake(E(1_000_000), T.D365)).wait();
    await (await pool.connect(alice).withdraw(0)).wait();           // 150,000 into the pot
    const before = await robin.balanceOf(sniper.address);
    await (await pool.connect(sniper).stake(E(50_000_000), T.FLEX)).wait();  // front-run, no lock
    await time.increase(30 * DAY);
    await (await pool.connect(sniper).claim(R)).wait();
    await (await pool.connect(sniper).withdraw(0)).wait();
    const gained = (await robin.balanceOf(sniper.address)) - before;
    console.log(`   front-runner took ${ethers.formatEther(gained)} of a 150,000 pot for free`);
    expect(gained, "zero-cost weight must not take the pot").to.be.lt(E(1_000));
  });

  it("D: does shortening the reward window compress the whole backlog?", async () => {
    await (await pool.connect(alice).stake(E(100_000), T.D365)).wait();
    await (await pool.connect(owner).setRewardDuration(R, 365 * DAY)).wait();
    await (await pool.connect(owner).notifyReward(R, E(1_000_000))).wait();
    await time.increase(DAY);
    // The guard must now REFUSE this outright while a stream is running.
    await expect(pool.connect(owner).setRewardDuration(R, 3600))
      .to.be.revertedWithCustomError(pool, "StreamRunning");
    await (await pool.connect(sniper).stake(E(50_000_000), T.FLEX)).wait();
    await time.increase(3600);
    const took = await pool.earned(sniper.address, R);
    console.log(`   after a duration flip, one hour of flexible weight took ${ethers.formatEther(took)} of 1,000,000`);
    expect(took, "a config change must not compress the backlog").to.be.lt(E(50_000));
  });
});
