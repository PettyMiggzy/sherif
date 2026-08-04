const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;

describe("Disperse", () => {
  async function setup() {
    const [dep, a, b, c] = await ethers.getSigners();
    const tok = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const disperse = await (await ethers.getContractFactory("Disperse")).deploy();
    return { dep, a, b, c, tok, disperse, addr: await disperse.getAddress() };
  }

  it("disperseTokenDirect: splits from sender to each recipient, contract holds nothing", async () => {
    const { dep, a, b, c, tok, disperse, addr } = await setup();
    const vals = [10n * ONE, 25n * ONE, 5n * ONE];
    const total = vals.reduce((x, y) => x + y, 0n);
    await tok.approve(addr, total);
    await disperse.disperseTokenDirect(await tok.getAddress(), [a.address, b.address, c.address], vals);
    expect(await tok.balanceOf(a.address)).to.equal(vals[0]);
    expect(await tok.balanceOf(b.address)).to.equal(vals[1]);
    expect(await tok.balanceOf(c.address)).to.equal(vals[2]);
    expect(await tok.balanceOf(addr)).to.equal(0n); // never custodies
  });

  it("disperseToken: pulls the sum once then pays out; contract nets to zero", async () => {
    const { dep, a, b, tok, disperse, addr } = await setup();
    const vals = [7n * ONE, 3n * ONE];
    const total = vals.reduce((x, y) => x + y, 0n);
    await tok.approve(addr, total);
    await disperse.disperseToken(await tok.getAddress(), [a.address, b.address], vals);
    expect(await tok.balanceOf(a.address)).to.equal(vals[0]);
    expect(await tok.balanceOf(b.address)).to.equal(vals[1]);
    expect(await tok.balanceOf(addr)).to.equal(0n);
  });

  it("disperseToken reverts (allowance) if the sender didn't approve the full sum", async () => {
    const { a, b, tok, disperse, addr } = await setup();
    await tok.approve(addr, 5n * ONE); // less than the 10 needed
    await expect(
      disperse.disperseToken(await tok.getAddress(), [a.address, b.address], [6n * ONE, 4n * ONE]),
    ).to.be.reverted;
  });

  it("disperseEther: pays each recipient and refunds the remainder to the sender", async () => {
    const { dep, a, b, disperse, addr } = await setup();
    const vals = [1n * ONE, 2n * ONE];
    const total = vals[0] + vals[1];
    const sent = total + (ONE / 2n); // 0.5 ETH overpay -> must be refunded
    await expect(
      disperse.disperseEther([a.address, b.address], vals, { value: sent }),
    ).to.changeEtherBalances([a, b], [vals[0], vals[1]]);
    expect(await ethers.provider.getBalance(addr)).to.equal(0n); // nothing stuck (recipients + refund)
  });

  it("disperseEther reverts when msg.value is short of the summed amounts", async () => {
    const { a, b, disperse } = await setup();
    await expect(
      disperse.disperseEther([a.address, b.address], [1n * ONE, 2n * ONE], { value: 2n * ONE }),
    ).to.be.revertedWithCustomError(disperse, "ValueMismatch");
  });

  it("reverts on length mismatch / empty / over-cap", async () => {
    const { a, b, tok, disperse } = await setup();
    const t = await tok.getAddress();
    await expect(disperse.disperseTokenDirect(t, [a.address, b.address], [1n]))
      .to.be.revertedWithCustomError(disperse, "LengthMismatch");
    await expect(disperse.disperseTokenDirect(t, [], []))
      .to.be.revertedWithCustomError(disperse, "EmptyList");
    const many = new Array(601).fill(a.address);
    const manyV = new Array(601).fill(1n);
    await expect(disperse.disperseTokenDirect(t, many, manyV))
      .to.be.revertedWithCustomError(disperse, "TooManyRecipients");
  });
});
