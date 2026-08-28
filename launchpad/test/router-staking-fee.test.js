const { expect } = require("chai");
const { ethers } = require("hardhat");
const E = (n) => ethers.parseEther(String(n));

// [SELLFEE] The 0.25% of every sell that funds the coin's own staking pool.
//
// The two things that must be true: a coin registered the OLD way is completely unaffected (live
// creators' income cannot move under them), and the new slice can never eat a creator's 1% base.
describe("[SELLFEE] sell-side staking share", function () {
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

  const reg = (token, sellBps, stakingBps) => router.connect(fac).registerWithStaking(
    token, P, P, owner.address, 125, sellBps, 10_000, 0, 0, stakingBps);

  it("the pad's shipping numbers register cleanly: 1.25% each side, 0.25% to staking", async () => {
    await expect(reg(TOK, 125, 25)).to.not.be.reverted;
    expect(await router.MAX_STAKING_BPS()).to.equal(100n);
  });

  it("the staking slice can never come out of the creator's 1% base", async () => {
    // 1.25% sell leaves exactly 0.25% available above the default. Asking for more must fail.
    await expect(reg(TOK, 125, 26)).to.be.revertedWithCustomError(router, "BadTax");
    await expect(reg(TOK, 100, 1)).to.be.revertedWithCustomError(router, "BadTax");   // no headroom at all
    await expect(reg(TOK, 400, 101)).to.be.revertedWithCustomError(router, "BadTax"); // over the ceiling
    await expect(reg(TOK, 400, 100)).to.not.be.reverted;                              // 1% is the ceiling
  });

  it("a coin registered the OLD way has no staking share — live coins are untouched", async () => {
    await (await router.connect(fac).register(OLD, P, P, owner.address, 100, 100, 10_000, 0, 0)).wait();
    expect(await router.stakingEscrow(OLD)).to.equal(0n);
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
