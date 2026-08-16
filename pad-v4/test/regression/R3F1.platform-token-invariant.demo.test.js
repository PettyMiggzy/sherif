// ROUND-3 FINDING F1 — DEMONSTRATOR (not a fix; proves the invariant break for the other session).
//
// AUDIT-ROUND-3-BRIEF.md:61 and AUDITOR-HANDOFF.md §0c:267 assert, as "the highest-value invariant, tested":
//   "the platform wallet's pad-token balance is always exactly zero ... the treasury key never receives a pad token."
//
// It is FALSE as deployed. deploy.js wires ONE key as both the fee-registry platformFeeWallet AND the staking
// pool's platformTreasury, with a 5% claim fee (StakingFactory(platform, _, 500)). RobinTokenTreasury.distribute()
// routes 70% of token-side LP fees into the DualStaking pool as a pad-token reward; when a holder claims it,
// DualStaking.claim skims 5% into platformFeesOwed[padToken], and claimPlatformFees sends those pad tokens to the
// platform key. This test reproduces that exact wiring and asserts the platform's pad-token balance is NON-ZERO.
//
// It PASSES today (the break exists). After the other session fixes it (zero the claim fee on pad pools, or point
// the staking treasury at a token sink, or scope the invariant honestly in the docs), flip the final assertion.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const TOKEN = 0;
const DAY = 86400;
const E = (x) => ethers.parseEther(String(x));

describe("R3-F1 [DEMO] platform receives pad tokens via the staking claim fee — 'platform never holds token' is false", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  it("the platform key's pad-token balance goes NON-ZERO under the default deploy config", async () => {
    const [platformOwner, platform, creator, staker, keeper] = await ethers.getSigners();

    // the pad token (a plain ERC20, like PadToken)
    const padToken = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);

    // the pad's DualStaking pool, wired EXACTLY as StakingFactory does with deploy.js defaults:
    //   StakingFactory(platformTreasury = platform, platformOwner, defaultClaimFeeBps = 500)
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await padToken.getAddress(), ethers.ZeroAddress, platformOwner.address, 0, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    await ds.setPlatformTreasury(platform.address);   // == the fee-registry platformFeeWallet in deploy.js
    await ds.setPlatformClaimFee(500);                // 5%, the deploy default (STAKING_CLAIM_FEE_BPS)
    await ds.listReward(TOKEN, await padToken.getAddress(), 7 * DAY);
    await ds.setRewarder(keeper.address, true);

    // the per-pad token treasury (70% staking / 30% burn), wired at the pool as deploy does
    const treasury = await (await ethers.getContractFactory("RobinTokenTreasury")).deploy(
      await padToken.getAddress(), await ds.getAddress(), creator.address
    );

    // a staker is present so rewards actually stream to someone
    await padToken.transfer(staker.address, E(1000));
    await padToken.connect(staker).approve(await ds.getAddress(), ethers.MaxUint256);
    await ds.connect(staker).stake(TOKEN, E(1000));

    // a token-side LP fee arrives at the treasury (in production: floor sweepTokenFees / lock sell-leg / ambush)
    await padToken.transfer(await treasury.getAddress(), E(100));
    // distribute(): 70 -> pool, 30 -> burn reserve
    await treasury.distribute();
    // the keeper books the pool's fresh token as a reward (measured-delta), exactly the launch.js keeper loop
    await ds.connect(keeper).fundTokenPushed(TOKEN, await padToken.getAddress());

    // the reward streams; the staker claims after the window
    await time.increase(7 * DAY + 1);
    const platBefore = await padToken.balanceOf(platform.address);
    await ds.connect(staker).claim(TOKEN, await padToken.getAddress());

    // the 5% claim fee is now owed to the platform treasury, IN PAD TOKEN
    const owed = await ds.platformFeesOwed(await padToken.getAddress());
    expect(owed).to.be.gt(0n);

    // anyone pokes it to the platform key
    await ds.connect(keeper).claimPlatformFees(await padToken.getAddress());
    const platAfter = await padToken.balanceOf(platform.address);
    const received = platAfter - platBefore;

    console.log(`   platform pad-token balance: ${ethers.formatEther(platBefore)} -> ${ethers.formatEther(platAfter)} ` +
      `(received ${ethers.formatEther(received)} PAD TOKEN via the 5% staking claim fee)`);

    // THE INVARIANT BREAK: the brief/handoff say this is always exactly zero. It is not.
    expect(received).to.be.gt(0n);
    expect(platAfter).to.be.gt(0n); // "platform wallet's pad-token balance is always exactly zero" — FALSE
  });
});
