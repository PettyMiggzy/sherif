// Per-function sim: PlatformFeeSplitter — ships as a 100% passthrough to the treasury; a configured robinShare
// splits to the sink; only the owner can reconfigure; caps at 100%; never strands funds.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PlatformFeeSplitter — passthrough + configurable split", function () {
  async function deploy() {
    const [dep, treasury, owner, sink, robin] = await ethers.getSigners();
    const s = await (await ethers.getContractFactory("PlatformFeeSplitter")).deploy(treasury.address, owner.address);
    return { dep, treasury, owner, sink, robin, s };
  }

  it("default: forwards 100% to the treasury via receive()", async () => {
    const { dep, treasury, s } = await deploy();
    const pre = await ethers.provider.getBalance(treasury.address);
    await (await dep.sendTransaction({ to: await s.getAddress(), value: ethers.parseEther("1") })).wait();
    expect((await ethers.provider.getBalance(treasury.address)) - pre).to.equal(ethers.parseEther("1"));
    expect(await ethers.provider.getBalance(await s.getAddress())).to.equal(0n); // nothing stranded
  });

  it("with a 25% robin share set, splits sink/treasury exactly; owner-only; caps at 100%", async () => {
    const { dep, treasury, owner, robin, s } = await deploy();
    await expect(s.connect(dep).setRobinShareBps(2500)).to.be.reverted; // non-owner
    await expect(s.connect(owner).setRobinShareBps(10001)).to.be.revertedWithCustomError(s, "BadBps");
    await (await s.connect(owner).setRobinShareBps(2500)).wait();
    await (await s.connect(owner).setRobinSink(robin.address)).wait();

    const preT = await ethers.provider.getBalance(treasury.address);
    const preR = await ethers.provider.getBalance(robin.address);
    await (await dep.sendTransaction({ to: await s.getAddress(), value: ethers.parseEther("1") })).wait();
    expect((await ethers.provider.getBalance(robin.address)) - preR).to.equal(ethers.parseEther("0.25"));
    expect((await ethers.provider.getBalance(treasury.address)) - preT).to.equal(ethers.parseEther("0.75"));
  });

  it("bps set but sink unset -> still forwards everything to treasury (never reverts on unset sink)", async () => {
    const { dep, treasury, owner, s } = await deploy();
    await (await s.connect(owner).setRobinShareBps(3000)).wait(); // sink left at address(0)
    const pre = await ethers.provider.getBalance(treasury.address);
    await (await dep.sendTransaction({ to: await s.getAddress(), value: ethers.parseEther("1") })).wait();
    expect((await ethers.provider.getBalance(treasury.address)) - pre).to.equal(ethers.parseEther("1"));
  });
});
