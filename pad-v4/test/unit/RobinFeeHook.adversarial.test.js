const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 1 — adversarial / edge coverage for the fee hook. These are the cases that actually bite a
// money contract: an unregistered pool must be inert, a blocklisted stock fee currency must SKIP the
// skim (not brick the swap), fees must accrue on BOTH legs, the stock curb must gate trading in-window,
// registration must reject bad config, and onWeightChange must be weight-source-only.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n; // oneForZero ceiling
const FLAGS = 0xc4n, MASK = 0x3fffn;
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
const DEFAULT_CFG = (c0, c1, creator, extra = {}) => ({
  currency0: c0, currency1: c1, creator, weightSource: ZERO, guardAdapter: ZERO,
  feeBps: 100, platformShareBps: 4000, creatorShareBps: 3000, guardWindow: 0, quoteIsStock: false, ...extra,
});

async function deployHook(pm, dep, reg, factorySigner) {
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const initCode = ethers.concat([
    HookF.bytecode,
    abi.encode(["address", "address", "address"], [await pm.getAddress(), factorySigner.address, await reg.getAddress()]),
  ]);
  const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
  await dep.deploy(salt, initCode);
  return HookF.attach(addr);
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
    const hook = await deployHook(pm, dep, reg, factory);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const key = await seedPool(hook, tok);
    // NO registerPool. A swap must still work and skim nothing.
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );
    expect(await tok.balanceOf(await hook.getAddress())).to.equal(0n);
  });

  it("D2: a blocklisted fee currency SKIPS the skim, swap still completes", async () => {
    const hook = await deployHook(pm, dep, reg, factory);
    const blk = await (await ethers.getContractFactory("BlocklistERC20")).connect(owner).deploy(10n ** 30n);
    const key = await seedPool(hook, blk);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(poolId, DEFAULT_CFG(ZERO, await blk.getAddress(), creator.address));
    // block the hook so PoolManager.take(BLK, hook, fee) reverts
    await blk.connect(owner).setBlocked(await hook.getAddress(), true);

    const tBefore = await blk.balanceOf(trader.address);
    await expect(
      sw.connect(trader).swap(
        key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
      )
    ).to.emit(hook, "SkimSkipped");
    // trader still received output; hook skimmed nothing; nothing booked
    expect(await blk.balanceOf(trader.address)).to.be.gt(tBefore);
    expect(await blk.balanceOf(await hook.getAddress())).to.equal(0n);
    expect(await hook.platformOwed(poolId, 1)).to.equal(0n);
  });

  it("fees accrue on BOTH legs (buy → currency1, sell → native currency0 via receive)", async () => {
    const hook = await deployHook(pm, dep, reg, factory);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const key = await seedPool(hook, tok);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(poolId, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address));

    // buy: zeroForOne, output currency1 (token) → fee in leg 1
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );
    // sell: oneForZero, output currency0 (native ETH) → fee in leg 0, taken to hook via receive()
    await tok.connect(owner).transfer(trader.address, 10n ** 22n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 21n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );

    expect(await hook.platformOwed(poolId, 1)).to.be.gt(0n, "token leg booked");
    expect(await hook.platformOwed(poolId, 0)).to.be.gt(0n, "native leg booked");
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.be.gt(0n, "hook holds native fees");
  });

  it("stock curb: beforeSwap reverts in-window, passes out-of-window and when adapter reverts", async () => {
    const hook = await deployHook(pm, dep, reg, factory);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const adapter = await (await ethers.getContractFactory("MockGuardAdapter")).deploy();
    const key = await seedPool(hook, tok);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(
      poolId,
      DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address, {
        quoteIsStock: true, guardWindow: 3600, guardAdapter: await adapter.getAddress(),
      })
    );

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await adapter.set(now + 100); // scheduled action within the 1h window → curb
    const doSwap = () => sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("0.1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("0.1") }
    );
    // PoolManager wraps the hook's revert, so we can't match the CorporateActionCurb selector by name;
    // the out-of-window pass below (same swap, only the adapter time changed) proves the curb is the cause.
    await expect(doSwap()).to.be.reverted;

    await adapter.set(now + 999999); // far outside the window → allowed
    await doSwap();

    await adapter.setRevert(true); // broken adapter → treated as no action, trading continues
    await doSwap();
  });

  it("registration rejects bad config and double-register", async () => {
    const hook = await deployHook(pm, dep, reg, factory);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const id = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });

    await expect(hook.connect(mallory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address)))
      .to.be.revertedWithCustomError(hook, "NotFactory");
    await expect(hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address, { feeBps: 0 })))
      .to.be.revertedWithCustomError(hook, "BadFee");
    await expect(hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address, { feeBps: 400 })))
      .to.be.revertedWithCustomError(hook, "BadFee"); // > MAX_FEE_BPS (300)
    await expect(hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address, { platformShareBps: 7000, creatorShareBps: 4000 })))
      .to.be.revertedWithCustomError(hook, "BadShares"); // sum > 10000
    await expect(hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), ZERO)))
      .to.be.revertedWithCustomError(hook, "ZeroAddress");

    await hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address));
    await expect(hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address)))
      .to.be.revertedWithCustomError(hook, "AlreadyRegistered");
  });

  it("onWeightChange rejects callers that are not the pool's weight source", async () => {
    const hook = await deployHook(pm, dep, reg, factory);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const id = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
    await hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address)); // weightSource = 0
    await expect(hook.connect(mallory).onWeightChange(id, mallory.address, 100)).to.be.revertedWithCustomError(hook, "NotWeightSource");
  });

  it("creator repoint is 2-step and creator-only", async () => {
    const hook = await deployHook(pm, dep, reg, factory);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const id = poolIdOf({ currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() });
    await hook.connect(factory).registerPool(id, DEFAULT_CFG(ZERO, await tok.getAddress(), creator.address));
    await expect(hook.connect(mallory).startCreatorRepoint(id, mallory.address)).to.be.revertedWithCustomError(hook, "NotCreator");
    await hook.connect(creator).startCreatorRepoint(id, mallory.address);
    await expect(hook.connect(creator).acceptCreatorRepoint(id)).to.be.revertedWithCustomError(hook, "NotCreator");
    await hook.connect(mallory).acceptCreatorRepoint(id);
    expect((await hook.config(id)).creator).to.equal(mallory.address);
  });
});
