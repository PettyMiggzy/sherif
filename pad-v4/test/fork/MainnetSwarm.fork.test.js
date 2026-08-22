const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { brandedTokenSalt } = require("../helpers/brand");

// ─────────────────────────────────────────────────────────────────────────────
// MAINNET-FORK E2E SWARM — deploys the FULL new ETH-fee curve suite FRESH against the REAL mainnet v4 stack
// (PoolManager 0x8366 + the real v4 PositionManager 0x174c) and drives the trader-swarm lifecycle that burned
// earlier pads, plus the new ETH-native fee mechanics end-to-end:
//   • no bot protection — many wallets buy in ONE block right after launch
//   • buy → instant sell round-trip loses ≈ the fees (not half)
//   • referral (EXTERNAL and SELF) accrues off the platform cut, never the trader/buffer
//   • an airdropped holder can sell
//   • sellout → graduate → permanent LP LOCKED to LockVault, platform/creator books claimable
//   • POST-graduation buys keep taxing; the ETH buffer is swept to the platform (F1)
// Graduation needs the real v4 PositionManager, which lives on MAINNET — hence the mainnet fork. Run:
//   FORK_RPC=https://rpc.mainnet.chain.robinhood.com FORK_CHAINID=4663 npx hardhat test test/fork/MainnetSwarm.fork.test.js
// ─────────────────────────────────────────────────────────────────────────────

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MIN = 4295128739n + 1n, MAX = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAG_MASK = 0x3fffn, HOOK_FLAGS = 0xccn;
const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;

function poolIdOf(k) {
  return ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));
}

