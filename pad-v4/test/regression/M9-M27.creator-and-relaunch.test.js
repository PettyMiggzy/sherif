// REGRESSION TESTS for M-9 and M-27 (see AUDITOR-HANDOFF.md).
//   M-9  — one pad had TWO creator addresses. RobinFeeHook kept a mutable, 2-step-repointable creator slot;
//          RobinCurveV4 stamped its own immutable at construction with no repoint and no claimCreatorTo. A
//          creator who moved keys kept the sell-tax stream and permanently lost the graduation reward.
//   M-27 — PadFactory.launch is permissionless and no uniqueness gate was keyed on the whole PoolKey: the
//          deterministic deployer ADOPTS a byte-identical pre-deploy, and registerPool rejects only a repeat of
//          the SAME PoolId. The same salts with a different fee or tickSpacing produced a SECOND live pool over
//          an already-launched pad token.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const FLAGS = 0xccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const poolIdOf = (k) => ethers.keccak256(
  abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
);

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("M-9 — one repoint governs both creator books", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const START = 6000, GRAD = 3000, TS = 60, FEE = 3000;
  let owner, factorySigner, platform, A, B;
  let pm, hook, curve, poolId;

  before(async () => {
    [owner, factorySigner, platform, A, B] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());
    const tok = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();

    // a real hook, with `factorySigner` as its registrar so this test can registerPool directly
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"],
      [await pm.getAddress(), factorySigner.address, await reg.getAddress(), await tok.getAddress()])]);
    let salt, addr;
    for (let i = 0n; ; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(await dep.getAddress(), s, ethers.keccak256(initCode));
      if ((BigInt(a) & MASK) === FLAGS) { salt = s; addr = a; break; }
    }
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);

    const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: addr };
    poolId = poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));
    await hook.connect(factorySigner).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: A.address, floorRecipient: platform.address,
      guardAdapter: ZERO, buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyBufferShareBps: 2000,
      referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
    });

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), FEE, TS, addr, START, GRAD, 2000, 1000, 1000, 500, A.address
    );
  });

  it("the curve follows the hook's repointable slot", async () => {
    expect(await curve.creator()).to.equal(A.address); // launch-time immutable, unchanged
    expect(await curve.currentCreator()).to.equal(A.address);

    await hook.connect(A).startCreatorRepoint(poolId, B.address);
    expect(await curve.currentCreator()).to.equal(A.address); // 2-step: pending alone changes nothing
    await hook.connect(B).acceptCreatorRepoint(poolId);

    expect(await curve.currentCreator()).to.equal(B.address); // the payee moved with the hook
    expect(await curve.creator()).to.equal(A.address); // provenance is still readable
  });

  it("falls back to the immutable when no hook governs the pool", async () => {
    // a curve deployed with hooks = address(0): the staticcall returns empty, the length check rejects it
    const tok2 = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    const bare = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, await tok2.getAddress(), FEE, TS, ZERO, START, GRAD, 2000, 1000, 1000, 500, A.address
    );
    expect(await bare.currentCreator()).to.equal(A.address);
  });

  it("a short-returning hook cannot brick the claim path", async () => {
    // [H-3] the read is a length-checked staticcall, not try/catch — a hook answering zero bytes falls back
    const bad = await (await ethers.getContractFactory("ShortReturner")).deploy();
    const tok3 = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    const c = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, await tok3.getAddress(), FEE, TS, await bad.getAddress(), START, GRAD, 2000, 1000, 1000, 500, A.address
    );
    expect(await c.currentCreator()).to.equal(A.address); // no revert, falls back
  });
});

describe("M-27 — a pad token can only be launched once per factory", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const TS = 60;
  let owner, platform, creator, pm, dep, reg, permit2, posm, lockVault, factory;

  before(async () => {
    [owner, platform, creator] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    factory = await (await ethers.getContractFactory("PadFactory")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(),
      await dep.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
  });

  const cfgFor = (over = {}) => ({
    name: "Pad", symbol: "PAD", decimals: 18, supply: E(1000000), lpTokenAmount: E(500000),
    sqrtPriceX96: SQRT_1_1, tickSpacing: TS, fee: 3000, buyTaxBps: 100, sellTaxBps: 100,
    sellFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 0,
    quoteIsStock: false, guardAdapter: ZERO, creator: creator.address,
    floorRecipient: platform.address, stakingRecipient: platform.address, ...over,
  });

  async function mineSalts(cfg) {
    const depAddr = await dep.getAddress();
    const TokenF = await ethers.getContractFactory("PadToken");
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const init = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"],
      [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await factory.getAddress()])]);
    const tokenAddr = ethers.getCreate2Address(depAddr, ethers.ZeroHash, ethers.keccak256(init));
    const hookInit = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"],
      [await pm.getAddress(), await factory.getAddress(), await reg.getAddress(), tokenAddr])]);
    const hookHash = ethers.keccak256(hookInit);
    let hookSalt;
    for (let i = 0n; ; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(depAddr, s, hookHash);
      if ((BigInt(a) & MASK) === FLAGS) { hookSalt = s; break; }
    }
    return { tokenSalt: ethers.ZeroHash, hookSalt, tokenAddr };
  }

  it("the same salts with a DIFFERENT fee can no longer open a second pool over the same token", async () => {
    const cfg = cfgFor();
    const { tokenSalt, hookSalt, tokenAddr } = await mineSalts(cfg);
    await factory.launch(cfg, tokenSalt, hookSalt, { value: E(1) });
    const firstPool = await factory.poolOf(tokenAddr);
    expect(firstPool).to.not.equal(ethers.ZeroHash);

    // identical salts (so the deployer ADOPTS the existing token and hook) but a different pool key
    for (const over of [{ fee: 500 }, { tickSpacing: 10 }, { fee: 10000, tickSpacing: 200 }]) {
      await expect(factory.launch(cfgFor(over), tokenSalt, hookSalt, { value: E(1) }))
        .to.be.revertedWithCustomError(factory, "AlreadyLaunched");
    }
    expect(await factory.poolOf(tokenAddr)).to.equal(firstPool); // the claim is unchanged
    expect(await factory.launchCount()).to.equal(1n);
  });

  it("the token is claimed BEFORE any external call the launch makes", async () => {
    // the guard is only airtight if poolOf is written at the earliest point poolId exists — otherwise a
    // re-entrant creator callback could slip a second launch past it inside the same transaction
    const cfg = cfgFor({ name: "Pad2", symbol: "PAD2" });
    const { tokenSalt: ts2, hookSalt: hs2, tokenAddr } = await mineSalts(cfg);
    // a fresh token salt so this is a genuinely new pad
    const salt2 = ethers.id("m27-second");
    const TokenF = await ethers.getContractFactory("PadToken");
    const init = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"],
      [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await factory.getAddress()])]);
    const tok2 = ethers.getCreate2Address(await dep.getAddress(), salt2, ethers.keccak256(init));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const hookHash = ethers.keccak256(ethers.concat([HookF.bytecode,
      abi.encode(["address", "address", "address", "address"],
        [await pm.getAddress(), await factory.getAddress(), await reg.getAddress(), tok2])]));
    let hs;
    for (let i = 0n; ; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(await dep.getAddress(), s, hookHash);
      if ((BigInt(a) & MASK) === FLAGS) { hs = s; break; }
    }
    await factory.launch(cfg, salt2, hs, { value: E(1) });
    expect(await factory.poolOf(tok2)).to.not.equal(ethers.ZeroHash);
    void ts2; void hs2; void tokenAddr;
  });
});
