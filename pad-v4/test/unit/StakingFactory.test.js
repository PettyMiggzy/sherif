const { ethers } = require("hardhat");
const { expect } = require("chai");

// StakingFactory — one call gives ANY token a stake-to-earn pool with the platform economics baked in.

describe("StakingFactory — any-token stake-to-earn", () => {
  let owner, treasury, platformOwner, creator, alice, tok, stock, factory;

  beforeEach(async () => {
    [owner, treasury, platformOwner, creator, alice] = await ethers.getSigners();
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    stock = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    factory = await (await ethers.getContractFactory("StakingFactory")).deploy(
      treasury.address, platformOwner.address, 500 // 5%
    );
  });

  it("creates a single-book pool with the 5% fee + no lock, handed to the platform owner", async () => {
    const tx = await factory.createPool(await tok.getAddress(), ethers.ZeroAddress, 0, creator.address);
    await tx.wait();
    expect(await factory.allPoolsLength()).to.equal(1n);
    const poolAddr = await factory.allPools(0);

    const ds = await ethers.getContractAt("DualStaking", poolAddr);
    expect(await ds.platformClaimFeeBps()).to.equal(500n);
    expect(await ds.platformTreasury()).to.equal(treasury.address);
    expect(await ds.antiJitDelay()).to.equal(0n); // no lock
    expect(await ds.isRewarder(creator.address)).to.equal(true); // creator can fund
    expect(await ds.isRewarder(platformOwner.address)).to.equal(true);

    // ownership is a pending 2-step transfer to the platform multisig
    expect(await ds.pendingOwner()).to.equal(platformOwner.address);
    await ds.connect(platformOwner).acceptOwnership();
    expect(await ds.owner()).to.equal(platformOwner.address);

    // it works: alice stakes the coin immediately, no lock
    await tok.connect(owner).transfer(alice.address, 10n ** 21n);
    await tok.connect(alice).approve(poolAddr, ethers.MaxUint256);
    await ds.connect(alice).stake(0, 1000n);
    expect(await ds.totalStaked(0)).to.equal(1000n);
    await ds.connect(alice).unstake(0, 1000n); // instantly, no lock
    expect(await ds.staked(0, alice.address)).to.equal(0n);
  });

  it("creates a two-book pool when a stock is supplied", async () => {
    await factory.createPool(await tok.getAddress(), await stock.getAddress(), 3600, ethers.ZeroAddress);
    const poolAddr = await factory.allPools(0);
    const ds = await ethers.getContractAt("DualStaking", poolAddr);
    expect(await ds.antiJitDelay()).to.equal(3600n);
    expect(await ds.stockAsset()).to.equal(await stock.getAddress());
    expect(await factory.poolsOfLength(await tok.getAddress())).to.equal(1n);
  });

  it("rejects a fee above 10% at construction", async () => {
    await expect(
      (await ethers.getContractFactory("StakingFactory")).deploy(treasury.address, platformOwner.address, 1500)
    ).to.be.revertedWithCustomError(factory, "FeeTooHigh");
  });
});
