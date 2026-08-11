const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");

// Feature 5 (curve-on-V4) — the DEFINITIVE end-to-end proof against the LIVE V4 stack: launch a free
// single-sided curve pad, buy it OUT (overshooting the ceiling), then graduate — asserting the ceiling
// nudge lands spot at gradTick, the permanent LOCKED 2-sided LP mints to the LockVault (reserve pairs the
// raise), the leftover reserve streams to the pad's DualStaking pool, and the platform fee book is claimable.
// This is the one leg the local tests can't cover (needs the real PositionManager). Run:
//   FORK_RPC=<robinhood rpc> npx hardhat test test/fork/CurveGraduation.fork.test.js

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAG_MASK = 0x3fffn, HOOK_FLAGS = 0xc4n;
const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();

describe("CurvePadFactoryV4 — launch → sellout → graduate on live 0x8366", function () {
  before(function () {
    if (!process.env.FORK_RPC) this.skip();
  });

  it("graduates: nudge to ceiling, locked 2-sided LP to LockVault, reserve → staking, platform book claimable", async () => {
    const [deployer, platform, creator, trader] = await ethers.getSigners();

    // ── bootstrap the stack ──
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(POSITION_MANAGER, await reg.getAddress());
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(POOL_MANAGER);
    const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());

    const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
    const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: 1800,
    });

    const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2, await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(),
      await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());

    const cfg = {
      name: "Robin Curve", symbol: "rCRV", decimals: 18,
      // NO DEV MINT: supply == curveSupply + reserveSupply exactly (creator gets nothing at launch)
      supply: 300n * 10n ** 18n, curveSupply: 100n * 10n ** 18n, reserveSupply: 200n * 10n ** 18n,
      tickSpacing: SPACING, creator: creator.address,
    };

    // predict token addr → mine hook salt (hook init-code carries the token)
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenSalt = ethers.id("rcrv-1");
    const tokenInit = ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await factory.getAddress()]),
    ]);
    const predictedToken = ethers.getCreate2Address(await dep.getAddress(), tokenSalt, ethers.keccak256(tokenInit));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(await dep.getAddress(), hookInitCode(HookF.bytecode, POOL_MANAGER, await factory.getAddress(), await reg.getAddress(), predictedToken));
    const curveSalt = ethers.id("rcrv-curve-1");

    // ── launch ──
    const ret = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
    await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
    const [token, hook, curveAddr] = ret;
    expect(token).to.equal(predictedToken);
    expect(BigInt(hook) & FLAG_MASK).to.equal(HOOK_FLAGS);

    const curve = HookF.attach(curveAddr) && await ethers.getContractAt("RobinCurveV4", curveAddr);
    const tok = await ethers.getContractAt("PadToken", token);
    expect(await curve.seeded()).to.equal(true);
    expect(await tok.balanceOf(curveAddr)).to.equal(cfg.reserveSupply); // reserve held, curve seeded
    expect(await tok.balanceOf(creator.address)).to.equal(0n); // NO premine — creator holds nothing at launch

    // ── wire a staking pool (token stake, token reward) + authorize the curve as rewarder ──
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(token, ZERO, deployer.address, 0, ZERO, ethers.ZeroHash, 0);
    await ds.setRewarder(curveAddr, true);
    await ds.listReward(0, token, 7 * 86400); // Side.TOKEN earns the token (the reserve)
    await curve.connect(platform).setStaking(await ds.getAddress());

    // ── buy the curve OUT (overshoot the ceiling) ──
    const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: SPACING, hooks: hook };
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(POOL_MANAGER);
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("300"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("300") }
    );
    expect(await curve.ready()).to.equal(true);

    // ── [audit] a hostile ETH donation to the curve before graduation must NOT brick graduate() ──
    // (the raise is measured from the pull delta, not raw balance, so the donation cannot inflate lpEth)
    await deployer.sendTransaction({ to: curveAddr, value: ethers.parseEther("2") });

    // ── graduate ──
    const posm = await ethers.getContractAt("IPositionManagerMinimal", POSITION_MANAGER);
    const idBefore = await posm.nextTokenId();
    await (await curve.graduate()).wait();

    expect(await curve.graduated()).to.equal(true);
    // the permanent LP NFT is owned by the LockVault (locked forever)
    expect(await posm.ownerOf(idBefore)).to.equal(await lockVault.getAddress());
    // spot was nudged back to the honest ceiling before seeding
    expect((await stateView.getSlot0(await factory.poolOf(token)))[1]).to.equal(GRAD);
    // the leftover reserve reached the staking pool (some of the reserve pairs the LP; the rest streams)
    expect(await tok.balanceOf(await ds.getAddress())).to.be.gt(0n);
    // platform fee book is non-negative and claimable without reverting
    await expect(curve.claimPlatform()).to.not.be.reverted;

    // v3-econ graduation waterfall: the creator-side reward is booked (creatorGradBps=10% of the raise) and
    // claimable; the 20% buy-LP carve is parked (no floor wired here) and flushable once a floor is set.
    expect(await curve.creatorEthOwed()).to.be.gt(0n);
    const creatorBefore = await ethers.provider.getBalance(creator.address);
    await (await curve.claimCreator()).wait();
    expect(await ethers.provider.getBalance(creator.address)).to.be.gt(creatorBefore);
    expect(await curve.creatorEthOwed()).to.equal(0n);
  });
});
