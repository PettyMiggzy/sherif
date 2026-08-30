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
    // 1000% of the pool's COMMITTED principal — including the account's own, which is what stops a one-wei
    // commitment from moving anybody's ceiling — plus 50% per 10M $ROBIN locked. 30M is three steps: 1150%.
    const committed = await p.totalCommitted();
    expect(raised).to.equal(committed * 115_000n / 10_000n);
    expect(raised).to.be.gt(committed * 100_000n / 10_000n); // strictly more than an account holding none
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
    // And it cannot be raised until it stops binding — the rail the boost has always had.
    await expect(p.setCap(180_000, E(10_000_000), 5_000, 40_000)).to.be.revertedWithCustomError(p, "BadCap");
    await (await p.setCap(0, 0, 0, 0)).wait();
    expect(await p.capBps()).to.equal(0);
  });

  it("the shipped parameters mean 14x everyone else, which is what the docs now say", async () => {
    const { p } = await setup();
    expect(await p.capBps()).to.equal(100_000);   // 10x
    expect(await p.capMaxBps()).to.equal(40_000); // +4x from $ROBIN
    expect(Number(await p.capBps()) + Number(await p.capMaxBps())).to.equal(140_000);
    expect(await p.MAX_CAP_TOTAL_BPS()).to.equal(200_000);
  });
});

// The three defeats the external audit found and measured at 97ec653. Each is written the way the auditor
// ran it, so a green here means their attack, not my paraphrase of it.
describe("[CAP] the three ways the first version was defeated", function () {
  this.timeout(180000);

  async function setup() {
    const [owner, bob, whale, dummy] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(1_000_000_000));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);
    for (const w of [bob, whale, dummy]) {
      await (await coin.transfer(w.address, E(80_000_000))).wait();
      await (await coin.connect(w).approve(pool, ethers.MaxUint256)).wait();
    }
    await (await coin.approve(pool, ethers.MaxUint256)).wait();
    const fund = async (amt) => { await (await p.notifyReward(await coin.getAddress(), amt)).wait(); };
    return { owner, bob, whale, dummy, coin, p, pool, fund };
  }

  const shareOf = async (p, coin, who, total) =>
    Number(await p.earned(who, await coin.getAddress())) / Number(total) * 100;

  it("HIGH — a flash-rented denominator can no longer uncap an already-capped whale", async () => {
    const { bob, whale, dummy, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();
    const capped = await p.weightOf(whale.address);

    // The auditor's attack: a dummy flash-stakes a huge FLEXIBLE position, syncBoost (permissionless)
    // recomputes the whale against the inflated denominator, then the dummy withdraws for free.
    await (await p.connect(dummy).stake(E(600_000), TIER.FLEX)).wait();
    await (await p.syncBoost(whale.address)).wait();
    await (await p.connect(dummy).withdraw(0)).wait();

    const after = await p.weightOf(whale.address);
    console.log(`   whale weight before ${ethers.formatEther(capped)} · after the flash poke ${ethers.formatEther(after)}`);
    expect(after).to.equal(capped); // flexible principal is not in the denominator, so nothing moved

    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    const w = await shareOf(p, coin, whale.address, E(150));
    console.log(`   whale takes ${w.toFixed(1)}% (the audit measured 99.9% before this fix)`);
    expect(w).to.be.lt(70); // the cap's own intended bound, not a band the old number fits through
  });

  it("renting a TERM position to inflate the denominator costs 15%, which is the point", async () => {
    const { bob, whale, dummy, coin, p } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();

    const before = await coin.balanceOf(dummy.address);
    await (await p.connect(dummy).stake(E(600_000), TIER.D7)).wait(); // must commit to count
    await (await p.syncBoost(whale.address)).wait();
    await (await p.connect(dummy).withdraw(0)).wait();                   // and pay to leave
    const paid = before - (await coin.balanceOf(dummy.address));
    console.log(`   inflating the denominator for one block cost the attacker ${ethers.formatEther(paid)} tokens`);
    expect(paid).to.equal(E(90_000)); // 15% of 600k, vs a flash fee before
  });

  it("HIGH — staking first into an empty pool no longer means no ceiling", async () => {
    const { bob, whale, coin, p, fund } = await setup();
    // Whale is first in. Nobody else has committed anything.
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    const w = await shareOf(p, coin, whale.address, E(150));
    console.log(`   first-in whale takes ${w.toFixed(1)}% (the audit measured 90.9% before this fix)`);
    expect(w).to.be.lt(70);
  });

  it("a pool of nothing but flexible stakers is still capped, not uncapped", async () => {
    const { bob, whale, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.FLEX)).wait();
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();
    const cap = await p.capOf(whale.address);
    console.log(`   nobody committed anything · ceiling is the floor: ${ethers.formatEther(cap)} tokens`);
    expect(cap).to.be.lt(ethers.MaxUint256);
    expect(cap).to.be.gt(0n);
    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    console.log(`   flexible whale takes ${(await shareOf(p, coin, whale.address, E(150))).toFixed(1)}%`);
  });

  // The audit's third defeat, and the one the denominator fix does NOT close. Recorded honestly rather
  // than left for someone to find, because it decides what the stake page is allowed to claim.
  it("RESIDUAL: a ceiling earned in a big pool survives the pool shrinking", async () => {
    const { bob, whale, dummy, coin, p, fund } = await setup();
    await (await p.connect(dummy).stake(E(1_000_000), TIER.D30)).wait(); // a big pool...
    await (await p.connect(whale).stake(E(50_000), TIER.FLEX)).wait();   // ...whale enters, ceiling is high
    const capWhenBig = await p.capOf(whale.address);
    await (await p.connect(dummy).withdraw(0)).wait();                   // ...and the pool empties out
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();       // one honest locker left

    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    const got = await shareOf(p, coin, whale.address, E(150));
    console.log(`   ceiling when the pool was big: ${ethers.formatEther(capWhenBig)} · whale still takes ${got.toFixed(1)}%`);

    // Anyone may correct it, and the keeper does. What it cannot do is claw back what already accrued.
    await (await p.syncBoost(whale.address)).wait();
    console.log(`   after a poke the ceiling is ${ethers.formatEther(await p.capOf(whale.address))} — future accrual only`);
    expect(got).to.be.gt(70); // this is NOT closed; the page must not claim a hard bound
  });

  it("a hostile boost source returning an absurd number cannot revert anyone's exit", async () => {
    const { owner, bob, whale, coin, p } = await setup();
    const H = await ethers.getContractFactory("MockERC20"); // stand-in; the call just has to return garbage
    await (await p.connect(bob).stake(E(1000), TIER.D365)).wait();
    await (await p.setCap(100_000, 1n, 5_000, 40_000)).wait(); // capStep of 1 wei — the overflow setup
    await (await p.connect(whale).stake(E(50_000), TIER.D30)).wait();
    await (await p.connect(whale).withdraw(0)).wait(); // must not revert on the multiply
    expect(await p.stakedOf(whale.address)).to.equal(0n);
  });
});

