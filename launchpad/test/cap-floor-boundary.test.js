const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const TIER = { FLEX: 0, D365: 6 };
const pct = (part, whole) => Number(part) / Number(whole) * 100;

// An audit flagged that `capFloor` becomes the governing cap term in a thin pool, and measured ~90% whale
// capture against a very small committed staker. That is real, it is inherent to having a floor at all, and
// the answer was a deliberate decision on the constant rather than a code change.
//
// These tests exist so the decision cannot be silently undone. They pin the BOUNDARY -- the commitment size
// at which the floor stops governing -- and the flat 33.3% on the far side of it. Change `capFloor` and
// these fail with the new numbers in front of you, which is the point.
describe("[CAP] the capFloor boundary is a decision, not an accident", function () {
  this.timeout(180000);

  // 1e9 supply => capFloor = 1e9 / 100_000 = 10,000 tokens. Boundary = capFloor/10 = 1,000 tokens.
  const SUPPLY = 1_000_000_000;
  const CAP_FLOOR = SUPPLY / 100_000;   // 10,000
  const BOUNDARY = CAP_FLOOR / 10;      // 1,000

  async function setup() {
    const [owner, bob, whale] = await ethers.getSigners();
    const T = await ethers.getContractFactory("MockERC20");
    const coin = await T.deploy(E(SUPPLY));
    const F = await ethers.getContractFactory("RobinTierStakingFactory");
    const factory = await F.deploy(owner.address);
    await (await factory.createPool(await coin.getAddress(), true)).wait();
    const p = await ethers.getContractAt("RobinTierStaking", await factory.poolOf(await coin.getAddress()));
    const pool = await p.getAddress();
    for (const w of [bob, whale]) {
      await (await coin.transfer(w.address, E(200_000_000))).wait();
      await (await coin.connect(w).approve(pool, ethers.MaxUint256)).wait();
    }
    await (await coin.approve(pool, ethers.MaxUint256)).wait();
    return { owner, bob, whale, coin, p };
  }

  // Run one committed size against a whale flooding flexible principal, and report the committed share.
  async function share(committed) {
    const { bob, whale, coin, p } = await setup();
    await (await p.connect(bob).stake(E(committed), TIER.D365)).wait();
    await (await p.connect(whale).stake(E(20_000_000), TIER.FLEX)).wait();
    await (await p.notifyReward(await coin.getAddress(), E(1000))).wait();
    await time.increase(7 * 24 * 3600);
    const asset = await coin.getAddress();
    const b = await p.earned(bob.address, asset);
    const w = await p.earned(whale.address, asset);
    return { bob: pct(b, b + w), whale: pct(w, b + w) };
  }

  it("capFloor is 0.001% of supply — the constant the rest of this file reasons about", async () => {
    const { p } = await setup();
    expect(await p.capFloor()).to.equal(E(CAP_FLOOR));
  });

  it(`AT the boundary (${BOUNDARY} = capFloor/10) the committed staker gets the designed 33.3%`, async () => {
    const s = await share(BOUNDARY);
    console.log(`   committed ${BOUNDARY}: ${s.bob.toFixed(1)}% vs whale ${s.whale.toFixed(1)}%`);
    expect(s.bob).to.be.closeTo(33.3, 0.6);
  });

  it("ABOVE the boundary the share is FLAT at 33.3% — more commitment does not buy a bigger slice", async () => {
    for (const c of [BOUNDARY * 2, BOUNDARY * 5, BOUNDARY * 50]) {
      const s = await share(c);
      console.log(`   committed ${c}: ${s.bob.toFixed(1)}%`);
      expect(s.bob).to.be.closeTo(33.3, 0.6);
    }
  });

  it("BELOW the boundary the floor dilutes the committed staker — this is the known, accepted cost", async () => {
    const half = await share(BOUNDARY / 2);
    const tenth = await share(BOUNDARY / 10);
    console.log(`   committed ${BOUNDARY / 2}: ${half.bob.toFixed(1)}%   ${BOUNDARY / 10}: ${tenth.bob.toFixed(1)}%`);
    expect(half.bob).to.be.closeTo(20.0, 1.0);
    expect(tenth.bob).to.be.closeTo(4.8, 1.0);
    // Strictly worse the smaller it gets — that monotonicity is what makes it a floor effect, not noise.
    expect(tenth.bob).to.be.lt(half.bob);
  });

  it("the floor levels flexible stakers: a whale and a capFloor-sized staker earn the SAME", async () => {
    const { bob, whale, coin, p } = await setup();
    await (await p.connect(bob).stake(E(CAP_FLOOR), TIER.FLEX)).wait();       // exactly at the floor
    await (await p.connect(whale).stake(E(20_000_000), TIER.FLEX)).wait();    // 2000x more
    await (await p.notifyReward(await coin.getAddress(), E(1000))).wait();
    await time.increase(7 * 24 * 3600);
    const asset = await coin.getAddress();
    const b = await p.earned(bob.address, asset);
    const w = await p.earned(whale.address, asset);
    console.log(`   floor-sized ${pct(b, b + w).toFixed(1)}% vs 2000x whale ${pct(w, b + w).toFixed(1)}%`);
    expect(pct(b, b + w)).to.be.closeTo(50.0, 0.6);
  });
});
