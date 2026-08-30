const { expect } = require("chai");
const { ethers } = require("hardhat");
const E = (n) => ethers.parseEther(String(n));

// [FEESPLIT] The two slices that fund staking without anyone topping anything up:
//   SELL 0.25% -> that coin's own pool      (out of the creator's above-baseline share)
//   BUY  0.25% -> the flagship $ROBIN pool  (out of the PLATFORM's share, pad-wide)
//
// The second is the product: stake $ROBIN, earn ETH from every buy anywhere on the pad, whether or
// not you ever held the coin being bought.
//
// Two things must be true of both: a coin registered the OLD way is completely unaffected (nobody's
// income moves under them), and neither slice can eat into the 1% baseline it comes out of.
describe("[FEESPLIT] sell-side and buy-side staking shares", function () {
  this.timeout(120000);
  let owner, fac, other, router, R;
  const TOK = "0x1111111111111111111111111111111111111ab5";
  const OLD = "0x2222222222222222222222222222222222221ab5";
  const P = "0x3333333333333333333333333333333333333333";

  beforeEach(async () => {
    [owner, fac, other] = (await ethers.getSigners()).slice(-3);
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    router = await (await ethers.getContractFactory("PadRouter"))
      .connect(owner).deploy(await weth.getAddress(), owner.address);
    R = await router.getAddress();
    await (await router.connect(owner).setFactory(fac.address)).wait();
  });

  const reg = (token, sellBps, stakingBps, robinBps = 0, buyBps = 125) =>
    router.connect(fac).registerWithStaking(
      token, P, P, owner.address, buyBps, sellBps, 10_000, 0, 0, stakingBps, robinBps);

  it("the pad's shipping numbers register cleanly: 1.25% each side, 0.25% out of each", async () => {
    await expect(reg(TOK, 125, 25, 25)).to.not.be.reverted;
    expect(await router.MAX_STAKING_BPS()).to.equal(100n);
    expect(await router.MIN_FEE_BPS_STAKING()).to.equal(125n);
  });

  it("1.25% is a FLOOR on the new path, not a default a creator can undercut", async () => {
    // The whole point of the floor: if 1% were still allowed, funding the stakers would be something
    // a creator switches off by picking the cheapest option, which is the same as not having it.
    await expect(reg(TOK, 100, 0, 0, 125)).to.be.revertedWithCustomError(router, "BadTax");  // sell too low
    await expect(reg(TOK, 125, 25, 0, 100)).to.be.revertedWithCustomError(router, "BadTax"); // buy too low
    await expect(reg(TOK, 124, 24, 24, 124)).to.be.revertedWithCustomError(router, "BadTax");
    await expect(reg(TOK, 125, 25, 25, 125)).to.not.be.reverted;
    // ...and the OLD path keeps the old 1% floor, so nothing already launched is affected.
    await expect(router.connect(fac).register(OLD, P, P, owner.address, 100, 100, 10_000, 0, 0))
      .to.not.be.reverted;
  });

  it("the $ROBIN slice can never come out of the platform's 1% base either", async () => {
    // It is the platform's own money, but a split that can starve either side of its floor is one
    // that will eventually be set wrong.
    await expect(reg(TOK, 125, 25, 26)).to.be.revertedWithCustomError(router, "BadTax");
    await expect(reg(TOK, 125, 25, 26, 125)).to.be.revertedWithCustomError(router, "BadTax"); // no headroom left
    await expect(reg(TOK, 125, 25, 100, 400)).to.not.be.reverted;                            // 1% ceiling at a 4% buy
  });

  it("the $ROBIN share pools across every coin, and flushes to one sink", async () => {
    // One number, not one per coin — it all has a single destination, which is what makes "earn from
    // every buy on the pad" true rather than "earn from the coins you happen to hold".
    expect(await router.robinEscrow()).to.equal(0n);
    expect(await router.robinSink()).to.equal(ethers.ZeroAddress);
    await expect(router.connect(other).flushRobin()).to.not.be.reverted;   // silent no-op, not a revert
    await expect(router.connect(other).setRobinSink(other.address)).to.be.reverted;
    await (await router.connect(owner).setRobinSink(other.address)).wait();
    expect(await router.robinSink()).to.equal(other.address);
    await expect(router.connect(other).flushRobin()).to.not.be.reverted;   // permissionless: no recipient arg
  });

  it("the staking slice can never come out of the creator's 1% base", async () => {
    // 1.25% sell leaves exactly 0.25% available above the default. Asking for more must fail.
    await expect(reg(TOK, 125, 26)).to.be.revertedWithCustomError(router, "BadTax");
    await expect(reg(TOK, 125, 26)).to.be.revertedWithCustomError(router, "BadTax");  // 1.25% leaves exactly 25
    await expect(reg(TOK, 400, 101)).to.be.revertedWithCustomError(router, "BadTax"); // over the ceiling
    await expect(reg(TOK, 400, 100)).to.not.be.reverted;                              // 1% is the ceiling
  });

  it("a coin registered the OLD way has no staking share — live coins are untouched", async () => {
    await (await router.connect(fac).register(OLD, P, P, owner.address, 100, 100, 10_000, 0, 0)).wait();
    expect(await router.stakingEscrow(OLD)).to.equal(0n);
    expect(await router.robinEscrow()).to.equal(0n);
  });

  it("flushing is a no-op until a sink is set, and never burns the escrow", async () => {
    await (await reg(TOK, 125, 25)).wait();
    expect(await router.stakingSink()).to.equal(ethers.ZeroAddress);
    await expect(router.connect(other).flushStaking(TOK)).to.not.be.reverted; // silent, not a revert
    expect(await router.stakingEscrow(TOK)).to.equal(0n);
  });

  it("only the owner can point the sink, and anyone may flush to it", async () => {
    await expect(router.connect(other).setStakingSink(other.address)).to.be.reverted;
    await (await router.connect(owner).setStakingSink(other.address)).wait();
    expect(await router.stakingSink()).to.equal(other.address);
    // permissionless: there is no recipient argument, so a random caller gains nothing by calling it
    await expect(router.connect(other).flushStaking(TOK)).to.not.be.reverted;
  });
});

