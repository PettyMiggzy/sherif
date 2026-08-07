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
const CFG = (c0, c1, creator, extra = {}) => ({
  currency0: c0, currency1: c1, creator, floorRecipient: ZERO, guardAdapter: ZERO,
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, guardWindow: 0, quoteIsStock: false, ...extra,
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

  it("D2: a blocklisted fee currency SKIPS the skim, swap still completes", async () => {
    const blk = await (await ethers.getContractFactory("BlocklistERC20")).connect(owner).deploy(10n ** 30n);
    const hook = await deployHook(pm, dep, reg, factory, await blk.getAddress());
    const key = await seedPool(hook, blk);
    const poolId = poolIdOf(key);
    await hook.connect(factory).registerPool(poolId, CFG(ZERO, await blk.getAddress(), creator.address));
    await blk.connect(owner).setBlocked(await hook.getAddress(), true); // hook can't receive the token skim

    const tBefore = await blk.balanceOf(trader.address);
    await expect(
      sw.connect(trader).swap(
        key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
      )
    ).to.emit(hook, "SkimSkipped");
    expect(await blk.balanceOf(trader.address)).to.be.gt(tBefore); // buy still filled
    expect(await hook.platformOwed(poolId, 1)).to.equal(0n); // nothing booked
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

    expect(await hook.platformOwed(poolId, 1)).to.be.gt(0n, "buy → platform (token leg)");
    expect(await hook.creatorOwed(poolId, 0)).to.be.gt(0n, "sell → creator (quote leg)");
    expect(await hook.floorOwed(poolId, 0)).to.be.gt(0n, "sell → floor carve (quote leg)");
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
    await hook.connect(platform).setFloorRecipient(id, mallory.address);
    expect((await hook.config(id)).floorRecipient).to.equal(mallory.address);
    await expect(hook.connect(platform).setFloorRecipient(id, creator.address)).to.be.revertedWithCustomError(hook, "FloorRecipientAlreadySet");
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
