const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { predictPadToken, brandedTokenSalt } = require("../helpers/brand");

// DailyAuctionVaultV4 / CurvePadFactoryV4's [AUCTION] carve-out — the pad-v4 port of launchpad's
// DailyAuctionVault (see /home/user/sherif/launchpad/contracts/DailyAuctionVault.sol and its
// daily-auction.test.js, the design template + coverage bar this file adapts to v4's mechanics: no direct
// pool.swap(), instead poolManager.unlock()/unlockCallback()/swap()/take(DEAD) — and the vault reads the pad's
// PoolKey pieces straight off the curve rather than being handed one). Real PoolManager/mock periphery stack,
// real mined hook salt, real branded token salt, real CurvePadFactoryV4.launch(), real PoolManager swaps
// executed BY the vault itself on closeDay — nothing here is mocked or shortcut.

const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 24 * 3600;

const START = 6000, GRAD = 3000, SPACING = 60, GOVERNED_FEE = 10000, MINGRAD = 1800;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000,
  referralShareBps: 0, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
  lpFee: GOVERNED_FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
  minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n,
};

async function deployStack(deployer, platform, { withAuction = true } = {}) {
  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
  const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
  const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
  const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
  const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, DEFAULTS);
  const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());

  // [AUCTION] the two thin deployers — deploy(0) leaves the feature OFF for a "not wired" fixture.
  let rsd = null, davd = ZERO;
  if (withAuction) {
    rsd = await (await ethers.getContractFactory("RobinStakingV4Deployer")).deploy();
    davd = await (await ethers.getContractFactory("DailyAuctionVaultV4Deployer")).deploy(await rsd.getAddress());
    davd = await davd.getAddress();
  }

  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(),
    await lockVault.getAddress(), davd
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, curveDep, feeCfg, lockVault, factory, rsd, davd };
}

function baseCfg(creator, auctionDays, overrides = {}) {
  return {
    name: "Robin Auction", symbol: "RAUC", decimals: 18,
    supply: 2000n * 10n ** 18n, curveSupply: 1000n * 10n ** 18n, reserveSupply: 1000n * 10n ** 18n,
    tickSpacing: SPACING, startTickMag: 0, creator: creator.address,
    noPoolForever: false, lpFee: GOVERNED_FEE, auctionDays,
    ...overrides,
  };
}

async function launchThroughFactory(S, cfg, tag) {
  const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id(tag));
  const TokenF = await ethers.getContractFactory("PadToken");
  const predictedToken = predictPadToken(await S.dep.getAddress(), await S.factory.getAddress(), cfg, tokenSalt, TokenF.bytecode);
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    await S.dep.getAddress(),
    hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predictedToken)
  );
  const curveSalt = ethers.id(tag + "-curve");
  const ret = await S.factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  const rc = await (await S.factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  const auctionVault = await S.factory.auctionVaultOf(ret[0]);
  return { token: ret[0], hook: ret[1], curveAddr: ret[2], poolId: ret[3], receipt: rc, auctionVault };
}

/// Every Transfer(..., to, value) the launch tx emitted on the pad token, in log order — used to observe the
/// EXACT amount the factory actually seeded the curve with (the curve's own sellable balance is gone the
/// instant seed() runs, deposited into the v4 position, so there is no balanceOf() left to read afterward).
function tokenTransfersTo(receipt, tokenIface, tokenAddr, to) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === tokenAddr.toLowerCase())
    .map((l) => { try { return tokenIface.parseLog(l); } catch { return null; } })
    .filter((e) => e && e.name === "Transfer" && e.args.to.toLowerCase() === to.toLowerCase())
    .map((e) => e.args.value);
}

function findEvent(receipt, iface, name) {
  return receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === name);
}

