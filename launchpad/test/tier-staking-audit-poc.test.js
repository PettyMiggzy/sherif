const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const T = { FLEX: 0, D7: 1, D30: 2, D60: 3, D90: 4, D180: 5, D365: 6 };
const f = (x) => Number(ethers.formatEther(x)).toLocaleString(undefined, { maximumFractionDigits: 2 });

describe("[AUDIT-POC] external audit findings — each fails on the pre-fix contract", function () {
  this.timeout(300000);
  let owner, alice, sybil, jit, robin, pool, R, P;

  beforeEach(async () => {
    [owner, alice, sybil, jit] = (await ethers.getSigners()).slice(-4);
    robin = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000_000));
    R = await robin.getAddress();
    pool = await (await ethers.getContractFactory("RobinTierStaking")).connect(owner).deploy(R, owner.address, ethers.ZeroAddress);
    P = await pool.getAddress();
    for (const w of [alice, sybil, jit]) {
      await (await robin.connect(owner).transfer(w.address, E(20_000_000))).wait();
      await (await robin.connect(w).approve(P, ethers.MaxUint256)).wait();
    }
    await (await robin.connect(owner).approve(P, ethers.MaxUint256)).wait();
  });

  it("#1 penalty JIT — a flexible staker sandwiches an exit and takes the tax risk-free", async () => {
    await (await pool.connect(owner).stake(E(1_000_000), T.D365)).wait();   // an honest long-term stayer
    await (await pool.connect(alice).stake(E(1_000_000), T.D365)).wait();   // the one who will leave early

    // The attacker holds nothing until the block of the exit.
    const before = await robin.balanceOf(jit.address);
    await (await pool.connect(jit).stake(E(20_000_000), T.FLEX)).wait();    // no lock, no exit tax
    await (await pool.connect(alice).withdraw(0)).wait();                    // pays 150,000 tax
    await (await pool.connect(jit).withdraw(0)).wait();                      // FLEX: leaves free
    await (await pool.connect(jit).claim(R)).wait();
    const gained = (await robin.balanceOf(jit.address)) - before;

    const tax = E(150_000);
    console.log(`   JIT captured ${f(gained)} of a ${f(tax)} penalty = ${(Number(gained * 10000n / tax) / 100).toFixed(2)}%`);
    expect(gained, "JIT capture should be negligible").to.be.lt(tax / 100n);
  });

  it("#2 sybil recapture — a second wallet hands the leaver their own penalty back", async () => {
    await (await pool.connect(alice).stake(E(1_000_000), T.D365)).wait();
    await (await pool.connect(alice).stake(E(1_000_000), T.D365)).wait();   // alice is the WHOLE pool
    await (await pool.connect(sybil).stake(1n, T.FLEX)).wait();             // 1 wei from her other wallet

    const before = await robin.balanceOf(sybil.address);
    await (await pool.connect(alice).withdraw(0)).wait();                    // 150,000 tax
    await (await pool.connect(sybil).claim(R)).wait();
    const recaptured = (await robin.balanceOf(sybil.address)) - before;
    const potted = await pool.stranded(R);

    console.log(`   1-wei sybil recaptured ${f(recaptured)}; pot got ${f(potted)}`);
    expect(recaptured, "a 1-wei sybil must not recapture the penalty").to.be.lt(E(1_000));
  });

  it("#3 flash boost — borrowed $ROBIN buys a lasting boost in another pool, in one transaction", async () => {
    const flagship = pool;                                    // the $ROBIN pool, its own boost source
    await (await flagship.connect(owner).setBoost(P, E(10_000_000), 2500)).wait();
    const coin = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000_000));
    const C = await coin.getAddress();
    const satellite = await (await ethers.getContractFactory("RobinTierStaking")).connect(owner).deploy(C, owner.address, P);
    const S = await satellite.getAddress();

    const atk = await (await ethers.getContractFactory("FlashBoost")).deploy();
    const A = await atk.getAddress();
    await (await coin.connect(owner).transfer(A, E(1000))).wait();
    await (await atk.stakeIn(S, C, E(1000), T.D365)).wait();   // a normal position in the satellite
    expect(await satellite.boosted(A)).to.equal(false);

    // Flash-borrowed ROBIN, in and out in ONE transaction.
    await (await robin.connect(owner).transfer(A, E(10_000_000))).wait();
    await (await atk.run(P, S, R, E(10_000_000))).wait();

    console.log(`   satellite boosted=${await satellite.boosted(A)} while staked $ROBIN=${f(await flagship.stakedOf(A))}`);
    expect(await satellite.boosted(A), "a boost must not survive a same-tx flash stake").to.equal(false);
  });

  it("#4 rate truncation — a small reward is frozen with no way out", async () => {
    await (await pool.connect(alice).stake(E(1000), T.FLEX)).wait();
    const dust = 604799n;                                     // one wei under the 7-day duration
    await (await pool.connect(owner).notifyReward(R, dust)).wait();
    await time.increase(30 * DAY);
    const earned = await pool.earned(alice.address, R);
    const info = await pool.rewardInfo(R);
    console.log(`   funded ${dust} wei -> rate ${info.rewardRate}, earned ${earned}, pending ${info.pending}, stranded ${await pool.stranded(R)}`);
    expect(earned + info.pending + (await pool.stranded(R)), "funded wei must be recoverable somewhere").to.be.gte(dust);
  });
});
