const { ethers } = require("hardhat");
const { expect } = require("chai");

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1 — the directional trade-tax + the A3 gate, run against a real Uniswap V4
// PoolManager (same source/compiler as live 0x8366). Proves the afterSwapReturnDelta
// idiom (exact-input skim closes the unlock with zero residual delta) AND the money model:
//   BUY  → buyTax of the token output  → platform
//   SELL → sellTax of the quote output → creator + floor carve
// Exact-output is skim-free.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAGS = 0xc4n, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(deployerAddr, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}
function poolIdOf(key) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])
  );
}

describe("RobinFeeHook — directional tax + A3 skim closes clean (local real PoolManager)", () => {
  const FEE = 3000, TS = 60;
  const BUY_BPS = 100n; // 1% buy tax → platform + curve buffer
  const SELL_BPS = 100n; // 1% sell tax → creator + floor
  const FLOOR_SHARE_BPS = 2000n; // 20% of the sell tax → floor (0.2% of trade); creator keeps 80%
  const BUFFER_SHARE_BPS = 2000n; // 20% of the buy tax → curve buffer; platform keeps 80%

  let owner, factory, platform, lp, trader, creator, floor;
  let pm, dep, reg, tok, hook, mod, sw, key, poolId;

  before(async () => {
    [owner, factory, platform, lp, trader, creator, floor] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);

    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress(), await tok.getAddress()]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);

    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: addr };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address,
      floorRecipient: floor.address, guardAdapter: ZERO,
      buyTaxBps: BUY_BPS, sellTaxBps: SELL_BPS, sellFloorShareBps: FLOOR_SHARE_BPS, buyBufferShareBps: BUFFER_SHARE_BPS,
      guardWindow: 0, quoteIsStock: false,
    });

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 20n, salt: ethers.ZeroHash }, "0x",
      { value: ethers.parseEther("2000") }
    );
  });

  it("BUY: exact-input closes clean, buy tax of the token output → platform + curve buffer", async () => {
    const hookAddr = await hook.getAddress();
    const hookBefore = await tok.balanceOf(hookAddr);
    const traderBefore = await tok.balanceOf(trader.address);

    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );

    const skim = (await tok.balanceOf(hookAddr)) - hookBefore;
    const traderGot = (await tok.balanceOf(trader.address)) - traderBefore;
    expect(skim).to.be.gt(0n);
    expect(skim).to.equal(((traderGot + skim) * BUY_BPS) / 10000n); // 1% of gross token output
    // buy tax (token leg, index 1) splits: 20% → curve buffer, the rest → platform. creator/floor untouched.
    const bufferCut = (skim * BUFFER_SHARE_BPS) / 10000n;
    const platformCut = skim - bufferCut; // contract conserves dust into the platform cut
    expect(await hook.platformOwed(poolId, 1)).to.equal(platformCut);
    expect(await hook.bufferOwed(poolId)).to.equal(bufferCut);
    expect(await hook.creatorOwed(poolId, 0)).to.equal(0n);
    expect(await hook.floorOwed(poolId, 0)).to.equal(0n);
  });

  it("SELL: quote output tax splits creator (80%) + floor (20%)", async () => {
    await tok.connect(owner).transfer(trader.address, 10n ** 22n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    const hookEthBefore = await ethers.provider.getBalance(await hook.getAddress());

    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 21n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );

    const creatorCut = await hook.creatorOwed(poolId, 0); // quote leg (native)
    const floorCut = await hook.floorOwed(poolId, 0);
    const totalSell = creatorCut + floorCut;
    expect(totalSell).to.be.gt(0n);
    // floor gets 20% of the sell tax, creator the remaining 80% (dust conserved into creator)
    expect(floorCut).to.equal((totalSell * FLOOR_SHARE_BPS) / 10000n);
    // hook holds the native fees it took
    expect((await ethers.provider.getBalance(await hook.getAddress())) - hookEthBefore).to.equal(totalSell);
  });

  it("[audit H1] exact-output swaps are REJECTED so the tax can't be bypassed", async () => {
    // exact-output (amountSpecified > 0) would skip the skim → beforeSwap reverts on registered pads.
    await expect(
      sw.connect(trader).swap(
        key, { zeroForOne: true, amountSpecified: ethers.parseEther("0.1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("2") }
      )
    ).to.be.reverted; // ExactOutputNotSupported (wrapped by PoolManager)
  });

  it("claims: platform→registry (token), creator→creator (quote), floor→floorRecipient (quote)", async () => {
    // platform (token leg)
    const pOwed = await hook.platformOwed(poolId, 1);
    const pBefore = await tok.balanceOf(platform.address);
    await hook.claimPlatform(poolId, 1);
    expect((await tok.balanceOf(platform.address)) - pBefore).to.equal(pOwed);

    // creator (quote/native leg)
    const cOwed = await hook.creatorOwed(poolId, 0);
    const cBefore = await ethers.provider.getBalance(creator.address);
    await hook.connect(owner).claimCreator(poolId, 0); // permissionless; funds go to creator slot
    expect((await ethers.provider.getBalance(creator.address)) - cBefore).to.equal(cOwed);

    // floor (quote/native leg) → floorRecipient
    const fOwed = await hook.floorOwed(poolId, 0);
    const fBefore = await ethers.provider.getBalance(floor.address);
    await hook.connect(owner).claimFloor(poolId, 0);
    expect((await ethers.provider.getBalance(floor.address)) - fBefore).to.equal(fOwed);
  });
});
