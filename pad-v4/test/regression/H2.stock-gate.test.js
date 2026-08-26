// REGRESSION TEST for H-2 (see AUDITOR-HANDOFF.md). StockPadFactory's stated securities gate rested on
// StockQuoteAdapter's constructor check — but that constructor takes `expectedRegistry` as an ARGUMENT, so it
// proves only that the stock and the registry agree with each other, not that the registry is the platform's.
// The factory had no registry immutable and no adapter allow-list, so anyone could deploy MockStockRegistry →
// MockStock(thatRegistry) → StockQuoteAdapter(both) and launch a pad carrying quoteIsStock == true that was
// on-chain indistinguishable from a genuine one. Worse, the adapter itself was launcher-supplied and sits on
// the curb path of every swap, above the direction check and above the sender == address(this) exemption — so
// the launcher shipped a pad it could freeze at will. try/catch defends only against an adapter that REVERTS;
// one that simply lies passes cleanly. The registry is now pinned on the factory and the adapter is DERIVED.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { brandedTokenSalt, tokenInitCode, predictPadToken } = require("../helpers/brand");

const FLAGS = 0xccn, MASK = 0x3fffn;
const SQRT_1_1 = 79228162514264337593543950336n;
const E = (x) => ethers.parseEther(String(x));

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("H-2 — a stock pad can no longer be launched against a self-certified registry", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const TS = 60, FEE = 3000;
  let owner, platform, attacker, creator, sink;
  let pm, permit2, posm, lockVault, dep, reg, realReg, realStock, factory;

  before(async () => {
    [owner, platform, attacker, creator, sink] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();

    // the PLATFORM's registry and a stock it actually governs
    realReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    realStock = await (await ethers.getContractFactory("MockStock")).deploy(await realReg.getAddress(), 10n ** 27n);
    await realReg.setRegistered(await realStock.getAddress(), true); // [H-2] the registry ATTESTS the real stock

    const fhd = await (await ethers.getContractFactory("FeeHookDeployer")).deploy(await dep.getAddress());
    factory = await (await ethers.getContractFactory("StockPadFactory")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(),
      await dep.getAddress(), await reg.getAddress(), await lockVault.getAddress(), await realReg.getAddress(),
      await fhd.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
  });

  const cfgFor = (stockAddr, over = {}) => ({
    name: "Pad", symbol: "PAD", decimals: 18, supply: E(1000000),
    lpTokenAmount: E(100), stockSeed: E(1000), sqrtPriceX96: SQRT_1_1, tickSpacing: TS, fee: FEE,
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, guardWindow: 3600,
    stock: stockAddr, creator: creator.address, floorRecipient: sink.address, stakingRecipient: sink.address,
    ...over,
  });

  async function mineSalts(cfg) {
    const depAddr = await dep.getAddress();
    const facAddr = await factory.getAddress();
    const PadToken = await ethers.getContractFactory("PadToken");
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const abi = ethers.AbiCoder.defaultAbiCoder();
    // [brand] PadBrand.requireBrand now rejects any launch whose token address does not end in `1ab5`, so the
    // salt must be MINED — and for a stock pad it must still sort ABOVE the stock (currency0 = stock ordering).
    // Mined here, from the very cfg that is about to be launched, so the two can never drift apart.
    const tokenSalt = await brandedTokenSalt(
      depAddr, facAddr, cfg,
      ethers.id(`h2-${cfg.stock}-${cfg.name}`), // per-pad seed: distinct pads get distinct addresses
      (a) => BigInt(a) > BigInt(cfg.stock)
    );
    // The factory deploys at keccak256(abi.encode(cfg, tokenSalt)), NOT at tokenSalt — predicting from the raw
    // salt named an address the factory never reaches, so the hook init-code below embedded the wrong token and
    // the mined hook salt was valid for nothing. `predictPadToken` is the one place that fold lives.
    const tokenAddr = predictPadToken(depAddr, facAddr, cfg, tokenSalt, PadToken.bytecode, factory);
    let hookSalt;
    const hookInit = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"],
      [await pm.getAddress(), await factory.getAddress(), await reg.getAddress(), tokenAddr])]);
    const hookHash = ethers.keccak256(hookInit);
    for (let i = 0n; ; i++) {
      const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(depAddr, salt, hookHash);
      if ((BigInt(a) & MASK) === FLAGS) { hookSalt = salt; break; }
    }
    return { tokenSalt, hookSalt };
  }

  it("the PROVEN rug: an attacker's own registry + stock is rejected", async () => {
    // exactly the construction the finding proved: attacker deploys the whole chain from their own account
    const fakeReg = await (await ethers.getContractFactory("MockStockRegistry")).connect(attacker).deploy();
    const fakeStock = await (await ethers.getContractFactory("MockStock")).connect(attacker).deploy(await fakeReg.getAddress(), 10n ** 27n);
    await fakeReg.connect(attacker).setRegistered(await fakeStock.getAddress(), true); // attacker makes their OWN registry attest
    // the adapter still deploys standalone — it only ever proved stock and registry agree with EACH OTHER
    const selfCertified = await (await ethers.getContractFactory("StockQuoteAdapter")).connect(attacker)
      .deploy(await fakeStock.getAddress(), await fakeReg.getAddress());
    expect(await selfCertified.registry()).to.equal(await fakeReg.getAddress()); // the attacker's own

    // ...but the factory now pins the platform's registry, so the launch cannot happen
    const cfg = cfgFor(await fakeStock.getAddress());
    const { tokenSalt, hookSalt } = await mineSalts(cfg);
    await fakeStock.connect(attacker).approve(await factory.getAddress(), ethers.MaxUint256);
    await expect(factory.connect(attacker).launch(cfg, tokenSalt, hookSalt)).to.be.reverted;
    expect(await factory.launchCount()).to.equal(0n);
  });

  it("[H-2 residual] a fake stock pointing at the REAL registry is rejected unless the registry ATTESTS it", async () => {
    // the variant the original test missed: the attacker's fake stock returns the PLATFORM's real registry from
    // ACCESS_CONTROLLED_REGISTRY(), so `reg == expectedRegistry` passes — but the real registry has not registered it.
    const fakeStock = await (await ethers.getContractFactory("MockStock")).connect(attacker)
      .deploy(await realReg.getAddress(), 10n ** 27n); // points at the REAL registry
    // the adapter ctor now requires the real registry to attest the stock — a fake, unattested one is rejected.
    const AdapterF = await ethers.getContractFactory("StockQuoteAdapter");
    await expect(AdapterF.connect(attacker).deploy(await fakeStock.getAddress(), await realReg.getAddress()))
      .to.be.revertedWithCustomError(AdapterF, "NotRegistered");
    // once the real registry actually governs it (an off-chain/legal decision the attacker cannot make), it passes.
    await realReg.setRegistered(await fakeStock.getAddress(), true);
    const ok = await AdapterF.connect(attacker).deploy(await fakeStock.getAddress(), await realReg.getAddress());
    expect(await ok.registry()).to.equal(await realReg.getAddress());
  });

  it("the curb adapter is DERIVED from the stock, so no launcher contract sits on the swap path", async () => {
    const cfg = cfgFor(await realStock.getAddress());
    const { tokenSalt, hookSalt } = await mineSalts(cfg);
    await realStock.transfer(attacker.address, E(1000));
    await realStock.connect(attacker).approve(await factory.getAddress(), ethers.MaxUint256);
    await factory.connect(attacker).launch(cfg, tokenSalt, hookSalt);

    const { hook, poolId } = await factory.launches(0);
    const wired = (await (await ethers.getContractAt("RobinFeeHook", hook)).config(poolId)).guardAdapter;

    // the wired adapter is the deterministic one for (stock, the factory's pinned registry) — reproduce it
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const AdapterF = await ethers.getContractFactory("StockQuoteAdapter");
    const initCode = ethers.concat([AdapterF.bytecode,
      abi.encode(["address", "address"], [await realStock.getAddress(), await realReg.getAddress()])]);
    const salt = ethers.keccak256(abi.encode(["address", "address"], [await realStock.getAddress(), await realReg.getAddress()]));
    const expected = ethers.getCreate2Address(await dep.getAddress(), salt, ethers.keccak256(initCode));
    expect(wired).to.equal(expected);

    const adapter = await ethers.getContractAt("StockQuoteAdapter", wired);
    expect(await adapter.stock()).to.equal(await realStock.getAddress());
    expect(await adapter.registry()).to.equal(await realReg.getAddress()); // the PLATFORM's, not the launcher's
  });

  it("guardWindow has a hard ceiling — hours, not years", async () => {
    const YEARS = 4_294_967_295; // the old unbounded uint32: ~136 years in one call
    const cfg = cfgFor(await realStock.getAddress(), { guardWindow: YEARS, name: "P3", symbol: "P3" });
    const { tokenSalt, hookSalt } = await mineSalts(cfg);
    await expect(factory.connect(attacker).launch(cfg, tokenSalt, hookSalt))
      .to.be.revertedWithCustomError(factory, "BadConfig");
    expect(Number(await factory.MAX_GUARD_WINDOW())).to.equal(7 * 86400);
  });

  it("the hook bounds it too — that write is the one that becomes permanent", async () => {
    // registerPool is where guardWindow is stamped immutably, so it must not depend on the factory checking
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const tok = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 27n);
    const initCode = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"],
      [await pm.getAddress(), owner.address, await reg.getAddress(), await tok.getAddress()])]);
    const hash = ethers.keccak256(initCode);
    let addr, salt;
    for (let i = 0n; ; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(await dep.getAddress(), s, hash);
      if ((BigInt(a) & MASK) === FLAGS) { salt = s; addr = a; break; }
    }
    await dep.deploy(salt, initCode);
    const hook = HookF.attach(addr);
    const id = ethers.keccak256("0x1234");
    const base = {
      currency0: ethers.ZeroAddress, currency1: await tok.getAddress(), creator: creator.address,
      floorRecipient: sink.address, guardAdapter: ethers.ZeroAddress, buyTaxBps: 100, sellTaxBps: 100,
      sellFloorShareBps: 2000, buyBufferShareBps: 0, referralShareBps: 0, quoteIsStock: true,
    };
    await expect(hook.connect(owner).registerPool(id, { ...base, guardWindow: 8 * 86400 }))
      .to.be.revertedWithCustomError(hook, "BadGuardWindow");
    await hook.connect(owner).registerPool(id, { ...base, guardWindow: 7 * 86400 }); // the ceiling itself is fine
  });
});
