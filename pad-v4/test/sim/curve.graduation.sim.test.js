const { ethers } = require("hardhat");
const { expect } = require("chai");

// SIM — full-lifecycle VALUE CONSERVATION through graduation, against a REAL local Uniswap v4 PoolManager
// (mock PositionManager + Permit2 stand in for the 0.8.17-pinned real ones). Drives a mixed buy/sell tape,
// a hostile ETH donation, and graduation, then drains every book and proves:
//   • NOTHING is stranded on the curve — ETH and token both end at ~0,
//   • every sink got funded (permanent LP locked, platform, creator, floor, staking),
//   • the hostile donation did not brick graduation (it fell through to the platform, not into lpEth).

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const TOKEN = 0;
const abi = ethers.AbiCoder.defaultAbiCoder();

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("SIM — graduation value conservation (nothing stranded, every sink funded)", () => {
  it("mixed tape + donation + graduate: curve ends empty; LP/platform/creator/floor/staking all funded", async () => {
    const [owner, platform, creator, trader] = await ethers.getSigners();
    const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
    const CURVE_SUPPLY = 1000n * 10n ** 18n, RESERVE = 1000n * 10n ** 18n;
    const GRAD_REWARD = ethers.parseEther("0.5");

    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    const tokAddr = await tok.getAddress();
    const key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    const poolId = poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));

    const curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
    );
    const curveAddr = await curve.getAddress();

    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);

    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(tokAddr, ZERO, owner.address, 0, ZERO, ethers.ZeroHash, TOKEN);
    await ds.setRewarder(curveAddr, true);
    await ds.listReward(TOKEN, tokAddr, 7 * 86400);
    await curve.connect(platform).setStaking(await ds.getAddress());
    const floor = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), platform.address, ZERO, tokAddr, FEE, SPACING, ZERO, GRAD, 10
    );
    await curve.connect(platform).setFloor(await floor.getAddress());
    // wire the two-sided ambush vault — the ambushGradBps (5%) share of the raise is swept here at graduation.
    // Anchor is read from the curve's gradTick() on-chain; floor sink = the floor vault, staking sink = DualStaking.
    const ambush = await (await ethers.getContractFactory("RobinAmbushVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await floor.getAddress(), await ds.getAddress(),
      curveAddr, ZERO, tokAddr, FEE, SPACING, ZERO, 0 /* gap */, 10 /* width spacings */
    );
    await curve.connect(platform).setAmbush(await ambush.getAddress());

    // ── a mixed buy/sell tape (accrues the platform ETH book, the 20% floor book, and token sell fees) ──
    const buy = (amt) => sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(amt) }
    );
    await buy("2");
    await curve.collectFees();
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(2n * 10n ** 17n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    await curve.collectFees();
    await buy("6000"); // buy the rest out → ceiling
    expect(await curve.ready()).to.equal(true);

    // ── hostile ETH donation just before graduation ──
    await owner.sendTransaction({ to: curveAddr, value: ethers.parseEther("3") });

    const dsAddr = await ds.getAddress();
    const idBefore = await posm.nextTokenId();
    await curve.graduate();

    // drain every accrue-and-pull book + finish the streamed sinks
    await curve.claimPlatform();
    await curve.claimCreator();
    // floor + staking + ambush were funded inline at graduation; flush is a no-op safety net
    await curve.flushFloor().catch(() => {});
    await curve.flushStaking().catch(() => {});
    await curve.flushAmbush().catch(() => {});

    // ── CONSERVATION: nothing stranded on the curve ──
    expect(await ethers.provider.getBalance(curveAddr)).to.equal(0n); // all ETH distributed (donation included)
    expect(await tok.balanceOf(curveAddr)).to.equal(0n); // all token → LP + staking
    expect(await curve.platformEthOwed()).to.equal(0n);
    expect(await curve.creatorEthOwed()).to.equal(0n);
    expect(await curve.floorEthOwed()).to.equal(0n);
    expect(await curve.ambushEthOwed()).to.equal(0n); // the 5% ambush share swept to the ambush vault

    // ── every sink got funded ──
    expect(await posm.ownerOf(idBefore)).to.equal(await lockVault.getAddress()); // permanent LP locked
    const [posL] = await stateView.getPositionInfo(
      poolId, await posm.getAddress(),
      Number(await th.minUsable(SPACING)), Number(await th.maxUsable(SPACING)), ethers.ZeroHash
    );
    expect(posL).to.be.gt(0n); // the locked LP holds real liquidity
    expect(await tok.balanceOf(dsAddr)).to.be.gt(0n); // staking got the leftover token
    expect(await ethers.provider.getBalance(await ambush.getAddress())).to.be.gt(0n); // ambush vault armed with the 5% share

    // ── [audit F1] POST-GRADUATION buffer → PLATFORM. On the live pad the hook keeps taxing buys after
    //    graduation and forwards the ETH buffer carve here via claimBuffer; graduate() is one-shot, so without a
    //    post-grad path that ETH would strand. sweepToPlatform() books any such ETH (here simulated by a direct
    //    send, exactly as claimBuffer/donations arrive) into the platform book, and claimPlatform pays it out. ──
    const platWallet = await reg.platformFeeWallet();
    const platBefore = await ethers.provider.getBalance(platWallet);
    const postGrad = ethers.parseEther("0.7");
    await owner.sendTransaction({ to: curveAddr, value: postGrad }); // mimic post-grad buffer/donation arriving
    expect(await curve.platformEthOwed()).to.equal(0n); // not booked until swept
    await curve.sweepToPlatform();
    expect(await curve.platformEthOwed()).to.equal(postGrad); // booked to the platform, not stranded
    await curve.claimPlatform();
    expect((await ethers.provider.getBalance(platWallet)) - platBefore).to.equal(postGrad); // platform actually received it
    expect(await ethers.provider.getBalance(curveAddr)).to.equal(0n); // nothing stranded
    await curve.sweepToPlatform(); // idempotent: a second sweep with nothing new is a no-op
    expect(await curve.platformEthOwed()).to.equal(0n);
  });
});
