// RobinZap — the cross-chain destination handler. Verifies it buys through PadRouter,
// forwards the coins to the real recipient (not itself), refunds ETH on a failed buy
// instead of stranding it, unwraps WETH on the Across path, and gates that path to the
// SpokePool. Run: npx hardhat test test/fn-robinzap.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinZap", () => {
  let coin, weth, router, zap, deployer, user, spoke, other;
  const RATE = 1000n; // coins per wei

  beforeEach(async () => {
    [deployer, user, spoke, other] = await ethers.getSigners();
    coin = await (await ethers.getContractFactory("MockCoin")).deploy();
    weth = await (await ethers.getContractFactory("MockWETH")).deploy();
    router = await (await ethers.getContractFactory("MockPadRouter")).deploy(await coin.getAddress(), RATE);
    zap = await (await ethers.getContractFactory("RobinZap")).deploy(
      await router.getAddress(), await weth.getAddress(), spoke.address);
    // Fund the router so it can pay over-ceiling refunds.
    await deployer.sendTransaction({ to: await router.getAddress(), value: ethers.parseEther("10") });
  });

  it("zap: buys and forwards the coins to the recipient (not to the zap contract)", async () => {
    const val = ethers.parseEther("1");
    await zap.connect(user).zap(await coin.getAddress(), 0, user.address, { value: val });
    expect(await coin.balanceOf(user.address)).to.equal(val * RATE);
    expect(await coin.balanceOf(await zap.getAddress())).to.equal(0n); // never stranded in the handler
  });

  it("zap: refunds over-ceiling ETH dust to the recipient", async () => {
    await router.setRefund(ethers.parseEther("0.1")); // router hands back 0.1 ETH
    const before = await ethers.provider.getBalance(other.address);
    await zap.connect(user).zap(await coin.getAddress(), 0, other.address, { value: ethers.parseEther("1") });
    const after = await ethers.provider.getBalance(other.address);
    expect(after - before).to.equal(ethers.parseEther("0.1")); // recipient, not the caller, gets the dust
    expect(await ethers.provider.getBalance(await zap.getAddress())).to.equal(0n);
  });

  it("zap: on a failed buy (slippage), refunds the full input to the recipient", async () => {
    const val = ethers.parseEther("1");
    // minOut higher than the mock will produce -> router reverts -> RobinZap refunds.
    const before = await ethers.provider.getBalance(other.address);
    await zap.connect(user).zap(await coin.getAddress(), val * RATE * 2n, other.address, { value: val });
    const after = await ethers.provider.getBalance(other.address);
    expect(after - before).to.equal(val);            // whole input returned to the recipient
    expect(await coin.balanceOf(other.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(await zap.getAddress())).to.equal(0n);
  });

  it("handleV3AcrossMessage: unwraps WETH, buys, forwards coins", async () => {
    const amount = ethers.parseEther("2");
    // Across delivers WETH to the zap contract; back the WETH with real ETH so withdraw works.
    await weth.mintTo(await zap.getAddress(), { value: amount });
    const msgData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address"], [await coin.getAddress(), 0, user.address]);
    await zap.connect(spoke).handleV3AcrossMessage(await weth.getAddress(), amount, other.address, msgData);
    expect(await coin.balanceOf(user.address)).to.equal(amount * RATE);
    expect(await coin.balanceOf(await zap.getAddress())).to.equal(0n);
  });

  it("handleV3AcrossMessage: only the SpokePool can call it", async () => {
    const msgData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address"], [await coin.getAddress(), 0, user.address]);
    await expect(
      zap.connect(other).handleV3AcrossMessage(await weth.getAddress(), 1n, other.address, msgData)
    ).to.be.revertedWithCustomError(zap, "NotSpokePool");
  });

  it("zap: rejects a zero recipient and a zero value", async () => {
    await expect(zap.connect(user).zap(await coin.getAddress(), 0, ethers.ZeroAddress, { value: 1n }))
      .to.be.revertedWithCustomError(zap, "BadRecipient");
    await expect(zap.connect(user).zap(await coin.getAddress(), 0, user.address, { value: 0n }))
      .to.be.revertedWithCustomError(zap, "NothingToZap");
  });
});
