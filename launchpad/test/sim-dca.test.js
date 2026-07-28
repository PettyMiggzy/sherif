// sim-dca.test.js — full DCA lifecycle + concurrency + cancel/expiry + ETH-refund sweep simulation
// for RobinLimit (Robin Labs, Robinhood Chain 4663, legacy type-0 txs, no EIP-1559).
//
// This simulates the non-custodial DCA/limit lifecycle end-to-end and asserts the invariants that
// MUST hold no matter what a keeper does:
//   INV-1  total filled slices never exceeds the signed slice count (no over-fill).
//   INV-2  filledSlices is monotonic non-decreasing, +1 per successful fill, never skips/rewinds.
//   INV-3  the DCA interval is enforced — a too-soon fill reverts, cadence can't be sped up.
//   INV-4  two keepers racing the SAME slice in the SAME block => exactly one fills, no double-fill.
//   INV-5  a cancelled order's remaining slices all revert "cancelled" — irreversible.
//   INV-6  an expired order reverts "expired" mid-DCA — no fills past expiry.
//   INV-7  the maker always receives >= signed minOut on every slice (measured on receipt).
//   INV-8  a venue ETH refund (near-graduation partial fill) is swept to the maker as WETH; the
//          contract strands 0 ETH between txs (non-custodial: never holds a balance).
//
// Run: npx hardhat test test/sim-dca.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinLimit — DCA lifecycle / concurrency / cancel simulation", () => {
  let weth, coin, swap, limit;
  let owner, maker, keeperA, keeperB;
  const E = (n) => ethers.parseEther(n);
  const COIN_PER_ETH = E("1000");

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
  async function bump(secs) {
    await ethers.provider.send("evm_increaseTime", [secs]);
    await ethers.provider.send("evm_mine", []);
  }

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
      salt: BigInt(Math.floor(Math.random() * 1e12)),
      ...over,
    };
  }
  async function sign(order) { return maker.signTypedData(domain, TYPES, order); }

  beforeEach(async () => {
    [owner, maker, keeperA, keeperB] = await ethers.getSigners();
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

  // ── Scenario 1: N=5 DCA fills exactly 5 times, never 6; interval enforced; filledSlices monotonic ──
  it("(1) N=5 DCA: fills exactly 5, never 6; interval gate reverts too-soon; filledSlices monotonic", async () => {
    const N = 5n;
    const interval = 100;
    await fundBuy(E("5"));
    const o = await mkOrder({ sliceIn: E("1"), slices: N, interval: BigInt(interval), minOut: E("990") });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    let prev = 0n;
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        // A fill attempt BEFORE the interval elapses must revert (INV-3).
        await expect(limit.connect(keeperA).execute(o, sig)).to.be.revertedWith("too soon");
        await bump(interval + 1);
      }
      await limit.connect(keeperA).execute(o, sig);
      const f = await limit.filledSlices(h);
      // INV-2: monotonic, exactly +1 per fill.
      expect(f).to.equal(prev + 1n);
      // INV-1: never above the signed slice count.
      expect(f).to.be.lte(N);
      prev = f;
    }
    expect(await limit.filledSlices(h)).to.equal(5n);

    // 6th attempt: even after the interval elapses, no slice remains -> revert "filled" (INV-1).
    await bump(interval + 1);
    await expect(limit.connect(keeperA).execute(o, sig)).to.be.revertedWith("filled");
    expect(await limit.filledSlices(h)).to.equal(5n); // did not tick to 6

    // INV-7: maker received >= minOut on every one of the 5 slices. 5 * 998 = 4990 (>= 5*990).
    expect(await coin.balanceOf(maker.address)).to.equal(E("4990"));
    expect(await coin.balanceOf(maker.address)).to.be.gte(o.minOut * 5n);
  });

  // ── Scenario 2: two keepers race the same slice in the same block => only one fills ──
  it("(2) two keepers race the same slice in one block: exactly one fills, the other reverts, no double-fill", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder({ sliceIn: E("1"), slices: 1n, minOut: E("990") });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    // Put both fill txs in the SAME block, then mine once. Explicit gasLimit skips eth_estimateGas
    // (which would otherwise revert the loser at send time against pre-fill state).
    await ethers.provider.send("evm_setAutomine", [false]);
    const tx1 = await limit.connect(keeperA).execute(o, sig, { gasLimit: 600000 });
    const tx2 = await limit.connect(keeperB).execute(o, sig, { gasLimit: 600000 });
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_setAutomine", [true]);

    const r1 = await ethers.provider.getTransactionReceipt(tx1.hash);
    const r2 = await ethers.provider.getTransactionReceipt(tx2.hash);
    // Same block (a real in-block race, not sequenced across blocks).
    expect(r1.blockNumber).to.equal(r2.blockNumber);
    // INV-4: exactly one succeeded (status 1), the other reverted (status 0). No double-fill.
    const ok = [r1.status, r2.status].filter((s) => s === 1).length;
    const bad = [r1.status, r2.status].filter((s) => s === 0).length;
    expect(ok).to.equal(1);
    expect(bad).to.equal(1);

    // INV-1: filled exactly once despite two racers.
    expect(await limit.filledSlices(h)).to.equal(1n);
    // Maker got exactly one slice's proceeds (998), not two (no over-fill).
    expect(await coin.balanceOf(maker.address)).to.equal(E("998"));
    // The two keepers together earned exactly ONE fee (2 coin), proving one real fill.
    const feeTotal = (await coin.balanceOf(keeperA.address)) + (await coin.balanceOf(keeperB.address));
    expect(feeTotal).to.equal(E("2"));
  });

  // ── Scenario 3: maker cancels mid-DCA => remaining slices all revert "cancelled" ──
  it("(3) cancel mid-DCA: remaining slices all revert 'cancelled', irreversibly", async () => {
    const interval = 100;
    await fundBuy(E("5"));
    const o = await mkOrder({ sliceIn: E("1"), slices: 5n, interval: BigInt(interval), minOut: E("990") });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    // Fill 2 of 5.
    await limit.connect(keeperA).execute(o, sig);
    await bump(interval + 1);
    await limit.connect(keeperA).execute(o, sig);
    expect(await limit.filledSlices(h)).to.equal(2n);

    // Only the maker can cancel.
    await expect(limit.connect(keeperA).cancel(o)).to.be.revertedWith("not maker");
    await limit.connect(maker).cancel(o);

    // INV-5: the remaining 3 slices never fill — even after the interval elapses.
    for (let i = 0; i < 3; i++) {
      await bump(interval + 1);
      await expect(limit.connect(keeperA).execute(o, sig)).to.be.revertedWith("cancelled");
    }
    expect(await limit.filledSlices(h)).to.equal(2n); // frozen at 2 — no fill past cancel
    // Maker keeps custody of the unspent WETH: 5 funded - 2 spent = 3 still in the wallet.
    expect(await weth.balanceOf(maker.address)).to.equal(E("3"));
  });

  // ── Scenario 4: expiry mid-DCA => reverts "expired" ──
  it("(4) expiry mid-DCA: fills stop and revert 'expired' once expiry passes", async () => {
    const interval = 100;
    const start = await now();
    const expiry = start + 250; // room for ~2 fills before it dies
    await fundBuy(E("5"));
    const o = await mkOrder({ sliceIn: E("1"), slices: 5n, interval: BigInt(interval), minOut: E("990"), expiry: BigInt(expiry) });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    await limit.connect(keeperA).execute(o, sig);            // slice 1 (t≈start)
    await bump(interval + 1);                                 // t≈start+101
    await limit.connect(keeperA).execute(o, sig);            // slice 2
    expect(await limit.filledSlices(h)).to.equal(2n);

    // Push time past expiry, then every remaining attempt reverts "expired" (INV-6).
    await bump(interval + 1);                                 // t≈start+202
    await bump(interval + 1);                                 // t≈start+303 > expiry(250)
    expect(await now()).to.be.gt(expiry);
    await expect(limit.connect(keeperA).execute(o, sig)).to.be.revertedWith("expired");
    await expect(limit.connect(keeperB).execute(o, sig)).to.be.revertedWith("expired");
    expect(await limit.filledSlices(h)).to.equal(2n); // no post-expiry fill
  });

  // ── Scenario 5: ETH-refund sweep over a DCA (padRouter near-graduation partial fill) ──
  it("(5) refund sweep: refundBps=3000 -> maker gets coins for consumed 70% + 30% back as WETH; contract holds 0 ETH", async () => {
    const rswap = await (await ethers.getContractFactory("MockRefundSwapLimit")).deploy(
      await weth.getAddress(), await coin.getAddress(), COIN_PER_ETH, 3000);
    const rlimit = await (await ethers.getContractFactory("RobinLimit")).deploy(
      await weth.getAddress(), await rswap.getAddress(), owner.address);
    const rdomain = {
      name: "RobinLimit", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await rlimit.getAddress(),
    };
    await weth.connect(maker).deposit({ value: E("2") });
    await weth.connect(maker).approve(await rlimit.getAddress(), ethers.MaxUint256);

    // Run it as a 2-slice DCA so we prove the sweep holds every slice, not just once.
    const interval = 100;
    const o = {
      maker: maker.address,
      sellToken: await weth.getAddress(),
      buyToken: await coin.getAddress(),
      sliceIn: E("1"), minOut: E("690"), slices: 2n, interval: BigInt(interval),
      expiry: BigInt((await now()) + 3600), salt: 424242n,
    };
    const sig = await maker.signTypedData(rdomain, TYPES, o);
    const h = await rlimit.hashOrder(o);

    // Slice 1: 0.7 ETH consumed * 1000 = 700 gross; keeper 0.2% = 1.4; maker gets 698.6 (>= 690).
    const coinBefore = await coin.balanceOf(maker.address);
    const wethBefore = await weth.balanceOf(maker.address);
    await rlimit.connect(keeperA).execute(o, sig);
    const afterS1 = await coin.balanceOf(maker.address);
    expect(afterS1 - coinBefore).to.equal(E("698.6"));           // INV-7: >= minOut(690)
    expect(afterS1 - coinBefore).to.be.gte(o.minOut);
    // INV-8: maker's WETH delta across the fill = -sliceIn + refund = -1 + 0.3 = -0.7, proving the
    // 0.3 refund was swept back as WETH (without the sweep the delta would be a full -1).
    expect((await weth.balanceOf(maker.address)) - wethBefore).to.equal(E("0.3") - E("1"));
    expect(await ethers.provider.getBalance(await rlimit.getAddress())).to.equal(0n); // no stranded ETH

    await bump(interval + 1);
    await rlimit.connect(keeperA).execute(o, sig);              // slice 2, same sweep
    expect(await coin.balanceOf(maker.address)).to.equal(E("1397.2")); // 2 * 698.6
    expect(await weth.balanceOf(maker.address)).to.equal(E("0.6"));    // 2 * 0.3 refund
    expect(await ethers.provider.getBalance(await rlimit.getAddress())).to.equal(0n);
    expect(await limit.filledSlices ? await rlimit.filledSlices(h) : 0n).to.equal(2n);

    // INV-1: exactly 2 slices, no more.
    await bump(interval + 1);
    await expect(rlimit.connect(keeperA).execute(o, sig)).to.be.revertedWith("filled");
    expect(await rlimit.filledSlices(h)).to.equal(2n);
  });
});
