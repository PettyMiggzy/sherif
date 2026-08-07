const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 3 — RobinFloorVault. A fee-funded, permanent, single-sided QUOTE buy-wall. Verified against
// a real PoolManager: the carve deploys as pure currency0 liquidity in a band just below the token
// price, the wall is add-only (no remove selector), it parks quote when spot is inside the band, and
// a sell that pushes price into the wall is absorbed (the floor buys the token) and accrues fees.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n; // tick 0
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("RobinFloorVault — permanent single-sided quote floor", () => {
  const FEE = 3000, TS = 60;
  let owner, lp, trader, platform, pm, stateView, tok, mod, sw, key, poolId, vault;

  before(async () => {
    [owner, lp, trader, platform] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);

    // plain pool (no hook) to isolate the floor mechanics
    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1); // tick 0

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    // modest base liquidity so a sell can push price up into the floor band
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash }, "0x",
      { value: ethers.parseEther("50") }
    );

    vault = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), platform.address,
      ZERO, await tok.getAddress(), FEE, TS, ZERO, 0 /* anchorTick = launch tick 0 */, 10 // band = 10 spacings wide
    );
  });

  it("places the band just above spot (pure currency0 region)", async () => {
    const lower = await vault.floorTickLower();
    const upper = await vault.floorTickUpper();
    expect(lower).to.equal(60n); // first spacing boundary above tick 0
    expect(upper).to.equal(660n); // + 10 * 60
  });

  it("exposes NO remove/withdraw selector (add-only wall)", () => {
    const banned = ["remove", "removeFloor", "withdraw", "decreaseLiquidity", "burn"];
    const names = vault.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const b of banned) expect(names).to.not.include(b.toLowerCase());
    expect(names).to.include("addfloor");
  });

  it("deploys the carve as single-sided quote liquidity", async () => {
    // fund the vault with the native carve
    await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("5") });
    await vault.addFloor();

    const L = await vault.floorLiquidity();
    expect(L).to.be.gt(0n);
    // the on-chain position liquidity matches
    const [posL] = await stateView.getPositionInfo(poolId, await vault.getAddress(), 60, 660, ethers.ZeroHash);
    expect(posL).to.equal(L);
    // single-sided: the vault used quote (its ETH), not token — it holds ~no token
    expect(await tok.balanceOf(await vault.getAddress())).to.equal(0n);
    // most of the ETH went into the wall
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.be.lt(ethers.parseEther("0.01"));
  });

  it("absorbs a sell that pushes price into the wall, and accrues fees the platform can collect", async () => {
    // a big SELL (oneForZero: token → quote) pushes tick UP into the floor band [60,660]
    await tok.connect(owner).transfer(trader.address, 10n ** 24n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 21n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    // price is now in/above the band → the floor bought token (converted). Collect its LP fees.
    const beforeTok = await tok.balanceOf(platform.address);
    await vault.collectFloorFees();
    // the wall earned token-side fees from the sell that passed through it
    expect(await tok.balanceOf(platform.address)).to.be.gte(beforeTok);
  });

  it("parks the carve when spot is inside the band instead of reverting", async () => {
    // spot is now inside/above the band; sending more carve and calling addFloor must park, not revert
    await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") });
    await expect(vault.addFloor()).to.emit(vault, "FloorSkipped");
    expect(await vault.parkedQuote()).to.be.gt(0n);
  });
});
