const { ethers } = require("hardhat");
const { expect } = require("chai");

// LP-1 — third-party liquidity must be impossible during the CURVE PHASE.
//
// The hole: REQUIRED_FLAGS carried no liquidity permission at all, so the PoolManager never asked the hook
// about `modifyLiquidity`. Two things followed, both live on every v4 pad.
//
//   (a) LP-THROUGH WAS A TAX-FREE EXIT. The sell tax fires only in afterSwap on a oneForZero swap, and
//       PadToken is a plain ERC-20 with no transfer hook. Mint a token-only range, let buyers walk down
//       through it, then REMOVE the position — you are now holding the money side, having paid no sell tax
//       and no floor carve. L-25 closed the tax-free venue in a SIBLING pool and left this one open inside
//       the pad's OWN pool.
//
//   (b) BUY-FLOW INTERCEPTION STARVED GRADUATION. Liquidity planted in the curve's own [gradTick, startTick]
//       range splits every buy pro-rata by L, so the curve never sells out, ready() never flips, the
//       permanent locked LP is never minted and staking is never funded.
//
// Closed by adding BEFORE_ADD_LIQUIDITY (0x800) to REQUIRED_FLAGS and gating beforeAddLiquidity to the pad's
// own contracts while a curve is wired and unfinished. Hook permissions live in the hook ADDRESS, so if 0x800
// ever leaves REQUIRED_FLAGS the first case here goes green when it should be red — and no already-launched
// pad can be repaired.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const FLAGS = 0x28ccn, MASK = 0x3fffn;
const BEFORE_ADD_LIQUIDITY = 0x800n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (n) => ethers.parseEther(String(n));

function mineHookSalt(dep, h) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(dep, salt, h);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}

