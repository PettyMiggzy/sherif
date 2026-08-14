// REGRESSION TEST for H-3 and M-17 (see AUDITOR-HANDOFF.md). Solidity's try/catch catches reverts but NOT a
// failure to decode the return data: the decode runs in the CALLER's frame after the call has already
// succeeded, outside the protected region. So a callee returning fewer than 32 bytes reverts straight through
// a `try ... catch`, uncatchably — falsifying every "never reverts" promise built on one.
//   H-3  RobinFeeHook._scheduledEffectiveAt — on the curb path of every swap of a stock pad, reading an address
//        written once at registerPool with NO setter: a bad adapter bricked the pad forever.
//   M-17 DualStaking.boostOf — reached from _reweigh on every stake/unstake/sync: a bad oracle froze principal.
//   Plus the six reads inside StockQuoteAdapter, all of which read the launcher-chosen stock or its registry.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0xccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const TOKEN = 0;

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
const shortReturner = async () => (await ethers.getContractFactory("ShortReturner")).deploy();

// NON-VACUITY. Everything below asserts that a read no longer reverts, which is only meaningful if the target
// really is the shape that used to make it revert. This pins that: the exact try/catch pattern the fixed
// contracts used to rely on, pointed at the same mock, still reverts today — the catch never fires because the
// call SUCCEEDS and the failure happens afterwards, in the caller's decoder.
describe("the defect itself: try/catch does not absorb a short return", () => {
  it("a try/catch read of a zero-byte returner reverts anyway", async () => {
    const bad = await shortReturner();
    const probe = await (await ethers.getContractFactory("TryCatchDecoder")).deploy();
    await expect(probe.readViaTryCatch(await bad.getAddress())).to.be.reverted;
    // and it is specifically the SHORT return, not a revert: a full 32-byte word decodes fine
    const full = await (await ethers.getContractFactory("DirtyBoolReturner")).deploy();
    expect(await probe.readViaTryCatch(await full.getAddress())).to.equal(2n ** 256n - 1n);
  });
});

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("M-17 — a short-returning boost oracle no longer freezes DualStaking principal", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  let owner, alice, tok, ds, bad;

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    tok = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), ZERO, owner.address, 0, ZERO, ethers.ZeroHash, TOKEN
    );
    await tok.transfer(alice.address, E(1000));
    await tok.connect(alice).approve(await ds.getAddress(), ethers.MaxUint256);
    bad = await shortReturner();
  });

  it("boostOf answers 1x instead of reverting", async () => {
    await ds.setBoostOracle(await bad.getAddress());
    expect(await ds.boostOf(TOKEN, alice.address)).to.equal(10000n); // BPS, the documented fallback
  });

  it("stake / unstake / claim all still work — principal is not frozen", async () => {
    await ds.connect(alice).stake(TOKEN, E(100)); // stake BEFORE the bad oracle, as an operator mistake would
    await ds.setBoostOracle(await bad.getAddress());
    await ds.connect(alice).stake(TOKEN, E(100));
    await ds.connect(alice).unstake(TOKEN, E(150)); // this is the one that used to trap the principal
    await ds.connect(alice).sync(TOKEN, alice.address);
    expect(await ds.staked(TOKEN, alice.address)).to.equal(E(50));
    expect(await ds.weight(TOKEN, alice.address)).to.equal(E(50)); // 1x, unboosted
  });

  it("a full-word but out-of-range boost is still clamped, not trusted", async () => {
    const dirty = await (await ethers.getContractFactory("DirtyBoolReturner")).deploy(); // returns 2^256-1
    await ds.setBoostOracle(await dirty.getAddress());
    expect(await ds.boostOf(TOKEN, alice.address)).to.equal(40000n); // MAX_BOOST_BPS, not the raw word
  });

  it("setBoostOracle rejects an address with no code (the commonest way in)", async () => {
    await expect(ds.setBoostOracle(alice.address)).to.be.revertedWithCustomError(ds, "BadParam");
    await ds.setBoostOracle(ZERO); // but 0 stays legal — it means "no boost"
    expect(await ds.boostOf(TOKEN, alice.address)).to.equal(10000n);
  });
});

