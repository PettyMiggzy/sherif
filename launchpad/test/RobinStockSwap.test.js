const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinStockSwap — any listed token <-> any listed token (incl. tokenized stocks) via WETH, platform fee on
// the WETH mid-leg. Mock SwapRouter02 produces tokenOut at a 1:1 rate, so the math is exact and easy to assert.

const E = (n) => ethers.parseEther(String(n));

describe("RobinStockSwap", () => {
  let owner, curator, user, user2, platform, recipient;
  let weth, router, meme, stock, swap;

  beforeEach(async () => {
    [owner, curator, user, user2, platform, recipient] = await ethers.getSigners();

    weth = await (await ethers.getContractFactory("RsWETH9")).deploy();
    router = await (await ethers.getContractFactory("MockSwapRouter02")).deploy(await weth.getAddress());
    // fund the mock router with ETH so it can pay out WETH (depositTo) on any token->WETH leg
    await owner.sendTransaction({ to: await router.getAddress(), value: E(1000) });

    meme = await (await ethers.getContractFactory("RsERC20")).deploy("Meme", "MEME");
    stock = await (await ethers.getContractFactory("RsERC20")).deploy("nVDA", "NVDA");

    swap = await (await ethers.getContractFactory("RobinStockSwap")).deploy(
      await weth.getAddress(), await router.getAddress(), owner.address
    );
    await swap.list(await meme.getAddress(), 10000);
    await swap.list(await stock.getAddress(), 10000);
  });

  it("defaults to a 2% fee, capped at 3%", async () => {
    expect(await swap.feeBps()).to.equal(200n);
    expect(await swap.MAX_FEE_BPS()).to.equal(300n);
  });

  it("token -> stock: routes through WETH and skims 2% to the platform escrow (as WETH)", async () => {
    await meme.mint(user.address, E(100));
    await meme.connect(user).approve(await swap.getAddress(), E(100));

    await swap.connect(user).swap(await meme.getAddress(), await stock.getAddress(), E(100), 0, user.address);

    // 100 meme -> 100 WETH; 2% (2 WETH) to platform; 98 WETH -> 98 stock to the user
    expect(await stock.balanceOf(user.address)).to.equal(E(98));
    expect(await swap.platformEscrowWeth()).to.equal(E(2));
  });

  it("ETH -> stock via swapFromETH: 2% skimmed, rest bought", async () => {
    await swap.connect(user).swapFromETH(await stock.getAddress(), 0, user.address, { value: E(100) });
    expect(await stock.balanceOf(user.address)).to.equal(E(98));
    expect(await swap.platformEscrowWeth()).to.equal(E(2));
  });

  it("stock -> ETH: unwraps the WETH leg to native ETH for the recipient", async () => {
    await stock.mint(user2.address, E(50));
    await stock.connect(user2).approve(await swap.getAddress(), E(50));

    const before = await ethers.provider.getBalance(recipient.address);
    await swap.connect(user2).swap(await stock.getAddress(), await weth.getAddress(), E(50), 0, recipient.address);
    const after = await ethers.provider.getBalance(recipient.address);

    // 50 stock -> 50 WETH; 1 WETH fee; 49 ETH to the (non-signing) recipient
    expect(after - before).to.equal(E(49));
    expect(await swap.platformEscrowWeth()).to.equal(E(1));
  });

  it("withdrawPlatform sweeps accrued WETH fees to the platform wallet", async () => {
    await meme.mint(user.address, E(100));
    await meme.connect(user).approve(await swap.getAddress(), E(100));
    await swap.connect(user).swap(await meme.getAddress(), await stock.getAddress(), E(100), 0, user.address);

    await swap.setPlatformWallet(platform.address);
    await swap.withdrawPlatform();
    expect(await weth.balanceOf(platform.address)).to.equal(E(2));
    expect(await swap.platformEscrowWeth()).to.equal(0n);
  });

  it("enforces whole-route slippage via minOut", async () => {
    await meme.mint(user.address, E(100));
    await meme.connect(user).approve(await swap.getAddress(), E(100));
    await expect(
      swap.connect(user).swap(await meme.getAddress(), await stock.getAddress(), E(100), E(100), user.address)
    ).to.be.revertedWithCustomError(swap, "Slippage");
  });

  it("rejects same-token, unlisted, and paused routes", async () => {
    await meme.mint(user.address, E(10));
    await meme.connect(user).approve(await swap.getAddress(), E(10));

    await expect(
      swap.connect(user).swap(await meme.getAddress(), await meme.getAddress(), E(10), 0, user.address)
    ).to.be.revertedWithCustomError(swap, "SameToken");

    const other = await (await ethers.getContractFactory("RsERC20")).deploy("X", "X");
    await expect(
      swap.connect(user).swap(await meme.getAddress(), await other.getAddress(), E(10), 0, user.address)
    ).to.be.revertedWithCustomError(swap, "Unknown");

    await swap.setPaused(await stock.getAddress(), true);
    await expect(
      swap.connect(user).swap(await meme.getAddress(), await stock.getAddress(), E(10), 0, user.address)
    ).to.be.revertedWithCustomError(swap, "Paused");
  });

  it("rescue recovers stranded ETH + donated WETH but never the fee escrow", async () => {
    // accrue 2 WETH of real escrow via a swap
    await meme.mint(user.address, E(100));
    await meme.connect(user).approve(await swap.getAddress(), E(100));
    await swap.connect(user).swap(await meme.getAddress(), await stock.getAddress(), E(100), 0, user.address);
    expect(await swap.platformEscrowWeth()).to.equal(E(2));

    // donate 5 WETH + send 3 ETH directly to the contract
    await weth.connect(user2).deposit({ value: E(5) });
    await weth.connect(user2).transfer(await swap.getAddress(), E(5));
    await user2.sendTransaction({ to: await swap.getAddress(), value: E(3) });

    const ethBefore = await ethers.provider.getBalance(recipient.address);
    await swap.rescue(recipient.address);
    const ethAfter = await ethers.provider.getBalance(recipient.address);

    expect(ethAfter - ethBefore).to.equal(E(3)); // stranded ETH out
    expect(await weth.balanceOf(recipient.address)).to.equal(E(5)); // only the donated excess WETH
    expect(await swap.platformEscrowWeth()).to.equal(E(2)); // escrow untouched
    expect(await weth.balanceOf(await swap.getAddress())).to.equal(E(2)); // escrow still backed

    await expect(swap.connect(user).rescue(user.address)).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
  });

  it("caps the fee at 3% and gates config/curation", async () => {
    await expect(swap.setFeeBps(301)).to.be.revertedWithCustomError(swap, "BadArg");
    await swap.setFeeBps(150);
    expect(await swap.feeBps()).to.equal(150n);

    await expect(swap.connect(user).setFeeBps(100)).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
    await expect(swap.connect(user).list(await weth.getAddress(), 3000)).to.be.revertedWithCustomError(swap, "NotCurator");
    await expect(swap.list(await meme.getAddress(), 3000)).to.be.revertedWithCustomError(swap, "AlreadyListed");
    await expect(swap.renounceOwnership()).to.be.revertedWith("disabled");
  });
});
