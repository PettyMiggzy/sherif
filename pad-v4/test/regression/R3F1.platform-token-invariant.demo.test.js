// ROUND-3 FINDING F1 — REGRESSION (was a leak demonstrator; now verifies the fix).
//
// The original finding: deploy.js wired ONE key as both the fee-registry platformFeeWallet AND the staking pool's
// platformTreasury, with a 5% claim fee (StakingFactory(platform, _, 500)). RobinTokenTreasury.distribute() routes
// 70% of token-side LP fees into the DualStaking pool as a pad-token reward; on claim, DualStaking skims 5% into
// platformFeesOwed[padToken], and claimPlatformFees sends those pad tokens to the platform key — so "the platform
// never holds a pad token" was FALSE as deployed.
//
// The fix (F1): deploy.js now defaults STAKING_CLAIM_FEE_BPS to 0 — the platform takes ETH only and deliberately
// forgoes the token-denominated staking claim fee. This test drives the FULL end-to-end path (token fee → treasury
// → 70% to the pool → staker claim → claimPlatformFees) and asserts the platform ends with ZERO pad token under the
// shipped config, and — as an honest governance caveat — that a nonzero claim fee re-opens the exact leak.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const TOKEN = 0;
const DAY = 86400;
const E = (x) => ethers.parseEther(String(x));

// Build the pad's token treasury + DualStaking pool exactly as deploy.js/launch.js wire them, with a chosen claim
// fee, then run one full token-fee → staking → claim → platform-pull cycle. Returns the pad token the platform got.
async function runCycle(claimFeeBps) {
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

describe("R3-F1 [regression] platform-token invariant across the staking claim path", () => {
  it("[FIXED] shipped deploy (claim fee 0): the platform receives ZERO pad token end-to-end", async () => {
    const received = await runCycle(0);
    expect(received).to.equal(0n); // "platform never holds a pad token" now HOLDS under the shipped config
  });

  it("[governance caveat] a nonzero staking claim fee re-opens the leak — exactly what the fee-0 default prevents", async () => {
    const received = await runCycle(500); // the mis-config the auditor originally demonstrated
    expect(received).to.be.gt(0n); // pad token reaches the platform key — do NOT set a token claim fee on pad pools
  });
});
