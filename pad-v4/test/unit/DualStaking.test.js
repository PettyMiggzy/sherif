const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Feature 2 — DualStaking. Two independent books (TOKEN / STOCK), each streaming a reward basket.
// Proves: independent books, "earn the other", ETH streaming + forfeit-to-stayers, anti-JIT hold,
// bounded boost (weight != principal), fundTokenPushed measured-delta, and DualStaking → hook weight wiring.

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DAY = 86400;
const TOKEN = 0, STOCK = 1;

async function erc20(supplyTo, amount = 10n ** 30n) {
  const t = await (await ethers.getContractFactory("TestERC20")).connect(supplyTo).deploy(amount);
  return t;
}

describe("DualStaking — two-book earn-the-other staking", () => {
  let owner, rewarder, alice, bob, tok, stk, ds;

  beforeEach(async () => {
    [owner, rewarder, alice, bob] = await ethers.getSigners();
    tok = await erc20(owner);
    stk = await erc20(owner);
    ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), await stk.getAddress(), owner.address,
      DAY, ethers.ZeroAddress, ethers.ZeroHash, TOKEN
    );
    await ds.setRewarder(rewarder.address, true);
    // seed stakers with both assets
    for (const u of [alice, bob]) {
      await tok.connect(owner).transfer(u.address, 10n ** 24n);
      await stk.connect(owner).transfer(u.address, 10n ** 24n);
      await tok.connect(u).approve(await ds.getAddress(), ethers.MaxUint256);
      await stk.connect(u).approve(await ds.getAddress(), ethers.MaxUint256);
    }
  });

  it("books are independent: staking TOKEN does not change STOCK totals", async () => {
    await ds.connect(alice).stake(TOKEN, 100n);
    expect(await ds.totalStaked(TOKEN)).to.equal(100n);
    expect(await ds.totalStaked(STOCK)).to.equal(0n);
    expect(await ds.weight(TOKEN, alice.address)).to.equal(100n); // 1x boost by default
  });

  it("earn-the-other: TOKEN stakers earn the STOCK reward, streamed over the window", async () => {
    // list STOCK as a reward asset on the TOKEN side
    await ds.connect(owner).listReward(TOKEN, await stk.getAddress(), 7 * DAY);
    await ds.connect(alice).stake(TOKEN, 1000n);

    // rewarder funds 7000e18 STOCK to the TOKEN side (must be 1e18-scale so rate = amt/window > 0)
    const amt = 7000n * 10n ** 18n;
    await stk.connect(owner).transfer(rewarder.address, amt);
    await stk.connect(rewarder).approve(await ds.getAddress(), ethers.MaxUint256);
    await ds.connect(rewarder).fundToken(TOKEN, await stk.getAddress(), amt);

    await time.increase(7 * DAY + 10);
    const earned = await ds.earned(TOKEN, alice.address, await stk.getAddress());
    // ~all of it streamed to the sole staker (allow streaming dust)
    expect(earned).to.be.gt(6990n * 10n ** 18n);
    const before = await stk.balanceOf(alice.address);
    await ds.connect(alice).claim(TOKEN, await stk.getAddress());
    expect((await stk.balanceOf(alice.address)) - before).to.equal(earned);
  });

  it("ETH streams and forfeiture goes to the stayer", async () => {
    await ds.connect(alice).stake(TOKEN, 1000n);
    await ds.connect(bob).stake(TOKEN, 1000n);
    await ds.connect(rewarder).fundETH(TOKEN, { value: ethers.parseEther("2") });

    await time.increase(3 * DAY); // partway through the 7-day ETH stream
    // bob leaves, forfeiting his accrued ETH to alice (re-streamed)
    const bobEarned = await ds.earned(TOKEN, bob.address, ETH);
    expect(bobEarned).to.be.gt(0n);
    await ds.connect(bob).unstake(TOKEN, 1000n); // past 1-day anti-jit
    // bob keeps nothing pending; alice now the sole staker
    expect(await ds.earned(TOKEN, bob.address, ETH)).to.equal(0n);
    await time.increase(7 * DAY);
    const aliceEarned = await ds.earned(TOKEN, alice.address, ETH);
    // alice gets essentially the whole 2 ETH (her share + bob's forfeiture), minus streaming dust
    expect(aliceEarned).to.be.gt(ethers.parseEther("1.98"));
  });

  it("anti-JIT: unstake before the hold reverts, after it succeeds", async () => {
    await ds.connect(alice).stake(TOKEN, 1000n);
    await expect(ds.connect(alice).unstake(TOKEN, 1000n)).to.be.revertedWithCustomError(ds, "Locked");
    await time.increase(DAY + 1);
    await ds.connect(alice).unstake(TOKEN, 1000n);
    expect(await ds.staked(TOKEN, alice.address)).to.equal(0n);
  });

  it("boost: weight is boosted and clamped to 4x; rewards split by weight not principal", async () => {
    const oracle = await (await ethers.getContractFactory("MockBoostOracle")).deploy();
    await ds.connect(owner).setBoostOracle(await oracle.getAddress());
    await oracle.set(TOKEN, alice.address, 20000); // 2x
    await oracle.set(TOKEN, bob.address, 100000); // 10x → clamps to 4x

    await ds.connect(alice).stake(TOKEN, 1000n); // weight 2000
    await ds.connect(bob).stake(TOKEN, 1000n); // weight 4000 (clamped)
    expect(await ds.weight(TOKEN, alice.address)).to.equal(2000n);
    expect(await ds.weight(TOKEN, bob.address)).to.equal(4000n);
    expect(await ds.totalWeight(TOKEN)).to.equal(6000n);

    await ds.connect(rewarder).fundETH(TOKEN, { value: ethers.parseEther("6") });
    await time.increase(7 * DAY + 10);
    const a = await ds.earned(TOKEN, alice.address, ETH);
    const b = await ds.earned(TOKEN, bob.address, ETH);
    // bob (weight 4000) earns ~2x alice (weight 2000)
    const diff = b - a * 2n;
    expect(diff >= -(10n ** 12n) && diff <= 10n ** 12n).to.equal(true);
  });

  it("boost oracle that reverts falls back to 1x (never blocks staking)", async () => {
    const oracle = await (await ethers.getContractFactory("MockBoostOracle")).deploy();
    await ds.connect(owner).setBoostOracle(await oracle.getAddress());
    await oracle.setRevert(true);
    await ds.connect(alice).stake(TOKEN, 500n);
    expect(await ds.weight(TOKEN, alice.address)).to.equal(500n); // 1x fallback
  });

  it("fundTokenPushed credits the measured balance delta", async () => {
    await ds.connect(owner).listReward(TOKEN, await stk.getAddress(), 7 * DAY);
    await ds.connect(alice).stake(TOKEN, 1000n);
    // simulate a hook `take` straight into the contract (1e18-scale)
    await stk.connect(owner).transfer(await ds.getAddress(), 5000n * 10n ** 18n);
    await ds.connect(rewarder).fundTokenPushed(TOKEN, await stk.getAddress());
    await time.increase(7 * DAY + 10);
    expect(await ds.earned(TOKEN, alice.address, await stk.getAddress())).to.be.gt(4990n * 10n ** 18n);
  });
});

