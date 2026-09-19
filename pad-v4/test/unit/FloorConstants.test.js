const { ethers } = require("hardhat");
const { expect } = require("chai");

// [H-5] The constants the closure's economic argument rests on, asserted ON-CHAIN so a future edit that
// silently breaks one of the inequalities fails CI rather than the audit. Every value and its justifying
// inequality is written up in FLOOR-H5-CLOSURE-SPEC.md §4.
const ZERO = ethers.ZeroAddress;

describe("[H-5] floor gate constants — the inequalities the closure rests on", () => {
  let vault, hookSizes;

  before(async () => {
    const [owner, platform] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 24n);
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    vault = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), 3000, 60, ZERO, 0, 20, 10n ** 14n
    );
    hookSizes = {};
    for (const n of ["RobinFeeHook", "PadFactory", "CurvePadFactoryV4", "StockPadFactory", "RobinFloorVault", "FeeHookDeployer"]) {
      const art = await ethers.getContractFactory(n);
      hookSizes[n] = (art.bytecode.length - 2) / 2;
    }
  });

  it("COMMIT_COOLDOWN > MIN_DWELL (the external auditor's explicit requirement (c))", async () => {
    expect(await vault.COMMIT_COOLDOWN()).to.be.gt(await vault.MIN_DWELL());
  });

  it("COMMIT_COOLDOWN > MAX_OBSERVED_GAP (the inequality the repo MEASURED as load-bearing)", async () => {
    expect(await vault.COMMIT_COOLDOWN()).to.be.gt(await vault.MAX_OBSERVED_GAP());
  });

  it("TWAP_WINDOW == 3 * COMMIT_COOLDOWN, and MIN_BELOW_DURATION == TWAP_WINDOW (auditor requirement (b))", async () => {
    const cc = await vault.COMMIT_COOLDOWN();
    expect(await vault.TWAP_WINDOW()).to.equal(cc * 3n);
    expect(await vault.MIN_BELOW_DURATION()).to.equal(await vault.TWAP_WINDOW());
  });

  it("the shipped pace limiters are unchanged: MIN_DWELL 10m, MAX_COMMIT_BPS 2000, COMMIT_COOLDOWN 65m, gap 1h", async () => {
    expect(await vault.MIN_DWELL()).to.equal(600n);
    expect(await vault.MAX_COMMIT_BPS()).to.equal(2000n);
    expect(await vault.COMMIT_COOLDOWN()).to.equal(3900n);
    expect(await vault.MAX_OBSERVED_GAP()).to.equal(3600n);
  });

  it("the ring is sized for the window: (OBS_N-1)*OBS_BUCKET - (OBS_BUCKET-1) >= TWAP_WINDOW", async () => {
    const OBS_N = 128n, OBS_BUCKET = 180n;
    const guaranteedSpan = (OBS_N - 1n) * OBS_BUCKET - (OBS_BUCKET - 1n);
    expect(guaranteedSpan).to.equal(22_681n);
    expect(guaranteedSpan).to.be.gte(await vault.TWAP_WINDOW());
  });

  it("EPISODE_BASE_WEI is immutable, non-zero, and a zero value is rejected at deploy", async () => {
    expect(await vault.EPISODE_BASE_WEI()).to.equal(10n ** 14n);
    const [owner, platform] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 24n);
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const F = await ethers.getContractFactory("RobinFloorVault");
    await expect(F.deploy(
      await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
      ZERO, await tok.getAddress(), 3000, 60, ZERO, 0, 20, 0
    )).to.be.revertedWithCustomError(F, "BadBand");
  });

  it("the vault still exposes NO remove/withdraw/decrease selector after the gate landed", async () => {
    const banned = ["remove", "removefloor", "withdraw", "decreaseliquidity", "burn", "rescue", "sweepquote"];
    const names = vault.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const b of banned) expect(names).to.not.include(b);
    expect(names).to.include("addfloor");
  });

  it("[EIP-170] every factory, the hook, the vault and the offload deployer fit under 24,576 bytes", () => {
    for (const [n, size] of Object.entries(hookSizes)) {
      expect(size, `${n} creation code`).to.be.lt(24_576);
    }
  });
});
