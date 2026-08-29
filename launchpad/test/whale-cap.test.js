const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const TIER = { FLEX: 0, D7: 1, D30: 2, D60: 3, D90: 4, D180: 5, D365: 6 };
const pct = (part, whole) => (Number(part) / Number(whole) * 100).toFixed(1);

// The cap exists because of one measured number: before it, a whale staking 50x the only locked staker,
// with no lock at all, took 90.9% of a reward. These tests re-run that exact scenario.
describe("[CAP] one account cannot take the whole pool", function () {
  this.timeout(180000);

  async function setup() {
    const [owner, bob, whale, carol] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(1_000_000_000));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);
    for (const w of [bob, whale, carol]) {
      await (await coin.transfer(w.address, E(60_000_000))).wait();
      await (await coin.connect(w).approve(pool, ethers.MaxUint256)).wait();
    }
    await (await coin.approve(pool, ethers.MaxUint256)).wait();
    // Fund with the stake token, which is how the early-exit tax arrives.
    const fund = async (amt) => { await (await p.notifyReward(await coin.getAddress(), amt)).wait(); };
    return { owner, bob, whale, carol, coin, factory, pool, p, fund };
  }

  it("THE CASE THAT CAUSED THIS: the 90.9% whale is cut to about half", async () => {
    const { bob, whale, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();
    await fund(E(150));
    await time.increase(7 * 24 * 3600);

    const asset = await coin.getAddress();
    const w = await p.earned(whale.address, asset);
    const b = await p.earned(bob.address, asset);
    console.log(`   whale ${pct(w, E(150))}% (was 90.9%) · the 365-day locker ${pct(b, E(150))}% (was 9.1%)`);
    expect(Number(pct(w, E(150)))).to.be.lte(67.0);
    expect(Number(pct(b, E(150)))).to.be.gte(33.0);
  });

  it("the whale's principal is never touched — it is earning less, not stuck", async () => {
    const { whale, bob, coin, p } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();
    const before = await coin.balanceOf(whale.address);
    await (await p.connect(whale).withdraw(0)).wait();
    expect(await coin.balanceOf(whale.address)).to.equal(before + E(50_000));
  });

  it("locking $ROBIN raises your ceiling — the intended way through", async () => {
    const { bob, whale, carol, p } = await setup();
    // This is the flagship pool (selfBoost), so what is locked here IS $ROBIN.
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();

    // Carol locks nothing extra: base ceiling only.
    const plain = await p.capOf(carol.address);
    // The whale locks 30M $ROBIN — three steps of ceiling on top of the base.
    await (await p.connect(whale).stake(E(30_000_000), TIER.D365)).wait();
    const raised = await p.capOf(whale.address);

    console.log(`   base ceiling ${ethers.formatEther(plain)} · after locking 30M $ROBIN ${ethers.formatEther(raised)}`);
    // Base is 1000% of everyone else's PRINCIPAL, +50% per 10M $ROBIN locked. 30M is three steps, so 1150%.
    const others = (await p.totalStaked()) - (await p.stakedOf(whale.address));
    expect(raised).to.equal(others * 115_000n / 10_000n);
    expect(raised).to.be.gt(others * 100_000n / 10_000n); // strictly more than an account holding none
  });

  it("does not bind on a normal pool where nobody is dominant", async () => {
    const { bob, whale, carol, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(whale).stake(E(1200), TIER.D365)).wait();
    await (await p.connect(carol).stake(E(900), TIER.D365)).wait();
    await fund(E(310));
    await time.increase(7 * 24 * 3600);
    const asset = await coin.getAddress();
    const [a, b, c] = await Promise.all([bob, whale, carol].map((s) => p.earned(s.address, asset)));
    const total = a + b + c;
    console.log(`   ordinary pool splits ${pct(a, total)}/${pct(b, total)}/${pct(c, total)} — untouched`);
    expect(Number(pct(b, total))).to.be.closeTo(38.7, 1.5); // 1200/3100
  });

  it("the first staker into an empty pool is not capped to zero", async () => {
    const { bob, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    expect(await p.totalWeight()).to.be.gt(0n);
    await fund(E(100));
    await time.increase(7 * 24 * 3600);
    expect(await p.earned(bob.address, await coin.getAddress())).to.be.gt(E(99));
  });

  it("HONEST LIMIT: splitting across wallets still gets around it", async () => {
    const { bob, whale, carol, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    // The same whale, as two wallets instead of one.
    await (await p.connect(whale).stake(E(25_000), TIER.FLEX)).wait();
    await (await p.connect(carol).stake(E(25_000), TIER.FLEX)).wait();
    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    const asset = await coin.getAddress();
    const combined = (await p.earned(whale.address, asset)) + (await p.earned(carol.address, asset));
    console.log(`   one whale as TWO wallets took ${pct(combined, E(150))}% — the cap is per account, and an account is free`);
    expect(combined).to.be.gt(E(60));
  });

  it("the cap can be turned off, and cannot be set somewhere hostile", async () => {
    const { p } = await setup();
    await expect(p.setCap(9_999, E(10_000_000), 5_000, 40_000)).to.be.revertedWithCustomError(p, "BadCap");
    await (await p.setCap(0, 0, 0, 0)).wait();
    expect(await p.capBps()).to.equal(0);
  });
});