describe("DualStaking — reports weight to the RobinFeeHook holder bucket", () => {
  const FLAGS = 0xc4n, MASK = 0x3fffn;
  const abi = ethers.AbiCoder.defaultAbiCoder();

  it("staking the weighted side updates hook.totalWeight / weightOf", async () => {
    const [owner, factory, platform, alice] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const tok = await erc20(owner);
    const stk = await erc20(owner);

    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress()]),
    ]);
    let salt, addr;
    for (let i = 0n; ; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(await dep.getAddress(), s, ethers.keccak256(initCode));
      if ((BigInt(a) & MASK) === FLAGS) { salt = s; addr = a; break; }
    }
    await dep.deploy(salt, initCode);
    const hook = HookF.attach(addr);

    const key = { currency0: ethers.ZeroAddress, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: addr };
    const poolId = ethers.keccak256(
      abi.encode(["tuple(address,address,uint24,int24,address)"], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])
    );

    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), await stk.getAddress(), owner.address, 86400, addr, poolId, 0
    );

    await pm.initialize(key, 79228162514264337593543950336n);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ethers.ZeroAddress, currency1: await tok.getAddress(), creator: owner.address,
      weightSource: await ds.getAddress(), guardAdapter: ethers.ZeroAddress,
      feeBps: 100, platformShareBps: 4000, creatorShareBps: 3000, guardWindow: 0, quoteIsStock: false,
    });

    await tok.connect(owner).transfer(alice.address, 10n ** 24n);
    await tok.connect(alice).approve(await ds.getAddress(), ethers.MaxUint256);
    await ds.connect(alice).stake(0, 777n);

    expect(await hook.totalWeight(poolId)).to.equal(777n);
    expect(await hook.weightOf(poolId, alice.address)).to.equal(777n);
  });
});