describe("Mainnet-fork E2E swarm — new ETH-fee suite vs live v4", function () {
  this.timeout(300000);
  let deployer, platform, creator, t1, t2, t3, t4, air, ref, rt;
  let dep, reg, lockVault, stateView, curveDep, factory, HookF, sw;

  before(async function () {
    if (!process.env.FORK_RPC) this.skip();
    [deployer, platform, creator, t1, t2, t3, t4, air, ref, rt] = await ethers.getSigners();

    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(POSITION_MANAGER, await reg.getAddress());
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(POOL_MANAGER);
    curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
    const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 2500,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: 1800,
      // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
      // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
      minFdvWei: 1n, maxFdvWei: (1n << 128n) - 1n,
    });
    factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2, await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
    HookF = await ethers.getContractFactory("RobinFeeHook");
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(POOL_MANAGER);
  });

  async function launch(tag, curveTok, reserveTok) {
    const cfg = {
      name: "Robin " + tag, symbol: tag, decimals: 18,
      supply: E(curveTok + reserveTok), curveSupply: E(curveTok), reserveSupply: E(reserveTok),
      tickSpacing: SPACING, startTickMag: 0, creator: creator.address,
    };
    const TokenF = await ethers.getContractFactory("PadToken");
    // [brand] the factory rejects any token address not ending in `1ab5` — mine the salt (seeded per-tag so two
    // pads with identical config still land on different addresses). MUST run before the hook mining below,
    // because the hook init-code embeds the predicted token address.
    const tokenSalt = await brandedTokenSalt(await dep.getAddress(), await factory.getAddress(), cfg, ethers.id("tok-" + tag));
    const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, 18, cfg.supply, await factory.getAddress()])]);
    const predicted = ethers.getCreate2Address(await dep.getAddress(), tokenSalt, ethers.keccak256(tokenInit));
    const { salt: hookSalt } = mineHookSalt(await dep.getAddress(), hookInitCode(HookF.bytecode, POOL_MANAGER, await factory.getAddress(), await reg.getAddress(), predicted));
    const curveSalt = ethers.id("curve-" + tag);
    const [token, hook, curveAddr] = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
    await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
    expect(token).to.equal(predicted);
    expect(BigInt(hook) & FLAG_MASK).to.equal(HOOK_FLAGS);
    const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: SPACING, hooks: hook };
    return {
      token, hook, curveAddr, key, poolId: poolIdOf(key),
      curve: await ethers.getContractAt("RobinCurveV4", curveAddr),
      hookC: await ethers.getContractAt("RobinFeeHook", hook),
      tok: await ethers.getContractAt("PadToken", token),
    };
  }
  const buy = (P, who, amt, data = "0x", limit = MIN) => sw.connect(who).swap(P.key, { zeroForOne: true, amountSpecified: -amt, sqrtPriceLimitX96: limit }, { takeClaims: false, settleUsingBurn: false }, data, { value: amt });
  async function sellAll(P, who) {
    const bal = await P.tok.balanceOf(who.address);
    const ar = await (await P.tok.connect(who).approve(await sw.getAddress(), ethers.MaxUint256)).wait();
    const sr = await (await sw.connect(who).swap(P.key, { zeroForOne: false, amountSpecified: -bal, sqrtPriceLimitX96: MAX }, { takeClaims: false, settleUsingBurn: false }, "0x")).wait();
    return { bal, gas: ar.gasUsed * ar.gasPrice + sr.gasUsed * sr.gasPrice };
  }

  it("swarm: same-block buys, buy→sell round-trip ≈ fees, referral (ext+self), airdrop holder sells", async () => {
    const P = await launch("SWARM", 5_000_000, 5_000_000); // big curve — the trade scenarios never sell it out

    // 1) NO BOT PROTECTION — 4 wallets buy in the SAME block, right after launch
    await ethers.provider.send("evm_setAutomine", [false]);
    const txs = await Promise.all([t1, t2, t3, t4].map((w, i) => buy(P, w, E(0.01 + i * 0.005))));
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_setAutomine", [true]);
    for (const w of [t1, t2, t3, t4]) expect(await P.tok.balanceOf(w.address)).to.be.gt(0n, "same-block buy filled");

    // 2) BUY → INSTANT SELL round-trip loses ≈ the fees (1% buy + 1% sell + LP each leg + tiny impact), not half.
    //    Use a FRESH wallet `rt` (t1..t4 already hold scenario-1 tokens, which would pollute the round-trip).
    const before = await ethers.provider.getBalance(rt.address);
    const spent = E(0.05);
    const rc1 = await (await buy(P, rt, spent)).wait();
    const s = await sellAll(P, rt);
    const gas = rc1.gasUsed * rc1.gasPrice + s.gas;
    const net = before - (await ethers.provider.getBalance(rt.address)) - gas; // ETH lost to the round-trip (ex-gas)
    expect(net).to.be.gt(0n); // it costs the fees
    expect(net).to.be.lt(spent / 6n); // but far less than "half" — well under ~16%
    expect(await P.tok.balanceOf(rt.address)).to.equal(0n); // fully sold

    // 3) REFERRAL — external referrer earns off the platform cut; buffer + trader untouched
    const refOwed0 = await P.hookC.referralOwed(ref.address, ZERO);
    const platOwed0 = await P.hookC.platformOwed(P.poolId, 0);
    const buff0 = await P.hookC.bufferOwed(P.poolId);
    await (await buy(P, t2, E(0.1), abi.encode(["address"], [ref.address]))).wait();
    const dRef = (await P.hookC.referralOwed(ref.address, ZERO)) - refOwed0;
    const dPlat = (await P.hookC.platformOwed(P.poolId, 0)) - platOwed0;
    const dBuff = (await P.hookC.bufferOwed(P.poolId)) - buff0;
    expect(dRef).to.be.gt(0n, "external referrer accrued");
    expect(dBuff).to.be.gt(0n, "buffer still accrues");
    // referral is carved from the platform cut: platform gets 75% of its cut, referrer 25% (of an 0.8% platform slice)
    expect(dRef * 3n).to.be.closeTo(dPlat, dPlat / 100n + 2n);

    // 3b) SELF-REFERRAL is permissionless (buyer names themselves) — still only lowers the platform's own cut
    const selfOwed0 = await P.hookC.referralOwed(t3.address, ZERO);
    await (await buy(P, t3, E(0.1), abi.encode(["address"], [t3.address]))).wait();
    expect((await P.hookC.referralOwed(t3.address, ZERO)) - selfOwed0).to.be.gt(0n, "self-referrer accrued (by design)");

    // 4) AIRDROPPED holder can sell — dev sends the reserve? no; a trader gifts tokens to `air`, who sells fine
    await (await P.tok.connect(t2).transfer(air.address, await P.tok.balanceOf(t2.address))).wait();
    const airHad = await P.tok.balanceOf(air.address);
    expect(airHad).to.be.gt(0n);
    const airEth0 = await ethers.provider.getBalance(air.address);
    await sellAll(P, air);
    expect(await ethers.provider.getBalance(air.address)).to.be.gt(airEth0); // received ETH for the airdrop
  });

  it("graduation: sellout → graduate → LP LOCKED to LockVault + books claimable; post-grad buffer → platform", async () => {
    const P = await launch("GRAD", 100, 200); // small curve so a bounded buy sells it out; reserve ≥ 0.904·curve

    // wire staking so the graduation reserve stream has a home
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(P.token, ZERO, deployer.address, 0, ZERO, ethers.ZeroHash, 0);
    await ds.setRewarder(P.curveAddr, true);
    await ds.listReward(0, P.token, 7 * 86400);
    await P.curve.connect(platform).setStaking(await ds.getAddress());

    // buy the curve OUT (overshoot the ceiling; graduate nudges spot back to gradTick)
    await (await buy(P, t1, E(300))).wait();
    expect(await P.curve.ready()).to.equal(true);

    const posm = await ethers.getContractAt("IPositionManagerMinimal", POSITION_MANAGER);
    const idBefore = await posm.nextTokenId();
    await (await P.curve.graduate()).wait();

    expect(await P.curve.graduated()).to.equal(true);
    expect(await posm.ownerOf(idBefore)).to.equal(await lockVault.getAddress()); // permanent LP locked forever
    expect((await stateView.getSlot0(P.poolId))[1]).to.equal(GRAD);               // spot nudged to the honest ceiling
    expect(await P.tok.balanceOf(await ds.getAddress())).to.be.gt(0n);            // leftover reserve → staking
    await expect(P.curve.claimPlatform()).to.not.be.reverted;                    // platform book claimable
    expect(await P.curve.creatorEthOwed()).to.be.gt(0n);                         // creator graduation reward booked
    const cBefore = await ethers.provider.getBalance(creator.address);
    await (await P.curve.claimCreator()).wait();
    expect(await ethers.provider.getBalance(creator.address)).to.be.gt(cBefore);

    // ── POST-GRADUATION buffer → platform (F1). Buy on the now-graduated permanent LP; the hook keeps taxing and
    //    accrues the ETH buffer, which claimBuffer forwards to the curve and sweepToPlatform books to the platform. ──
    await (await buy(P, t2, E(0.5))).wait();                                      // post-grad buy on the permanent LP
    const buffered = await P.hookC.bufferOwed(P.poolId);
    expect(buffered).to.be.gt(0n, "post-grad buys still accrue the buffer");
    await (await P.hookC.claimBuffer(P.poolId)).wait();                           // hook → curve (ETH)
    const platBefore = await P.curve.platformEthOwed();
    await (await P.curve.sweepToPlatform()).wait();                              // curve books it to the platform
    expect(await P.curve.platformEthOwed()).to.be.gt(platBefore, "post-grad buffer reached the platform book");
  });
});