// The two HIGHs the audit found in the FIRST cap rework, both priced at one wei. Written the way they ran
// them so a green here is their attack, not my paraphrase.
describe("[CAP] a one-wei commitment must buy nothing", function () {
  this.timeout(180000);

  async function setup() {
    const [owner, bob, attacker] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(1_000_000_000));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const pool = await factory.poolOf(await coin.getAddress());
    const p = await ethers.getContractAt("RobinTierStaking", pool);
    for (const w of [bob, attacker]) {
      await (await coin.transfer(w.address, E(60_000_000))).wait();
      await (await coin.connect(w).approve(pool, ethers.MaxUint256)).wait();
    }
    await (await coin.approve(pool, ethers.MaxUint256)).wait();
    const fund = async (amt) => { await (await p.notifyReward(await coin.getAddress(), amt)).wait(); };
    return { owner, bob, attacker, coin, p, pool, fund };
  }

  it("HIGH-1 — 1 wei committed does not uncap an unlimited flexible flood", async () => {
    const { bob, attacker, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1000), TIER.FLEX)).wait();   // other stakers exist, none committed
    await (await p.connect(attacker).stake(1n, TIER.D7)).wait();     // the dust commit
    await (await p.connect(attacker).stake(E(10_000_000), TIER.FLEX)).wait();

    const w = await p.weightOf(attacker.address);
    console.log(`   attacker weight after 1 wei + 10M flexible: ${ethers.formatEther(w)} (uncapped would be 10,000,000)`);
    expect(w).to.be.lt(E(1_000_000)); // the audit measured a full 10M ride, taking 98.04%

    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    const share = Number(await p.earned(attacker.address, await coin.getAddress())) / Number(E(150)) * 100;
    console.log(`   attacker takes ${share.toFixed(1)}% (the audit measured 98.0%)`);
    expect(share).to.be.lt(95);
  });

  it("HIGH-2 — 1 wei committed cannot crush an honest year-locked staker", async () => {
    const { bob, attacker, coin, p, fund } = await setup();
    await (await p.connect(bob).stake(E(1_000_000), TIER.D365)).wait();
    const before = await p.weightOf(bob.address);

    // The takeover: commit a single wei, then poke Bob so his ceiling is recomputed against it.
    await (await p.connect(attacker).stake(1n, TIER.D7)).wait();
    await (await p.syncBoost(bob.address)).wait();
    const after = await p.weightOf(bob.address);
    console.log(`   bob's weight before ${ethers.formatEther(before)} · after the 1-wei poke ${ethers.formatEther(after)}`);
    expect(after).to.equal(before); // the audit measured 5,000,000e18 collapsing to 50 wei

    await fund(E(150));
    await time.increase(7 * 24 * 3600);
    const bobShare = Number(await p.earned(bob.address, await coin.getAddress())) / Number(E(150)) * 100;
    console.log(`   bob still earns ${bobShare.toFixed(1)}% (the audit measured 0%)`);
    expect(bobShare).to.be.gt(95);
  });

  it("committed principal is never capped — your own commitment is in your own denominator", async () => {
    const { bob, p } = await setup();
    await (await p.connect(bob).stake(E(5_000_000), TIER.D365)).wait();
    expect(await p.capOf(bob.address)).to.be.gte(E(5_000_000));
    expect(await p.weightOf(bob.address)).to.equal(E(5_000_000) * 5n); // full 365-day multiplier, unclipped
  });

  it("buying a bigger ceiling costs real committed money, not a wei", async () => {
    const { attacker, coin, p } = await setup();
    const before = await coin.balanceOf(attacker.address);
    await (await p.connect(attacker).stake(E(1_000_000), TIER.D7)).wait(); // commit 1M to reach a 10M ceiling
    expect(await p.capOf(attacker.address)).to.be.gte(E(10_000_000));
    await (await p.connect(attacker).withdraw(0)).wait();                  // and pay to walk it back
    const paid = before - (await coin.balanceOf(attacker.address));
    console.log(`   a 10,000,000 ceiling cost ${ethers.formatEther(paid)} tokens to rent for one block`);
    expect(paid).to.equal(E(150_000)); // 15% of the 1M commitment
  });
});
