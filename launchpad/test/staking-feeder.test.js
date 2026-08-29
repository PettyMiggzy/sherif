const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;

// [FEEDER] The fuel line. A staking pool with nothing in it pays nothing, and a design that asks
// every creator to remember to top theirs up is one where almost none of them do.
//
// The property worth testing above all others: money that goes in here cannot come out to a wallet.
describe("[FEEDER] staking fuel line", function () {
  this.timeout(120000);
  let owner, keeper, mallory, robin, coin, fac, feeder, pool, F;

  beforeEach(async () => {
    [owner, keeper, mallory] = (await ethers.getSigners()).slice(-3);
    const M = await ethers.getContractFactory("MockERC20");
    robin = await M.connect(owner).deploy(E(1_000_000_000));
    coin = await M.connect(owner).deploy(E(1_000_000_000));
    fac = await (await ethers.getContractFactory("RobinTierStakingFactory")).connect(owner).deploy(owner.address);
    await (await fac.createPool(await robin.getAddress(), true)).wait();
    await (await fac.createPool(await coin.getAddress(), false)).wait();
    pool = await ethers.getContractAt("RobinTierStaking", await fac.poolOf(await coin.getAddress()));
    feeder = await (await ethers.getContractFactory("StakingFeeder"))
      .connect(owner).deploy(owner.address, await fac.getAddress());
    F = await feeder.getAddress();
    await (await feeder.connect(owner).setOperator(keeper.address, true)).wait();
    // The pool owner authorises the feeder once. Until then it is not a rewarder and says so.
    await (await pool.connect(owner).setRewarder(F, true)).wait();
    await (await coin.connect(owner).transfer(mallory.address, E(10_000))).wait();
    await (await coin.connect(mallory).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  });

  it("fuels a pool with ETH, and stakers actually receive it", async () => {
    await (await pool.connect(mallory).stake(E(1000), 2)).wait();          // a 30-day lock
    await owner.sendTransaction({ to: F, value: E(5) });                    // platform revenue arrives
    await (await feeder.connect(keeper).feedEth(await pool.getAddress(), E(5))).wait();
    await time.increase(30 * DAY);
    const earned = await pool.earned(mallory.address, ethers.ZeroAddress);
    console.log(`   staker earned ${ethers.formatEther(earned)} ETH from the fuel line, creator did nothing`);
    expect(earned).to.be.closeTo(E(5), E(0.001));
    expect(await feeder.totalFedEth()).to.equal(E(5));
  });

  it("THERE IS NO PATH TO A WALLET — not for the operator, not for the owner", async () => {
    await owner.sendTransaction({ to: F, value: E(5) });
    // Assert the shape of the ABI, not a behaviour: a payout path that does not exist cannot be
    // reached by a future mistake either.
    const names = feeder.interface.fragments.filter((x) => x.type === "function").map((x) => x.name);
    for (const forbidden of ["withdraw", "sweep", "rescue", "transfer", "emergencyWithdraw", "skim"]) {
      expect(names, `${forbidden} must not exist`).to.not.include(forbidden);
    }
    // Every function that moves value takes a POOL, and a pool is validated against the registry.
    await expect(feeder.connect(keeper).feedEth(mallory.address, E(1)))
      .to.be.revertedWithCustomError(feeder, "NotAPool");
    await expect(feeder.connect(owner).feedEth(owner.address, E(1)))
      .to.be.revertedWithCustomError(feeder, "NotAPool");
    expect(await ethers.provider.getBalance(F)).to.equal(E(5)); // still all there
  });

  it("a look-alike pool cannot be funded — the registry decides, not the contract claiming to be one", async () => {
    // A contract can answer stakeToken() with anything. Only something the FACTORY created counts.
    const fake = await (await ethers.getContractFactory("RobinTierStaking"))
      .connect(mallory).deploy(await coin.getAddress(), mallory.address, ethers.ZeroAddress);
    await owner.sendTransaction({ to: F, value: E(1) });
    await expect(feeder.connect(keeper).feedEth(await fake.getAddress(), E(1)))
      .to.be.revertedWithCustomError(feeder, "NotAPool");
  });

  it("a stolen operator key cannot steal — only choose which real pool gets fuel", async () => {
    await owner.sendTransaction({ to: F, value: E(3) });
    await expect(feeder.connect(mallory).feedEth(await pool.getAddress(), E(1)))
      .to.be.revertedWithCustomError(feeder, "NotOperator");
    // Even WITH the key, the worst it can do is fund a genuine pool early.
    await (await feeder.connect(owner).setOperator(mallory.address, true)).wait();
    await (await pool.connect(mallory).stake(E(1000), 0)).wait();
    await (await feeder.connect(mallory).feedEth(await pool.getAddress(), E(3))).wait();
    expect(await ethers.provider.getBalance(F)).to.equal(0n);
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(E(3));
  });

  it("says plainly when the pool has not authorised it yet", async () => {
    // Otherwise this fails as an opaque revert from inside the pool, and the fix ("add the feeder as
    // a rewarder") is invisible.
    await (await pool.connect(owner).setRewarder(F, false)).wait();
    await owner.sendTransaction({ to: F, value: E(1) });
    await expect(feeder.connect(keeper).feedEth(await pool.getAddress(), E(1)))
      .to.be.revertedWithCustomError(feeder, "NotARewarder");
  });

  it("feeds many pools in one call, which is how a keeper splits a batch of fees", async () => {
    const robinPool = await ethers.getContractAt("RobinTierStaking", await fac.poolOf(await robin.getAddress()));
    await (await robinPool.connect(owner).setRewarder(F, true)).wait();
    await (await robin.connect(owner).approve(await robinPool.getAddress(), ethers.MaxUint256)).wait();
    await (await robinPool.connect(owner).stake(E(1000), 2)).wait();
    await (await pool.connect(mallory).stake(E(1000), 2)).wait();

    await owner.sendTransaction({ to: F, value: E(10) });
    await (await feeder.connect(keeper).feedManyEth(
      [await pool.getAddress(), await robinPool.getAddress()], [E(7), E(3)])).wait();
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(E(7));
    expect(await ethers.provider.getBalance(await robinPool.getAddress())).to.equal(E(3));
  });

  it("cannot spend more fuel than it holds", async () => {
    await owner.sendTransaction({ to: F, value: E(1) });
    await expect(feeder.connect(keeper).feedEth(await pool.getAddress(), E(2)))
      .to.be.revertedWithCustomError(feeder, "Insufficient");
  });
});

describe("[FEEDER] the factory authorises it, so a pool can be funded the moment it exists", function () {
  this.timeout(120000);
  let owner, keeper, robin, coin, fac, feeder;

  beforeEach(async () => {
    [owner, keeper] = (await ethers.getSigners()).slice(-2);
    const M = await ethers.getContractFactory("MockERC20");
    robin = await M.connect(owner).deploy(E(1_000_000_000));
    coin = await M.connect(owner).deploy(E(1_000_000_000));
    fac = await (await ethers.getContractFactory("RobinTierStakingFactory")).connect(owner).deploy(owner.address);
    feeder = await (await ethers.getContractFactory("StakingFeeder"))
      .connect(owner).deploy(owner.address, await fac.getAddress());
  });

  it("a pool created after setFeeder can be funded with no extra step", async () => {
    // The silent failure this prevents: without the rewarder grant, fees accrue, the keeper's call
    // reverts, and the stakers simply never see anything.
    await (await fac.connect(owner).setFeeder(await feeder.getAddress())).wait();
    await (await fac.createPool(await coin.getAddress(), false)).wait();
    const pool = await ethers.getContractAt("RobinTierStaking", await fac.poolOf(await coin.getAddress()));
    expect(await pool.isRewarder(await feeder.getAddress())).to.equal(true);

    await (await coin.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.connect(owner).stake(E(1000), 2)).wait();
    await owner.sendTransaction({ to: await feeder.getAddress(), value: E(1) });
    await (await feeder.connect(owner).feedEth(await pool.getAddress(), E(1))).wait();
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(E(1));
  });

  it("a pool created BEFORE setFeeder is not authorised, and says so rather than failing oddly", async () => {
    await (await fac.createPool(await coin.getAddress(), false)).wait();
    const pool = await ethers.getContractAt("RobinTierStaking", await fac.poolOf(await coin.getAddress()));
    expect(await pool.isRewarder(await feeder.getAddress())).to.equal(false);
    await owner.sendTransaction({ to: await feeder.getAddress(), value: E(1) });
    await expect(feeder.connect(owner).feedEth(await pool.getAddress(), E(1)))
      .to.be.revertedWithCustomError(feeder, "NotARewarder");
    // ...and the pool's owner can repair it, since the factory no longer owns the pool.
    await (await pool.connect(owner).setRewarder(await feeder.getAddress(), true)).wait();
    await (await coin.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.connect(owner).stake(E(1000), 2)).wait();
    await expect(feeder.connect(owner).feedEth(await pool.getAddress(), E(1))).to.not.be.reverted;
  });
});
