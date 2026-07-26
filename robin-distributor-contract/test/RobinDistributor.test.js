// On-chain audit: deploy, load the REAL 1000 recipients, fund, distribute in
// batches, and assert the split invariants + that batches fit under the gas cap.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const GAS_CAP = 16_777_216n; // Robinhood Chain per-tx cap (2^24)
const RECIPIENTS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "recipients.json"), "utf8"))
  .map((a) => ethers.getAddress(a));

// $0.0000814 @ $3500/ETH, fixed for determinism.
const UNIT = ethers.parseUnits(((0.0000814 / 3500)).toFixed(18), 18);

async function deployAndLoad() {
  const [owner] = await ethers.getSigners();
  const C = await ethers.getContractFactory("RobinDistributor");
  const c = await C.deploy(UNIT);
  await c.waitForDeployment();
  for (let i = 0; i < RECIPIENTS.length; i += 200) {
    const tx = await c.addRecipients(RECIPIENTS.slice(i, i + 200));
    const rc = await tx.wait();
    expect(rc.gasUsed).to.be.lessThan(GAS_CAP);
  }
  expect(await c.recipientCount()).to.equal(BigInt(RECIPIENTS.length));
  return { c, owner };
}

async function runRound(c, owner, valueWei) {
  await (await owner.sendTransaction({ to: await c.getAddress(), value: valueWei })).wait();
  await (await c.startRound()).wait();
  let maxBatchGas = 0n;
  while (await c.roundActive()) {
    const tx = await c.distribute(250);
    const rc = await tx.wait();
    if (rc.gasUsed > maxBatchGas) maxBatchGas = rc.gasUsed;
  }
  return maxBatchGas;
}

async function balancesOf(list) {
  const out = [];
  for (const a of list) out.push(await ethers.provider.getBalance(a));
  return out;
}

