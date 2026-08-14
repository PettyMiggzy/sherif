const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 1 — adversarial / edge coverage for the directional fee hook. The cases that bite a money
// contract: an unregistered pool must be inert, a blocklisted fee currency must SKIP the skim (not
// brick the swap), buys route to platform + sells to creator/floor, the stock curb gates in-window,
// and registration rejects bad config.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAGS = 0xccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(dep, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(dep, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}
function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}
const CFG = (c0, c1, creator, extra = {}) => ({
  currency0: c0, currency1: c1, creator, floorRecipient: ZERO, guardAdapter: ZERO,
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 0, quoteIsStock: false, ...extra,
});

async function deployHook(pm, dep, reg, factorySigner, tokenAddr) {
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const initCode = ethers.concat([
    HookF.bytecode,
    abi.encode(["address", "address", "address", "address"], [await pm.getAddress(), factorySigner.address, await reg.getAddress(), tokenAddr]),
  ]);
  const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
  await dep.deploy(salt, initCode);
  return HookF.attach(addr);
}
async function newToken(owner) {
  return (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
}

describe("RobinFeeHook — adversarial", () => {
  let owner, factory, platform, lp, trader, creator, mallory;
  let pm, dep, reg, mod, sw;

  beforeEach(async () => {
    [owner, factory, platform, lp, trader, creator, mallory] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
  });

  async function seedPool(hook, token) {
    const key = { currency0: ZERO, currency1: await token.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
    await pm.initialize(key, SQRT_1_1);
    await token.connect(owner).transfer(lp.address, 10n ** 24n);
    await token.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 20n, salt: ethers.ZeroHash }, "0x",
      { value: ethers.parseEther("2000") }
    );
    return key;
  }

  it("unregistered pool is inert: swap succeeds with no skim", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const key = await seedPool(hook, tok);
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );
    expect(await tok.balanceOf(await hook.getAddress())).to.equal(0n);
  });

  it("D2: a blocklisted money-side currency never bricks the buy; the tax is minted as a claim and the payout is retriable", async () => {
    // The buy tax is fee-on-input on the MONEY SIDE (currency0), collected via poolManager.mint (an ERC-6909
    // CLAIM — pure accounting, no transfer), so even a fully blocklisting stock cannot stop the tax being booked
    // or brick the buy. The block only bites when the claim is REDEEMED (claimPlatform's take), and that reverts
    // cleanly + retriably, restoring the book. (On an ETH pad currency0 is native ETH and can never block.)
    const blk = await (await ethers.getContractFactory("BlocklistERC20")).connect(owner).deploy(10n ** 30n); // money side
    // pad token (currency1) must sort ABOVE the money side (currency0): redeploy until tok > blk.
    let tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    while (BigInt(await tok.getAddress()) <= BigInt(await blk.getAddress())) {
      tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    }
    const blkAddr = await blk.getAddress(), tokAddr = await tok.getAddress();
    const hook = await deployHook(pm, dep, reg, factory, tokAddr); // pad = currency1 = tok

    const key = { currency0: blkAddr, currency1: tokAddr, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
    const poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);
    // seed 2-sided ERC20/ERC20 liquidity (no ETH; both legs settle via transferFrom)
    await blk.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await blk.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 20n, salt: ethers.ZeroHash }, "0x"
    );
    await hook.connect(factory).registerPool(poolId, CFG(blkAddr, tokAddr, creator.address, { quoteIsStock: true }));
    const hookAddr = await hook.getAddress();
    await blk.connect(owner).setBlocked(hookAddr, true); // hook can't RECEIVE the money-side stock (blocks the claim-time take)

    // trader buys: spends BLK (currency0), receives TOK. beforeSwap MINTS the fee claim (no transfer) → buy fills,
    // and the whole buy tax is booked (NOT skipped) even though the stock blocks the hook.
    await blk.connect(owner).transfer(trader.address, 10n ** 22n);
    await blk.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    const tBefore = await tok.balanceOf(trader.address);
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    expect(await tok.balanceOf(trader.address)).to.be.gt(tBefore); // buy filled
    expect(await hook.platformOwed(poolId, 0)).to.be.gt(0n); // tax BOOKED (mint can't be blocked)
    expect(await pm.balanceOf(hookAddr, BigInt(blkAddr))).to.be.gt(0n); // held as an ERC-6909 claim on the stock

    // the redemption (claimPlatform → burn+take real stock to the hook) reverts while the hook is blocked — the
    // book is preserved (retriable), and trading is never bricked.
    await expect(hook.claimPlatform(poolId, 0)).to.be.reverted;
    expect(await hook.platformOwed(poolId, 0)).to.be.gt(0n); // book intact

    // once the block is lifted the claim succeeds and pays the platform wallet in real stock.
    await blk.connect(owner).setBlocked(hookAddr, false);
    const owed = await hook.platformOwed(poolId, 0);
    await hook.claimPlatform(poolId, 0);
    expect(await blk.balanceOf(platform.address)).to.equal(owed);
    expect(await hook.platformOwed(poolId, 0)).to.equal(0n);
  });

  it("buy routes to platform, sell routes to creator + floor", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const key = await seedPool(hook, tok);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(poolId, CFG(ZERO, await tok.getAddress(), creator.address));

    // buy
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );
    // sell
    await tok.connect(owner).transfer(trader.address, 10n ** 22n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 21n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );

    expect(await hook.platformOwed(poolId, 0)).to.be.gt(0n, "buy → platform (money side, ETH)");
    expect(await hook.creatorOwed(poolId, 0)).to.be.gt(0n, "sell → creator (money side, ETH)");
    expect(await hook.floorOwed(poolId, 0)).to.be.gt(0n, "sell → floor carve (money side, ETH)");
  });

  it("stock curb: beforeSwap reverts in-window, passes out-of-window and when adapter reverts", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const adapter = await (await ethers.getContractFactory("MockGuardAdapter")).deploy();
    const key = await seedPool(hook, tok);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(
      poolId, CFG(ZERO, await tok.getAddress(), creator.address, {
        quoteIsStock: true, guardWindow: 3600, guardAdapter: await adapter.getAddress(),
      })
    );

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await adapter.set(now + 100);
    const doSwap = () => sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("0.1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("0.1") }
    );
    await expect(doSwap()).to.be.reverted; // in-window (PoolManager wraps the curb revert)
    await adapter.set(now + 999999);
    await doSwap(); // out-of-window
    await adapter.setRevert(true);
    await doSwap(); // broken adapter → trading continues
  });

  it("registration rejects bad config and double-register", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const t = await tok.getAddress();
    const id = poolIdOf({ currency0: ZERO, currency1: t, fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });

    await expect(hook.connect(mallory).registerPool(id, CFG(ZERO, t, creator.address)))
      .to.be.revertedWithCustomError(hook, "NotFactory");
    await expect(hook.connect(factory).registerPool(id, CFG(ZERO, t, creator.address, { buyTaxBps: 0, sellTaxBps: 0 })))
      .to.be.revertedWithCustomError(hook, "BadTax");
    await expect(hook.connect(factory).registerPool(id, CFG(ZERO, t, creator.address, { buyTaxBps: 400 })))
      .to.be.revertedWithCustomError(hook, "BadTax"); // > MAX_TAX_BPS
    await expect(hook.connect(factory).registerPool(id, CFG(ZERO, t, creator.address, { sellFloorShareBps: 12000 })))
      .to.be.revertedWithCustomError(hook, "BadShares"); // > 10000
    await expect(hook.connect(factory).registerPool(id, CFG(ZERO, t, ZERO)))
      .to.be.revertedWithCustomError(hook, "ZeroAddress");

    await hook.connect(factory).registerPool(id, CFG(ZERO, t, creator.address));
    await expect(hook.connect(factory).registerPool(id, CFG(ZERO, t, creator.address)))
      .to.be.revertedWithCustomError(hook, "AlreadyRegistered");
  });

  it("claimFloor reverts when no floor recipient is set", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const id = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
    await hook.connect(factory).registerPool(id, CFG(ZERO, await tok.getAddress(), creator.address)); // floorRecipient = 0
    await expect(hook.claimFloor(id, 0)).to.be.revertedWithCustomError(hook, "NoFloorRecipient");
  });

  it("setFloorRecipient is platform-only and one-shot", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const id = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
    await hook.connect(factory).registerPool(id, CFG(ZERO, await tok.getAddress(), creator.address)); // floorRecipient = 0
    // platform wallet is `platform` (registry initial wallet)
    await expect(hook.connect(mallory).setFloorRecipient(id, mallory.address)).to.be.revertedWithCustomError(hook, "NotPlatform");
    // [M-4] an EOA recipient is rejected — a floor carve routed to an EOA would be permanently stranded (one-shot).
    await expect(hook.connect(platform).setFloorRecipient(id, mallory.address)).to.be.revertedWithCustomError(hook, "ZeroAddress");
    const floorRecip = await reg.getAddress(); // any contract satisfies the code-length check
    await hook.connect(platform).setFloorRecipient(id, floorRecip);
    expect((await hook.config(id)).floorRecipient).to.equal(floorRecip);
    await expect(hook.connect(platform).setFloorRecipient(id, creator.address)).to.be.revertedWithCustomError(hook, "FloorRecipientAlreadySet");
  });

  it("[M-24] the hook can never be its own floor sink: setter rejects it, and a cfg-seeded self-send reverts PayoutFailed", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const hookAddr = await hook.getAddress();

    // (a) the SETTER rejects the hook's own address — the M-24 entry point (a hook-as-floor pointer would make
    //     claimFloor report success while moving nothing, stranding the carve permanently).
    const id0 = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 500, tickSpacing: 10, hooks: hookAddr });
    await hook.connect(factory).registerPool(id0, CFG(ZERO, await tok.getAddress(), creator.address));
    await expect(hook.connect(platform).setFloorRecipient(id0, hookAddr)).to.be.revertedWithCustomError(hook, "ZeroAddress");

    // (b) the registerPool variant (floorRecipient seeded straight from cfg, NOT via the setter): accrue a real floor
    //     carve via a sell, then claimFloor must revert PayoutFailed (the shared self-send guard in _payout) and LEAVE
    //     the book intact — never zero it while emitting FloorClaimed, which is the exact M-24 silent loss.
    const key = await seedPool(hook, tok);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(poolId, CFG(ZERO, await tok.getAddress(), creator.address, { floorRecipient: hookAddr }));
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );
    await tok.connect(owner).transfer(trader.address, 10n ** 22n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 21n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    const owedBefore = await hook.floorOwed(poolId, 0);
    expect(owedBefore).to.be.gt(0n, "sell accrued a floor carve to the hook-as-floor pool");
    await expect(hook.claimFloor(poolId, 0)).to.be.revertedWithCustomError(hook, "PayoutFailed");
    expect(await hook.floorOwed(poolId, 0)).to.equal(owedBefore); // book NOT zeroed — the revert rolled it back
  });

  it("creator repoint is 2-step and creator-only", async () => {
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await tok.getAddress());
    const id = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
    await hook.connect(factory).registerPool(id, CFG(ZERO, await tok.getAddress(), creator.address));
    await expect(hook.connect(mallory).startCreatorRepoint(id, mallory.address)).to.be.revertedWithCustomError(hook, "NotCreator");
    await hook.connect(creator).startCreatorRepoint(id, mallory.address);
    await expect(hook.connect(creator).acceptCreatorRepoint(id)).to.be.revertedWithCustomError(hook, "NotCreator");
    await hook.connect(mallory).acceptCreatorRepoint(id);
    expect((await hook.config(id)).creator).to.equal(mallory.address);
  });
});
