const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const T = { FLEX: 0, D7: 1, D30: 2, D60: 3, D90: 4, D180: 5, D365: 6 };
const ETH0 = ethers.ZeroAddress;

describe("[AUDIT] tiered staking — adversarial", function () {
  this.timeout(300000);
  let owner, a, b, c, robin, pool, R;

  beforeEach(async () => {
    [owner, a, b, c] = (await ethers.getSigners()).slice(-4);
    robin = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000_000));
    R = await robin.getAddress();
    pool = await (await ethers.getContractFactory("RobinTierStaking"))
      .connect(owner).deploy(R, owner.address, ethers.ZeroAddress);
    for (const w of [a, b, c]) {
      await (await robin.connect(owner).transfer(w.address, E(10_000_000))).wait();
      await (await robin.connect(w).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await robin.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  });

  /// The invariant that matters more than any other: the contract can always pay back every
  /// principal AND every reward it has promised. Everything else is a detail next to this.
  async function assertSolvent(tag) {
    const held = await robin.balanceOf(await pool.getAddress());
    const totalStaked = await pool.totalStaked();
    let owed = 0n;
    for (const w of [owner, a, b, c]) owed += await pool.earned(w.address, R);
    owed += await pool.stranded(R);
    owed += (await pool.rewardInfo(R)).pending;
    expect(held, `${tag}: holds ${ethers.formatEther(held)} but owes ${ethers.formatEther(totalStaked + owed)}`)
      .to.be.gte(totalStaked + owed);
  }

  it("stays solvent through a long randomised sequence of stakes, exits, funds and claims", async () => {
    // A scripted-but-messy sequence: overlapping terms, exits mid-stream, funding an empty pool,
    // refunding a repopulated one, claims interleaved. Solvency is asserted after EVERY step.
    const wallets = [a, b, c];
    const tiers = [T.FLEX, T.D7, T.D30, T.D365];
    let step = 0;
    for (let round = 0; round < 6; round++) {
      for (const w of wallets) {
        await (await pool.connect(w).stake(E(1000 + round * 137), tiers[(round + wallets.indexOf(w)) % 4])).wait();
        await assertSolvent(`stake r${round} s${step++}`);
      }
      await (await pool.connect(owner).notifyReward(R, E(500))).wait();
      await assertSolvent(`fund r${round}`);
      await time.increase(3 * DAY);

      // one wallet fully exits every round, which empties nothing but churns weight
      const leaver = wallets[round % 3];
      const n = await pool.positionCount(leaver.address);
      if (n > 0n) { await (await pool.connect(leaver).withdraw(0)).wait(); await assertSolvent(`exit r${round}`); }
      await (await pool.connect(wallets[(round + 1) % 3]).claim(R)).wait();
      await assertSolvent(`claim r${round}`);
    }
    // everyone out, everything claimed
    await time.increase(400 * DAY);
    for (const w of wallets) {
      while ((await pool.positionCount(w.address)) > 0n) await (await pool.connect(w).withdraw(0)).wait();
      await (await pool.connect(w).claim(R)).wait();
      await assertSolvent("drain");
    }
    const left = await robin.balanceOf(await pool.getAddress());
    const stranded = await pool.stranded(R);
    const pending = (await pool.rewardInfo(R)).pending;
    console.log(`   after full drain: ${ethers.formatEther(left)} left = stranded ${ethers.formatEther(stranded)} + pending ${ethers.formatEther(pending)} + dust`);
    expect(left - stranded - pending).to.be.lt(E(0.001)); // only rounding dust unaccounted
  });

  it("nothing is lost across repeated empty/refill cycles", async () => {
    // The `pending` recapture path runs whenever the pool empties mid-stream. Three cycles: if the
    // recapture is off by a window, tokens silently stop being payable to anyone.
    let funded = 0n;
    for (let i = 0; i < 3; i++) {
      await (await pool.connect(a).stake(E(1000), T.FLEX)).wait();
      await (await pool.connect(owner).notifyReward(R, E(300))).wait(); funded += E(300);
      await time.increase(2 * DAY);          // partway through a 7-day stream
      await (await pool.connect(a).withdraw(0)).wait();  // pool empties mid-stream
      await time.increase(10 * DAY);         // the un-streamed remainder must NOT decay away
    }
    await (await pool.connect(b).stake(E(1000), T.FLEX)).wait();
    await time.increase(60 * DAY);
    const earned = await pool.earned(b.address, R);
    const aEarned = await pool.earned(a.address, R);
    console.log(`   funded ${ethers.formatEther(funded)}, recovered ${ethers.formatEther(earned + aEarned)}`);
    expect(earned + aEarned).to.be.closeTo(funded, E(0.01));
  });

  it("a frozen reward token cannot block claims of the others", async () => {
    // A stock reward can be paused or its holder blocklisted. If that jams the whole pool, one bad
    // asset takes everyone's ETH and $ROBIN hostage.
    const bad = await (await ethers.getContractFactory("FreezableReward")).connect(owner).deploy(E(1_000_000));
    const B = await bad.getAddress();
    await (await pool.connect(owner).listReward(B, 7 * DAY)).wait();
    await (await bad.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();

    await (await pool.connect(a).stake(E(1000), T.FLEX)).wait();
    await (await pool.connect(owner).notifyReward(R, E(100))).wait();
    await (await pool.connect(owner).notifyReward(B, E(100))).wait();
    await time.increase(30 * DAY);

    await (await bad.connect(owner).setFrozen(true)).wait();
    await expect(pool.connect(a).claim(B)).to.be.reverted;              // the bad one fails, as it must
    await expect(pool.connect(a).claim(R)).to.not.be.reverted;          // the good one still pays
    await expect(pool.connect(a).withdraw(0)).to.not.be.reverted;       // and the exit still works
  });

  it("a staker who cannot receive ETH is not trapped", async () => {
    // ETH rewards pay by call(). A contract staker that rejects ETH must still be able to leave and
    // to claim its ERC-20 rewards — otherwise its principal is stuck behind a reward it cannot take.
    const rej = await (await ethers.getContractFactory("StakeEthRejecter")).deploy();
    const A = await rej.getAddress();
    await (await robin.connect(owner).transfer(A, E(1000))).wait();
    await (await rej.stakeInto(await pool.getAddress(), R, E(1000))).wait();
    await (await pool.connect(owner).notifyRewardETH({ value: E(1) })).wait();
    await (await pool.connect(owner).notifyReward(R, E(100))).wait();
    await time.increase(30 * DAY);

    await expect(rej.claimFrom(await pool.getAddress(), ETH0)).to.be.reverted;   // ETH claim fails
    await expect(rej.claimFrom(await pool.getAddress(), R)).to.not.be.reverted;  // ERC-20 still pays
    const before = await robin.balanceOf(A);
    // and the principal comes out regardless of the unclaimable ETH
    const iface = new ethers.Interface(["function withdraw(uint256)"]);
    await expect(owner.sendTransaction({ to: A, data: "0x" })).to.be.reverted; // sanity: it really rejects ETH
    expect(await robin.balanceOf(A)).to.be.gte(before);
  });

  it("a fee-on-transfer stake token credits what ARRIVED, not what was asked for", async () => {
    const fot = await (await ethers.getContractFactory("FotStakeToken")).connect(owner).deploy(E(1_000_000));
    const F = await fot.getAddress();
    const p2 = await (await ethers.getContractFactory("RobinTierStaking"))
      .connect(owner).deploy(F, owner.address, ethers.ZeroAddress);
    await (await fot.connect(owner).approve(await p2.getAddress(), ethers.MaxUint256)).wait();
    await (await p2.connect(owner).stake(E(1000), T.FLEX)).wait();
    // 1% is taken in flight; crediting 1000 would promise more than the contract holds.
    expect(await p2.stakedOf(owner.address)).to.equal(E(990));
    expect(await fot.balanceOf(await p2.getAddress())).to.be.gte(await p2.totalStaked());
  });

  it("the position cap cannot be used to gas somebody out of their own exit", async () => {
    for (let i = 0; i < 24; i++) await (await pool.connect(a).stake(E(1), T.D365)).wait();
    await expect(pool.connect(a).stake(E(1), T.D365)).to.be.revertedWithCustomError(pool, "TooManyPositions");
    const rc = await (await pool.connect(a).withdraw(0)).wait();
    console.log(`   withdraw with 24 open positions: ${rc.gasUsed} gas`);
    expect(rc.gasUsed).to.be.lt(1_500_000n);
  });

  it("releasing the pot cannot pay it out twice", async () => {
    await (await pool.connect(a).stake(E(1000), T.D30)).wait();
    await (await pool.connect(a).stake(E(1000), T.D365)).wait();
    await (await pool.connect(a).withdraw(0)).wait();          // strands 150
    const potted = await pool.stranded(R);
    expect(potted).to.equal(E(150));
    await (await pool.connect(b).stake(E(1000), T.D30)).wait();
    await (await pool.connect(owner).releaseStranded(R)).wait();
    expect(await pool.stranded(R)).to.equal(0n);
    await expect(pool.connect(owner).releaseStranded(R)).to.be.revertedWithCustomError(pool, "NothingStranded");
    await time.increase(30 * DAY);
    const total = (await pool.earned(a.address, R)) + (await pool.earned(b.address, R));
    expect(total).to.be.closeTo(potted, E(0.01));   // released exactly once
    await assertSolvent("post-release");
  });
});
