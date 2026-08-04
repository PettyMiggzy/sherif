// Simulations for Disperse: adversarial (reentrancy, fee-on-transfer) + realistic
// usage (the 6-wallet dev-buy split math, a large airdrop batch).
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;

describe("Disperse (sim)", () => {
  async function base() {
    const [dep, a, b, c] = await ethers.getSigners();
    const disperse = await (await ethers.getContractFactory("Disperse")).deploy();
    return { dep, a, b, c, disperse, addr: await disperse.getAddress() };
  }

  it("reentrancy: a malicious ETH recipient cannot re-enter (guard blocks it); legit legs still pay", async () => {
    const { b, disperse, addr } = await base();
    const attacker = await (await ethers.getContractFactory("ReenterEther")).deploy(addr);
    const atkAddr = await attacker.getAddress();

    await expect(
      disperse.disperseEther([atkAddr, b.address], [ONE, ONE], { value: 2n * ONE }),
    ).to.changeEtherBalances([b], [ONE]);

    expect(await attacker.tried()).to.equal(true);
    expect(await attacker.reentryReverted()).to.equal(true); // ReentrancyGuard stopped the inner call
    expect(await ethers.provider.getBalance(atkAddr)).to.equal(ONE); // attacker still got its (legit) leg
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);     // nothing stuck / drained
  });

  it("fee-on-transfer: disperseTokenDirect stays safe (each recipient nets amount-fee)", async () => {
    const { a, b, disperse, addr } = await base();
    const fee = await (await ethers.getContractFactory("FeeERC20")).deploy(1_000_000n * ONE);
    const vals = [1000n * ONE, 2000n * ONE];
    await fee.approve(addr, vals[0] + vals[1]);
    await disperse.disperseTokenDirect(await fee.getAddress(), [a.address, b.address], vals);
    // 1% burned on each transfer -> recipient nets 99%
    expect(await fee.balanceOf(a.address)).to.equal(vals[0] - vals[0] / 100n);
    expect(await fee.balanceOf(b.address)).to.equal(vals[1] - vals[1] / 100n);
    expect(await fee.balanceOf(addr)).to.equal(0n);
  });

  it("fee-on-transfer: the pull-based disperseToken reverts (why direct is the default)", async () => {
    const { a, b, disperse, addr } = await base();
    const fee = await (await ethers.getContractFactory("FeeERC20")).deploy(1_000_000n * ONE);
    const vals = [1000n * ONE, 2000n * ONE];
    await fee.approve(addr, vals[0] + vals[1]);
    // pulls `total` but only receives total-fee, then can't pay the full amounts out -> revert
    await expect(
      disperse.disperseToken(await fee.getAddress(), [a.address, b.address], vals),
    ).to.be.reverted;
  });

  it("dev-buy split: 6 wallets by %, mirrors the create.html bps math; dust stays with the dev", async () => {
    const signers = await ethers.getSigners();
    const dep = signers[0];
    const wallets = signers.slice(1, 7); // 6 recipients
    const disperse = await (await ethers.getContractFactory("Disperse")).deploy();
    const addr = await disperse.getAddress();
    const tok = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);

    // simulate a dev-buy balance that doesn't divide evenly, to exercise rounding
    const bal = 333_333n * ONE + 7n;
    const pcts = [30, 25, 20, 15, 7, 3]; // sums to 100
    const amts = pcts.map((p) => (bal * BigInt(p * 100)) / 10000n); // pct -> bps of balance
    const total = amts.reduce((s, v) => s + v, 0n);
    expect(total).to.be.lte(bal); // never exceeds what the dev holds

    await tok.approve(addr, total);
    await disperse.disperseTokenDirect(await tok.getAddress(), wallets.map((w) => w.address), amts);
    for (let i = 0; i < 6; i++) expect(await tok.balanceOf(wallets[i].address)).to.equal(amts[i]);
    // the dev keeps the un-assigned remainder (rounding dust here, or any <100% total)
    expect(await tok.balanceOf(dep.address)).to.equal(1_000_000n * ONE - total);
  });

  it("large batch: an airdrop to 200 wallets goes through in one tx", async () => {
    const { dep, disperse, addr } = await base();
    const tok = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const recips = [];
    for (let i = 0; i < 200; i++) recips.push(ethers.getAddress("0x" + (i + 1).toString(16).padStart(40, "0")));
    const vals = recips.map(() => ONE);
    const total = ONE * 200n;
    await tok.approve(addr, total);
    await disperse.disperseTokenDirect(await tok.getAddress(), recips, vals);
    expect(await tok.balanceOf(recips[0])).to.equal(ONE);
    expect(await tok.balanceOf(recips[199])).to.equal(ONE);
    expect(await tok.balanceOf(addr)).to.equal(0n);
  });
});
