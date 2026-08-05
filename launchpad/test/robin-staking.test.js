const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE = 10n ** 18n;
const DAY = 86400;
const WEEK = 7 * DAY;

async function mineAt(ts) {
  await network.provider.send("evm_setNextBlockTimestamp", [ts]);
  await network.provider.send("evm_mine", []);
}
async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("RobinStaking", () => {
  async function setup() {
    const [owner, a, b, c, funder] = await ethers.getSigners();
    const ROBIN = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000_000n * ONE);
    const staking = await (await ethers.getContractFactory("RobinStaking")).deploy(
      await ROBIN.getAddress(),
      owner.address
    );
    const saddr = await staking.getAddress();
    for (const u of [a, b, c]) {
      await ROBIN.transfer(u.address, 10_000_000n * ONE);
      await ROBIN.connect(u).approve(saddr, ethers.MaxUint256);
    }
    await staking.setRewarder(funder.address, true);
    return { owner, a, b, c, funder, ROBIN, staking, saddr };
  }

  // fund ETH stream and let it fully stream out
  async function fundEthFull(staking, funder, amount) {
    await staking.connect(funder).notifyRewardETH({ value: amount });
    await mineAt((await now()) + WEEK + 1);
  }

  it("streams ETH pro-rata over the window; not a lump", async () => {
    const { a, b, funder, staking } = await setup();
    await staking.connect(a).stake(30_000n * ONE);
    await staking.connect(b).stake(10_000n * ONE); // a:b = 3:1

    await staking.connect(funder).notifyRewardETH({ value: 4n * ONE });
    // right after funding, almost nothing has streamed (JIT defense)
    expect(await staking.earned(a.address, ETH)).to.be.lt(ONE / 1000n);

    await mineAt((await now()) + WEEK + 5);
    const ea = await staking.earned(a.address, ETH);
    const eb = await staking.earned(b.address, ETH);
    expect(ea + eb).to.be.closeTo(4n * ONE, 10n ** 12n);
    // 3:1 split
    expect(ea).to.be.closeTo(3n * ONE, 10n ** 12n);
    expect(eb).to.be.closeTo(1n * ONE, 10n ** 12n);
  });

  it("claim() pays out and does not forfeit; keeps stake", async () => {
    const { a, funder, staking } = await setup();
    await staking.connect(a).stake(1000n * ONE);
    await fundEthFull(staking, funder, 5n * ONE);
    const before = await ethers.provider.getBalance(a.address);
    const tx = await staking.connect(a).claim(ETH);
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const after = await ethers.provider.getBalance(a.address);
    expect(after - before + gas).to.be.closeTo(5n * ONE, 10n ** 12n);
    expect(await staking.staked(a.address)).to.equal(1000n * ONE); // still staked
  });

  it("unstaking FORFEITS pending and redistributes to the stayers", async () => {
    const { a, b, funder, staking } = await setup();
    await staking.connect(a).stake(1000n * ONE);
    await staking.connect(b).stake(1000n * ONE); // 50/50
    await fundEthFull(staking, funder, 4n * ONE); // each earns ~2 ETH

    expect(await staking.earned(a.address, ETH)).to.be.closeTo(2n * ONE, 10n ** 12n);

    // b unstakes fully -> forfeits ~2 ETH; b loses ALL pending immediately
    await staking.connect(b).unstake(1000n * ONE);
    expect(await staking.earned(b.address, ETH)).to.equal(0n);
    // the forfeited ~2 now STREAMS to a (the only stayer) over the window — not an instant bump
    await mineAt((await now()) + WEEK + 5);
    expect(await staking.earned(a.address, ETH)).to.be.closeTo(4n * ONE, 10n ** 12n);
  });

  it("partial unstake forfeits ALL pending immediately (leaver's accrued zeroed at exit)", async () => {
    const { a, b, funder, staking } = await setup();
    await staking.connect(a).stake(1000n * ONE);
    await staking.connect(b).stake(1000n * ONE);
    await fundEthFull(staking, funder, 4n * ONE); // a:2, b:2

    // a partially unstakes -> forfeits ALL of a's ~2 ETH at the moment of exit
    await staking.connect(a).unstake(1n * ONE);
    expect(await staking.earned(a.address, ETH)).to.equal(0n);
    // the forfeited ~2 re-streams to the pool; b (a stayer) ends with more than its own 2 after the window
    await mineAt((await now()) + WEEK + 5);
    expect(await staking.earned(b.address, ETH)).to.be.gt(2n * ONE + ONE / 2n);
  });

  it("forfeiture cannot be sniped by a same-block flash-staker (streamed, not instant)", async () => {
    const { a, b, funder, staking } = await setup();
    await staking.connect(a).stake(1000n * ONE); // honest staker
    await fundEthFull(staking, funder, 5n * ONE); // a accrues ~5 as sole staker, fully streamed
    expect(await staking.earned(a.address, ETH)).to.be.closeTo(5n * ONE, 10n ** 12n);

    // attacker flash-stakes a huge amount right before the honest whale's exit
    await staking.connect(b).stake(1_000_000n * ONE);
    // whale exits, forfeiting ~5 ETH
    await staking.connect(a).unstake(1000n * ONE);
    // with STREAMED forfeiture the attacker has accrued ≈0 (no instant bump to snipe)
    expect(await staking.earned(b.address, ETH)).to.be.lt(ONE / 100n);
    // attacker exits same block -> gets ~nothing and forfeits even that
    await staking.connect(b).unstake(1_000_000n * ONE);
    expect(await staking.earned(b.address, ETH)).to.equal(0n);
  });

  it("JIT flash-stake earns ≈nothing due to streaming", async () => {
    const { a, b, funder, staking } = await setup();
    await staking.connect(a).stake(1000n * ONE);
    // fund a fresh stream
    await staking.connect(funder).notifyRewardETH({ value: 10n * ONE });
    // attacker b flash-stakes a huge amount immediately after funding
    await staking.connect(b).stake(1_000_000n * ONE);
    // ...and exits almost immediately (a couple of blocks later)
    await network.provider.send("evm_mine", []);
    await network.provider.send("evm_mine", []);
    const jit = await staking.earned(b.address, ETH);
    // even with 1000x the stake, only a few seconds of a 7-day stream accrued
    expect(jit).to.be.lt(ONE / 100n); // < 0.01 ETH of the 10
    await staking.connect(b).unstake(1_000_000n * ONE); // and forfeits even that
    expect(await staking.earned(b.address, ETH)).to.equal(0n);
  });

  it("rewards funded with zero stake are parked and kickstart on first stake", async () => {
    const { a, funder, staking } = await setup();
    // nobody staked yet
    await staking.connect(funder).notifyRewardETH({ value: 7n * ONE });
    expect((await staking.rewardInfo(ETH)).pending).to.equal(7n * ONE);
    // a stakes -> stream kicks off
    await staking.connect(a).stake(1000n * ONE);
    expect((await staking.rewardInfo(ETH)).pending).to.equal(0n);
    await mineAt((await now()) + WEEK + 5);
    expect(await staking.earned(a.address, ETH)).to.be.closeTo(7n * ONE, 10n ** 12n);
  });

  describe("multi-asset (ETH + stock tokens)", () => {
    async function multi() {
      const base = await setup();
      const STK = await (await ethers.getContractFactory("PausableToken")).deploy(1_000_000n * ONE);
      await base.staking.listReward(await STK.getAddress(), WEEK);
      await STK.transfer(base.funder.address, 500_000n * ONE);
      await STK.connect(base.funder).approve(base.saddr, ethers.MaxUint256);
      return { ...base, STK, stkAddr: await STK.getAddress() };
    }

    it("streams ETH and a stock token independently", async () => {
      const { a, funder, staking, STK, stkAddr } = await multi();
      await staking.connect(a).stake(1000n * ONE);
      await staking.connect(funder).notifyRewardETH({ value: 3n * ONE });
      await staking.connect(funder).notifyReward(stkAddr, 300n * ONE);
      await mineAt((await now()) + WEEK + 5);
      expect(await staking.earned(a.address, ETH)).to.be.closeTo(3n * ONE, 10n ** 12n);
      expect(await staking.earned(a.address, stkAddr)).to.be.closeTo(300n * ONE, 10n ** 11n);
      await staking.connect(a).claim(stkAddr);
      expect(await STK.balanceOf(a.address)).to.be.closeTo(300n * ONE, 10n ** 11n);
    });

    it("CRITICAL: unstake succeeds even when a stock reward token is PAUSED", async () => {
      const { a, funder, staking, STK, stkAddr, ROBIN } = await multi();
      await staking.connect(a).stake(1000n * ONE);
      await staking.connect(funder).notifyReward(stkAddr, 300n * ONE);
      await mineAt((await now()) + WEEK + 5);

      await STK.setPaused(true); // Robinhood pauses the stock token
      // claiming that asset fails...
      await expect(staking.connect(a).claim(stkAddr)).to.be.reverted;
      // ...but principal exit MUST still work (forfeits the paused reward, returns stake)
      const balBefore = await ROBIN.balanceOf(a.address);
      await staking.connect(a).unstake(1000n * ONE);
      expect(await ROBIN.balanceOf(a.address)).to.equal(balBefore + 1000n * ONE);
    });

    it("single-asset claim isolates a paused token from a healthy one", async () => {
      const { a, funder, staking, STK, stkAddr } = await multi();
      await staking.connect(a).stake(1000n * ONE);
      await staking.connect(funder).notifyRewardETH({ value: 2n * ONE });
      await staking.connect(funder).notifyReward(stkAddr, 100n * ONE);
      await mineAt((await now()) + WEEK + 5);
      await STK.setPaused(true);
      // ETH claim still works despite STK being paused
      await expect(staking.connect(a).claim(ETH)).to.not.be.reverted;
      await expect(staking.connect(a).claim(stkAddr)).to.be.reverted;
    });

    it("caps reward assets at MAX_REWARD_TOKENS", async () => {
      const { staking } = await multi(); // ETH + STK = 2 listed
      for (let i = 0; i < 6; i++) {
        const t = await (await ethers.getContractFactory("PausableToken")).deploy(ONE);
        await staking.listReward(await t.getAddress(), WEEK); // fills to 8
      }
      const over = await (await ethers.getContractFactory("PausableToken")).deploy(ONE);
      await expect(staking.listReward(await over.getAddress(), WEEK)).to.be.revertedWithCustomError(
        staking,
        "TooManyRewards"
      );
    });
  });

  describe("access & guards", () => {
    it("only a rewarder can fund", async () => {
      const { a, staking } = await setup();
      await expect(staking.connect(a).notifyRewardETH({ value: ONE })).to.be.revertedWithCustomError(
        staking,
        "NotRewarder"
      );
    });
    it("only owner can list rewards / set rewarders / durations", async () => {
      const { a, staking } = await setup();
      const t = await (await ethers.getContractFactory("PausableToken")).deploy(ONE);
      await expect(staking.connect(a).listReward(await t.getAddress(), WEEK)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(a).setRewarder(a.address, true)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
    });
    it("rejects bad durations and duplicate listings", async () => {
      const { staking } = await setup();
      const t = await (await ethers.getContractFactory("PausableToken")).deploy(ONE);
      await expect(staking.listReward(await t.getAddress(), 1)).to.be.revertedWithCustomError(staking, "BadDuration");
      await expect(staking.listReward(ETH, WEEK)).to.be.revertedWithCustomError(staking, "AlreadyListed");
    });
    it("stake(0)/unstake(0) revert; unstake > balance reverts", async () => {
      const { a, staking } = await setup();
      await expect(staking.connect(a).stake(0)).to.be.revertedWithCustomError(staking, "Zero");
      await staking.connect(a).stake(100n * ONE);
      await expect(staking.connect(a).unstake(0)).to.be.revertedWithCustomError(staking, "Zero");
      await expect(staking.connect(a).unstake(200n * ONE)).to.be.revertedWithCustomError(staking, "Insufficient");
    });
    it("no lock: can unstake in the very same block window", async () => {
      const { a, staking } = await setup();
      await staking.connect(a).stake(100n * ONE);
      await expect(staking.connect(a).unstake(100n * ONE)).to.not.be.reverted; // instant, no delay
    });
  });

  describe("fee-on-transfer stake token (launched coins may tax transfers)", () => {
    it("credits the ACTUAL received amount; last unstaker's principal never bricks", async () => {
      const [owner, a, b] = await ethers.getSigners();
      const FEE = await (await ethers.getContractFactory("MintFeeERC20")).deploy("Taxed", "TAX", 500); // 5% burn
      const staking = await (await ethers.getContractFactory("RobinStaking")).deploy(
        await FEE.getAddress(),
        owner.address
      );
      const saddr = await staking.getAddress();
      for (const u of [a, b]) {
        await FEE.mint(u.address, 10_000n * ONE);
        await FEE.connect(u).approve(saddr, ethers.MaxUint256);
      }
      await staking.connect(a).stake(1000n * ONE); // 5% burned -> ~950 received
      await staking.connect(b).stake(1000n * ONE);
      // credited stake == actual received, not nominal
      expect(await staking.staked(a.address)).to.equal(950n * ONE);
      expect(await staking.totalStaked()).to.equal(1900n * ONE);
      // contract holds exactly what it credited -> both can fully exit, last one included
      await staking.connect(a).unstake(950n * ONE);
      await staking.connect(b).unstake(950n * ONE); // would revert if accounting were nominal
      expect(await staking.totalStaked()).to.equal(0n);
    });
  });

  describe("conservation", () => {
    it("total claimed + forfeited-then-claimed never exceeds funded", async () => {
      const { a, b, c, funder, staking, saddr } = await setup();
      await staking.connect(a).stake(1000n * ONE);
      await staking.connect(b).stake(2000n * ONE);
      await staking.connect(c).stake(3000n * ONE);
      await staking.connect(funder).notifyRewardETH({ value: 6n * ONE });
      await mineAt((await now()) + WEEK + 5); // stream 6: a≈1, b≈2, c≈3

      // b bails (forfeits ~2, which RE-STREAMS to a & c over a fresh window)
      await staking.connect(b).unstake(2000n * ONE);
      await mineAt((await now()) + WEEK + 5); // let the forfeiture finish streaming
      await staking.connect(a).claim(ETH);
      await staking.connect(c).claim(ETH);
      // everything funded (6 ETH) is either claimed or tiny dust — never over-paid, never stuck
      const remaining = await ethers.provider.getBalance(saddr);
      expect(remaining).to.be.gte(0n);
      expect(remaining).to.be.lt(10n ** 13n); // tiny rounding dust only
    });
  });
});

