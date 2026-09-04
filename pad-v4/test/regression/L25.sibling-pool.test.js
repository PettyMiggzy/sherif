const { ethers } = require("hardhat");
const { expect } = require("chai");

// L-25 — a sibling pool carrying this pad's own hook must be IMPOSSIBLE.
//
// The hole: REQUIRED_FLAGS omitted BEFORE_INITIALIZE, so the PoolManager never called beforeInitialize and
// ANYONE could stand up a second pool with the same two currencies and THIS hook at a different fee or
// tickSpacing. A v4 PoolId is keccak(currency0, currency1, fee, tickSpacing, hooks), so the sibling had a
// different id, `config[id].registered` was false, and beforeSwap fell through with ZERO_DELTA: no buy tax,
// no sell tax, no creator share, no floor carve, and exact-output re-enabled. It looked like a genuine Robin
// pad to anything keying on the hook address. Found as L-25 and DEFERRED; closed by gating beforeInitialize
// to the factory.
//
// This test is the thing that stops it coming back. If REQUIRED_FLAGS loses 0x2000, or the beforeInitialize
// gate is widened, the first case here goes green when it should be red.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const FLAGS = 0x20ccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(dep, h) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(dep, salt, h);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}

describe("[L-25 regression] a sibling pool behind this hook cannot exist", () => {
  const FEE = 3000, TS = 60;
  let owner, factory, platform, stranger, pm, dep, reg, tok, hook, hookAddr, tokAddr;

  before(async () => {
    [owner, factory, platform, stranger] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    tokAddr = await tok.getAddress();

    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address", "address"],
        [await pm.getAddress(), factory.address, await reg.getAddress(), tokAddr]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr); hookAddr = addr;
  });

  it("the flag word carries BEFORE_INITIALIZE — without it the PoolManager never asks the hook", async () => {
    expect(await hook.REQUIRED_FLAGS()).to.equal(0x20ccn);
    expect(BigInt(hookAddr) & MASK).to.equal(0x20ccn); // and the mined ADDRESS advertises it
    expect((await hook.REQUIRED_FLAGS()) & 0x2000n).to.equal(0x2000n);
  });

  it("THE HOLE: a stranger cannot open a pool at a different fee behind this hook", async () => {
    for (const fee of [100, 500, 10000]) {
      const sibling = { currency0: ZERO, currency1: tokAddr, fee, tickSpacing: TS, hooks: hookAddr };
      await expect(pm.connect(stranger).initialize(sibling, SQRT_1_1)).to.be.reverted;
    }
  });

  it("nor at a different tickSpacing, which is the other half of the pool id", async () => {
    for (const ts of [1, 10, 200]) {
      const sibling = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: ts, hooks: hookAddr };
      await expect(pm.connect(stranger).initialize(sibling, SQRT_1_1)).to.be.reverted;
    }
  });

  it("the FACTORY still can — the gate must not brick legitimate launches", async () => {
    const real = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: TS, hooks: hookAddr };
    await expect(pm.connect(factory).initialize(real, SQRT_1_1)).to.not.be.reverted;
  });

  it("and the owner is NOT special — only the factory address passes", async () => {
    const other = { currency0: ZERO, currency1: tokAddr, fee: 500, tickSpacing: TS, hooks: hookAddr };
    await expect(pm.connect(owner).initialize(other, SQRT_1_1)).to.be.reverted;
  });
});
