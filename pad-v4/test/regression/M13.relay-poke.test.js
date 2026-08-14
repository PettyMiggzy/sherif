// REGRESSION TEST for M-13 (see AUDITOR-HANDOFF.md). DualStaking.fundTokenPushed scheduled its tranche with
// extend=TRUE, which re-armed periodFinish to now + duration and re-divided the WHOLE undripped reservoir over a
// fresh full window. The path is rewarder-gated, but its rewarders are RELAYS that anyone can poke —
// RobinCurveV4.flushStaking() has no once-only guard, and RobinAmbushVault.collectFees()/flushFees() forward LP
// fees on any caller's call — so a stranger could stall the stream indefinitely for dust.
//
// The fix is one word (extend=FALSE), and it TRADES one property for another rather than being free. This file
// measures both sides, because the fix's own skeptic pointed out that asserting the trade away would be the
// dishonest move: it kills the stall, and it lowers the shortest horizon a relay push can be spread over from
// `duration` to MIN_DRIP_WINDOW. The second number is recorded here so nobody has to rediscover it.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const TOKEN = 0;
const DAY = 86400;
const WEEK = 7 * DAY;
const E = (x) => ethers.parseEther(String(x));
const pct = (part, whole) => Number((part * 1000000n) / whole) / 10000;

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("M-13 — a relay poke can no longer stall the stream", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  let owner, relay, honest, whale, tok, ds;

  beforeEach(async () => {
    [owner, relay, honest, whale] = await ethers.getSigners();
    tok = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), ethers.ZeroAddress, owner.address, 0, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    await ds.listReward(TOKEN, await tok.getAddress(), WEEK);
    await ds.setRewarder(relay.address, true); // the curve / ambush vault, in production
    for (const w of [honest, whale]) {
      await tok.transfer(w.address, E(10000000));
      await tok.connect(w).approve(await ds.getAddress(), ethers.MaxUint256);
    }
  });

  // push `amt` into the contract and poke the relay path, exactly as flushStaking / _forwardStaking do
  async function relayPush(amt) {
    await tok.transfer(await ds.getAddress(), amt);
    await ds.connect(relay).fundTokenPushed(TOKEN, await tok.getAddress());
  }

  it("dust pokes no longer re-arm the window: the stream still finishes on time", async () => {
    await ds.connect(honest).stake(TOKEN, E(1000));
    await relayPush(E(1000)); // the real reservoir, opening a 7-day window
    const info0 = await ds.rewardInfo(TOKEN, await tok.getAddress());
    const pf0 = info0.periodFinish;

    // a stranger pokes the relay with 1 wei every few hours for most of the window
    let pokes = 0;
    for (let i = 0; i < 16; i++) {
      await time.increase(8 * 3600);
      await relayPush(1n);
      pokes++;
      const r = await ds.rewardInfo(TOKEN, await tok.getAddress());
      // while more than MIN_DRIP_WINDOW remains, periodFinish is pinned to the wei
      if (BigInt(await time.latest()) + BigInt(DAY) <= pf0) {
        expect(r.periodFinish).to.equal(pf0);
      }
      expect(r.periodFinish).to.be.lte(pf0 + BigInt(DAY)); // and never further out than one floored window
    }

    // stop poking and let the stream drain
    await time.increase(2 * DAY);
    const earned = await ds.earned(TOKEN, honest.address, await tok.getAddress());
    console.log(`   after ${pokes} dust pokes the honest staker earned ${pct(earned, E(1000))}% of the reservoir`);
    expect(earned).to.be.gt((E(1000) * 999n) / 1000n); // >99.9% delivered — the stall is dead
  });

  it("value is conserved better than before: a 1-wei poke can only lose its own wei", async () => {
    await ds.connect(honest).stake(TOKEN, E(1000));
    await relayPush(E(1000));
    await time.increase(2 * DAY);

    const before = await ds.rewardInfo(TOKEN, await tok.getAddress());
    const t0 = BigInt(await time.latest());
    const undrippedBefore = (before.periodFinish - t0) * before.rewardRate;

    await relayPush(1n);

    const after = await ds.rewardInfo(TOKEN, await tok.getAddress());
    const t1 = BigInt(await time.latest());
    const undrippedAfter = (after.periodFinish - t1) * after.rewardRate;
    // the poke advances the block, so a second of drip is legitimately paid out between the two reads — that is
    // delivery, not loss. Net it off before comparing, or the elapsed second reads as a 3.3e15 shortfall.
    const paidOut = (t1 - t0) * before.rewardRate;
    const expectedAfter = undrippedBefore - paidOut + 1n;

    // the old extend=true branch re-divided the whole reservoir by `duration`, truncating up to duration-1 units
    // every poke. The else branch's leftover is exactly divisible by `remaining`, so the only loss is
    // `amount mod window` — a 1-wei poke can lose at most its own wei.
    const lost = expectedAfter > undrippedAfter ? expectedAfter - undrippedAfter : 0n;
    console.log(`   reservoir units lost to a 1-wei poke: ${lost} (extend=true truncated up to ${WEEK - 1})`);
    expect(lost).to.be.lte(1n);
  });

  it("MEASURED TRADE-OFF: the shortest horizon a relay push can be spread over is now MIN_DRIP_WINDOW", async () => {
    // This is the property the fix gives up, recorded rather than asserted away. A tranche pushed while a live
    // window has less than a day left is scheduled over one day instead of a fresh `duration`, so a whale needs
    // ONE DAY of exposure to take the bulk of it rather than seven.
    await ds.connect(honest).stake(TOKEN, E(1000));
    await relayPush(E(1000));
    const pf0 = (await ds.rewardInfo(TOKEN, await tok.getAddress())).periodFinish;

    await time.increaseTo(pf0 - BigInt(12 * 3600)); // 12h left in the window
    await ds.connect(whale).stake(TOKEN, E(10000)); // 10x the honest float
    const whaleBefore = await ds.earned(TOKEN, whale.address, await tok.getAddress());
    await relayPush(E(500)); // the relay realizes LP fees; anyone can trigger this

    const r = await ds.rewardInfo(TOKEN, await tok.getAddress());
    const horizon = r.periodFinish - BigInt(await time.latest());
    expect(horizon).to.equal(BigInt(DAY)); // floored at MIN_DRIP_WINDOW, not reset to the 7-day duration

    await time.increase(DAY);
    const whaleTook = (await ds.earned(TOKEN, whale.address, await tok.getAddress())) - whaleBefore;
    // note this is the whale's take of EVERYTHING streaming in that day — the 500-token relay tranche plus the
    // tail of the original reservoir it was merged with — so it exceeds the tranche alone. The point is the
    // EXPOSURE it required, not the denominator.
    console.log(`   whale staked ${DAY / 3600}h took ${ethers.formatEther(whaleTook)} tokens; ` +
      `pre-fix the same take needed ${WEEK / DAY} days of exposure`);

    // the exposure requirement is real and bounded: one MIN_DRIP_WINDOW, not zero
    expect(horizon).to.be.gte(BigInt(DAY));
    // and antiJitDelay is the lever that removes it — set it and the whale cannot unstake inside the window
    const locked = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), ethers.ZeroAddress, owner.address, DAY, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    expect(await locked.antiJitDelay()).to.equal(BigInt(DAY));
    await tok.connect(whale).approve(await locked.getAddress(), ethers.MaxUint256);
    await locked.connect(whale).stake(TOKEN, E(1));
    await expect(locked.connect(whale).unstake(TOKEN, E(1))).to.be.revertedWithCustomError(locked, "Locked");
  });
});