describe("RobinDistributor", function () {
  this.timeout(600000);
  const n = BigInt(RECIPIENTS.length);

  it("loads all 1000 recipients (each add batch under the gas cap)", async () => {
    const { c } = await deployAndLoad();
    expect(await c.recipientCount()).to.equal(n);
  });

  it("even-splits a $20-equivalent deposit across all recipients", async () => {
    const { c, owner } = await deployAndLoad();
    const balance = ethers.parseUnits((20 / 3500).toFixed(18), 18); // ~$20 of ETH
    const before = await balancesOf(RECIPIENTS);
    const maxGas = await runRound(c, owner, balance);

    const after = await balancesOf(RECIPIENTS);
    const got = after.map((b, i) => b - before[i]);

    // every payout is a whole increment
    for (const g of got) expect(g % UNIT).to.equal(0n);

    // everyone funded, within ONE increment of each other
    const funded = got.filter((g) => g > 0n);
    expect(funded.length).to.equal(Number(n));
    const min = funded.reduce((a, b) => (a < b ? a : b));
    const max = funded.reduce((a, b) => (a > b ? a : b));
    expect(max - min).to.equal(UNIT); // 20/3500 doesn't divide evenly → spread is exactly one step

    // conservation: distributed + leftover == deposit, leftover < one increment
    const distributed = got.reduce((a, b) => a + b, 0n);
    const leftover = await ethers.provider.getBalance(await c.getAddress());
    expect(distributed + leftover).to.equal(balance);
    expect(leftover).to.be.lessThan(UNIT);

    // batches fit under the per-tx gas cap
    expect(maxGas).to.be.lessThan(GAS_CAP);
  });

  it("FIXED mode: pays exactly one $0.0000814 step to every wallet", async () => {
    const { c, owner } = await deployAndLoad();
    // fund with exactly what's needed for all + a little extra to prove the extra
    // is NOT distributed in fixed mode (each wallet gets exactly one step).
    const needForAll = UNIT * n;
    const before = await balancesOf(RECIPIENTS);
    await (await owner.sendTransaction({ to: await c.getAddress(), value: needForAll + UNIT * 7n })).wait();
    await (await c.startFixedRound()).wait();
    while (await c.roundActive()) await (await c.distribute(250)).wait();

    const after = await balancesOf(RECIPIENTS);
    const got = after.map((b, i) => b - before[i]);
    for (const g of got) expect(g).to.equal(UNIT); // EXACTLY one step, everyone
    // the extra 7 steps stay as leftover (fixed mode caps at one each)
    const leftover = await ethers.provider.getBalance(await c.getAddress());
    expect(leftover).to.equal(UNIT * 7n);
  });

  it("FIXED mode scarcity: funds as many wallets as affordable, one step each", async () => {
    const { c, owner } = await deployAndLoad();
    const before = await balancesOf(RECIPIENTS);
    await (await owner.sendTransaction({ to: await c.getAddress(), value: UNIT * 40n + UNIT / 3n })).wait();
    await (await c.startFixedRound()).wait();
    while (await c.roundActive()) await (await c.distribute(250)).wait();
    const after = await balancesOf(RECIPIENTS);
    const got = after.map((b, i) => b - before[i]); // delta this round only
    const funded = got.filter((g) => g > 0n).length;
    expect(funded).to.equal(40);
    for (let i = 0; i < 40; i++) expect(got[i]).to.equal(UNIT);
    for (let i = 40; i < got.length; i++) expect(got[i]).to.equal(0n);
  });

  it("handles scarcity (few units): funds as many as possible, one step each", async () => {
    const { c, owner } = await deployAndLoad();
    const balance = UNIT * 12n + UNIT / 2n; // only ~12 increments available
    const before = await balancesOf(RECIPIENTS);
    await runRound(c, owner, balance);
    const after = await balancesOf(RECIPIENTS);
    const got = after.map((b, i) => b - before[i]);

    const funded = got.filter((g) => g > 0n);
    expect(funded.length).to.equal(12);
    for (const g of funded) expect(g).to.equal(UNIT); // exactly one step each
    // only the first 12 recipients get paid
    for (let i = 0; i < 12; i++) expect(got[i]).to.equal(UNIT);
    for (let i = 12; i < got.length; i++) expect(got[i]).to.equal(0n);
  });

  it("multiple rounds: a second deposit distributes again", async () => {
    const { c, owner } = await deployAndLoad();
    const dep = ethers.parseUnits((5 / 3500).toFixed(18), 18);
    const before = await balancesOf(RECIPIENTS);
    await runRound(c, owner, dep);
    await runRound(c, owner, dep);
    const after = await balancesOf(RECIPIENTS);
    const got = after.map((b, i) => b - before[i]);
    for (const g of got) expect(g % UNIT).to.equal(0n);
    expect(got.filter((g) => g > 0n).length).to.equal(Number(n));
  });

  it("only the owner can add/set/start/distribute/sweep", async () => {
    const { c } = await deployAndLoad();
    const [, stranger] = await ethers.getSigners();
    await expect(c.connect(stranger).addRecipients([ethers.ZeroAddress])).to.be.revertedWith("not owner");
    await expect(c.connect(stranger).setUnitWei(1)).to.be.revertedWith("not owner");
    await expect(c.connect(stranger).startRound()).to.be.revertedWith("not owner");
    await expect(c.connect(stranger).distribute(1)).to.be.revertedWith("not owner");
    await expect(c.connect(stranger).sweep(stranger.address)).to.be.revertedWith("not owner");
  });

  it("sweep recovers leftover dust", async () => {
    const { c, owner } = await deployAndLoad();
    const dep = ethers.parseUnits((1 / 3500).toFixed(18), 18);
    await runRound(c, owner, dep);
    const leftover = await ethers.provider.getBalance(await c.getAddress());
    expect(leftover).to.be.greaterThan(0n).and.lessThan(UNIT);
    await (await c.sweep(owner.address)).wait();
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0n);
  });
});
