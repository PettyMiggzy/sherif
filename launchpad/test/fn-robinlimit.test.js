// RobinLimit — non-custodial limit orders + DCA over RobinSwap. Verifies a limit buy/sell fills
// only when the signed minOut price clears, the maker keeps custody (pull-swap-forward, no escrow),
// the keeper fee is capped and taken from output after minOut, DCA respects slice count + interval
// and can't be over-filled, cancel + expiry + replay + bad-signature are all rejected.
// Run: npx hardhat test test/fn-robinlimit.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinLimit", () => {
  let weth, coin, swap, limit;
  let owner, maker, keeper, other;
  const E = (n) => ethers.parseEther(n);
  const COIN_PER_ETH = E("1000"); // 1 ETH buys 1000 coin at the mock's set price

  let domain;
  const TYPES = {
    Order: [
      { name: "maker", type: "address" },
      { name: "sellToken", type: "address" },
      { name: "buyToken", type: "address" },
      { name: "sliceIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "slices", type: "uint256" },
      { name: "interval", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "salt", type: "uint256" },
    ],
  };

  async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }

  // Build an order object with sensible defaults, overridable per-test.
  async function mkOrder(over = {}) {
    const t = await now();
    return {
      maker: maker.address,
      sellToken: await weth.getAddress(),
      buyToken: await coin.getAddress(),
      sliceIn: E("1"),
      minOut: E("990"),   // accept ≥990 coin for 1 ETH (price gate)
      slices: 1n,
      interval: 0n,
      expiry: BigInt(t + 3600),
      salt: BigInt(Math.floor(Math.random() * 1e9)),
      ...over,
    };
  }
  async function sign(order) { return maker.signTypedData(domain, TYPES, order); }

  beforeEach(async () => {
    [owner, maker, keeper, other] = await ethers.getSigners();
    weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    coin = await (await ethers.getContractFactory("MintERC20")).deploy("Robin", "ROBIN");
    swap = await (await ethers.getContractFactory("MockRobinSwapLimit")).deploy(
      await weth.getAddress(), await coin.getAddress(), COIN_PER_ETH);
    limit = await (await ethers.getContractFactory("RobinLimit")).deploy(
      await weth.getAddress(), await swap.getAddress(), owner.address);
    // fund the mock swap with ETH so the sell path can pay out
    await owner.sendTransaction({ to: await swap.getAddress(), value: E("100") });

    domain = {
      name: "RobinLimit", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await limit.getAddress(),
    };
  });

  // Give the maker WETH and approve the limit contract (buy side).
  async function fundBuy(amount) {
    await weth.connect(maker).deposit({ value: amount });
    await weth.connect(maker).approve(await limit.getAddress(), ethers.MaxUint256);
  }
  // Give the maker coin and approve (sell side).
  async function fundSell(amount) {
    await coin.mint(maker.address, amount);
    await coin.connect(maker).approve(await limit.getAddress(), ethers.MaxUint256);
  }

  it("fills a limit BUY when the price clears; maker gets coin, keeper gets the capped fee", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder();
    const sig = await sign(o);
    await limit.connect(keeper).execute(o, sig);

    // 1 ETH * 1000 = 1000 coin out; keeper fee 0.20% = 2 coin; maker gets 998 (≥ minOut 990)
    expect(await coin.balanceOf(maker.address)).to.equal(E("998"));
    expect(await coin.balanceOf(keeper.address)).to.equal(E("2"));
    expect(await weth.balanceOf(maker.address)).to.equal(0n); // the WETH was spent
    expect(await limit.filledSlices(await limit.hashOrder(o))).to.equal(1n);
  });

  it("reverts a BUY when the price does not clear (minOut not met)", async () => {
    await fundBuy(E("1"));
    await swap.setPrice(E("980")); // now 1 ETH only buys 980 coin < minOut 990
    const o = await mkOrder();
    await expect(limit.connect(keeper).execute(o, await sign(o))).to.be.revertedWith("price");
  });

  it("fills a limit SELL (coin → WETH) and pays the maker WETH", async () => {
    await fundSell(E("1000"));
    const o = await mkOrder({
      sellToken: await coin.getAddress(),
      buyToken: await weth.getAddress(),
      sliceIn: E("1000"),
      minOut: E("0.99"), // 1000 coin → 1 ETH; accept ≥0.99 WETH
    });
    await limit.connect(keeper).execute(o, await sign(o));
    // 1 WETH out, 0.20% keeper fee = 0.002, maker gets 0.998
    expect(await weth.balanceOf(maker.address)).to.equal(E("0.998"));
    expect(await weth.balanceOf(keeper.address)).to.equal(E("0.002"));
    expect(await coin.balanceOf(maker.address)).to.equal(0n);
  });

  it("runs a DCA order over N slices, enforcing the interval and never over-filling", async () => {
    await fundBuy(E("3"));
    const o = await mkOrder({ sliceIn: E("1"), slices: 3n, interval: 100n, minOut: E("990") });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    await limit.connect(keeper).execute(o, sig); // slice 1 ok
    expect(await limit.filledSlices(h)).to.equal(1n);
    // too soon for slice 2
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("too soon");
    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);
    await limit.connect(keeper).execute(o, sig); // slice 2 ok
    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);
    await limit.connect(keeper).execute(o, sig); // slice 3 ok
    expect(await limit.filledSlices(h)).to.equal(3n);
    // no 4th slice
    await ethers.provider.send("evm_increaseTime", [101]);
    await ethers.provider.send("evm_mine", []);
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("filled");
    expect(await coin.balanceOf(maker.address)).to.equal(E("2994")); // 3 * 998
  });

  it("lets the maker cancel; a cancelled order can't be executed", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder();
    const sig = await sign(o);
    await expect(limit.connect(other).cancel(o)).to.be.revertedWith("not maker");
    await limit.connect(maker).cancel(o);
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("cancelled");
  });

  it("rejects an expired order and a bad signature", async () => {
    await fundBuy(E("1"));
    const expired = await mkOrder({ expiry: BigInt(await now()) - 1n });
    await expect(limit.connect(keeper).execute(expired, await sign(expired))).to.be.revertedWith("expired");

    const o = await mkOrder();
    const badSig = await other.signTypedData(domain, TYPES, o); // signed by the wrong wallet
    await expect(limit.connect(keeper).execute(o, badSig)).to.be.revertedWith("bad sig");
  });

  it("caps the keeper fee at MAX_KEEPER_BPS", async () => {
    await expect(limit.setKeeperFeeBps(101)).to.be.revertedWith("fee too high");
    await limit.setKeeperFeeBps(100); // 1% exactly is allowed
    expect(await limit.keeperFeeBps()).to.equal(100n);
  });

  it("rejects a pair where neither/both legs are WETH", async () => {
    await fundSell(E("10"));
    const bad = await mkOrder({
      sellToken: await coin.getAddress(),
      buyToken: await coin.getAddress(), // both non-WETH
      sliceIn: E("10"), minOut: 0n,
    });
    await expect(limit.connect(keeper).execute(bad, await sign(bad))).to.be.revertedWith("pair");
  });
});
