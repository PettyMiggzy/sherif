// sim-edge — adversarial simulation for RobinLimit: griefing, signature edge cases, value extremes.
// Robin Labs / Robinhood Chain 4663 / Arbitrum Orbit L2. Legacy type-0 txs (no EIP-1559).
//
// A "violation" here = the executor let something happen that must NEVER happen (funds moved on a
// forged/replayed order, partial state written on a reverted fill, stranded balances, overflow/
// mis-round). Every case that MUST fail is asserted to revert with the exact reason; a fill that
// slips through would fail the assertion (that IS the violation surfacing as a red test).
//
// Run: npx hardhat test test/sim-edge.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RobinLimit — sim-edge (griefing / sig edges / value extremes)", () => {
  let weth, coin, swap, limit;
  let owner, maker, keeper, other;
  const E = (n) => ethers.parseEther(n);
  const COIN_PER_ETH = E("1000"); // 1 ETH buys 1000 coin at the mock's set price

  let domain, chainId;
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

    chainId = (await ethers.provider.getNetwork()).chainId;
    domain = {
      name: "RobinLimit", version: "1",
      chainId,
      verifyingContract: await limit.getAddress(),
    };
  });

  async function fundBuy(amount) {
    await weth.connect(maker).deposit({ value: amount });
    await weth.connect(maker).approve(await limit.getAddress(), ethers.MaxUint256);
  }
  async function fundSell(amount) {
    await coin.mint(maker.address, amount);
    await coin.connect(maker).approve(await limit.getAddress(), ethers.MaxUint256);
  }

  // (1) forged / altered order — every mutated field breaks the signature -----------------------
  it("rejects a FORGED order: any field changed after signing => 'bad sig' (no field is malleable)", async () => {
    await fundBuy(E("5"));
    const base = await mkOrder({ sliceIn: E("1"), minOut: E("990") });
    const sig = await sign(base); // signature is bound to `base` only

    // A griefer flips each field in turn, reusing the maker's original signature.
    const mutations = {
      sliceIn: E("2"),                       // pull twice as much
      minOut: E("1"),                        // gut the price floor
      slices: 5n,                            // turn a 1-shot into a DCA
      interval: 999n,
      expiry: base.expiry + 100000n,
      salt: base.salt + 1n,
    };
    for (const [field, val] of Object.entries(mutations)) {
      const forged = { ...base, [field]: val };
      await expect(
        limit.connect(keeper).execute(forged, sig),
        `mutating ${field} must not fill`
      ).to.be.revertedWith("bad sig");
    }
    // changing the maker (funds source / recipient) is likewise unauthorized
    const forgedMaker = { ...base, maker: other.address };
    await expect(limit.connect(keeper).execute(forgedMaker, sig)).to.be.revertedWith("bad sig");

    // and nothing moved: maker still holds all 5 WETH, contract holds nothing.
    expect(await weth.balanceOf(maker.address)).to.equal(E("5"));
    expect(await coin.balanceOf(maker.address)).to.equal(0n);
    expect(await weth.balanceOf(await limit.getAddress())).to.equal(0n);
  });

  // (2) replay of a fully-filled single-slice order --------------------------------------------
  it("rejects REPLAY of a fully-filled single-slice order => 'filled' (a valid sig is not reusable)", async () => {
    await fundBuy(E("2")); // extra headroom so a replay CANNOT be starved by allowance
    const o = await mkOrder();
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    await limit.connect(keeper).execute(o, sig); // first fill: legit
    expect(await limit.filledSlices(h)).to.equal(1n);

    // same order, same (valid) signature, replayed — must not fill a second slice.
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("filled");
    await expect(limit.connect(other).execute(o, sig)).to.be.revertedWith("filled"); // any keeper, still dead
    expect(await limit.filledSlices(h)).to.equal(1n); // count did not advance
    expect(await coin.balanceOf(maker.address)).to.equal(E("998")); // paid exactly once
  });

  // (3) wrong-chain / wrong-verifyingContract signatures ---------------------------------------
  it("rejects a WRONG-CHAIN signature => 'bad sig' (cross-chain replay blocked by domain chainId)", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder();
    const wrongChain = { ...domain, chainId: chainId + 1n }; // signed as if for a different chain
    const sig = await maker.signTypedData(wrongChain, TYPES, o);
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("bad sig");
  });

  it("rejects a WRONG-verifyingContract signature => 'bad sig' (order bound to a different deployment)", async () => {
    await fundBuy(E("1"));
    const o = await mkOrder();
    const wrongVC = { ...domain, verifyingContract: other.address }; // some other contract address
    const sig = await maker.signTypedData(wrongVC, TYPES, o);
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("bad sig");
  });

  // (4) pair guard: both legs WETH, and neither leg WETH ---------------------------------------
  it("rejects a pair with BOTH legs WETH => 'pair'", async () => {
    await fundBuy(E("1"));
    const bad = await mkOrder({
      sellToken: await weth.getAddress(),
      buyToken: await weth.getAddress(),
      minOut: 1n,
    });
    await expect(limit.connect(keeper).execute(bad, await sign(bad))).to.be.revertedWith("pair");
  });

  it("rejects a pair with NEITHER leg WETH => 'pair'", async () => {
    await fundSell(E("10"));
    const other20 = await (await ethers.getContractFactory("MintERC20")).deploy("Other", "OTH");
    const bad = await mkOrder({
      sellToken: await coin.getAddress(),
      buyToken: await other20.getAddress(),
      sliceIn: E("10"), minOut: 1n,
    });
    await expect(limit.connect(keeper).execute(bad, await sign(bad))).to.be.revertedWith("pair");
  });

  // (5) value extremes: dust (1 wei) and whole-supply-scale outputs -----------------------------
  it("DUST: a 1-wei slice fills without mis-round; maker gets 998 wei coin, keeper 2 wei, contract clean", async () => {
    await fundBuy(E("1"));
    // 1 wei WETH * 1000 = 1000 wei coin gross; keeper 0.20% = 2 wei; maker gets 998 wei (>= minOut 1).
    const o = await mkOrder({ sliceIn: 1n, minOut: 1n });
    await limit.connect(keeper).execute(o, await sign(o));
    expect(await coin.balanceOf(maker.address)).to.equal(998n);
    expect(await coin.balanceOf(keeper.address)).to.equal(2n);
    // nothing stranded in the executor.
    expect(await coin.balanceOf(await limit.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await limit.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await limit.getAddress())).to.equal(0n);
  });

  it("EXTREME: a whole-supply-scale output (1e12 coin/ETH) does not overflow or mis-round", async () => {
    // Fresh venue priced at 1e12 coin per ETH: a single 1-ETH slice mints 1e12 coin (1e30 base units),
    // exercising the out*bps/BPS fee math at scale. 1e30 * 100 (max bps) = 1e32 << 2^256, so no overflow.
    const bigSwap = await (await ethers.getContractFactory("MockRobinSwapLimit")).deploy(
      await weth.getAddress(), await coin.getAddress(), E("1000000000000")); // 1e12 coin/ETH
    const bigLimit = await (await ethers.getContractFactory("RobinLimit")).deploy(
      await weth.getAddress(), await bigSwap.getAddress(), owner.address);
    await weth.connect(maker).deposit({ value: E("1") });
    await weth.connect(maker).approve(await bigLimit.getAddress(), ethers.MaxUint256);
    const bigDomain = { name: "RobinLimit", version: "1", chainId, verifyingContract: await bigLimit.getAddress() };

    const gross = E("1000000000000");          // 1 ETH * 1e12 coin/ETH = 1e12 coin
    const fee = (gross * 20n) / 10000n;         // 0.20%
    const makerExp = gross - fee;
    const o = { maker: maker.address, sellToken: await weth.getAddress(), buyToken: await coin.getAddress(),
      sliceIn: E("1"), minOut: makerExp, slices: 1n, interval: 0n, expiry: BigInt(await now() + 3600), salt: 42n };
    await bigLimit.connect(keeper).execute(o, await maker.signTypedData(bigDomain, TYPES, o));
    expect(await coin.balanceOf(maker.address)).to.equal(makerExp); // exact, no rounding drift
    expect(await coin.balanceOf(keeper.address)).to.equal(fee);
    expect(await coin.balanceOf(await bigLimit.getAddress())).to.equal(0n);
  });

  // (6) allowance < sliceIn: clean revert, NO partial state -------------------------------------
  it("GRIEF: allowance < sliceIn reverts cleanly and writes NO state (filledSlices/lastFillTs stay 0)", async () => {
    await weth.connect(maker).deposit({ value: E("1") });
    // approve one wei short of the slice — the pull (transferFrom) must fail.
    await weth.connect(maker).approve(await limit.getAddress(), E("1") - 1n);
    const o = await mkOrder({ sliceIn: E("1") });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    await expect(limit.connect(keeper).execute(o, sig)).to.be.reverted; // ERC20InsufficientAllowance
    // the effects-before-interactions write to filledSlices/lastFillTs must have rolled back.
    expect(await limit.filledSlices(h)).to.equal(0n);
    expect(await limit.lastFillTs(h)).to.equal(0n);
    // no funds moved, nothing stranded.
    expect(await weth.balanceOf(maker.address)).to.equal(E("1"));
    expect(await coin.balanceOf(maker.address)).to.equal(0n);
    expect(await weth.balanceOf(await limit.getAddress())).to.equal(0n);
  });

  // (6b) reverted fill mid-DCA: a post-swap price revert must NOT advance filledSlices/lastFillTs -
  it("GRIEF: a reverted slice (price fails AFTER the swap) does not advance filledSlices or lastFillTs", async () => {
    await fundBuy(E("3"));
    const o = await mkOrder({ sliceIn: E("1"), slices: 3n, interval: 0n, minOut: E("990") });
    const sig = await sign(o);
    const h = await limit.hashOrder(o);

    await limit.connect(keeper).execute(o, sig); // slice 1 fills
    expect(await limit.filledSlices(h)).to.equal(1n);
    const tsAfter1 = await limit.lastFillTs(h);

    // drop the price so slice 2's swap succeeds but makerOut < minOut => "price" revert AFTER the
    // effects-before-interactions write. The write must roll back with the tx.
    await swap.setPrice(E("980"));
    await expect(limit.connect(keeper).execute(o, sig)).to.be.revertedWith("price");
    expect(await limit.filledSlices(h)).to.equal(1n);          // still 1, not 2
    expect(await limit.lastFillTs(h)).to.equal(tsAfter1);       // cadence clock did not advance
    expect(await coin.balanceOf(await limit.getAddress())).to.equal(0n); // no coin stranded from the reverted buy
    expect(await ethers.provider.getBalance(await limit.getAddress())).to.equal(0n);

    // and the order is still fillable once the price recovers — the revert cost only gas.
    await swap.setPrice(COIN_PER_ETH);
    await limit.connect(keeper).execute(o, sig);
    expect(await limit.filledSlices(h)).to.equal(2n);
  });

  // (7) sell path pays WETH and leaves the contract with 0 ETH / 0 coin -------------------------
  it("SELL path pays the maker WETH and leaves the executor with ZERO ETH and ZERO coin", async () => {
    await fundSell(E("1000"));
    const o = await mkOrder({
      sellToken: await coin.getAddress(),
      buyToken: await weth.getAddress(),
      sliceIn: E("1000"),
      minOut: E("0.99"),
    });
    await limit.connect(keeper).execute(o, await sign(o));
    // 1000 coin -> 1 WETH gross; keeper 0.20% = 0.002; maker nets 0.998.
    expect(await weth.balanceOf(maker.address)).to.equal(E("0.998"));
    expect(await weth.balanceOf(keeper.address)).to.equal(E("0.002"));
    expect(await coin.balanceOf(maker.address)).to.equal(0n);
    // the non-custodial invariant: contract holds no ETH, no coin, no WETH between txs.
    expect(await ethers.provider.getBalance(await limit.getAddress())).to.equal(0n);
    expect(await coin.balanceOf(await limit.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await limit.getAddress())).to.equal(0n);
  });
});
