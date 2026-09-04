// REGRESSION TEST for H-1 (see AUDITOR-HANDOFF.md). The sell tax was collected with a physical
// `poolManager.take` of native ETH, inside a try/catch that booked nothing and returned a zero delta on failure.
// v4's flash accounting lets anyone borrow the singleton's native balance with no collateral inside their own
// unlock, so a seller could starve the singleton below the fee, run the sell in the same unlock, hit the catch,
// and keep the full output — a permanent waiver, measured 6,946 gas CHEAPER than paying the tax. The fee is now
// minted as an ERC-6909 claim (pure accounting), so no reachable state can make collection fail.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAGS = 0x20ccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));

function mineHookSalt(deployerAddr, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}
const poolIdOf = (k) => ethers.keccak256(
  abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
);

// Hardhat keeps chain state across test FILES, so a suite that moves large balances would otherwise leave
// later files short of ETH. Each describe below snapshots before it deploys and restores when it is done.
describe("H-1 exploit, replayed against the patched hook", () => {
  // Snapshot the whole file's worth of state, not each test's, so balances this file spends are handed back.
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const FEE = 3000, TS = 60, SELL_BPS = 100n, FLOOR_SHARE = 2000n;
  let owner, factory, platform, lp, trader, creator, floor;
  let pm, tok, hook, sw, mod, key, poolId, hookAddr;

  beforeEach(async () => {
    [owner, factory, platform, lp, trader, creator, floor] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"],
      [await pm.getAddress(), factory.address, await reg.getAddress(), await tok.getAddress()])]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);
    hookAddr = addr;

    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: addr };
    poolId = poolIdOf(key);
    await pm.connect(factory).initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address, floorRecipient: floor.address,
      guardAdapter: ZERO, buyTaxBps: 0, sellTaxBps: Number(SELL_BPS), sellFloorShareBps: Number(FLOOR_SHARE),
      buyBufferShareBps: 0, referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
    });

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 25n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 21n, salt: ethers.ZeroHash }, "0x",
      { value: E(5000) }
    );
  });

  const taxed = async () => (await hook.creatorOwed(poolId, 0)) + (await hook.floorOwed(poolId, 0));

  it("the flash-starve no longer waives the tax: the attacker pays exactly what an honest seller pays", async () => {
    const SELL = E(500);
    // Both runs start from IDENTICAL state — a snapshot, not a second sell into an already-moved pool — so the
    // two tax figures are directly comparable and no price impact leaks into the comparison.
    const snap = await takeSnapshot();

    // BASELINE — an honest sell of the same size through the plain router, no attacker present
    await tok.connect(owner).transfer(trader.address, SELL);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -SELL, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    const honestTax = await taxed();
    expect(honestTax).to.be.gt(0n);

    await snap.restore();

    // ATTACK — same sell, same starting state, wrapped in an unlock that first drains the singleton's native
    // balance so any physical take of the fee would revert
    const atk = await (await ethers.getContractFactory("FlashStarveSeller")).deploy(await pm.getAddress());
    const atkAddr = await atk.getAddress();
    await tok.connect(owner).transfer(atkAddr, SELL);
    await owner.sendTransaction({ to: atkAddr, value: E(6000) }); // float to repay the borrow

    await expect(atk.attack(key, SELL)).to.not.emit(hook, "SkimSkipped");
    const attackTax = await taxed();

    // the starve was real: the singleton held nothing when the sell ran, and a physical take of even 1 wei
    // reverted at that moment — which is exactly the old collection path's catch
    expect(await atk.pmBalanceAtSwap()).to.equal(0n);
    expect(await atk.physicalTakeRevertedWhileStarved()).to.equal(true);

    // ...and the tax was still collected, to the wei
    console.log(`   honest sell taxed ${ethers.formatEther(honestTax)} ETH; flash-starved sell taxed ${ethers.formatEther(attackTax)} ETH`);
    expect(attackTax).to.equal(honestTax);
    // and it is the full statutory rate on the attacker's OWN gross output — not a discount. Stated with the
    // contract's own formula (floor(gross * bps / 10000)) rather than a re-derived ratio, which would floor to
    // 99 bps on any gross that isn't a multiple of 100 wei.
    const gross = attackTax + (await atk.ethReceived());
    expect(attackTax).to.equal((gross * SELL_BPS) / 10000n);
  });

  it("the collected sell tax is an ERC-6909 claim, not the hook's raw ETH", async () => {
    await tok.connect(owner).transfer(trader.address, E(500));
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -E(500), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    const owed = await taxed();
    expect(owed).to.be.gt(0n);
    // this is what makes the starve irrelevant: nothing physical moved at swap time
    expect(await pm.balanceOf(hookAddr, 0n)).to.equal(owed);
    expect(await ethers.provider.getBalance(hookAddr)).to.equal(0n);
  });

  it("claims still redeem to real ETH and drain both books to zero", async () => {
    await tok.connect(owner).transfer(trader.address, E(500));
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -E(500), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    const cOwed = await hook.creatorOwed(poolId, 0), fOwed = await hook.floorOwed(poolId, 0);
    const cBefore = await ethers.provider.getBalance(creator.address);
    const fBefore = await ethers.provider.getBalance(floor.address);
    await hook.connect(owner).claimCreator(poolId, 0);
    await hook.connect(owner).claimFloor(poolId, 0);
    expect((await ethers.provider.getBalance(creator.address)) - cBefore).to.equal(cOwed);
    expect((await ethers.provider.getBalance(floor.address)) - fBefore).to.equal(fOwed);
    expect(await pm.balanceOf(hookAddr, 0n)).to.equal(0n);
    expect(await ethers.provider.getBalance(hookAddr)).to.equal(0n);
    // floor gets exactly 20% of the sell tax; dust is conserved into the creator's cut
    expect(fOwed).to.equal(((cOwed + fOwed) * FLOOR_SHARE) / 10000n);
  });
});