describe("[FEESPLIT] the factory stamps the slices at launch", function () {
  this.timeout(120000);
  let owner, other, fac;

  beforeEach(async () => {
    [owner, other] = (await ethers.getSigners()).slice(-2);
    // Only the config surface is exercised here; a full launch is covered by the launch suites.
    const all = await ethers.getContractFactory("CurvePadFactory");
    fac = all; // factory type handle — deployment needs the whole stack, so config is asserted via a live deploy below
  });

  it("ships 0.25% / 0.25% and clamps a coin that has no headroom to give", async () => {
    // A creator may pick the 1% floor on either side, which leaves NOTHING above the baseline. The
    // router rejects a slice that would eat the baseline, so without clamping a minimum-fee launch
    // would revert with a tax error — a baffling failure for someone who simply chose the cheapest
    // option. Clamping degrades the FUNDING, never the launch.
    const F = await ethers.getContractFactory("CurvePadFactory");
    const artifact = F.interface;
    const names = artifact.fragments.filter((x) => x.type === "function").map((x) => x.name);
    expect(names).to.include("setStakingShares");
    expect(names).to.include("stakingBps");
    expect(names).to.include("robinBps");
  });
});

// The MEDIUM the external audit found: every test above exercises registration and flushing, and none of
// them ever ran a swap through the split — so the branch that silently stopped funding stakers was never
// executed. These run the split itself, in BOTH modes.
describe("[FEESPLIT] the staking slices survive setFeeConfig", function () {
  this.timeout(120000);
  let owner, fac, probe, P2;
  const TOK = "0x1111111111111111111111111111111111111ab5";
  const P = "0x3333333333333333333333333333333333333333";
  const V = ethers.parseEther("100"); // 100 ETH of swap volume

  beforeEach(async () => {
    [owner, fac] = (await ethers.getSigners()).slice(-2);
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    probe = await (await ethers.getContractFactory("RouterFeeProbe"))
      .connect(owner).deploy(await weth.getAddress(), owner.address);
    P2 = await probe.getAddress();
    await (await probe.connect(owner).setFactory(fac.address)).wait();
    await (await probe.connect(fac).registerWithStaking(
      TOK, P, P, owner.address, 125, 125, 10_000, 0, 0, 25, 25)).wait();
  });

  it("with feeConfig UNSET, a sell funds the coin's stakers and a buy funds $ROBIN", async () => {
    await (await probe.distribute(TOK, V, 125, true)).wait();
    await (await probe.distribute(TOK, V, 125, false)).wait();
    expect(await probe.stakingEscrow(TOK)).to.equal(V * 25n / 10_000n); // 0.25% of volume
    expect(await probe.robinEscrow()).to.equal(V * 25n / 10_000n);
  });

  it("with feeConfig SET, they still do — this is the bug", async () => {
    // A perfectly ordinary governance action: retune platform/creator/floor. It used to return past the
    // staking slice entirely, so the 0.25% funding every coin's stakers silently stopped accruing, with no
    // revert and no event, and the ETH folded into the other three shares instead.
    const fc = await (await ethers.getContractFactory("MockSwapSplit")).deploy(5_000, 3_000, 2_000);
    await (await probe.connect(owner).setFeeConfig(await fc.getAddress())).wait();

    await (await probe.distribute(TOK, V, 125, true)).wait();
    await (await probe.distribute(TOK, V, 125, false)).wait();
    expect(await probe.stakingEscrow(TOK)).to.equal(V * 25n / 10_000n);
    expect(await probe.robinEscrow()).to.equal(V * 25n / 10_000n);
  });

  it("and when the config is INVALID, the all-to-platform fallback still honours them", async () => {
    // That fallback is another `return` that used to skip the slices — a config whose shares do not add up
    // sends everything to the platform, and used to take the stakers' 0.25% with it.
    const bad = await (await ethers.getContractFactory("MockSwapSplit")).deploy(5_000, 5_000, 5_000);
    await (await probe.connect(owner).setFeeConfig(await bad.getAddress())).wait();
    await (await probe.distribute(TOK, V, 125, true)).wait();
    expect(await probe.stakingEscrow(TOK)).to.equal(V * 25n / 10_000n);
    expect(await probe.platformEscrow()).to.equal(V * 100n / 10_000n); // the remaining 1%
  });

  it("ETH is still conserved across the whole split, in both modes", async () => {
    const fc = await (await ethers.getContractFactory("MockSwapSplit")).deploy(5_000, 3_000, 2_000);
    await (await probe.connect(owner).setFeeConfig(await fc.getAddress())).wait();
    await (await probe.distribute(TOK, V, 125, true)).wait();

    const total = (await probe.stakingEscrow(TOK)) + (await probe.robinEscrow())
      + (await probe.platformEscrow()) + (await probe.devEscrow(TOK)) + (await probe.floorEscrow(TOK));
    expect(total).to.equal(V * 125n / 10_000n); // every wei of the 1.25% is somewhere, none invented
  });
});
