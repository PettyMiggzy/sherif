// ROUND-3 FINDING F1 — REGRESSION (was a leak demonstrator; now verifies the STRUCTURAL fix).
//
// The original finding: deploy.js wired ONE key as both the fee-registry platformFeeWallet AND the staking pool's
// platformTreasury, with a 5% claim fee (StakingFactory(platform, _, 500)). RobinTokenTreasury.distribute() routes
// 70% of token-side LP fees into the DualStaking pool as a pad-token reward; on claim, DualStaking skimmed 5% into
// platformFeesOwed[padToken], and claimPlatformFees sent those pad tokens to the platform key — so "the platform
// never holds a pad token" was FALSE as deployed.
//
// The fix (F1, structural): DualStaking.claim() now exempts the pad token (`tokenAsset`) from the platform claim
// fee UNCONDITIONALLY — `fee = asset == address(tokenAsset) ? 0 : amount*bps/BPS`. No owner setting of
// platformClaimFeeBps, and no matter which side lists the token, can route a pad token to platformTreasury. The
// invariant is now CONTRACT-enforced, not deploy/governance-dependent. This test drives the FULL end-to-end path
// (token fee → treasury → 70% to the pool → staker claim → claimPlatformFees) and asserts the platform ends with
// ZERO pad token EVEN WHEN a nonzero claim fee is set — and, as a guard against over-fixing, that a money-side
// (ETH) reward STILL carries the fee so the platform's legitimate ETH revenue is untouched.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const TOKEN = 0;
const DAY = 86400;
const E = (x) => ethers.parseEther(String(x));

// Build the pad's token treasury + DualStaking pool exactly as deploy.js/launch.js wire them, with a chosen claim
// fee, then run one full token-fee → staking → claim → platform-pull cycle. Returns the pad token the platform got.
async function runTokenCycle(claimFeeBps) {
  const [platformOwner, platform, creator, staker, keeper] = await ethers.getSigners();
  const padToken = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
  const ds = await (await ethers.getContractFactory("DualStaking")).deploy(
    await padToken.getAddress(), ethers.ZeroAddress, platformOwner.address, 0, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
  );
  await ds.setPlatformTreasury(platform.address); // == the fee-registry platformFeeWallet in deploy.js
  if (claimFeeBps > 0) await ds.setPlatformClaimFee(claimFeeBps);
  await ds.listReward(TOKEN, await padToken.getAddress(), 7 * DAY);
  await ds.setRewarder(keeper.address, true);

  const treasury = await (await ethers.getContractFactory("RobinTokenTreasury")).deploy(
    await padToken.getAddress(), await ds.getAddress(), creator.address
  );

  await padToken.transfer(staker.address, E(1000));
  await padToken.connect(staker).approve(await ds.getAddress(), ethers.MaxUint256);
  await ds.connect(staker).stake(TOKEN, E(1000));

  // a token-side LP fee arrives at the treasury → distribute() sends 70% to the pool → keeper books it
  await padToken.transfer(await treasury.getAddress(), E(100));
  await treasury.distribute();
  await ds.connect(keeper).fundTokenPushed(TOKEN, await padToken.getAddress());

  await time.increase(7 * DAY + 1);
  const platBefore = await padToken.balanceOf(platform.address);
  await ds.connect(staker).claim(TOKEN, await padToken.getAddress());
  // pull whatever the platform is owed (reverts Zero if nothing — treat as 0)
  try { await ds.connect(keeper).claimPlatformFees(await padToken.getAddress()); } catch { /* nothing owed */ }
  return (await padToken.balanceOf(platform.address)) - platBefore;
}

describe("R3-F1 [regression] platform-token invariant is contract-enforced across the staking claim path", () => {
  it("[FIXED] shipped deploy (claim fee 0): the platform receives ZERO pad token end-to-end", async () => {
    const received = await runTokenCycle(0);
    expect(received).to.equal(0n);
  });

  it("[FIXED — structural] even a nonzero staking claim fee (500) skims ZERO pad token — the exemption is unbypassable", async () => {
    const received = await runTokenCycle(500); // the exact mis-config the auditor originally demonstrated
    expect(received).to.equal(0n); // pad token is structurally exempt regardless of platformClaimFeeBps
  });

  it("[guard] a money-side (ETH) reward STILL carries the platform claim fee — the fix does not disable ETH revenue", async () => {
    const [platformOwner, platform, , staker, keeper] = await ethers.getSigners();
    const padToken = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await padToken.getAddress(), ethers.ZeroAddress, platformOwner.address, 0, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    await ds.setPlatformTreasury(platform.address);
    await ds.setPlatformClaimFee(500);
    await ds.setRewarder(keeper.address, true);

    await padToken.transfer(staker.address, E(1000));
    await padToken.connect(staker).approve(await ds.getAddress(), ethers.MaxUint256);
    await ds.connect(staker).stake(TOKEN, E(1000));

    // fund an ETH reward on the TOKEN side (ETH is auto-listed in the constructor)
    await ds.connect(keeper).fundETH(TOKEN, { value: E(10) });
    await time.increase(7 * DAY + 1);

    const platBefore = await ethers.provider.getBalance(platform.address);
    await ds.connect(staker).claim(TOKEN, ETH);
    await ds.connect(keeper).claimPlatformFees(ETH);
    const got = (await ethers.provider.getBalance(platform.address)) - platBefore;
    expect(got).to.be.gt(0n); // the platform's legitimate ETH claim fee is untouched by the pad-token exemption
  });
});