describe("CurvePadFactoryV4 / DailyAuctionVaultV4 — optional 0-4 day pre-launch daily batch auction", function () {
  this.timeout(600000);

  let deployer, platform, creator, alice, bob, carol, S;

  beforeEach(async () => {
    [deployer, platform, creator, alice, bob, carol] = await ethers.getSigners();
    S = await deployStack(deployer, platform);
  });

  // ── 1. factory-side carve-out correctness ────────────────────────────────────────────────────────────

  it("auctionDays: 0 launches with NO vault — unchanged legacy behavior", async () => {
    const cfg = baseCfg(creator, 0);
    const { token, auctionVault } = await launchThroughFactory(S, cfg, "auc-none");
    expect(auctionVault).to.equal(ZERO);
    expect(await S.factory.auctionVaultOf(token)).to.equal(ZERO);
  });

  for (const auctionDays of [1, 4]) {
    it(`auctionDays: ${auctionDays} — carves exactly ${auctionDays}*10% of curveSupply into a dedicated vault; curve seeds with the rest`, async () => {
      const cfg = baseCfg(creator, auctionDays);
      const { token, curveAddr, auctionVault, receipt } = await launchThroughFactory(S, cfg, `auc-carve-${auctionDays}`);
      expect(auctionVault).to.not.equal(ZERO);
      expect(await S.factory.auctionVaultOf(token)).to.equal(auctionVault);

      const dayTranche = cfg.curveSupply / 10n; // 10% of the ORIGINAL (pre-carve) curveSupply
      const expectedAuctionAmt = dayTranche * BigInt(auctionDays);
      const expectedCurveSupply = cfg.curveSupply - expectedAuctionAmt;

      const TOK = await ethers.getContractAt("PadToken", token);
      const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);

      // the vault's own accounting matches the expected carve-out
      expect(await vault.dayTranche()).to.equal(dayTranche);
      expect(await vault.auctionDays()).to.equal(auctionDays);
      expect(await TOK.balanceOf(auctionVault)).to.equal(expectedAuctionAmt);

      // the curve was ACTUALLY seeded with the reduced amount — read straight off the launch tx's own
      // Transfer log (the curve's balance is gone into the v4 position by the time this test runs, so
      // there is nothing left to balanceOf() after the fact).
      const toCurve = tokenTransfersTo(receipt, TOK.interface, token, curveAddr);
      expect(toCurve.length).to.be.gte(1);
      expect(toCurve[0]).to.equal(expectedCurveSupply); // the FIRST transfer to the curve is the seed transfer

      // total conservation: nothing stranded in the factory, nothing unaccounted for
      expect(await TOK.balanceOf(await S.factory.getAddress())).to.equal(0n);
      expect(toCurve[0] + cfg.reserveSupply + expectedAuctionAmt).to.equal(cfg.supply);
    });
  }

  it("dayTranche is 10% of the ORIGINAL (pre-carve) curveSupply regardless of auctionDays chosen", async () => {
    const cfg1 = baseCfg(creator, 1);
    const cfg4 = baseCfg(creator, 4);
    const { auctionVault: v1 } = await launchThroughFactory(S, cfg1, "auc-tranche-1");
    const { auctionVault: v4 } = await launchThroughFactory(S, cfg4, "auc-tranche-4");
    const vault1 = await ethers.getContractAt("DailyAuctionVaultV4", v1);
    const vault4 = await ethers.getContractAt("DailyAuctionVaultV4", v4);
    expect(await vault1.dayTranche()).to.equal(await vault4.dayTranche());
  });

  // ── 2. rejections ─────────────────────────────────────────────────────────────────────────────────────

  it("auctionDays > 4 reverts BadConfig", async () => {
    const cfg = baseCfg(creator, 5);
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("auc-over"));
    await expect(S.factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(S.factory, "BadConfig");
  });

  it("auctionDays > 0 against a factory deployed with auctionVaultDeployer = address(0) reverts BadConfig (feature off)", async () => {
    const off = await deployStack(deployer, platform, { withAuction: false });
    expect(off.factory.auctionVaultDeployer).to.not.be.undefined;
    expect(await off.factory.auctionVaultDeployer()).to.equal(ZERO);
    const cfg = baseCfg(creator, 1);
    const tokenSalt = await brandedTokenSalt(await off.dep.getAddress(), await off.factory.getAddress(), cfg, ethers.id("auc-feature-off"));
    await expect(off.factory.launch(cfg, tokenSalt, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(off.factory, "BadConfig");
  });

  // ── 3. geometry checks use the REDUCED (post-carve) curveSupply, not the raw cfg value ──────────────────

  it("a geometry that would FAIL the reserve-ratio check against the raw curveSupply PASSES once auction carve-out reduces it — proving the checks run against the post-carve value", async () => {
    // reserveSupply/curveSupply ≈ 0.7: strictly between the ratio needed to satisfy the reserve check at the
    // RAW 1000e18 curveSupply (needs ≳0.90) and at the 4-day-reduced 600e18 curveSupply (needs ≳0.54) for this
    // pad's fixed geometry (startTick=6000, gradTick=3000). See CurvePadFactoryV4.launch()'s reserve check:
    // reserveSupply * sqrt(startTick) * 100 >= curveSupply * sqrt(gradTick) * 105.
    const shared = { curveSupply: 1000n * 10n ** 18n, reserveSupply: 700n * 10n ** 18n, supply: 1700n * 10n ** 18n };

    const cfgNoAuction = baseCfg(creator, 0, shared);
    const tokenSaltNo = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfgNoAuction, ethers.id("auc-boundary-raw"));
    await expect(S.factory.launch(cfgNoAuction, tokenSaltNo, ethers.id("h"), ethers.id("c")))
      .to.be.revertedWithCustomError(S.factory, "BadConfig"); // raw curveSupply (1000e18) fails the reserve check

    const cfgAuction = baseCfg(creator, 4, shared); // reduces curveSupply to 600e18 (1000e18 - 4*100e18)
    const { token, curveAddr, auctionVault, receipt } = await launchThroughFactory(S, cfgAuction, "auc-boundary-reduced");
    expect(auctionVault).to.not.equal(ZERO); // same geometry, now succeeds once the carve-out is applied

    // confirm the curve was actually seeded with the REDUCED 600e18, not the raw 1000e18
    const TOK = await ethers.getContractAt("PadToken", token);
    const dayTranche = shared.curveSupply / 10n;
    const expectedAuctionAmt = dayTranche * 4n;
    const expectedCurveSupply = shared.curveSupply - expectedAuctionAmt;
    const toCurve = tokenTransfersTo(receipt, TOK.interface, token, curveAddr);
    expect(toCurve[0]).to.equal(expectedCurveSupply);
  });

  // ── 4. bidding windows ────────────────────────────────────────────────────────────────────────────────

  it("bidding: window gating, BadDay, Zero, and additive accumulation", async () => {
    const cfg = baseCfg(creator, 2);
    const { auctionVault } = await launchThroughFactory(S, cfg, "auc-bidwindow");
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);

    // day 2's window hasn't opened yet (still inside day 1's window, right after launch)
    await expect(vault.connect(alice).bid(2, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(vault, "WindowNotOpen");
    // day 0 and day > auctionDays are both BadDay
    await expect(vault.connect(alice).bid(0, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(vault, "BadDay");
    await expect(vault.connect(alice).bid(3, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(vault, "BadDay");
    // zero value
    await expect(vault.connect(alice).bid(1, { value: 0 })).to.be.revertedWithCustomError(vault, "Zero");

    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    await vault.connect(bob).bid(1, { value: ethers.parseEther("3") });
    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") }); // additive
    expect(await vault.bidOf(1, alice.address)).to.equal(ethers.parseEther("2"));
    expect(await vault.bidOf(1, bob.address)).to.equal(ethers.parseEther("3"));
    expect(await vault.dayTotal(1)).to.equal(ethers.parseEther("5"));

    // closeDay before the window has actually closed also reverts WindowNotOpen
    await expect(vault.closeDay(1)).to.be.revertedWithCustomError(vault, "WindowNotOpen");

    // warp past day 1's close: bidding on day 1 now reverts WindowClosed
    const [, closes1] = await vault.dayWindow(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(closes1) + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(alice).bid(1, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(vault, "WindowClosed");
  });

  // ── 5. closeDay — bid path ────────────────────────────────────────────────────────────────────────────

  it("closeDay (bid path): 10% flat to the LIVE platform wallet, the rest is a REAL swap against the pool, tokens land at DEAD, bidders claim pro-rata", async () => {
    const cfg = baseCfg(creator, 1);
    const { token, curveAddr, poolId, auctionVault } = await launchThroughFactory(S, cfg, "auc-close-bid");
    const TOK = await ethers.getContractAt("PadToken", token);
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);

    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    await vault.connect(bob).bid(1, { value: ethers.parseEther("3") });
    const total = ethers.parseEther("4");

    const deadBefore = await TOK.balanceOf(DEAD);
    const platformBefore = await ethers.provider.getBalance(platform.address);
    const [sqrtBefore, tickBefore] = await S.stateView.getSlot0(poolId);

    const [, closes1] = await vault.dayWindow(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(closes1) + 1]);
    await ethers.provider.send("evm_mine", []);
    const rc = await (await vault.closeDay(1)).wait();
    expect(await vault.closed(1)).to.equal(true);

    const expectedPlatform = (total * 1000n) / 10000n; // PLATFORM_BPS = 10%
    expect((await ethers.provider.getBalance(platform.address)) - platformBefore).to.equal(expectedPlatform);

    const ev = findEvent(rc, vault.interface, "DayClosed");
    expect(ev.args.totalBid).to.equal(total);
    expect(ev.args.toPlatform).to.equal(expectedPlatform);
    expect(ev.args.toCurve).to.equal(total - expectedPlatform);
    expect(ev.args.tokensBurned).to.be.gt(0n);
    expect(ev.args.tokensToStaking).to.equal(0n);

    // a REAL swap happened: spot price genuinely moved
    const [, tickAfter] = await S.stateView.getSlot0(poolId);
    expect(tickAfter).to.not.equal(tickBefore);

    // the bought tokens landed DIRECTLY at DEAD (v4's take()-to-DEAD, never touching the vault's own balance)
    const deadAfter = await TOK.balanceOf(DEAD);
    expect(deadAfter - deadBefore).to.equal(ev.args.tokensBurned);

    // pro-rata claims: alice 1/4, bob 3/4
    const tranche = await vault.dayTranche();
    const aliceBefore = await TOK.balanceOf(alice.address);
    await (await vault.connect(alice).claim(1)).wait();
    const aliceGot = (await TOK.balanceOf(alice.address)) - aliceBefore;
    expect(aliceGot).to.equal(tranche / 4n);

    const bobBefore = await TOK.balanceOf(bob.address);
    await (await vault.connect(bob).claim(1)).wait();
    const bobGot = (await TOK.balanceOf(bob.address)) - bobBefore;
    expect(bobGot).to.equal((tranche * 3n) / 4n);
    expect(aliceGot + bobGot).to.equal(tranche); // exact conservation

    await expect(vault.connect(alice).claim(1)).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
    await expect(vault.connect(carol).claim(1)).to.be.revertedWithCustomError(vault, "NothingBid");
    await expect(vault.closeDay(1)).to.be.revertedWithCustomError(vault, "AlreadyClosed");
  });

  // v3 sibling parity check: launchpad's DailyAuctionVault had a real, reachable bug where a bid day's
  // burn-buy that didn't fully consume the ETH (price hit gradTick first) reverted forever trying to refund
  // the leftover — it round-tripped WETH.withdraw() back to itself with no receive(). DailyAuctionVaultV4
  // never round-trips: the vault already holds native ETH from bid() directly, and the leftover refund is a
  // single outbound `platform.call{value: leftover}("")` straight from that balance — there is no receive()
  // needed for it to work, so structurally this bug class can't recur here. This test proves that holds for
  // real (not just on paper) AND closes the loop the user asked about: confirms the auction's contribution to
  // the raise genuinely reaches BOTH creator and platform once graduation runs, exactly like v3's live proof.
  it("closeDay (bid path) that overshoots the graduation ceiling refunds the leftover to the platform (not reverts); the auction's raise reaches BOTH creator and platform at graduation", async () => {
    const cfg = baseCfg(creator, 4); // thinnest curve this pad geometry allows — 40% carved out before seeding
    const { curveAddr, poolId, auctionVault } = await launchThroughFactory(S, cfg, "auc-overshoot");
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);

    // one bid, overwhelmingly larger than this thin test-geometry curve can absorb before spot hits gradTick
    const total = ethers.parseEther("500");
    await vault.connect(alice).bid(1, { value: total });
    const expectedPlatformCut = (total * 1000n) / 10000n; // PLATFORM_BPS = 10%

    const platformBefore = await ethers.provider.getBalance(platform.address);
    const [, closes1] = await vault.dayWindow(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(closes1) + 1]);
    await ethers.provider.send("evm_mine", []);
    const rc = await (await vault.closeDay(1)).wait(); // must NOT revert
    expect(await vault.closed(1)).to.equal(true);

    const ev = findEvent(rc, vault.interface, "DayClosed");
    expect(ev.args.toCurve).to.equal(total - expectedPlatformCut);

    // platform received its flat 10% cut PLUS whatever the swap didn't spend of toCurve — proves the
    // leftover-refund branch (the exact path v3's bug lived in) actually ran and actually succeeded.
    const platformDelta = (await ethers.provider.getBalance(platform.address)) - platformBefore;
    expect(platformDelta).to.be.gt(expectedPlatformCut);
    expect(platformDelta).to.be.lte(total);

    // confirm this genuinely hit the price limit rather than just spending everything: spot is at (or a
    // rounding hair from) gradTick, not wherever an unconstrained 450 ETH buy would have landed.
    const [, tickAfter] = await S.stateView.getSlot0(poolId);
    const gradTick = await curve.gradTick();
    const tickDiff = tickAfter > gradTick ? tickAfter - gradTick : gradTick - tickAfter;
    expect(tickDiff).to.be.lte(2n);

    // the overshoot alone should have filled the curve — graduate and confirm BOTH sides of the raise split
    // actually got booked, non-zero, from ETH the auction (not an ordinary trader) contributed.
    expect(await curve.ready()).to.equal(true);
    await (await curve.connect(alice).graduate()).wait();
    expect(await curve.graduated()).to.equal(true);
    expect(await curve.platformEthOwed()).to.be.gt(0n);
    expect(await curve.creatorEthOwed()).to.be.gt(0n);
  });

  // ── 6. closeDay — zero-bid path (lazy RobinStaking deploy, idempotent reuse) ─────────────────────────────

  it("closeDay (zero-bid path): funds a lazily-deployed dedicated RobinStaking pool; a SECOND zero-bid day reuses the SAME pool and funds it again", async () => {
    const cfg = baseCfg(creator, 2);
    const { token, auctionVault } = await launchThroughFactory(S, cfg, "auc-zerobid");
    const TOK = await ethers.getContractAt("PadToken", token);
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);
    const tranche = await vault.dayTranche();

    expect(await vault.stakingPool()).to.equal(ZERO); // nothing deployed yet — lazy

    // day 1: no bids
    const [, closes1] = await vault.dayWindow(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(closes1) + 1]);
    await ethers.provider.send("evm_mine", []);
    const rc1 = await (await vault.closeDay(1)).wait();

    const stakingAddr = await vault.stakingPool();
    expect(stakingAddr).to.not.equal(ZERO);
    const staking = await ethers.getContractAt("RobinStaking", stakingAddr);
    expect(await staking.owner()).to.equal(auctionVault);
    expect((await staking.rewardInfo(token))[0]).to.equal(true); // the coin is a LISTED reward asset

    const ev1 = findEvent(rc1, vault.interface, "DayClosed");
    expect(ev1.args.totalBid).to.equal(0n);
    expect(ev1.args.tokensBurned).to.equal(0n);
    expect(ev1.args.tokensToStaking).to.equal(tranche);
    expect(await TOK.balanceOf(stakingAddr)).to.equal(tranche);

    // day 2: also no bids — must reuse the SAME staking pool, and fund it a second time
    const [, closes2] = await vault.dayWindow(2);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(closes2) + 1]);
    await ethers.provider.send("evm_mine", []);
    const rc2 = await (await vault.closeDay(2)).wait();

    expect(await vault.stakingPool()).to.equal(stakingAddr); // idempotent — same address, no redeploy
    const ev2 = findEvent(rc2, vault.interface, "DayClosed");
    expect(ev2.args.tokensToStaking).to.equal(tranche);
    expect(await TOK.balanceOf(stakingAddr)).to.equal(tranche * 2n); // funded twice — the stream reflects a second notifyReward
  });

  // ── 7. claiming ───────────────────────────────────────────────────────────────────────────────────────

  it("claim before closeDay reverts NotClosed", async () => {
    const cfg = baseCfg(creator, 1);
    const { auctionVault } = await launchThroughFactory(S, cfg, "auc-claim-notclosed");
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);
    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    await expect(vault.connect(alice).claim(1)).to.be.revertedWithCustomError(vault, "NotClosed");
  });

  it("bidders can claim any time after close, even much later — pull-based, no forced deadline", async () => {
    const cfg = baseCfg(creator, 1);
    const { auctionVault } = await launchThroughFactory(S, cfg, "auc-lateclaim");
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", auctionVault);
    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });

    const [, closes1] = await vault.dayWindow(1);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(closes1) + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.closeDay(1)).wait();

    await ethers.provider.send("evm_increaseTime", [90 * DAY]); // long after everything else has settled
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(alice).claim(1)).to.not.be.reverted;
  });

  // ── 8. gas sanity ─────────────────────────────────────────────────────────────────────────────────────

  it("a real auctionDays=4 launch through the factory completes with NO inflated gasLimit override", async () => {
    // pad-v4's own hardhat.config.js sets no `gas`/`blockGasLimit` override for the in-process `hardhat`
    // network (see hardhat.config.js — only the `robinhood`/`robinhoodTestnet` live networks pin a legacy
    // gasPrice; none of them, nor the local network, configure a reduced per-tx/block gas cap). So unlike
    // Robinhood Chain's real ~16.7M-per-tx production cap (which is what forced v3's DailyAuctionVault to
    // adopt the thin-deployer + lazy-staking-deploy pattern in the first place — see DailyAuctionVault.sol's
    // own comment on `stakingPool`), this local test network does not itself enforce or exhibit that
    // constraint; Hardhat's default in-process block gas limit (30,000,000) comfortably covers a launch tx
    // even with an auction vault deploy attached. This test is therefore a confidence check that the SAME
    // gas-budget fix v3 needed (thin deployers, lazy RobinStaking deploy) keeps a v4 auction-enabled launch
    // well within an ordinary gas budget, not a reproduction of a cap this harness doesn't model.
    const cfg = baseCfg(creator, 4);
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("auc-gas4"));
    const TokenF = await ethers.getContractFactory("PadToken");
    const predictedToken = predictPadToken(await S.dep.getAddress(), await S.factory.getAddress(), cfg, tokenSalt, TokenF.bytecode);
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(
      await S.dep.getAddress(),
      hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predictedToken)
    );
    const curveSalt = ethers.id("auc-gas4-curve");
    const predictedTokenBeforeTx = predictedToken; // same value launch() will land on
    const tx = await S.factory.launch(cfg, tokenSalt, hookSalt, curveSalt); // no gasLimit override
    const rc = await tx.wait();
    expect(rc.status).to.equal(1);
    const vaultAddr = await S.factory.auctionVaultOf(predictedTokenBeforeTx);
    expect(vaultAddr).to.not.equal(ZERO);
    const vault = await ethers.getContractAt("DailyAuctionVaultV4", vaultAddr);
    expect(await vault.auctionDays()).to.equal(4);
  });
});
