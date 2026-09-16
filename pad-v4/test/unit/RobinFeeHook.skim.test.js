const { ethers } = require("hardhat");
const { expect } = require("chai");

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1 — the directional trade-tax + the A3 gate, run against a real Uniswap V4
// PoolManager (same source/compiler as live 0x8366). Proves the delta idioms
// (beforeSwap fee-on-INPUT for buys, afterSwapReturnDelta for sells — both close the
// unlock with zero residual delta) AND the ETH-native money model:
//   BUY  (beforeSwap) → buyTax of the MONEY-SIDE INPUT (currency0: ETH) → platform + buffer
//   SELL (afterSwap)  → sellTax of the MONEY-SIDE OUTPUT (currency0: ETH) → creator + floor
// Both taxes are denominated in the money side (currency0), never the coin. Exact-output is rejected.
// [SIMPLE-FEES] the buy-tax remainder now goes to the CREATOR (was platform), and the sell-tax carve now
// joins the SAME buffer pot the buy-tax carve feeds (was a separate floor pot) — see RobinFeeHook.sol.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAGS = 0x28ccn, MASK = 0x3fffn;
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

describe("RobinFeeHook — directional tax (ETH-native) closes clean (local real PoolManager)", () => {
  const FEE = 3000, TS = 60;
  const BUY_BPS = 100n; // 1% buy tax (money side) → platform + curve buffer
  const SELL_BPS = 100n; // 1% sell tax (money side) → creator + floor
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
    await pm.connect(factory).initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address,
      floorRecipient: floor.address, guardAdapter: ZERO,
      buyTaxBps: BUY_BPS, sellTaxBps: SELL_BPS, sellFloorShareBps: FLOOR_SHARE_BPS, buyBufferShareBps: BUFFER_SHARE_BPS, referralShareBps: 0,
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
    // [SIMPLE-FEES] bufferRecipient is normally wired by the factory at launch (setBufferRecipient); registerPool
    // always seeds it to address(0). Reusing the `floor` signer as the stand-in trader-rebate-pot recipient here
    // (its original floorRecipient role is retired — floorOwed no longer accrues via normal swap flow).
    await hook.connect(factory).setBufferRecipient(poolId, floor.address);
  });

  it("BUY: fee-on-input closes clean; buy tax of the MONEY-SIDE (ETH) input held as an ERC-6909 claim → creator + buffer [SIMPLE-FEES]", async () => {
    const hookAddr = await hook.getAddress();
    const hookEthBefore = await ethers.provider.getBalance(hookAddr);
    const claimBefore = await pm.balanceOf(hookAddr, 0n); // ERC-6909 native-ETH claim (id 0)
    const spend = ethers.parseEther("1");

    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -spend, sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: spend }
    );

    // the buy fee is minted as an ERC-6909 claim (NOT a physical take — no reserve fronting): the hook's raw ETH
    // is unchanged; its claim balance grew by EXACTLY 1% of the ETH the buyer spent. 99% went to the pool to swap.
    expect((await ethers.provider.getBalance(hookAddr)) - hookEthBefore).to.equal(0n);
    const skim = (await pm.balanceOf(hookAddr, 0n)) - claimBefore;
    expect(skim).to.equal((spend * BUY_BPS) / 10000n); // 0.01 ETH, exact
    // [SIMPLE-FEES] buy tax (money side, index 0) splits: 20% → curve buffer (trader-rebate pot), the rest →
    // CREATOR (was platform). floor untouched (retired).
    const bufferCut = (skim * BUFFER_SHARE_BPS) / 10000n;
    const creatorCut = skim - bufferCut; // contract conserves dust into the creator cut
    expect(await hook.creatorOwed(poolId, 0)).to.equal(creatorCut);
    expect(await hook.bufferOwed(poolId)).to.equal(bufferCut);
    expect(await hook.platformOwed(poolId, 0)).to.equal(0n);
    expect(await hook.floorOwed(poolId, 0)).to.equal(0n);
  });

  it("SELL: money-side (ETH) output tax splits creator (80%) + the shared trader-rebate buffer (20%) [SIMPLE-FEES]", async () => {
    await tok.connect(owner).transfer(trader.address, 10n ** 22n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    const hookEthBefore = await ethers.provider.getBalance(await hook.getAddress());
    const hookClaimBefore = await pm.balanceOf(await hook.getAddress(), 0n); // ERC-6909 ETH claim
    const creatorBefore = await hook.creatorOwed(poolId, 0);
    const bufferBefore = await hook.bufferOwed(poolId); // buy already ran, so this is nonzero going in

    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -(10n ** 21n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );

    const creatorCut = (await hook.creatorOwed(poolId, 0)) - creatorBefore; // money side (native)
    const rebateCut = (await hook.bufferOwed(poolId)) - bufferBefore;
    const totalSell = creatorCut + rebateCut;
    expect(totalSell).to.be.gt(0n);
    // [SIMPLE-FEES] the trader-rebate pot gets 20% of the sell tax (was floor), creator the remaining 80%
    expect(rebateCut).to.equal((totalSell * FLOOR_SHARE_BPS) / 10000n);
    expect(await hook.floorOwed(poolId, 0)).to.equal(0n); // retired — nothing ever lands here now
    // [H-1] the SELL fee is minted as an ERC-6909 claim, exactly like the BUY fee — never taken as real ETH at
    // swap time. So the hook's CLAIM grows by exactly the sell fee and its raw ETH balance does not move. Taking
    // real ETH here is what let a seller starve the singleton inside their own unlock and waive the tax outright.
    expect((await pm.balanceOf(await hook.getAddress(), 0n)) - hookClaimBefore).to.equal(totalSell);
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(hookEthBefore);
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

  it("claims: creator→creator (ETH), buffer→bufferRecipient (ETH) [SIMPLE-FEES]", async () => {
    // creator (money/native leg) — [SIMPLE-FEES] this is now where the buy-tax remainder lands too, no platform claim to test here
    const cOwed = await hook.creatorOwed(poolId, 0);
    const cBefore = await ethers.provider.getBalance(creator.address);
    await hook.connect(owner).claimCreator(poolId, 0); // permissionless; funds go to creator slot
    expect((await ethers.provider.getBalance(creator.address)) - cBefore).to.equal(cOwed);

    // buffer (money/native leg) → bufferRecipient — [SIMPLE-FEES] the shared trader-rebate pot both buy and
    // sell feed; floorOwed stays 0 (retired, see the BUY/SELL tests above), nothing to claim there anymore.
    const bOwed = await hook.bufferOwed(poolId);
    const bBefore = await ethers.provider.getBalance(floor.address);
    await hook.connect(owner).claimBuffer(poolId);
    expect((await ethers.provider.getBalance(floor.address)) - bBefore).to.equal(bOwed);
    expect(await hook.floorOwed(poolId, 0)).to.equal(0n);
    await expect(hook.connect(owner).claimFloor(poolId, 0)).to.be.revertedWithCustomError(hook, "NothingToClaim");
  });
});