describe("H-3 — a short-returning guardAdapter no longer bricks every swap of a stock pad", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const FEE = 3000, TS = 60;
  let owner, factory, platform, lp, trader, creator, floor;
  let pm, tok, hook, sw, mod, key, poolId;

  before(async () => {
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

    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: addr };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);

    // the pad is registered with a guard adapter that succeeds and returns nothing. guardAdapter is written
    // ONCE here and there is no setter anywhere in the hook — this configuration is permanent.
    const bad = await shortReturner();
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address, floorRecipient: floor.address,
      guardAdapter: await bad.getAddress(), buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
      buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 3600, quoteIsStock: true,
    });

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 25n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 21n, salt: ethers.ZeroHash }, "0x",
      { value: E(1000) }
    );
    await tok.connect(owner).transfer(trader.address, E(10000));
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
  });

  it("BUYS still execute, and are still taxed", async () => {
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(1), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(1) }
    );
    expect(await hook.platformOwed(poolId, 0)).to.be.gt(0n);
  });

  it("SELLS still execute, and are still taxed", async () => {
    await sw.connect(trader).swap(
      key, { zeroForOne: false, amountSpecified: -E(100), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    expect(await hook.creatorOwed(poolId, 0)).to.be.gt(0n);
  });

  it("the curb still fires for an adapter that DOES answer — the read is best-effort, not disabled", async () => {
    // a real adapter reporting a corporate action inside the guard window must still halt trading
    const stockReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    const stock = await (await ethers.getContractFactory("MockStock")).deploy(await stockReg.getAddress(), 10n ** 27n);
    await stockReg.setRegistered(await stock.getAddress(), true); // [H-2] the registry attests the stock
    const adapter = await (await ethers.getContractFactory("StockQuoteAdapter")).deploy(
      await stock.getAddress(), await stockReg.getAddress()
    );
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await stock.scheduleMultiplier(2n * 10n ** 18n, now + 60); // inside a 3600s guard window
    expect(await adapter.scheduledEffectiveAt()).to.equal(BigInt(now + 60));

    const key2 = { ...key, fee: 500 };
    const id2 = poolIdOf(key2);
    await pm.initialize(key2, SQRT_1_1);
    await hook.connect(factory).registerPool(id2, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address, floorRecipient: floor.address,
      guardAdapter: await adapter.getAddress(), buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
      buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 3600, quoteIsStock: true,
    });
    await mod.connect(lp).modifyLiquidity(
      key2, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 21n, salt: ethers.ZeroHash }, "0x",
      { value: E(1000) }
    );
    await expect(sw.connect(trader).swap(
      key2, { zeroForOne: true, amountSpecified: -E(1), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(1) }
    )).to.be.reverted; // CorporateActionCurb
  });
});

describe("H-3 — StockQuoteAdapter's never-reverting reads hold against a short-returning stock", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  let adapter, alice;

  before(async () => {
    [, alice] = await ethers.getSigners();
    // [H-2] the registry must ATTEST the stock at ctor time (a short-returning registry is now correctly rejected —
    // see the H-2 gate test); the STOCK is the hostile short-returning target whose RUNTIME reads must not brick.
    const badReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    const badStock = await (await ethers.getContractFactory("ShortReturningStock")).deploy(await badReg.getAddress());
    await badReg.setRegistered(await badStock.getAddress(), true);
    adapter = await (await ethers.getContractFactory("StockQuoteAdapter")).deploy(
      await badStock.getAddress(), await badReg.getAddress()
    );
  });

  it("every read answers its documented fallback instead of reverting", async () => {
    expect(await adapter.scheduledEffectiveAt()).to.equal(0n); // unreadable → never curb
    expect(await adapter.displayScalar()).to.equal(10n ** 18n); // WAD
    expect(await adapter.marketDataStale()).to.equal(false);
    expect(await adapter.tradeable([alice.address])).to.equal(false); // unreadable pause → not tradeable
  });

  it("a dirty (non-0/1) bool word is read without reverting", async () => {
    // abi.decode(_, (bool)) reverts on any word that isn't exactly 0 or 1; the flag reader decodes it as a word
    const dirtyReg = await (await ethers.getContractFactory("DirtyBoolReturner")).deploy();
    const dirtyStock = await (await ethers.getContractFactory("ShortReturningStock")).deploy(await dirtyReg.getAddress());
    const a2 = await (await ethers.getContractFactory("StockQuoteAdapter")).deploy(
      await dirtyStock.getAddress(), await dirtyReg.getAddress()
    );
    expect(await a2.marketDataStale()).to.equal(false); // stock short-returns → documented false
    expect(await a2.tradeable([alice.address])).to.equal(false); // registry says "paused" (dirty word ≠ 0)
    expect(await a2.displayScalar()).to.equal(10n ** 18n);
  });
});
