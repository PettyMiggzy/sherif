const { expect } = require("chai");
const { ethers } = require("hardhat");

// [TIERFAC] The registry that lets the staking page be a LIST instead of a constant. What matters here is not
// "can it deploy a pool" — it is the wiring that is invisible when it is wrong: a pool with no boost source
// works perfectly and silently boosts nobody, and a pool the owner cannot fund looks fine until the first
// reward never arrives.
const E = (n) => ethers.parseEther(String(n));

describe("[TIERFAC] tiered staking factory", function () {
  this.timeout(120000);
  let owner, keeper, alice, robin, coin, fac;

  beforeEach(async () => {
    [owner, keeper, alice] = (await ethers.getSigners()).slice(-3);
    const M = await ethers.getContractFactory("MockERC20");
    robin = await M.connect(owner).deploy(E(1_000_000_000));
    coin = await M.connect(owner).deploy(E(1_000_000_000));
    fac = await (await ethers.getContractFactory("RobinTierStakingFactory")).connect(owner).deploy(owner.address);
  });

  const poolAt = async (a) => ethers.getContractAt("RobinTierStaking", a);

  it("the flagship pool is its own boost source, wired in the same transaction", async () => {
    await (await fac.connect(owner).createPool(await robin.getAddress(), true)).wait();
    const addr = await fac.poolOf(await robin.getAddress());
    const p = await poolAt(addr);
    // Not "a source is set" — the RIGHT source. A pool pointed at the wrong contract boosts nobody, and
    // nothing about the pool looks broken when that happens.
    expect(await p.boostSource()).to.equal(addr);
    expect(await fac.boostSource()).to.equal(addr);
  });

  it("every later pool inherits the flagship as its boost source", async () => {
    await (await fac.connect(owner).createPool(await robin.getAddress(), true)).wait();
    const flagship = await fac.poolOf(await robin.getAddress());
    await (await fac.connect(owner).createPool(await coin.getAddress(), false)).wait();
    const p = await poolAt(await fac.poolOf(await coin.getAddress()));
    expect(await p.boostSource()).to.equal(flagship);
  });

  it("the owner ends up owning the pool AND able to fund it", async () => {
    // The regression this locks down: the pool's constructor makes the DEPLOYER a rewarder, and the deployer
    // is the factory. Get the handover wrong and the owner owns a pool they cannot pay rewards into, while
    // the factory can fund every pool forever.
    await (await fac.connect(owner).createPool(await coin.getAddress(), false)).wait();
    const addr = await fac.poolOf(await coin.getAddress());
    const p = await poolAt(addr);
    expect(await p.owner()).to.equal(owner.address);
    expect(await p.isRewarder(owner.address)).to.equal(true);
    expect(await p.isRewarder(await fac.getAddress())).to.equal(false);

    await (await coin.connect(owner).approve(addr, ethers.MaxUint256)).wait();
    await expect(p.connect(owner).notifyReward(await coin.getAddress(), E(100))).to.not.be.reverted;
  });

  it("a creator slot adds pools but does not control them", async () => {
    // This is what makes graduation able to mint a pool with no human in the loop, without that automation
    // key also being a key to every pool's settings.
    await expect(fac.connect(keeper).createPool(await coin.getAddress(), false))
      .to.be.revertedWithCustomError(fac, "NotCreator");
    await (await fac.connect(owner).setCreator(keeper.address, true)).wait();
    await (await fac.connect(keeper).createPool(await coin.getAddress(), false)).wait();

    const p = await poolAt(await fac.poolOf(await coin.getAddress()));
    expect(await p.owner()).to.equal(owner.address);
    await expect(p.connect(keeper).setRewarder(keeper.address, true)).to.be.reverted;
  });

  it("one token can only ever have one pool", async () => {
    await (await fac.connect(owner).createPool(await coin.getAddress(), false)).wait();
    // Two pools for one token splits the stakers and the rewards, and `poolOf` stops being an answer.
    await expect(fac.connect(owner).createPool(await coin.getAddress(), false))
      .to.be.revertedWithCustomError(fac, "PoolExists");
  });

  it("the whole list is readable in one call, which is what the site renders", async () => {
    await (await fac.connect(owner).createPool(await robin.getAddress(), true)).wait();
    await (await fac.connect(owner).createPool(await coin.getAddress(), false)).wait();
    const list = await fac.pools();
    expect(list.length).to.equal(2);
    expect(await fac.allPoolsLength()).to.equal(2n);
    expect(list[0]).to.equal(await fac.poolOf(await robin.getAddress()));
    expect(list[1]).to.equal(await fac.poolOf(await coin.getAddress()));
  });

  it("creation is closed by default and can be opened deliberately", async () => {
    await expect(fac.connect(alice).createPool(await coin.getAddress(), false))
      .to.be.revertedWithCustomError(fac, "NotCreator");
    await (await fac.connect(owner).setOpenCreation(true)).wait();
    await expect(fac.connect(alice).createPool(await coin.getAddress(), false)).to.not.be.reverted;
  });

  it("a pool created before the flagship exists can be repointed", async () => {
    // Order is not guaranteed in a real deploy, so a pool that came first must not be permanently unboosted.
    await (await fac.connect(owner).createPool(await coin.getAddress(), false)).wait();
    const p = await poolAt(await fac.poolOf(await coin.getAddress()));
    expect(await p.boostSource()).to.equal(ethers.ZeroAddress);

    await (await fac.connect(owner).createPool(await robin.getAddress(), true)).wait();
    const flagship = await fac.poolOf(await robin.getAddress());
    await (await p.connect(owner).setBoost(flagship, await p.boostThreshold(), await p.boostBps())).wait();
    expect(await p.boostSource()).to.equal(flagship);
  });
});
