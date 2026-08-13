const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinAmbushVault — the two-sided ambush band: an ETH-seeded, single-sided concentrated range placed strictly
// ABOVE gradTick (below the graduation PRICE). Passive: a dip (sell pushes tick up into the band) converts its ETH
// to token (buys the dip); a recovery (buy pushes tick back down) sells that token for ETH. Add-only, un-pullable,
// anchor read from the curve's gradTick() on-chain. Verified against a real PoolManager on a plain (hookless) pool.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n; // tick 0
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("RobinAmbushVault — two-sided ETH-seeded ambush band", () => {
  const FEE = 3000, TS = 60;
  let owner, lp, trader, floorSink, pm, stateView, tok, mod, sw, key, poolId;

  beforeEach(async () => {
    [owner, lp, trader, floorSink] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1); // tick 0

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    // deep base liquidity spanning the band so trades can move spot up through [60,660] and back
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: E(5), salt: ethers.ZeroHash }, "0x",
      { value: E(200) }
    );
  });

  async function deployVault(gradTick, floorRecipient, stakingRecipient) {
    // [M-26] the vault now cross-checks its PoolKey against the curve, so the double must carry the same key
    const curve = await (await ethers.getContractFactory("MockCurveGrad"))
      .deploy(gradTick, ZERO, await tok.getAddress(), FEE, TS, ZERO);
    return (await ethers.getContractFactory("RobinAmbushVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), floorRecipient, stakingRecipient ?? ZERO,
      await curve.getAddress(), ZERO, await tok.getAddress(), FEE, TS, ZERO, 0 /* gap */, 10 /* width spacings */
    );
  }

  it("anchors the band ABOVE gradTick, read from the curve on-chain (not a param)", async () => {
    const v0 = await deployVault(0, floorSink.address);
    expect(await v0.ambushTickLower()).to.equal(60n); // first spacing boundary above gradTick 0
    expect(await v0.ambushTickUpper()).to.equal(660n); // + 10 * 60
    const v120 = await deployVault(120, floorSink.address);
    expect(await v120.ambushTickLower()).to.equal(180n); // anchor shifted with the curve's gradTick
    expect(await v120.ambushTickUpper()).to.equal(780n);
  });

  it("exposes NO remove/withdraw selector (add-only band)", async () => {
    const v = await deployVault(0, floorSink.address);
    const banned = ["remove", "removeambush", "withdraw", "decreaseliquidity", "burn", "unseed"];
    const names = v.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const b of banned) expect(names).to.not.include(b);
    expect(names).to.include("seedambush");
  });

  it("seeds the band as SINGLE-SIDED ETH (pulls no token) when spot is below it", async () => {
    const v = await deployVault(0, floorSink.address);
    await owner.sendTransaction({ to: await v.getAddress(), value: E(1) });
    await v.seedAmbush();
    const L = await v.ambushLiquidity();
    expect(L).to.be.gt(0n);
    const [posL] = await stateView.getPositionInfo(poolId, await v.getAddress(), 60, 660, ethers.ZeroHash);
    expect(posL).to.equal(L);
    expect(await tok.balanceOf(await v.getAddress())).to.equal(0n); // used only ETH, pulled no token
    expect(await ethers.provider.getBalance(await v.getAddress())).to.equal(0n); // all seed ETH went in
  });

  it("PARKS the seed instead of reverting when spot is inside/above the band", async () => {
    const v = await deployVault(0, floorSink.address);
    // push spot UP above the band with a big sell (token in → tick up)
    await tok.connect(owner).transfer(trader.address, E(50));
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -E(20), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    expect((await stateView.getSlot0(poolId))[1]).to.be.gte(60n); // spot now inside/above the band
    await owner.sendTransaction({ to: await v.getAddress(), value: E(1) });
    await expect(v.seedAmbush()).to.emit(v, "AmbushParked");
    expect(await v.parkedEth()).to.equal(E(1));
    expect(await v.ambushLiquidity()).to.equal(0n);
  });

  it("buys the dip and sells the rip: a round-trip through the band sweeps ETH fees to the floor", async () => {
    const v = await deployVault(0, floorSink.address);
    await owner.sendTransaction({ to: await v.getAddress(), value: E(2) });
    await v.seedAmbush();

    await tok.connect(owner).transfer(trader.address, E(100));
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    // DIP: sell pushes tick UP through the band → band buys (ETH→token)
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -E(30), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    // RECOVERY: buy pushes tick back DOWN through the band → band sells (token→ETH), earning ETH-leg fees
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(30), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(30) }
    );

    const Lbefore = await v.ambushLiquidity();
    const floorBefore = await ethers.provider.getBalance(floorSink.address);
    await v.collectFees();
    expect(await ethers.provider.getBalance(floorSink.address)).to.be.gt(floorBefore); // ETH fees → floor
    expect(await v.ambushLiquidity()).to.equal(Lbefore); // principal untouched (only fees moved)
  });

  it("fee forwarding is NON-BRICKING: a reverting floor sink parks the ETH, never reverts collectFees", async () => {
    const badSink = await (await ethers.getContractFactory("RevertingEthSink")).deploy();
    const v = await deployVault(0, await badSink.getAddress());
    await owner.sendTransaction({ to: await v.getAddress(), value: E(2) });
    await v.seedAmbush();

    await tok.connect(owner).transfer(trader.address, E(100));
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -E(30), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(30), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(30) }
    );

    const L = await v.ambushLiquidity();
    await expect(v.collectFees()).to.not.be.reverted; // never bricks
    expect(await v.pendingFloorEth()).to.be.gt(0n); // ETH parked, retriable
    expect(await v.ambushLiquidity()).to.equal(L); // principal untouched
    // the parked ETH is EXCLUDED from a re-seed (band L must not grow from parked fees)
    await v.seedAmbush();
    expect(await v.ambushLiquidity()).to.equal(L);
  });

  it("rejects an inverted / out-of-range band at deploy", async () => {
    const F = await ethers.getContractFactory("RobinAmbushVault");
    const curve = await (await ethers.getContractFactory("MockCurveGrad"))
      .deploy(0, ZERO, await tok.getAddress(), FEE, TS, ZERO);
    await expect(
      F.deploy(await pm.getAddress(), await stateView.getAddress(), floorSink.address, ZERO,
        await curve.getAddress(), ZERO, await tok.getAddress(), FEE, TS, ZERO, 0, 0) // width 0
    ).to.be.revertedWithCustomError(F, "BadBand");
  });
});
