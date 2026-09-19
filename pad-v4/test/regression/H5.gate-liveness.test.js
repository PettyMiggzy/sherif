const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, buildLab } = require("../helpers/h5-lab");

// [H-5] LIVENESS half of the floor-gate regression. The gate's whole safety argument is "when in doubt, PARK" —
// so every way the hook read can go wrong must resolve to a park, never a revert and never a commit. A revert
// here would be worse than the finding it closes: `RobinCurveV4._fundFloor` pokes the vault at graduation, and
// `scripts/keeper.js` pokes it forever.
//
// Deployed as a standalone vault against a REAL PoolManager so the hook slot can be pointed at hostile stubs.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const EPISODE_BASE_WEI = 10n ** 14n;

// A vault's pool key is (currency0, currency1, fee, tickSpacing, hooks) — the "hook" here never receives a
// callback, it is only the address the vault staticcalls for its gate state, so any address works.
async function vaultWithGateSource(pm, stateView, reg, tok, gateSource) {
  return (await ethers.getContractFactory("RobinFloorVault")).deploy(
    await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
    ZERO, await tok.getAddress(), 3000, 60, gateSource, 0, 20, EPISODE_BASE_WEI
  );
}

describe("[H-5] floor gate liveness — every unreadable/unarmed/mismatched path PARKS, never reverts", function () {
  this.timeout(600000);
  let owner, platform, pm, stateView, tok, reg;

  before(async () => {
    [owner, , , platform] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
  });

  async function pokeAndExpectPark(gateSource, reasonName) {
    const vault = await vaultWithGateSource(pm, stateView, reg, tok, gateSource);
    // the pool this vault names must exist, or the live-spot read would revert for an unrelated reason
    const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: gateSource };
    if (gateSource === ZERO) await pm.initialize(key, SQRT_1_1).catch(() => {});
    await owner.sendTransaction({ to: await vault.getAddress(), value: E(1) });
    const tx = vault.addFloor();
    await expect(tx).to.emit(vault, "FloorParked").withArgs(await vault[reasonName](), 0, 0, E(1));
    expect(await vault.floorLiquidity()).to.equal(0n);
    expect(await vault.bandQuoteWei()).to.equal(0n);
    expect(await vault.parkedQuote()).to.equal(E(1));
    return vault;
  }

  it("hooks == address(0): a staticcall to an EOA/empty address succeeds with 0 bytes -> R_ORACLE park", async () => {
    await pokeAndExpectPark(ZERO, "R_ORACLE");
  });

  it("a hook that returns ZERO bytes (the [H-3] short-return trap) -> R_ORACLE park, no revert", async () => {
    const stub = await (await ethers.getContractFactory("GateShortReturner")).deploy();
    await pokeAndExpectPark(await stub.getAddress(), "R_ORACLE");
  });

  it("a hook that REVERTS -> R_ORACLE park, no revert in the vault's frame", async () => {
    const stub = await (await ethers.getContractFactory("GateReverter")).deploy();
    await pokeAndExpectPark(await stub.getAddress(), "R_ORACLE");
  });

  it("a hook returning a full-length but DIRTY word (armedAt > uint64, wrong band) -> R_ORACLE park", async () => {
    const stub = await (await ethers.getContractFactory("GateDirtyReturner")).deploy();
    await pokeAndExpectPark(await stub.getAddress(), "R_ORACLE");
  });

  it("an armed hook bound to a DIFFERENT band is rejected by the on-chain cross-check", async () => {
    // A real hook armed for a real vault, then a SECOND vault with a different band pointed at the same hook.
    const L = await buildLab({ baseL: 10n ** 20n, carve: E(1), dumpTick: null, hookTaxBps: 100, bandSpacings: 20 });
    const other = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await L.pm.getAddress(), await L.stateView.getAddress(), await reg.getAddress(),
      ZERO, await L.tok.getAddress(), 3000, 60, await L.hook.getAddress(),
      600 /* a DIFFERENT anchorTick => a different band */, 20, EPISODE_BASE_WEI
    );
    expect(await other.floorTickLower()).to.not.equal(await L.vault.floorTickLower());
    await owner.sendTransaction({ to: await other.getAddress(), value: E(1) });
    await time.increase(Number(await other.MIN_BELOW_DURATION()) + 1);
    await expect(other.addFloor()).to.emit(other, "FloorParked").withArgs(await other.R_ORACLE(), 0, 0, E(1));
    expect(await other.floorLiquidity()).to.equal(0n);
  });

  it("warm-up: an armed gate parks with R_WARMUP until armedAt + MIN_BELOW_DURATION, then commits", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: E(1), dumpTick: null, hookTaxBps: 100 });
    const { vault } = L;
    await expect(vault.addFloor()).to.emit(vault, "FloorParked"); // still inside the warm-up
    expect(await vault.floorLiquidity()).to.equal(0n);

    await time.increase(Number(await vault.MIN_BELOW_DURATION()) + 1);
    await vault.addFloor(); // arms the legacy dwell clock
    await time.increase(Number(await vault.MIN_DWELL()) + 1);
    await vault.addFloor();
    expect(await vault.floorLiquidity()).to.be.gt(0n);
    expect(await vault.bandQuoteWei()).to.be.gt(0n);
  });

  it("GRIEF: touching the band once per MIN_BELOW_DURATION holds the floor parked — and loses nothing", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: E(1), dumpTick: null, hookTaxBps: 100 });
    const { vault, sw, key, sqrtAt, trader } = L;
    await time.increase(Number(await vault.MIN_BELOW_DURATION()) + 1);
    const parked0 = await ethers.provider.getBalance(await vault.getAddress());
    for (let i = 0; i < 3; i++) {
      // a griefer pushes the tick INTO the band, then straight back out; the return leg's PRE-swap tick is
      // inside the band, so it re-stamps `aboveLowerTs` and restarts the whole MIN_BELOW_DURATION clock
      await sw.connect(trader).swap(
        key, { zeroForOne: false, amountSpecified: -(10n ** 22n), sqrtPriceLimitX96: await sqrtAt(700) },
        { takeClaims: false, settleUsingBurn: false }, "0x"
      );
      await sw.connect(trader).swap(
        key, { zeroForOne: true, amountSpecified: -E(50), sqrtPriceLimitX96: await sqrtAt(-600) },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(50) }
      );
      await time.increase(3600);
      await vault.addFloor();
      expect(await vault.floorLiquidity()).to.equal(0n); // held parked, every round
    }
    // nothing is lost: the vault still holds the whole carve, exactly, and `parkedQuote` reports it
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(parked0);
    expect(await vault.parkedQuote()).to.equal(parked0);
  });

  it("lastCommitAt is NOT advanced by a poke that mints nothing", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: E(1), dumpTick: null, hookTaxBps: 100 });
    const { vault } = L;
    await time.increase(Number(await vault.MIN_BELOW_DURATION()) + 1);
    await vault.addFloor();
    expect(await vault.lastCommitAt()).to.equal(0n); // parked, not committed
  });

  it("[P3] a platform wallet that moves the tick into the band mid-collect aborts the mint cleanly", async () => {
    const L = await buildLab({ baseL: 10n ** 20n, carve: E(2), dumpTick: null, hookTaxBps: 100 });
    const { vault, key, sqrtAt } = L;
    // land a first commit so `floorLiquidity > 0` and `_add` takes the `_collect()` branch
    await time.increase(Number(await vault.MIN_BELOW_DURATION()) + 1);
    await vault.addFloor();
    await time.increase(Number(await vault.MIN_DWELL()) + 1);
    await vault.addFloor();
    expect(await vault.floorLiquidity()).to.be.gt(0n);
    const bandBefore = await vault.bandQuoteWei();

    // rotate the platform wallet to a contract that swaps the tick INTO the band when it is paid
    const attackerPlat = await (await ethers.getContractFactory("TickMovingPlatform")).deploy(await L.pm.getAddress());
    await attackerPlat.arm(key, await sqrtAt(700));
    const regC = await ethers.getContractAt("FeeWalletRegistry", await vault.feeRegistry());
    await regC.connect(L.owner).proposePlatformFeeWallet(await attackerPlat.getAddress());
    await time.increase(2 * 24 * 3600 + 1);
    await regC.connect(L.owner).commitPlatformFeeWallet();

    await time.increase(Number(await vault.COMMIT_COOLDOWN()) + 1);
    const tokBefore = await L.tok.balanceOf(await vault.getAddress());
    await vault.addFloor(); // must not revert, whatever the platform wallet does with its gas
    // either the platform did not manage to move the tick (mint proceeds) or it did and the mint aborted —
    // in NEITHER case may the vault's parked currency1 be converted into floor principal
    expect(await L.tok.balanceOf(await vault.getAddress())).to.be.gte(tokBefore);
    expect(await vault.bandQuoteWei()).to.be.gte(bandBefore);
  });
});
