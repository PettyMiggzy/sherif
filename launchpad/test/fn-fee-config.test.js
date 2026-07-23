const { expect } = require("chai");
const { ethers } = require("hardhat");

// Unit tests for FeeConfig — the pad's single owner-governed fee dial. No fork needed: this contract
// only holds ratios, never funds. Covers the on-chain safety caps, the sum-to-100% invariant, the
// events, and onlyOwner enforcement.
// Run: npx hardhat test test/fn-fee-config.test.js
describe("FeeConfig — owner-governed fee dials", function () {
  async function deploy() {
    const [owner, stranger] = await ethers.getSigners();
    const fc = await (await ethers.getContractFactory("FeeConfig")).deploy(owner.address);
    return { fc, owner, stranger };
  }

  it("ships with sane defaults (LP 10% creator, swap 45/45/10)", async () => {
    const { fc } = await deploy();
    expect(await fc.lpCreatorBps()).to.equal(1000);
    expect(await fc.LP_CREATOR_MAX()).to.equal(5000);
    const [p, c, f] = await fc.swapSplit();
    expect(p).to.equal(4500);
    expect(c).to.equal(4500);
    expect(f).to.equal(1000);
  });

  it("setLpCreatorBps: accepts up to the 50% cap, rejects above it, and emits LpSplitChanged", async () => {
    const { fc } = await deploy();

    // at the cap is fine
    await expect(fc.setLpCreatorBps(5000)).to.emit(fc, "LpSplitChanged").withArgs(5000);
    expect(await fc.lpCreatorBps()).to.equal(5000);

    // a normal retune emits the event
    await expect(fc.setLpCreatorBps(2500)).to.emit(fc, "LpSplitChanged").withArgs(2500);
    expect(await fc.lpCreatorBps()).to.equal(2500);

    // above LP_CREATOR_MAX -> revert, state unchanged
    await expect(fc.setLpCreatorBps(5001)).to.be.revertedWith("lp cap");
    expect(await fc.lpCreatorBps()).to.equal(2500);
  });

  it("setSwapSplit: requires the three shares to sum to exactly 10000 and emits SwapSplitChanged", async () => {
    const { fc } = await deploy();

    // a valid split (sums to 100%)
    await expect(fc.setSwapSplit(6000, 3000, 1000))
      .to.emit(fc, "SwapSplitChanged").withArgs(6000, 3000, 1000);
    const [p, c, f] = await fc.swapSplit();
    expect(p).to.equal(6000); expect(c).to.equal(3000); expect(f).to.equal(1000);

    // under 100% -> revert
    await expect(fc.setSwapSplit(4500, 4500, 500)).to.be.revertedWith("sum");
    // over 100% -> revert
    await expect(fc.setSwapSplit(5000, 4500, 1000)).to.be.revertedWith("sum");
    // unchanged after the two failed calls
    const [p2, c2, f2] = await fc.swapSplit();
    expect(p2).to.equal(6000); expect(c2).to.equal(3000); expect(f2).to.equal(1000);
  });

  it("both setters are onlyOwner", async () => {
    const { fc, stranger } = await deploy();
    await expect(fc.connect(stranger).setLpCreatorBps(1000))
      .to.be.revertedWithCustomError(fc, "OwnableUnauthorizedAccount");
    await expect(fc.connect(stranger).setSwapSplit(4500, 4500, 1000))
      .to.be.revertedWithCustomError(fc, "OwnableUnauthorizedAccount");
  });
});