describe("[LP-1 regression] third-party liquidity is locked for the curve phase", () => {
  const FEE = 3000, TS = 60;
  const RANGE = { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash };

  let owner, factory, platform, stranger, curveSigner, creator;
  let pm, dep, reg, tok, hook, hookAddr, tokAddr;
  let padLp, floorLp, strangerLp; // three separate routers => three distinct `sender`s

  const keyFor = (fee) => ({ currency0: ZERO, currency1: tokAddr, fee, tickSpacing: TS, hooks: hookAddr });
  const idOf = (k) => ethers.keccak256(abi.encode(
    ["address", "address", "uint24", "int24", "address"],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));

  const register = async (id, floorRecipient) => hook.connect(factory).registerPool(id, {
    currency0: ZERO, currency1: tokAddr, creator: creator.address, floorRecipient,
    guardAdapter: ZERO, buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
    buyBufferShareBps: 0, referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
  });

  const addVia = (router, key) => router.modifyLiquidity(key, RANGE, "0x", { value: E(10) });

  // v4's PoolManager bubbles a hook revert up inside WrappedError, so `revertedWithCustomError` cannot see
  // through it. Assert on the raw payload instead: it must carry OUR selector, not merely "something reverted".
  const LOCKED = ethers.id("LiquidityLocked()").slice(0, 10);
  const expectLocked = async (promise) => {
    let threw = false;
    try { await promise; } catch (e) {
      threw = true;
      const blob = JSON.stringify(e, Object.getOwnPropertyNames(e)) + String(e);
      expect(blob, "revert payload must carry the LiquidityLocked selector").to.include(LOCKED.slice(2));
    }
    expect(threw, "expected the add to revert").to.equal(true);
  };

  before(async () => {
    [owner, factory, platform, stranger, curveSigner, creator] = await ethers.getSigners();
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

    const MLT = await ethers.getContractFactory("PoolModifyLiquidityTest");
    padLp = await MLT.deploy(await pm.getAddress());
    floorLp = await MLT.deploy(await pm.getAddress());
    strangerLp = await MLT.deploy(await pm.getAddress());
    for (const r of [padLp, floorLp, strangerLp]) {
      await tok.connect(owner).transfer(stranger.address, 10n ** 24n);
      await tok.connect(stranger).approve(await r.getAddress(), ethers.MaxUint256);
    }
  });

  it("the flag word carries BEFORE_ADD_LIQUIDITY — without it the PoolManager never asks the hook", async () => {
    expect(await hook.REQUIRED_FLAGS()).to.equal(FLAGS);
    expect((await hook.REQUIRED_FLAGS()) & BEFORE_ADD_LIQUIDITY).to.equal(BEFORE_ADD_LIQUIDITY);
    expect(BigInt(hookAddr) & MASK).to.equal(FLAGS); // and the mined ADDRESS advertises it
  });

  it("an instant-LP pad (no curve wired) is NOT gated — the fix must not break PadFactory/StockPadFactory", async () => {
    const key = keyFor(FEE);
    await pm.connect(factory).initialize(key, SQRT_1_1);
    await register(idOf(key), await floorLp.getAddress());
    // bufferRecipient is still 0: there is no curve phase to protect, so anyone may provide.
    await expect(addVia(strangerLp.connect(stranger), key)).to.not.be.reverted;
  });

  describe("once a curve is wired", () => {
    let key, id;

    before(async () => {
      key = keyFor(500);
      id = idOf(key);
      await pm.connect(factory).initialize(key, SQRT_1_1);
      await register(id, await floorLp.getAddress());
      await hook.connect(factory).setBufferRecipient(id, await padLp.getAddress());
    });

    it("THE HOLE: a stranger can no longer plant liquidity in the pad's own pool", async () => {
      await expectLocked(addVia(strangerLp.connect(stranger), key));
    });

    it("the pad's own curve still can — the gate must not brick the launch it protects", async () => {
      await expect(addVia(padLp.connect(stranger), key)).to.not.be.reverted;
    });

    it("and so can the floor vault, so a carve commit parks on its own terms instead of reverting here", async () => {
      await expect(addVia(floorLp.connect(stranger), key)).to.not.be.reverted;
    });

    it("onGraduated is reachable ONLY by the wired curve — not the factory, platform, creator or a stranger", async () => {
      for (const who of [stranger, factory, platform, creator, owner]) {
        await expect(hook.connect(who).onGraduated(id)).to.be.revertedWithCustomError(hook, "NotCurve");
      }
      expect((await hook.config(id)).graduated).to.equal(false);
    });
  });

  describe("after graduation the pool is an ordinary v4 pool again", () => {
    let key, id;

    before(async () => {
      key = keyFor(10000);
      id = idOf(key);
      await pm.connect(factory).initialize(key, SQRT_1_1);
      await register(id, await floorLp.getAddress());
      // curveSigner stands in for RobinCurveV4: an EOA so it can make the onGraduated call itself.
      await hook.connect(factory).setBufferRecipient(id, curveSigner.address);
    });

    it("locked before", async () => {
      await expectLocked(addVia(strangerLp.connect(stranger), key));
    });

    it("the curve lifts the lock exactly once, and the flip is idempotent so a retried graduation cannot brick", async () => {
      await expect(hook.connect(curveSigner).onGraduated(id)).to.emit(hook, "PoolGraduated").withArgs(id);
      expect((await hook.config(id)).graduated).to.equal(true);
      await expect(hook.connect(curveSigner).onGraduated(id)).to.not.be.reverted; // second call is a no-op
    });

    it("open after — third-party depth, routing and aggregator support all need this", async () => {
      await expect(addVia(strangerLp.connect(stranger), key)).to.not.be.reverted;
    });

    it("HONEST SCOPE: the LP-through exit is closed for the curve phase only, not forever", async () => {
      // Post-graduation a holder can still mint a range, let buyers walk through it and withdraw the money
      // side without paying the sell tax. Closing that would mean banning third-party liquidity permanently,
      // which costs more than the 1% it protects. The curve phase — where the whole float is the curve's and
      // interception starves graduation outright — is the part that had to be shut.
      expect((await hook.config(id)).graduated).to.equal(true);
      await expect(addVia(strangerLp.connect(stranger), key)).to.not.be.reverted;
    });
  });
});
