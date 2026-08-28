const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const T = { FLEX: 0, D7: 1, D30: 2, D365: 6 };

describe("[FIX-REG] regressions the four fixes could have introduced", function () {
  this.timeout(300000);
  let owner, a, b, robin, pool, R, P;
  beforeEach(async () => {
    [owner, a, b] = (await ethers.getSigners()).slice(-3);
    robin = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000_000));
    R = await robin.getAddress();
    pool = await (await ethers.getContractFactory("RobinTierStaking")).connect(owner).deploy(R, owner.address, ethers.ZeroAddress);
    P = await pool.getAddress();
    await (await pool.connect(owner).setBoost(P, E(10_000_000), 2500)).wait();
    for (const w of [a, b]) {
      await (await robin.connect(owner).transfer(w.address, E(50_000_000))).wait();
      await (await robin.connect(w).approve(P, ethers.MaxUint256)).wait();
    }
    await (await robin.connect(owner).approve(P, ethers.MaxUint256)).wait();
  });

  it("a boost keeps paying after its lock matures, until somebody syncs", async () => {
    // stakedLockedOf excludes a MATURED position, so the staker stops QUALIFYING the moment their
    // lock ends — but weightOf was cached with the boost baked in and nothing recomputes it. Before
    // fix 3 the boost only lapsed when someone unstaked $ROBIN, which is deliberate. Now it lapses
    // on MATURITY, which happens to every locked staker on a timer, with no transaction at all.
    await (await pool.connect(a).stake(E(10_000_000), T.D30)).wait();
    expect(await pool.qualifiesForBoost(a.address)).to.equal(true);
    const boostedWeight = await pool.weightOf(a.address);

    await time.increase(31 * DAY);                                   // the lock matures on its own
    expect(await pool.qualifiesForBoost(a.address)).to.equal(false); // no longer deserved...
    expect(await pool.weightOf(a.address)).to.equal(boostedWeight);  // ...but still being paid on

    // Claiming must correct it — nobody spends gas syncing a stranger, so the correction has to
    // happen when the holder reaches for the money.
    await (await pool.connect(owner).notifyReward(R, E(100))).wait();
    await time.increase(10 * DAY);
    await (await pool.connect(a).claim(R)).wait();
    const after = await pool.weightOf(a.address);
    const overpaid = Number((boostedWeight - after) * 10000n / after) / 100;
    console.log(`   matured lock carried +${overpaid.toFixed(1)}% stale weight; claiming corrected it`);
    expect(after).to.be.lt(boostedWeight);
    expect(await pool.boosted(a.address)).to.equal(false);
  });

  it("stakedLockedOf with 24 positions still fits the satellite's 100k gas cap", async () => {
    for (let i = 0; i < 24; i++) await (await pool.connect(a).stake(E(500_000), T.D365)).wait();
    expect(await pool.positionCount(a.address)).to.equal(24n);
    // The satellite calls this through a 100k-gas staticcall. If it does not fit, boosts silently
    // stop working for exactly the biggest stakers.
    const gas = await pool.stakedLockedOf.estimateGas(a.address);
    console.log(`   stakedLockedOf(24 positions): ${gas} gas (cap 250000, was 100000)`);
    expect(gas).to.be.lt(250000n);
    expect(gas, "keep real headroom under the cap").to.be.lt(150000n);
  });

  it("releasing a pot denominated in the STAKE token keeps the pool solvent", async () => {
    await (await pool.connect(a).stake(E(1000), T.D30)).wait();
    await (await pool.connect(a).stake(E(1000), T.D365)).wait();
    await (await pool.connect(a).withdraw(0)).wait();      // 150 into the pot, in the stake token
    await (await pool.connect(b).stake(E(5000), T.D30)).wait();
    await (await pool.connect(owner).releaseStranded(R)).wait();
    await time.increase(400 * DAY);
    for (const w of [a, b]) {
      while ((await pool.positionCount(w.address)) > 0n) await (await pool.connect(w).withdraw(0)).wait();
      await (await pool.connect(w).claim(R)).wait();
    }
    const held = await robin.balanceOf(P);
    console.log(`   after everyone exits and claims: ${ethers.formatEther(held)} left`);
    expect(held).to.be.lt(E(0.001));
  });
});
