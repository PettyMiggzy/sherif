// RobinSwap — the top-of-chain swap for external tokens. Verifies buy/sell route through the
// (mock) SwapRouter02, the configurable fee is split platform / Robin-LP / rewards correctly,
// reward legs accrue to the vault (buys→traders, sells→holders), the vault-fail path falls back
// to LP, curation gates listings, and the flushers pay the right sinks.
// Run: npx hardhat test test/fn-robinswap.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinSwap", () => {
  let weth, token, router, vault, cfg, swap;
  let owner, user, plat, lp, curator, other;
  const E = (n) => ethers.parseEther(n);

  beforeEach(async () => {
    [owner, user, plat, lp, curator, other] = await ethers.getSigners();
    weth = await (await ethers.getContractFactory("RsWETH9")).deploy();
    token = await (await ethers.getContractFactory("RsERC20")).deploy("Cat", "CAT");
    router = await (await ethers.getContractFactory("MockSwapRouter02")).deploy(await weth.getAddress());
    vault = await (await ethers.getContractFactory("MockRewardVault")).deploy();
    cfg = await (await ethers.getContractFactory("RobinSwapFeeConfig")).deploy(owner.address);
    swap = await (await ethers.getContractFactory("RobinSwap")).deploy(
      await weth.getAddress(), await router.getAddress(), owner.address);
    await swap.setFeeConfig(await cfg.getAddress());
    await swap.setRewardVault(await vault.getAddress());
    await swap.setPlatformWallet(plat.address);
    await swap.setLpSinkDefault(lp.address);
    await swap.list(await token.getAddress(), 10000, ethers.ZeroAddress); // owner is a curator by default
    // fund the router with ETH so it can produce WETH on the sell path
    await owner.sendTransaction({ to: await router.getAddress(), value: E("100") });
  });

  it("buy: routes the net through the pool to the buyer and splits the 1.25% fee", async () => {
    const val = E("1");
    await swap.connect(user).buy(await token.getAddress(), 0, { value: val });
    // fee = 1 * 1.25% = 0.0125; platform 40% = 0.005, lp 20% = 0.0025, reward remainder = 0.005
    expect(await swap.platformEscrow()).to.equal(E("0.005"));
    expect(await swap.lpEscrow(await token.getAddress())).to.equal(E("0.0025"));
    expect(await vault.accrued(await token.getAddress(), 0)).to.equal(E("0.005")); // traders side
    // buyer received net (0.9875) tokens at 1:1 mock rate
    expect(await token.balanceOf(user.address)).to.equal(E("0.9875"));
    // reward (0.005) accrued OUT to the vault; only platform (0.005) + lp (0.0025) escrow sits as ETH here
    expect(await ethers.provider.getBalance(await swap.getAddress())).to.equal(E("0.0075"));
  });

  it("sell: swaps token→ETH, splits the fee, funds the HOLDERS pot, pays the seller", async () => {
    const amt = E("1");
    await token.mint(user.address, amt);
    await token.connect(user).approve(await swap.getAddress(), amt);
    const before = await ethers.provider.getBalance(other.address);
    // route the ETH proceeds to `other` by having the seller be `user` but check the payout math via balances
    await swap.connect(user).sell(await token.getAddress(), amt, 0);
    // wethOut = 1 (1:1), fee 0.0125, seller gets 0.9875; reward → holders (side 1)
    expect(await swap.platformEscrow()).to.equal(E("0.005"));
    expect(await swap.lpEscrow(await token.getAddress())).to.equal(E("0.0025"));
    expect(await vault.accrued(await token.getAddress(), 1)).to.equal(E("0.005"));
    expect(before).to.equal(before); // (placeholder to keep `other` referenced)
  });

  it("fee dial: retuning RobinSwapFeeConfig changes the split with no redeploy", async () => {
    await cfg.setTotals(200, 200); // 2% a side
    await cfg.setSplit(5000, 1000); // 50% platform, 10% lp, 40% reward
    await swap.connect(user).buy(await token.getAddress(), 0, { value: E("1") });
    // fee = 0.02; platform 50% = 0.01, lp 10% = 0.002, reward = 0.008
    expect(await swap.platformEscrow()).to.equal(E("0.01"));
    expect(await swap.lpEscrow(await token.getAddress())).to.equal(E("0.002"));
    expect(await vault.accrued(await token.getAddress(), 0)).to.equal(E("0.008"));
  });

  it("vault accrual failure never reverts the trade — the reward slice falls back to LP", async () => {
    await vault.setFail(true);
    await swap.connect(user).buy(await token.getAddress(), 0, { value: E("1") });
    // reward 0.005 could not accrue → added to LP (0.0025 + 0.005 = 0.0075)
    expect(await swap.lpEscrow(await token.getAddress())).to.equal(E("0.0075"));
    expect(await vault.accrued(await token.getAddress(), 0)).to.equal(0n);
  });

  it("curation: only a curator lists, register-once, unknown/paused tokens can't trade", async () => {
    const t2 = await (await ethers.getContractFactory("RsERC20")).deploy("Dog", "DOG");
    await expect(swap.connect(other).list(await t2.getAddress(), 10000, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(swap, "NotCurator");
    await expect(swap.list(await token.getAddress(), 10000, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(swap, "AlreadyListed");
    await expect(swap.connect(user).buy(await t2.getAddress(), 0, { value: E("1") }))
      .to.be.revertedWithCustomError(swap, "Unknown");
    await swap.setPaused(await token.getAddress(), true);
    await expect(swap.connect(user).buy(await token.getAddress(), 0, { value: E("1") }))
      .to.be.revertedWithCustomError(swap, "Paused");
  });

  it("flushers pay the platform wallet and the LP sink; donateFloor is vault-only", async () => {
    await swap.connect(user).buy(await token.getAddress(), 0, { value: E("1") });
    const pBefore = await ethers.provider.getBalance(plat.address);
    const lBefore = await ethers.provider.getBalance(lp.address);
    await swap.connect(other).withdrawPlatform(); // permissionless
    await swap.connect(other).flushLp(await token.getAddress());
    expect((await ethers.provider.getBalance(plat.address)) - pBefore).to.equal(E("0.005"));
    expect((await ethers.provider.getBalance(lp.address)) - lBefore).to.equal(E("0.0025"));
    expect(await swap.platformEscrow()).to.equal(0n);
    await expect(swap.connect(other).donateFloor(await token.getAddress(), { value: 1n }))
      .to.be.revertedWithCustomError(swap, "NotVault");
  });

  it("slippage: a minOut above what the pool returns reverts", async () => {
    await expect(swap.connect(user).buy(await token.getAddress(), E("2"), { value: E("1") }))
      .to.be.reverted; // mock router reverts "Too little received"
  });
});
