// sim-mev.test.js — adversarial pricing / slippage / keeper-fee invariants for RobinLimit.
// Simulates a maker signing an order and a keeper landing (or failing to land) a fill after the
// market moves, at fee boundaries, and against a fee-on-transfer buyToken. The load-bearing
// invariant: RobinLimit is the sole authority on the limit price and NEVER settles a fill in
// which the maker receives less than the signed minOut, never lets the keeper take more than its
// cut, and never strands ETH or buyToken in the contract between txs.
// Run: npx hardhat test test/sim-mev.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinLimit — MEV / pricing / keeper-fee simulation", () => {
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

  async function mkOrder(over = {}) {
    const t = await now();
    return {
      maker: maker.address,
      sellToken: await weth.getAddress(),
      buyToken: await coin.getAddress(),
      sliceIn: E("1"),
      minOut: E("990"),
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
    await owner.sendTransaction({ to: await swap.getAddress(), value: E("100") });

    domain = {
      name: "RobinLimit", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await limit.getAddress(),
    };
  });

  async function fundBuy(amount) {
    await weth.connect(maker).deposit({ value: amount });
    await weth.connect(maker).approve(await limit.getAddress(), ethers.MaxUint256);
  }

  // The core no-escrow invariant: after any fill the executor must hold nothing.
  async function assertContractEmpty(l, token) {
    expect(await ethers.provider.getBalance(await l.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await l.getAddress())).to.equal(0n);
  }

  // ── Scenario 1: price moves against the maker between sign and fill ──────────
  it("(1) price drops below the order's implied minOut after signing -> execute reverts, maker loses nothing", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder({ minOut: E("990") }); // maker demands >=990 coin/ETH
    const sig = await sign(o);

    // adversary/market moves the price down before the keeper lands the fill
    await swap.setPrice(E("980")); // 1 ETH now buys only 980 coin < 990
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("price");

    // maker's funds untouched: the pull-swap-forward reverted atomically
    expect(await weth.balanceOf(maker.address)).to.equal(E("1"));
    expect(await coin.balanceOf(maker.address)).to.equal(0n);
    expect(await limit.filledSlices(await limit.hashOrder(o))).to.equal(0n);
    await assertContractEmpty(limit, coin);

    // once the price recovers to exactly the floor, the same signed order clears
    await swap.setPrice(E("990"));
    await limit.setKeeperFeeBps(0); // isolate the price gate from the fee
    await limit.connect(keeper).execute(o, sig);
    expect(await coin.balanceOf(maker.address)).to.equal(E("990"));
    await assertContractEmpty(limit, coin);
  });

  // ── Scenario 2: exact minOut boundary ───────────────────────────────────────
  it("(2) boundary: makerOut == minOut fills; makerOut == minOut-1 reverts", async () => {
    await limit.setKeeperFeeBps(0); // fee 0 so makerOut == gross out, isolating the boundary

    // out == minOut: fills exactly on the floor
    await fundBuy(E("1"));
    await swap.setPrice(E("1000"));
    const oEq = await mkOrder({ minOut: E("1000") });
    await limit.connect(keeper).execute(oEq, await sign(oEq));
    expect(await coin.balanceOf(maker.address)).to.equal(E("1000"));
    await assertContractEmpty(limit, coin);

    // out == minOut - 1 (1 wei short): must revert "price", nothing settles
    await fundBuy(E("1"));
    await swap.setPrice(E("1000") - 1n); // 1 ETH buys 1000coin - 1 wei
    const oShort = await mkOrder({ minOut: E("1000") });
    const mBefore = await coin.balanceOf(maker.address);
    await expect(limit.connect(keeper).execute(oShort, await sign(oShort))).to.be.revertedWith("price");
    expect(await coin.balanceOf(maker.address)).to.equal(mBefore); // unchanged
    expect(await weth.balanceOf(maker.address)).to.equal(E("1"));   // slice not pulled
    await assertContractEmpty(limit, coin);
  });

  // ── Scenario 3: keeper fee at 0, 20 (default), 100 (MAX) bps ─────────────────
  it("(3) fee at 0 / 20 / 100 bps: keeper == floor(out*bps/1e4), maker == out-fee >= minOut, maker+keeper == out", async () => {
    // pick a gross out that is NOT divisible by the fee denominator so floor() is observable
    const grossPerEth = E("1000") + 3n; // out = 1000.000...003 coin per ETH
    await swap.setPrice(grossPerEth);
    const out = grossPerEth; // sliceIn = 1 ETH -> out = coinPerEth (18-dec math)

    for (const bps of [0, 20, 100]) {
      await limit.setKeeperFeeBps(bps);
      expect(await limit.keeperFeeBps()).to.equal(BigInt(bps));

      const expFee = (out * BigInt(bps)) / 10000n; // contract's exact floor formula
      const expMaker = out - expFee;

      // fresh maker/keeper balances per iteration by using the running deltas
      const mBefore = await coin.balanceOf(maker.address);
      const kBefore = await coin.balanceOf(keeper.address);

      await fundBuy(E("1"));
      const o = await mkOrder({ minOut: expMaker }); // demand exactly what we expect to net
      await limit.connect(keeper).execute(o, await sign(o));

      const makerGot = (await coin.balanceOf(maker.address)) - mBefore;
      const keeperGot = (await coin.balanceOf(keeper.address)) - kBefore;

      expect(keeperGot).to.equal(expFee);                 // keeper gets exactly floor(out*bps/1e4)
      expect(makerGot).to.equal(expMaker);                // maker gets out - fee
      expect(makerGot).to.be.greaterThanOrEqual(o.minOut); // maker always nets >= minOut
      expect(makerGot + keeperGot).to.equal(out);          // conservation: maker+keeper == out
      await assertContractEmpty(limit, coin);              // nothing stranded
    }

    // sanity on the floor: at 100bps of 1000.000...003, the .003 is truncated from the fee
    await limit.setKeeperFeeBps(100);
    expect((out * 100n) / 10000n).to.equal(E("10")); // == 10.0 exactly, the +3 wei dropped by floor
  });

  // ── Scenario 4: minOut = 0 is rejected outright ─────────────────────────────
  it("(4) minOut = 0 is rejected 'no min' (no unprotected market buy)", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder({ minOut: 0n });
    await expect(limit.connect(keeper).execute(o, await sign(o))).to.be.revertedWith("no min");
    // nothing pulled, nothing filled
    expect(await weth.balanceOf(maker.address)).to.equal(E("1"));
    expect(await limit.filledSlices(await limit.hashOrder(o))).to.equal(0n);
    await assertContractEmpty(limit, coin);
  });

  // ── Scenario 5: fee-on-transfer buyToken — minOut enforced on ACTUAL receipt ─
  it("(5) fee-on-transfer buyToken: minOut is measured post-transfer-fee; too-tight order reverts, slack order fills", async () => {
    const fcoin = await (await ethers.getContractFactory("MintFeeERC20")).deploy("Fee", "FEE", 500); // 5% on transfer
    const fswap = await (await ethers.getContractFactory("MockRobinSwapLimit")).deploy(
      await weth.getAddress(), await fcoin.getAddress(), COIN_PER_ETH);
    const flimit = await (await ethers.getContractFactory("RobinLimit")).deploy(
      await weth.getAddress(), await fswap.getAddress(), owner.address);
    const fdomain = { name: "RobinLimit", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await flimit.getAddress() };

    async function fundF() {
      await weth.connect(maker).deposit({ value: E("1") });
      await weth.connect(maker).approve(await flimit.getAddress(), ethers.MaxUint256);
    }
    const base = async (over) => ({
      maker: maker.address, sellToken: await weth.getAddress(), buyToken: await fcoin.getAddress(),
      sliceIn: E("1"), slices: 1n, interval: 0n, expiry: BigInt(await now() + 3600), ...over,
    });

    // gross out = 1000 coin; default 20bps keeper fee -> send 998; maker actually receives 998*0.95 = 948.1
    // an order demanding 990 must REVERT because the real receipt is only 948.1
    await fundF();
    const tight = await base({ minOut: E("990"), salt: 101n });
    await expect(flimit.connect(keeper).execute(tight, await maker.signTypedData(fdomain, TYPES, tight)))
      .to.be.revertedWith("price");
    expect(await weth.balanceOf(maker.address)).to.equal(E("1")); // slice not pulled
    await assertContractEmpty(flimit, fcoin);

    // a slack order (accept 948) fills, and the maker gets the true post-fee amount, not the pre-fee 998
    const mBefore = await fcoin.balanceOf(maker.address);
    const slack = await base({ minOut: E("948"), salt: 102n });
    await flimit.connect(keeper).execute(slack, await maker.signTypedData(fdomain, TYPES, slack));
    const makerGot = (await fcoin.balanceOf(maker.address)) - mBefore;
    expect(makerGot).to.equal(E("948.1"));                  // 998 * 0.95, the ACTUAL receipt
    expect(makerGot).to.be.greaterThanOrEqual(slack.minOut); // >= signed minOut
    await assertContractEmpty(flimit, fcoin);                // executor holds no ETH, no buyToken
  });
});
