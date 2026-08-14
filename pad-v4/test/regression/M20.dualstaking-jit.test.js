// REGRESSION TEST for M-20 (see AUDITOR-HANDOFF.md). DualStaking's `_applyReward` divided a top-up by the LIVE
// window's `remaining`, so a donation landing in the tail streamed over seconds and whoever happened to be staked
// for those seconds took it. Measured: a whale staked 121 seconds took 99.00% of a creator's 10 ETH gift.
// The fix floors the scheduling window at MIN_DRIP_WINDOW and parks sub-rate tranches instead of opening a
// live zero-rate window. These tests replay the exploit and pin the two properties the fix must not break.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const TOKEN = 0;
const DAY = 86400;
const E = (x) => ethers.parseEther(String(x));
const pct = (part, whole) => Number((part * 1000000n) / whole) / 10000;

describe("M-20 exploit, replayed against the patched contract", () => {
  async function book({ antiJit = 0 } = {}) {
    const [owner, honest, whale, creator] = await ethers.getSigners();
    const tok = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    // single-book pool (no stock), owner is the default rewarder
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), ethers.ZeroAddress, owner.address,
      antiJit, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    for (const u of [honest, whale]) {
      await tok.transfer(u.address, E(10000000));
      await tok.connect(u).approve(await ds.getAddress(), ethers.MaxUint256);
    }
    return { owner, honest, whale, creator, tok, ds };
  }

  it("the capture no longer captures: a tail-staking whale cannot take the creator's gift", async () => {
    const { owner, honest, whale, creator, ds } = await book();

    // an honest 1 ETH stream over the default 7-day window, with an honest staker present from the start
    await ds.connect(honest).stake(TOKEN, E(1000));
    await ds.connect(owner).fundETH(TOKEN, { value: E(1) });
    const pf0 = (await ds.rewardInfo(TOKEN, ETH)).periodFinish;

    // the whale shows up 121 seconds before the window closes and takes ~99.9% of the weight
    await time.increaseTo(pf0 - 121n);
    await ds.connect(whale).stake(TOKEN, E(1000000));

    // the creator's gift lands in the tail — this is the exact moment the old code paid it out over 121 seconds
    await ds.connect(creator).donateETH(TOKEN, { value: E(10) });
    const r = await ds.rewardInfo(TOKEN, ETH);
    const now = BigInt(await time.latest());

    // the window is floored: the gift is scheduled over a day, not over the 121 seconds that were left
    expect(r.periodFinish - now).to.equal(BigInt(DAY));
    expect(await ds.MIN_DRIP_WINDOW()).to.equal(BigInt(DAY));

    // ride out exactly the whale's 121-second presence, then let it take everything it can
    await time.increase(121);
    const earned = await ds.earned(TOKEN, whale.address, ETH);
    const net = await ds.connect(whale).claim.staticCall(TOKEN, ETH);
    console.log(`   whale earned ${ethers.formatEther(earned)} ETH of a 10 ETH gift = ${pct(earned, E(10))}% (was 99.00%)`);
    expect(net).to.equal(earned);
    expect(earned).to.be.lt(E(0.1)); // < 1% of the gift; the rest keeps streaming to whoever stays
  });

  it("the whale gains nothing by timing: staking 121s early is worth the same as staking a day early", async () => {
    // Same tape, but the whale arrives a full day before the donation instead of 121 seconds before. If the
    // tail were still special, the 121-second entry would beat this one. It must not.
    const { owner, honest, whale, creator, ds } = await book();
    await ds.connect(honest).stake(TOKEN, E(1000));
    await ds.connect(owner).fundETH(TOKEN, { value: E(1) });
    const pf0 = (await ds.rewardInfo(TOKEN, ETH)).periodFinish;

    await time.increaseTo(pf0 - 121n - BigInt(DAY));
    await ds.connect(whale).stake(TOKEN, E(1000000));
    await time.increaseTo(pf0 - 121n);
    await ds.connect(creator).donateETH(TOKEN, { value: E(10) });
    const before = await ds.earned(TOKEN, whale.address, ETH);
    await time.increase(121);
    const fromGift = (await ds.earned(TOKEN, whale.address, ETH)) - before;
    console.log(`   early whale's share of the gift window: ${ethers.formatEther(fromGift)} ETH`);
    expect(fromGift).to.be.lt(E(0.1)); // the same trickle — arrival time buys nothing
  });

  it("a sub-rate donation PARKS instead of opening a live zero-rate window", async () => {
    const { honest, creator, ds } = await book();
    await ds.connect(honest).stake(TOKEN, E(1000));
    // no window has ever opened, so the lapsed branch runs: 1 wei / 7 days == rate 0
    await ds.connect(creator).donateETH(TOKEN, { value: 1n });
    const r = await ds.rewardInfo(TOKEN, ETH);
    const now = BigInt(await time.latest());
    expect(r.rewardRate).to.equal(0n);
    expect(r.periodFinish).to.be.lte(now); // no live window installed for a wei
    expect(r.pending).to.equal(1n); // carried, credited on the next real tranche
  });

  it("the anti-spam property survives: a donation while > MIN_DRIP_WINDOW remains cannot move periodFinish", async () => {
    const { owner, honest, creator, ds } = await book();
    await ds.connect(honest).stake(TOKEN, E(1000));
    await ds.connect(owner).fundETH(TOKEN, { value: E(1) });
    const pf0 = (await ds.rewardInfo(TOKEN, ETH)).periodFinish;

    // spam donations across the fat part of the window — periodFinish must be pinned, rate must only rise
    let lastRate = (await ds.rewardInfo(TOKEN, ETH)).rewardRate;
    for (let i = 0; i < 3; i++) {
      await time.increase(DAY);
      await ds.connect(creator).donateETH(TOKEN, { value: E(1) });
      const r = await ds.rewardInfo(TOKEN, ETH);
      expect(r.periodFinish).to.equal(pf0); // exactly unchanged — no stretch
      expect(r.rewardRate).to.be.gt(lastRate);
      lastRate = r.rewardRate;
    }
  });

  it("nobody can be paid more than was funded, gift included", async () => {
    const { owner, honest, whale, creator, ds } = await book();
    await ds.connect(honest).stake(TOKEN, E(1000));
    await ds.connect(owner).fundETH(TOKEN, { value: E(1) });
    const pf0 = (await ds.rewardInfo(TOKEN, ETH)).periodFinish;
    await time.increaseTo(pf0 - 121n);
    await ds.connect(whale).stake(TOKEN, E(1000000));
    await ds.connect(creator).donateETH(TOKEN, { value: E(10) });
    await time.increase(30 * DAY); // long past every window; everything that can stream has streamed

    const total = (await ds.earned(TOKEN, honest.address, ETH)) + (await ds.earned(TOKEN, whale.address, ETH));
    console.log(`   total streamed ${ethers.formatEther(total)} ETH of 11 ETH funded`);
    expect(total).to.be.lte(E(11));
    expect(total).to.be.gt(E(10.9)); // and it is not stranded either
  });
});
