const { ethers } = require("hardhat");
const { expect } = require("chai");

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1 — the A3 gate, run LOCALLY against a real Uniswap V4 PoolManager
// (same source/compiler as the live 0x8366). Proves the afterSwapReturnDelta skim
// idiom: an exact-input swap closes the unlock with ZERO residual delta (no revert),
// the hook holds exactly the skim, and the 3-way split books correctly. Exact-output
// is skim-free. The fork variant (test/fork) points the same assertions at 0x8366.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n; // price 1:1
const MIN_SQRT_LIMIT = 4295128739n + 1n; // zeroForOne price floor
const FLAGS = 0xc4n;
const MASK = 0x3fffn;
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
    abi.encode(
      ["tuple(address,address,uint24,int24,address)"],
      [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
    )
  );
}

describe("RobinFeeHook — A3 skim closes clean + 3-way split (local real PoolManager)", () => {
  const FEE = 3000; // static lp fee
  const TS = 60;
  const SKIM_BPS = 100n; // 1%
  const PLAT_BPS = 4000n;
  const CREA_BPS = 3000n; // holder = 3000

  let owner, factory, platform, lp, trader, creator;
  let pm, dep, reg, tok, hook, mod, sw, key, poolId, ucIndex;

  before(async () => {
    [owner, factory, platform, lp, trader, creator] = await ethers.getSigners();

    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    // TestERC20 mints the whole supply to the deployer (owner)
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);

    // token must be currency1 (native 0 is currency0). TestERC20 address > 0 always.
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress()]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);
    expect(BigInt(addr) & MASK).to.equal(FLAGS);

    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: addr };
    poolId = poolIdOf(key);
    ucIndex = 1; // zeroForOne output = currency1

    await pm.initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO,
      currency1: await tok.getAddress(),
      creator: creator.address,
      weightSource: ZERO,
      guardAdapter: ZERO,
      feeBps: SKIM_BPS,
      platformShareBps: PLAT_BPS,
      creatorShareBps: CREA_BPS,
      guardWindow: 0,
      quoteIsStock: false,
    });

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    // seed full-range liquidity: give LP tokens, approve, add with generous native (refunded)
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    // full-range L≈1e20 needs ≈100 ETH + ≈100 tokens at price 1:1; send generous value (refunded)
    await mod.connect(lp).modifyLiquidity(
      key,
      { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 20n, salt: ethers.ZeroHash },
      "0x",
      { value: ethers.parseEther("2000") }
    );
  });

  it("exact-input swap: unlock closes clean, hook holds the skim, split is exact", async () => {
    const hookAddr = await hook.getAddress();
    const hookBefore = await tok.balanceOf(hookAddr);
    const traderBefore = await tok.balanceOf(trader.address);

    // exact-input: amountSpecified < 0 (sell 1 ETH for token)
    const amountIn = ethers.parseEther("1");
    await sw.connect(trader).swap(
      key,
      { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
      { value: amountIn }
    );

    const hookAfter = await tok.balanceOf(hookAddr);
    const traderAfter = await tok.balanceOf(trader.address);
    const skim = hookAfter - hookBefore;
    const traderGot = traderAfter - traderBefore;

    // 1) the swap did not revert (implicit) and the hook actually skimmed
    expect(skim).to.be.gt(0n, "hook must have taken a skim");
    // 2) trader received the output minus the skim (both positive)
    expect(traderGot).to.be.gt(0n);
    // 3) fee == 1% of the gross output (traderGot + skim), rounded down
    const grossOut = traderGot + skim;
    expect(skim).to.equal((grossOut * SKIM_BPS) / 10000n);

    // 4) 3-way split books exactly, dust conserved into holder bucket
    const plat = await hook.platformOwed(poolId, ucIndex);
    const crea = await hook.creatorOwed(poolId, ucIndex);
    const parked = await hook.unallocated(poolId, ucIndex); // holder cut parks (no weight yet)
    expect(plat).to.equal((skim * PLAT_BPS) / 10000n);
    expect(crea).to.equal((skim * CREA_BPS) / 10000n);
    expect(plat + crea + parked).to.equal(skim);
  });

  it("exact-output swap is skim-free", async () => {
    const hookAddr = await hook.getAddress();
    const hookBefore = await tok.balanceOf(hookAddr);

    // exact-output: amountSpecified > 0 (buy exactly 0.1 token, paying ETH)
    await sw.connect(trader).swap(
      key,
      { zeroForOne: true, amountSpecified: ethers.parseEther("0.1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
      { value: ethers.parseEther("2") }
    );

    expect(await tok.balanceOf(hookAddr)).to.equal(hookBefore, "exact-output must not skim");
  });

  it("platform claim pulls to the timelocked registry wallet", async () => {
    const owed = await hook.platformOwed(poolId, ucIndex);
    expect(owed).to.be.gt(0n);
    const before = await tok.balanceOf(platform.address);
    await hook.claimPlatform(poolId, ucIndex);
    expect(await tok.balanceOf(platform.address)).to.equal(before + owed);
    expect(await hook.platformOwed(poolId, ucIndex)).to.equal(0n);
  });

  it("creator claim pulls to the creator slot", async () => {
    const owed = await hook.creatorOwed(poolId, ucIndex);
    expect(owed).to.be.gt(0n);
    const before = await tok.balanceOf(creator.address);
    await hook.claimCreator(poolId, ucIndex);
    expect(await tok.balanceOf(creator.address)).to.equal(before + owed);
  });
});
