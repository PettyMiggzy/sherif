const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinAmbushVault — the mirror of RobinFloorVault: a fee-funded, permanent, single-sided TOKEN sell-wall placed
// just BELOW the graduation price. Verified against a real PoolManager: the allotment deploys as pure currency1
// liquidity in a band under spot, the wall is add-only (no remove selector), it parks token when spot is inside
// the band, and a PUMP (a buy that pushes price down into the wall) is absorbed (the wall sells token) with the
// ETH-side LP fees swept to the floor recipient.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n; // tick 0
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("RobinAmbushVault — permanent single-sided token sell-wall → floor", () => {
  const FEE = 3000, TS = 60;
  let owner, lp, trader, floorSink, pm, stateView, tok, mod, sw, key, poolId, vault;

  before(async () => {
    [owner, lp, trader, floorSink] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);

    // plain pool (no hook) to isolate the ambush mechanics
    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1); // tick 0

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    // modest base liquidity so a buy can push price down into the ambush band
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash }, "0x",
      { value: ethers.parseEther("50") }
    );

    // floorSink stands in for the RobinFloorVault (ETH LP fees are swept there)
    vault = await (await ethers.getContractFactory("RobinAmbushVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), floorSink.address,
      ZERO, await tok.getAddress(), FEE, TS, ZERO, 0 /* anchorTick = graduation tick 0 */, 10 // band = 10 spacings wide
    );
  });

  it("places the band just below spot (pure currency1 region)", async () => {
    expect(await vault.ambushTickUpper()).to.equal(-60n); // first spacing boundary below tick 0
    expect(await vault.ambushTickLower()).to.equal(-660n); // - 10 * 60
  });

  it("exposes NO remove/withdraw selector (add-only wall)", () => {
    const banned = ["remove", "removeambush", "withdraw", "decreaseliquidity", "burn"];
    const names = vault.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const b of banned) expect(names).to.not.include(b);
    expect(names).to.include("addambush");
  });

  it("deploys the allotment as single-sided token liquidity (pulls NO ETH)", async () => {
    await tok.connect(owner).transfer(await vault.getAddress(), 10n ** 21n); // 1,000 token allotment
    await vault.addAmbush();

    const L = await vault.ambushLiquidity();
    expect(L).to.be.gt(0n);
    const [posL] = await stateView.getPositionInfo(poolId, await vault.getAddress(), -660, -60, ethers.ZeroHash);
    expect(posL).to.equal(L);
    // single-sided: the wall used token, required no ETH
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    // nearly all the token went into the wall
    expect(await tok.balanceOf(await vault.getAddress())).to.be.lt(10n ** 18n);
  });

  it("absorbs a pump that pushes price into the wall, sweeping ETH fees to the floor", async () => {
    // a big BUY (zeroForOne: ETH → token) pushes tick DOWN into the ambush band [-660,-60]
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6") }
    );
    // the wall sold token into the pump and earned ETH-side LP fees → swept to the floor sink
    const beforeEth = await ethers.provider.getBalance(floorSink.address);
    await vault.collectFees();
    expect(await ethers.provider.getBalance(floorSink.address)).to.be.gt(beforeEth);
  });

  it("parks the allotment when spot is inside/below the band instead of reverting", async () => {
    // spot is now inside/below the band; sending more token and calling addAmbush must park, not revert
    await tok.connect(owner).transfer(await vault.getAddress(), 10n ** 20n);
    await expect(vault.addAmbush()).to.emit(vault, "AmbushSkipped");
    expect(await vault.parkedToken()).to.be.gt(0n);
  });
});