describe("StakingFactory", () => {
  async function setup() {
    const [owner, creator, platform, user] = await ethers.getSigners();
    const COIN = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const STK = await (await ethers.getContractFactory("PausableToken")).deploy(1_000_000n * ONE);
    const factory = await (await ethers.getContractFactory("StakingFactory")).deploy(owner.address, platform.address);
    return { owner, creator, platform, user, COIN, STK, factory };
  }

  it("creates a pool with a curated stock reward basket; authorizes creator + platform", async () => {
    const { owner, creator, platform, COIN, STK, factory } = await setup();
    const coinAddr = await COIN.getAddress();
    const stkAddr = await STK.getAddress();
    await factory.connect(owner).createPool(coinAddr, [stkAddr], [WEEK], creator.address);
    const pool = await factory.poolOf(coinAddr);
    expect(pool).to.not.equal(ethers.ZeroAddress);
    const staking = await ethers.getContractAt("RobinStaking", pool);
    expect(await staking.isRewarder(creator.address)).to.equal(true);
    expect(await staking.isRewarder(platform.address)).to.equal(true);
    expect(await staking.stakeToken()).to.equal(coinAddr);
    // reward assets: ETH (default) + the stock
    expect(await staking.rewardTokensLength()).to.equal(2n);
  });

  it("one pool per stake token; unauthorized cannot create", async () => {
    const { owner, creator, user, COIN, factory } = await setup();
    const coinAddr = await COIN.getAddress();
    await factory.connect(owner).createPool(coinAddr, [], [], creator.address);
    await expect(
      factory.connect(owner).createPool(coinAddr, [], [], creator.address)
    ).to.be.revertedWithCustomError(factory, "PoolExists");
    const COIN2 = await (await ethers.getContractFactory("MockERC20")).deploy(ONE);
    await expect(
      factory.connect(user).createPool(await COIN2.getAddress(), [], [], creator.address)
    ).to.be.revertedWithCustomError(factory, "NotAuthorized");
  });

  it("end-to-end: creator funds stock rewards, user stakes the coin and earns the stock", async () => {
    const { owner, creator, COIN, STK, factory, user } = await setup();
    const coinAddr = await COIN.getAddress();
    const stkAddr = await STK.getAddress();
    await factory.connect(owner).createPool(coinAddr, [stkAddr], [WEEK], creator.address);
    const pool = await factory.poolOf(coinAddr);
    const staking = await ethers.getContractAt("RobinStaking", pool);

    // give the user some coin and stake it
    await COIN.transfer(user.address, 1000n * ONE);
    await COIN.connect(user).approve(pool, ethers.MaxUint256);
    await staking.connect(user).stake(1000n * ONE);

    // creator funds the stock reward
    await STK.transfer(creator.address, 500n * ONE);
    await STK.connect(creator).approve(pool, ethers.MaxUint256);
    await staking.connect(creator).notifyReward(stkAddr, 500n * ONE);

    await mineAt((await now()) + WEEK + 5);
    expect(await staking.earned(user.address, stkAddr)).to.be.closeTo(500n * ONE, 10n ** 11n);
  });
});
