const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("FeeWalletRegistry — the only mutable knob (2-step + 2-day timelock)", () => {
  let owner, other, w1, w2, reg;

  beforeEach(async () => {
    [owner, other, w1, w2] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(w1.address, owner.address);
  });

  it("starts at the initial wallet", async () => {
    expect(await reg.platformFeeWallet()).to.equal(w1.address);
  });

  it("only owner can propose", async () => {
    await expect(reg.connect(other).proposePlatformFeeWallet(w2.address)).to.be.reverted;
  });

  it("cannot commit before the timelock elapses", async () => {
    await reg.connect(owner).proposePlatformFeeWallet(w2.address);
    await expect(reg.connect(owner).commitPlatformFeeWallet()).to.be.revertedWithCustomError(
      reg,
      "TimelockNotElapsed"
    );
    expect(await reg.platformFeeWallet()).to.equal(w1.address); // unchanged
  });

  it("commits after 2 days", async () => {
    await reg.connect(owner).proposePlatformFeeWallet(w2.address);
    await time.increase(2 * 24 * 3600 + 1);
    await reg.connect(owner).commitPlatformFeeWallet();
    expect(await reg.platformFeeWallet()).to.equal(w2.address);
  });

  it("cancel clears a pending proposal", async () => {
    await reg.connect(owner).proposePlatformFeeWallet(w2.address);
    await reg.connect(owner).cancelProposal();
    await time.increase(2 * 24 * 3600 + 1);
    await expect(reg.connect(owner).commitPlatformFeeWallet()).to.be.revertedWithCustomError(reg, "NoProposal");
    expect(await reg.platformFeeWallet()).to.equal(w1.address);
  });

  it("rejects the zero wallet", async () => {
    await expect(reg.connect(owner).proposePlatformFeeWallet(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      reg,
      "ZeroAddress"
    );
  });
});
