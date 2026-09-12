const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinBurnTracker — permissionless self-burn with an on-chain per-account tally. One shared deployment across
// every pad token (same "deployed once, reused everywhere" shape as Disperse); this is the on-chain half of
// "burn-boost" — the off-chain dividend-snapshot indexer reads burnedBy(token, account) when weighting the
// NEXT RobinDividendPool epoch. No on-chain weighting formula, no owner, no rescue, no un-burn.

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = ethers.ZeroAddress;

describe("RobinBurnTracker", () => {
  let a, b, tok, tok2, tracker;

  beforeEach(async () => {
    [, a, b] = await ethers.getSigners();
    tracker = await (await ethers.getContractFactory("RobinBurnTracker")).deploy();
    tok = await (await ethers.getContractFactory("TestERC20")).connect(a).deploy(10n ** 24n);
    tok2 = await (await ethers.getContractFactory("TestERC20")).connect(b).deploy(10n ** 24n);
  });

  it("burns via transferFrom to the dead address and tallies the caller", async () => {
    await tok.connect(a).approve(await tracker.getAddress(), ethers.MaxUint256);
    await expect(tracker.connect(a).burn(await tok.getAddress(), 100n))
      .to.emit(tracker, "Burned").withArgs(await tok.getAddress(), a.address, 100n, 100n);
    expect(await tok.balanceOf(DEAD)).to.equal(100n);
    expect(await tracker.burnedBy(await tok.getAddress(), a.address)).to.equal(100n);
    expect(await tracker.totalBurned(await tok.getAddress())).to.equal(100n);
  });

  it("accumulates across multiple burns by the same account", async () => {
    await tok.connect(a).approve(await tracker.getAddress(), ethers.MaxUint256);
    await tracker.connect(a).burn(await tok.getAddress(), 100n);
    await tracker.connect(a).burn(await tok.getAddress(), 50n);
    expect(await tracker.burnedBy(await tok.getAddress(), a.address)).to.equal(150n);
    expect(await tracker.totalBurned(await tok.getAddress())).to.equal(150n);
  });

  it("tracks each (token, account) pair independently", async () => {
    await tok.connect(a).transfer(b.address, 1000n);
    await tok.connect(a).approve(await tracker.getAddress(), ethers.MaxUint256);
    await tok.connect(b).approve(await tracker.getAddress(), ethers.MaxUint256);
    await tok2.connect(b).approve(await tracker.getAddress(), ethers.MaxUint256);

    await tracker.connect(a).burn(await tok.getAddress(), 10n);
    await tracker.connect(b).burn(await tok.getAddress(), 20n);
    await tracker.connect(b).burn(await tok2.getAddress(), 30n);

    expect(await tracker.burnedBy(await tok.getAddress(), a.address)).to.equal(10n);
    expect(await tracker.burnedBy(await tok.getAddress(), b.address)).to.equal(20n);
    expect(await tracker.burnedBy(await tok2.getAddress(), b.address)).to.equal(30n);
    expect(await tracker.burnedBy(await tok2.getAddress(), a.address)).to.equal(0n); // untouched
    expect(await tracker.totalBurned(await tok.getAddress())).to.equal(30n);
  });

  it("cannot burn zero", async () => {
    await tok.connect(a).approve(await tracker.getAddress(), ethers.MaxUint256);
    await expect(tracker.connect(a).burn(await tok.getAddress(), 0)).to.be.revertedWithCustomError(tracker, "ZeroAmount");
  });

  it("cannot burn tokens the caller has not approved (no 'burn on behalf of' path)", async () => {
    // b never approved the tracker to move a's tokens; a cannot credit b's tally by calling on b's behalf either
    // — msg.sender is always both payer and credited account, so this can only ever revert on the ERC20 pull.
    await expect(tracker.connect(a).burn(await tok.getAddress(), 10n)).to.be.reverted; // no approval yet
  });

  it("a bad/reverting token cannot brick anyone else's burn — reverts are per-call, no shared state", async () => {
    await tok.connect(a).approve(await tracker.getAddress(), ethers.MaxUint256);
    await expect(tracker.connect(a).burn(ZERO, 10n)).to.be.reverted; // address(0) has no code — call fails
    // tracker itself is untouched; a's real token burn still works right after
    await tracker.connect(a).burn(await tok.getAddress(), 5n);
    expect(await tracker.burnedBy(await tok.getAddress(), a.address)).to.equal(5n);
  });
});
