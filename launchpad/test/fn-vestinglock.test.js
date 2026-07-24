// Per-function sim: TokenVestingLock — the irrevocable cliff+linear locker.
// Unit-style (MockERC20, no fork). Covers the release math, the trust guarantees
// (irrevocable, only-beneficiary), and the security guards (reentrancy, fee-on-transfer honesty).
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 86400n;
const parse = ethers.parseEther;

async function now() { return BigInt((await ethers.provider.getBlock("latest")).timestamp); }
async function setTime(t) { await ethers.provider.send("evm_setNextBlockTimestamp", [Number(t)]); await ethers.provider.send("evm_mine", []); }
async function setNext(t) { await ethers.provider.send("evm_setNextBlockTimestamp", [Number(t)]); } // next TX mines at exactly t

describe("TokenVestingLock", function () {
  let lock, token, owner, dev, other;

  beforeEach(async () => {
    [owner, dev, other] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy(parse("1000000000"));
    lock = await (await ethers.getContractFactory("TokenVestingLock")).deploy();
    // give the dev tokens to lock
    await (await token.transfer(dev.address, parse("100000000"))).wait();
  });

  async function createLock({ amount = parse("10000000"), start = 0n, cliff = 0n, duration = 30n * DAY, beneficiary } = {}) {
    beneficiary = beneficiary || dev.address;
    await (await token.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const rc = await (await lock.connect(dev).create(await token.getAddress(), beneficiary, amount, start, cliff, duration)).wait();
    return 0n; // first schedule id
  }

  it("create pulls tokens, stores the schedule, emits, counts", async () => {
    const amount = parse("10000000");
    await (await token.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const t = (await now()) + 5n;
    await setTime(t);
    await expect(lock.connect(dev).create(await token.getAddress(), dev.address, amount, 0n, 7n * DAY, 30n * DAY))
      .to.emit(lock, "ScheduleCreated");
    const s = await lock.schedules(0);
    expect(s.token).to.equal(await token.getAddress());
    expect(s.beneficiary).to.equal(dev.address);
    expect(s.total).to.equal(amount);
    expect(s.released).to.equal(0n);
    expect(await lock.scheduleCount()).to.equal(1n);
    expect(await token.balanceOf(await lock.getAddress())).to.equal(amount);
  });

  it("nothing releasable before the cliff", async () => {
    const id = await createLock({ cliff: 10n * DAY, duration: 30n * DAY });
    expect(await lock.releasable(id)).to.equal(0n);
    await expect(lock.release(id)).to.be.revertedWithCustomError(lock, "NothingToRelease");
  });

  it("linear accrual with no cliff: exactly half at the midpoint, paid to the beneficiary", async () => {
    const amount = parse("10000000");
    await (await token.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const start = (await now()) + 5n;
    await setNext(start);
    await (await lock.connect(dev).create(await token.getAddress(), dev.address, amount, start, 0n, 30n * DAY)).wait();
    const before = await token.balanceOf(dev.address);
    // Release AS A TX at exactly the midpoint block so block.timestamp is deterministic.
    await setNext(start + 15n * DAY);
    await (await lock.connect(other).release(0)).wait(); // permissionless trigger; funds go to beneficiary
    expect((await token.balanceOf(dev.address)) - before).to.equal(amount / 2n); // exact half, to dev not caller
  });

  it("fully vested returns exact total; dust swept; released == total", async () => {
    const amount = parse("10000000") + 7n; // odd amount to test dust
    await (await token.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const start = (await now()) + 5n;
    await setTime(start);
    await (await lock.connect(dev).create(await token.getAddress(), dev.address, amount, start, 5n * DAY, 30n * DAY)).wait();
    await setTime(start + 31n * DAY);
    expect(await lock.releasable(0)).to.equal(amount);
    await (await lock.release(0)).wait();
    const s = await lock.schedules(0);
    expect(s.released).to.equal(amount);
    expect(await lock.locked(0)).to.equal(0n);
    expect(await lock.lockedPercent(0)).to.equal(0n);
    expect(await token.balanceOf(await lock.getAddress())).to.equal(0n);
  });

  it("released tracks vesting exactly and never exceeds total (releases as txs)", async () => {
    const amount = parse("9999999") + 123n; // odd amount to exercise dust
    await (await token.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const start = (await now()) + 5n;
    await setNext(start);
    await (await lock.connect(dev).create(await token.getAddress(), dev.address, amount, start, 0n, 20n * DAY)).wait();
    for (let d = 1; d <= 20; d++) {
      await setNext(start + BigInt(d) * DAY); // release mines at exactly this block
      await (await lock.release(0)).wait();
      expect((await lock.schedules(0)).released).to.be.lte(amount); // never exceeds total
    }
    // the last release lands at end (start+20d) → full total, dust swept
    expect((await lock.schedules(0)).released).to.equal(amount);
    expect(await token.balanceOf(await lock.getAddress())).to.equal(0n);
  });

  it("lockedPercent tracks the schedule (100% -> 0%)", async () => {
    const amount = parse("10000000");
    await (await token.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const start = (await now()) + 5n;
    await setTime(start - 1n);
    await (await lock.connect(dev).create(await token.getAddress(), dev.address, amount, start, 0n, 40n * DAY)).wait();
    // just after start ~100% locked
    await setTime(start + 1n);
    expect(await lock.lockedPercent(0)).to.be.gte(9990n); // ~100%
    await setTime(start + 20n * DAY); // half (view evaluates at pending+1s, so allow ±2 bps)
    const lp = await lock.lockedPercent(0);
    expect(lp).to.be.gte(4998n); expect(lp).to.be.lte(5002n);
    await setTime(start + 40n * DAY);
    expect(await lock.lockedPercent(0)).to.equal(0n);
  });

  it("is irrevocable: no cancel/revoke/owner/withdraw; creator can't claw back", async () => {
    const id = await createLock({ duration: 30n * DAY });
    // no such functions exist on the ABI
    for (const fn of ["cancel", "revoke", "withdraw", "owner", "transferOwnership", "sweep"]) {
      expect(lock.interface.fragments.find((f) => f.type === "function" && f.name === fn)).to.equal(undefined);
    }
    // creator gets nothing extra: only vested funds ever leave, and only to beneficiary
    expect(await lock.releasable(id)).to.equal(0n);
  });

  it("blocks reentrancy on release (no double payout)", async () => {
    const rt = await (await ethers.getContractFactory("ReentrantVestToken")).deploy(parse("1000000"));
    await (await rt.transfer(dev.address, parse("100000"))).wait();
    const amount = parse("50000");
    await (await rt.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const start = (await now()) + 5n;
    await setTime(start);
    await (await lock.connect(dev).create(await rt.getAddress(), dev.address, amount, start, 0n, 10n * DAY)).wait();
    await rt.arm(await lock.getAddress(), 0); // re-enter release on the outgoing transfer
    await setTime(start + 20n * DAY);
    await expect(lock.release(0)).to.be.revertedWithCustomError(lock, "ReentrancyGuardReentrantCall");
  });

  it("records the ACTUAL received amount for a fee-on-transfer token", async () => {
    const fot = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy(parse("1000000"), 100n); // 1% fee
    await (await fot.transfer(dev.address, parse("100000"))).wait();
    const amount = parse("50000");
    await (await fot.connect(dev).approve(await lock.getAddress(), amount)).wait();
    const start = (await now()) + 5n;
    await setTime(start);
    await (await lock.connect(dev).create(await fot.getAddress(), dev.address, amount, start, 0n, 10n * DAY)).wait();
    const got = amount - (amount * 100n) / 10000n; // 99%
    expect((await lock.schedules(0)).total).to.equal(got);
    await setTime(start + 11n * DAY);
    // full vest pays exactly what was received (minus the fee taken again on the way out)
    expect(await lock.releasable(0)).to.equal(got);
    await (await lock.release(0)).wait();
    expect((await lock.schedules(0)).released).to.equal(got);
  });

  it("validates inputs", async () => {
    const amount = parse("1000");
    await (await token.connect(dev).approve(await lock.getAddress(), amount * 10n)).wait();
    const T = await token.getAddress();
    await expect(lock.connect(dev).create(T, ethers.ZeroAddress, amount, 0n, 0n, DAY)).to.be.revertedWithCustomError(lock, "BadBeneficiary");
    await expect(lock.connect(dev).create(ethers.ZeroAddress, dev.address, amount, 0n, 0n, DAY)).to.be.revertedWithCustomError(lock, "BadToken");
    await expect(lock.connect(dev).create(T, dev.address, 0n, 0n, 0n, DAY)).to.be.revertedWithCustomError(lock, "ZeroAmount");
    await expect(lock.connect(dev).create(T, dev.address, amount, 0n, 0n, 0n)).to.be.revertedWithCustomError(lock, "BadDuration");
    await expect(lock.connect(dev).create(T, dev.address, amount, 0n, 2n * DAY, DAY)).to.be.revertedWithCustomError(lock, "BadDuration"); // cliff > duration
    await expect(lock.releasable(999)).to.be.revertedWithCustomError(lock, "NoSchedule");
  });

  it("indexes schedules by beneficiary and token", async () => {
    await createLock({ duration: 30n * DAY });
    // second lock, different beneficiary
    await (await token.connect(dev).approve(await lock.getAddress(), parse("5000000"))).wait();
    await (await lock.connect(dev).create(await token.getAddress(), other.address, parse("5000000"), 0n, 0n, 30n * DAY)).wait();
    const devIds = await lock.idsOfBeneficiary(dev.address);
    const otherIds = await lock.idsOfBeneficiary(other.address);
    const tokIds = await lock.idsOfToken(await token.getAddress());
    expect(devIds.map(Number)).to.deep.equal([0]);
    expect(otherIds.map(Number)).to.deep.equal([1]);
    expect(tokIds.map(Number)).to.deep.equal([0, 1]);
  });
});
