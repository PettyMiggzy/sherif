const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Feature 2 — adversarial / edge coverage for DualStaking. The cases that protect stakers' money:
// partial unstake keeps proportional future rewards, an empty pool pauses the stream and kickstarts
// it losslessly, forfeiture does NOT reset the window (anti-grief), the STOCK book is independent,
// boost re-sync works without a stake, and funding is rewarder-gated with the reward-token cap enforced.

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DAY = 86400;
const TOKEN = 0, STOCK = 1;

async function erc20(to, amount = 10n ** 30n) {
  return (await ethers.getContractFactory("TestERC20")).connect(to).deploy(amount);
}

describe("DualStaking — adversarial", () => {
  let owner, rewarder, alice, bob, tok, stk, ds;

  beforeEach(async () => {
    [owner, rewarder, alice, bob] = await ethers.getSigners();
    tok = await erc20(owner);
    stk = await erc20(owner);
    ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), await stk.getAddress(), owner.address, DAY, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    await ds.setRewarder(rewarder.address, true);
    for (const u of [alice, bob]) {
      await tok.connect(owner).transfer(u.address, 10n ** 24n);
      await stk.connect(owner).transfer(u.address, 10n ** 24n);
      await tok.connect(u).approve(await ds.getAddress(), ethers.MaxUint256);
      await stk.connect(u).approve(await ds.getAddress(), ethers.MaxUint256);
    }
  });

  it("partial unstake forfeits pending but keeps earning on the remainder", async () => {
    await ds.connect(alice).stake(TOKEN, 1000n);
    await ds.connect(rewarder).fundETH(TOKEN, { value: ethers.parseEther("7") });
    await time.increase(DAY + 1); // past anti-jit; ~1 day of a 7-day stream accrued
    expect(await ds.earned(TOKEN, alice.address, ETH)).to.be.gt(0n);

    await ds.connect(alice).unstake(TOKEN, 500n); // partial → forfeits current pending, keeps 500 staked
    expect(await ds.earned(TOKEN, alice.address, ETH)).to.equal(0n);
    expect(await ds.staked(TOKEN, alice.address)).to.equal(500n);

    await time.increase(7 * DAY);
    // still the only staker → she re-earns the forfeited + remaining stream on her 500
    expect(await ds.earned(TOKEN, alice.address, ETH)).to.be.gt(0n);
  });

  it("empty pool pauses the stream, and a later stake kickstarts it losslessly", async () => {
    await ds.connect(alice).stake(TOKEN, 1000n);
    await ds.connect(rewarder).fundETH(TOKEN, { value: ethers.parseEther("7") });
    await time.increase(DAY + 1);
    await ds.connect(alice).unstake(TOKEN, 1000n); // pool empties mid-stream → remainder parks in pending

    await time.increase(30 * DAY); // long gap; parked rewards must NOT leak to nobody
    await ds.connect(bob).stake(TOKEN, 1000n); // kickstart
    await time.increase(7 * DAY + 10);
    // bob receives the parked remainder streamed fresh (a meaningful chunk of the original 7 ETH)
    expect(await ds.earned(TOKEN, bob.address, ETH)).to.be.gt(ethers.parseEther("2"));
  });

  it("forfeiture recycles into the REMAINING window (no reset / dilution grief)", async () => {
    await ds.connect(alice).stake(TOKEN, 1000n);
    await ds.connect(bob).stake(TOKEN, 1000n);
    await ds.connect(rewarder).fundETH(TOKEN, { value: ethers.parseEther("7") });
    await time.increase(DAY + 1);
    const finishBefore = (await ds.rewardInfo(TOKEN, ETH)).periodFinish;
    await ds.connect(bob).unstake(TOKEN, 1000n); // forfeits into the remaining window
    const finishAfter = (await ds.rewardInfo(TOKEN, ETH)).periodFinish;
    // periodFinish must NOT be pushed out by a forfeiture (that would let a griefer perpetually reset it)
    expect(finishAfter).to.equal(finishBefore);
  });

  it("the STOCK book is fully independent", async () => {
    await ds.connect(alice).stake(STOCK, 500n);
    await ds.connect(rewarder).fundETH(STOCK, { value: ethers.parseEther("3") });
    await time.increase(7 * DAY + 10);
    expect(await ds.earned(STOCK, alice.address, ETH)).to.be.gt(ethers.parseEther("2.9"));
    // TOKEN side saw nothing
    expect(await ds.totalStaked(TOKEN)).to.equal(0n);
    expect(await ds.earned(TOKEN, alice.address, ETH)).to.equal(0n);
  });

  it("sync() re-weights on a boost change with no stake action", async () => {
    const oracle = await (await ethers.getContractFactory("MockBoostOracle")).deploy();
    await ds.connect(owner).setBoostOracle(await oracle.getAddress());
    await ds.connect(alice).stake(TOKEN, 1000n); // weight 1000 (1x)
    expect(await ds.weight(TOKEN, alice.address)).to.equal(1000n);
    await oracle.set(TOKEN, alice.address, 30000); // 3x
    await ds.sync(TOKEN, alice.address);
    expect(await ds.weight(TOKEN, alice.address)).to.equal(3000n);
    expect(await ds.totalWeight(TOKEN)).to.equal(3000n);
  });

  it("funding is rewarder-gated and enforces the reward-token cap", async () => {
    await expect(ds.connect(bob).fundETH(TOKEN, { value: 1n })).to.be.revertedWithCustomError(ds, "NotRewarder");
    await expect(ds.connect(bob).fundToken(TOKEN, await stk.getAddress(), 1n)).to.be.revertedWithCustomError(ds, "NotRewarder");

    // list up to the cap (ETH is already listed on each side in the ctor → 1 slot used; 7 more allowed)
    for (let i = 0; i < 7; i++) {
      const t = await erc20(owner);
      await ds.connect(owner).listReward(TOKEN, await t.getAddress(), 7 * DAY);
    }
    const over = await erc20(owner);
    await expect(ds.connect(owner).listReward(TOKEN, await over.getAddress(), 7 * DAY)).to.be.revertedWithCustomError(ds, "TooManyRewards");
  });

  it("a bad side index is rejected everywhere", async () => {
    await expect(ds.connect(alice).stake(2, 1n)).to.be.revertedWithCustomError(ds, "BadSide");
    await expect(ds.connect(rewarder).fundETH(2, { value: 1n })).to.be.revertedWithCustomError(ds, "BadSide");
  });

  it("platform claim fee: staker gets 95%, platform accrues 5%, no lock", async () => {
    await ds.connect(owner).setPlatformClaimFee(500); // 5%
    await ds.connect(owner).setPlatformTreasury(bob.address);
    await ds.connect(alice).stake(TOKEN, 1000n);
    await ds.connect(rewarder).fundETH(TOKEN, { value: ethers.parseEther("10") });
    await time.increase(7 * DAY + 10);

    const gross = await ds.earned(TOKEN, alice.address, ETH);
    expect(gross).to.be.gt(0n);
    const aBefore = await ethers.provider.getBalance(alice.address);
    const tx = await (await ds.connect(alice).claim(TOKEN, ETH)).wait();
    const gasPaid = tx.gasUsed * tx.gasPrice;
    const got = (await ethers.provider.getBalance(alice.address)) - aBefore + gasPaid;

    const fee = (gross * 500n) / 10000n;
    expect(got).to.equal(gross - fee); // staker got 95%
    expect(await ds.platformFeesOwed(ETH)).to.equal(fee); // 5% accrued

    // platform pulls its cut to the treasury (bob)
    const bBefore = await ethers.provider.getBalance(bob.address);
    await ds.connect(rewarder).claimPlatformFees(ETH); // permissionless; goes to treasury
    expect((await ethers.provider.getBalance(bob.address)) - bBefore).to.equal(fee);
  });

  it("[F1] shipped default claim fee 0 — a TOKEN reward skims ZERO to the platform (invariant holds)", async () => {
    // The pad-token staking pool rewards the PAD TOKEN (the 70% LP-fee stream). A platform claim-fee would skim
    // that token to platformTreasury (== platformFeeWallet in the deploy), breaking "platform holds no pad token".
    // The shipped deploy fixes this by defaulting the fee to 0. `stk` stands in for the token reward asset.
    await ds.connect(owner).listReward(TOKEN, await stk.getAddress(), DAY);
    await ds.connect(owner).setPlatformTreasury(bob.address); // a platform-controlled key
    expect(await ds.platformClaimFeeBps()).to.equal(0n); // shipped default (deploy.js CLAIM_FEE_BPS = 0)
    await ds.connect(alice).stake(TOKEN, 1000n);
    await stk.connect(owner).transfer(rewarder.address, ethers.parseEther("10"));
    await stk.connect(rewarder).approve(await ds.getAddress(), ethers.MaxUint256);
    await ds.connect(rewarder).fundToken(TOKEN, await stk.getAddress(), ethers.parseEther("10"));
    await time.increase(DAY + 10);
    expect(await ds.earned(TOKEN, alice.address, await stk.getAddress())).to.be.gt(0n);
    const bBefore = await stk.balanceOf(bob.address);
    await ds.connect(alice).claim(TOKEN, await stk.getAddress());
    expect(await ds.platformFeesOwed(await stk.getAddress())).to.equal(0n); // platform accrued NO token
    await expect(ds.connect(rewarder).claimPlatformFees(await stk.getAddress())).to.be.revertedWithCustomError(ds, "Zero");
    expect(await stk.balanceOf(bob.address)).to.equal(bBefore); // treasury received zero token
  });

  it("[F1] proves the leak the fee-0 default prevents — a nonzero token claim fee reaches the platform key", async () => {
    await ds.connect(owner).listReward(TOKEN, await stk.getAddress(), DAY);
    await ds.connect(owner).setPlatformClaimFee(500); // the mis-config that re-opens F1
    await ds.connect(owner).setPlatformTreasury(bob.address);
    await ds.connect(alice).stake(TOKEN, 1000n);
    await stk.connect(owner).transfer(rewarder.address, ethers.parseEther("10"));
    await stk.connect(rewarder).approve(await ds.getAddress(), ethers.MaxUint256);
    await ds.connect(rewarder).fundToken(TOKEN, await stk.getAddress(), ethers.parseEther("10"));
    await time.increase(DAY + 10);
    await ds.connect(alice).claim(TOKEN, await stk.getAddress());
    expect(await ds.platformFeesOwed(await stk.getAddress())).to.be.gt(0n); // token accrued to the platform
    const bBefore = await stk.balanceOf(bob.address);
    await ds.connect(rewarder).claimPlatformFees(await stk.getAddress());
    expect(await stk.balanceOf(bob.address)).to.be.gt(bBefore); // platform key received pad-side token — the F1 leak
  });

  it("single-book pool (no paired stock): TOKEN stakes, STOCK side is disabled", async () => {
    const solo = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), ethers.ZeroAddress, owner.address, 0, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    await tok.connect(alice).approve(await solo.getAddress(), ethers.MaxUint256);
    await solo.connect(alice).stake(TOKEN, 100n); // works
    expect(await solo.totalStaked(TOKEN)).to.equal(100n);
    await expect(solo.connect(alice).stake(STOCK, 100n)).to.be.revertedWithCustomError(solo, "SideDisabled");
  });

  it("claim fee is capped at 10%", async () => {
    await expect(ds.connect(owner).setPlatformClaimFee(1500)).to.be.revertedWithCustomError(ds, "BadParam");
  });

  it("[audit C1] fundTokenPushed can NEVER pay out staked principal (stake asset == other-side reward)", async () => {
    // The 'earn the other' config: stk is the STOCK-side stake asset AND a listed TOKEN-side reward.
    await ds.connect(owner).listReward(TOKEN, await stk.getAddress(), 7 * DAY);
    // alice stakes 1000e18 stk as PRINCIPAL on the STOCK side
    const principal = 1000n * 10n ** 18n;
    await ds.connect(alice).stake(STOCK, principal);

    // With only principal present, a pushed-fund sees NO arrived reward (received = bal - reserve = 0).
    // Before the fix this credited alice's entire principal as a TOKEN-side reward.
    await expect(ds.connect(rewarder).fundTokenPushed(TOKEN, await stk.getAddress()))
      .to.be.revertedWithCustomError(ds, "Zero");

    // A genuine push credits ONLY the actually-arrived amount, never the principal.
    const realPush = 500n * 10n ** 18n;
    await stk.connect(owner).transfer(await ds.getAddress(), realPush);
    await ds.connect(bob).stake(TOKEN, 1000n); // give the TOKEN side weight to receive the stream
    await ds.connect(rewarder).fundTokenPushed(TOKEN, await stk.getAddress());
    await time.increase(7 * DAY + 10);
    expect(await ds.earned(TOKEN, bob.address, await stk.getAddress())).to.be.lte(realPush);

    // alice's STOCK principal is fully intact and withdrawable — she gets every wei back
    await ds.connect(alice).unstake(STOCK, principal);
    expect(await ds.staked(STOCK, alice.address)).to.equal(0n);
    expect(await stk.balanceOf(alice.address)).to.equal(10n ** 24n); // exactly her original balance
  });

  it("[M-5] a later setAntiJitDelay cannot retroactively lock already-staked principal", async () => {
    // pool antiJitDelay = DAY (from the ctor). alice stakes now → her hold is snapshotted at DAY.
    await ds.connect(alice).stake(TOKEN, 1000n * 10n ** 18n);
    expect(await ds.antiJitAtStake(TOKEN, alice.address)).to.equal(BigInt(DAY));
    // the owner raises the global delay to the max AFTER alice staked
    await ds.connect(owner).setAntiJitDelay(7 * DAY);
    // past alice's ORIGINAL 1-day hold (but well within the new 7-day one): she can still exit in full
    await time.increase(DAY + 1);
    await expect(ds.connect(alice).unstake(TOKEN, 1000n * 10n ** 18n)).to.not.be.reverted;
    // a NEW stake, however, binds to the raised delay
    await ds.connect(bob).stake(TOKEN, 1000n * 10n ** 18n);
    expect(await ds.antiJitAtStake(TOKEN, bob.address)).to.equal(BigInt(7 * DAY));
    await time.increase(DAY + 1);
    await expect(ds.connect(bob).unstake(TOKEN, 1000n * 10n ** 18n)).to.be.revertedWithCustomError(ds, "Locked");
  });

  it("[re-audit/L-2] fundTokenPushed: permissionless when SINGLE-listed, rewarder-gated when DUAL-listed", async () => {
    // SINGLE-listed reward → attribution is unambiguous → permissionless (this is the flushStaking() recovery path).
    const rw = await erc20(owner);
    await ds.connect(owner).listReward(TOKEN, await rw.getAddress(), 7 * DAY); // TOKEN side ONLY
    await ds.connect(bob).stake(TOKEN, 1000n); // give the TOKEN side weight to receive the stream
    await rw.connect(owner).transfer(await ds.getAddress(), 500n * 10n ** 18n); // arrived (parked) delta
    await expect(ds.connect(alice).fundTokenPushed(TOKEN, await rw.getAddress())).to.not.be.reverted; // a stranger may push

    // DUAL-listed reward → `side` is caller-asserted and accountedReserve is per-asset, so a stranger could steal
    // reward attribution between sides. Only a trusted rewarder (who pushes for a KNOWN side) may resolve it.
    const dual = await erc20(owner);
    await ds.connect(owner).listReward(TOKEN, await dual.getAddress(), 7 * DAY);
    await ds.connect(owner).listReward(STOCK, await dual.getAddress(), 7 * DAY); // listed on BOTH sides
    await dual.connect(owner).transfer(await ds.getAddress(), 500n * 10n ** 18n); // arrived delta (meant for one side)
    // a stranger naming EITHER side is now rejected
    await expect(ds.connect(alice).fundTokenPushed(STOCK, await dual.getAddress())).to.be.revertedWithCustomError(ds, "NotRewarder");
    await expect(ds.connect(alice).fundTokenPushed(TOKEN, await dual.getAddress())).to.be.revertedWithCustomError(ds, "NotRewarder");
    // the trusted rewarder resolves it by naming the correct side
    await ds.connect(bob).stake(STOCK, 1000n); // STOCK side weight to receive
    await expect(ds.connect(rewarder).fundTokenPushed(STOCK, await dual.getAddress())).to.not.be.reverted;
  });
});
