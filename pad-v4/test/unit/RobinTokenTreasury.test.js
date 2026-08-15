const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinTokenTreasury — the per-pad TOKEN-fee split + public burn treasury.
// The platform holds NO pad tokens; every token-side LP fee lands here and splits 70% staking / 30% burn reserve,
// with the creator (and only the creator) able to burn the retained 30% to the dead address. No withdraw path.

const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("RobinTokenTreasury — 70/30 token-fee split + creator burn", () => {
  let owner, creator, staking, stranger, token, treasury;

  beforeEach(async () => {
    [owner, creator, staking, stranger] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 27n);
    treasury = await (await ethers.getContractFactory("RobinTokenTreasury")).deploy(
      await token.getAddress(), staking.address, creator.address
    );
  });

  it("rejects zero addresses in the constructor", async () => {
    const F = await ethers.getContractFactory("RobinTokenTreasury");
    await expect(F.deploy(ethers.ZeroAddress, staking.address, creator.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(await token.getAddress(), ethers.ZeroAddress, creator.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(await token.getAddress(), staking.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("splits arrivals 70% to staking / 30% retained as burn reserve", async () => {
    await token.connect(owner).transfer(await treasury.getAddress(), 1000n);
    expect(await treasury.pendingStaking()).to.equal(1000n);

    await treasury.connect(stranger).distribute(); // permissionless
    expect(await token.balanceOf(staking.address)).to.equal(700n);
    expect(await treasury.burnReserve()).to.equal(300n);
    expect(await treasury.totalToStaking()).to.equal(700n);
    // the retained 30% stays in the contract; pendingStaking is now 0 (nothing new)
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(300n);
    expect(await treasury.pendingStaking()).to.equal(0n);
  });

  it("is idempotent — a second distribute with no new arrivals never re-splits the retained reserve", async () => {
    await token.connect(owner).transfer(await treasury.getAddress(), 1000n);
    await treasury.distribute();
    await treasury.distribute(); // no-op
    expect(await treasury.burnReserve()).to.equal(300n);
    expect(await token.balanceOf(staking.address)).to.equal(700n);
  });

  it("accumulates the burn reserve across multiple fee arrivals", async () => {
    await token.connect(owner).transfer(await treasury.getAddress(), 1000n);
    await treasury.distribute();
    await token.connect(owner).transfer(await treasury.getAddress(), 2000n);
    await treasury.distribute();
    // 30% of (1000 + 2000) = 900 retained; 70% of 3000 = 2100 to staking
    expect(await treasury.burnReserve()).to.equal(900n);
    expect(await token.balanceOf(staking.address)).to.equal(2100n);
  });

  it("lets ONLY the creator burn the retained reserve, to the dead address, and zeroes it", async () => {
    await token.connect(owner).transfer(await treasury.getAddress(), 1000n);
    await treasury.distribute();

    await expect(treasury.connect(stranger).burn()).to.be.revertedWithCustomError(treasury, "NotCreator");

    const deadBefore = await token.balanceOf(DEAD);
    await expect(treasury.connect(creator).burn()).to.emit(treasury, "Burned").withArgs(creator.address, 300n, 300n);
    expect(await token.balanceOf(DEAD)).to.equal(deadBefore + 300n);
    expect(await treasury.burnReserve()).to.equal(0n);
    expect(await treasury.totalBurned()).to.equal(300n);
    // nothing left to burn
    await expect(treasury.connect(creator).burn()).to.be.revertedWithCustomError(treasury, "NothingToBurn");
  });

  it("exposes NO withdraw/rescue/owner path — token can only leave to staking or dead", () => {
    const banned = ["withdraw", "rescue", "sweep", "transfertoken", "owner", "setstaking", "setcreator", "recover"];
    const names = treasury.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const b of banned) expect(names).to.not.include(b);
    // the only outward-moving selectors:
    expect(names).to.include("distribute");
    expect(names).to.include("burn");
  });

  it("conserves dust into the burn reserve (odd amounts never strand wei)", async () => {
    await token.connect(owner).transfer(await treasury.getAddress(), 7n); // 70% = 4 (floor), remainder 3 → reserve
    await treasury.distribute();
    expect(await token.balanceOf(staking.address)).to.equal(4n);
    expect(await treasury.burnReserve()).to.equal(3n);
    expect(4n + 3n).to.equal(7n); // nothing lost
  });
});
