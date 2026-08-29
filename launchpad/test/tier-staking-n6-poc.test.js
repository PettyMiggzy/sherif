const { expect } = require("chai");
const { ethers } = require("hardhat");

// N6 (re-audit, MEDIUM): the factory hands over ownership but never re-points `strandedSink`.
// RobinTierStaking's constructor sets `strandedSink = owner_`, and the factory constructs every pool
// owned by ITSELF so it can run the onlyOwner setup. So every factory-created pool shipped with its
// exit-tax pot aimed at the factory — which has no token-exit path of any kind. `sweepStranded` is
// permissionless, so ANY passer-by could send the 15% penalties somewhere they can never come back from.
describe("[N6] the factory must not leave the exit-tax pot aimed at itself", function () {
  async function setup() {
    const [owner, alice] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const robin = await T.deploy(ethers.parseEther("100000000"));
    const coin = await T.deploy(ethers.parseEther("100000000"));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    await (await factory.createPool(await robin.getAddress(), true)).wait();
    await (await factory.createPool(await coin.getAddress(), false)).wait();
    return { owner, alice, robin, coin, factory };
  }

  it("the flagship pool points its pot at the OWNER, not the factory", async () => {
    const { owner, robin, factory } = await setup();
    const p = await ethers.getContractAt("RobinTierStaking", await factory.poolOf(await robin.getAddress()));
    expect(await p.strandedSink()).to.equal(owner.address);
    expect(await p.strandedSink()).to.not.equal(await factory.getAddress());
  });

  it("every satellite pool does too", async () => {
    const { owner, coin, factory } = await setup();
    const p = await ethers.getContractAt("RobinTierStaking", await factory.poolOf(await coin.getAddress()));
    expect(await p.strandedSink()).to.equal(owner.address);
    expect(await p.strandedSink()).to.not.equal(await factory.getAddress());
  });

  it("a stranger sweeping the pot cannot freeze it in the factory", async () => {
    const { owner, alice, coin, factory } = await setup();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);

    // Alice locks for a year and bails early — a 15% tax, and she is the only staker, so it strands.
    await (await coin.transfer(alice.address, ethers.parseEther("1000"))).wait();
    await (await coin.connect(alice).approve(pool, ethers.MaxUint256)).wait();
    await (await p.connect(alice).stake(ethers.parseEther("1000"), 6)).wait();
    await (await p.connect(alice).withdraw(0)).wait();

    const pot = await p.stranded(await coin.getAddress());
    expect(pot).to.equal(ethers.parseEther("150")); // 15% of 1000

    // sweepStranded is permissionless by design (the pot should be visible and movable by anyone).
    await (await p.connect(alice).sweepStranded(await coin.getAddress())).wait();

    expect(await coin.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await coin.balanceOf(owner.address)).to.be.gte(pot);
    console.log(`   swept ${ethers.formatEther(pot)} — factory holds ${ethers.formatEther(await coin.balanceOf(await factory.getAddress()))}`);
  });
});
