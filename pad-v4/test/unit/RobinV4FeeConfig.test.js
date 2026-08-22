const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinV4FeeConfig — governed DEFAULT launch params for the V4 curve suite. Changing them only affects
// future launches; live pads are immutable. Caps bound what any future launch can carry.

const GOOD = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyLpFloorShareBps: 0, buyBufferShareBps: 2000, referralShareBps: 2500,
  platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
  lpFee: 10000, startTickMag: 201600, curveWidth: 25800, minGradWidth: 22800,
  // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
  // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
  minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n, // = HARD_MAX_FDV_WEI
};
const DYNAMIC_FEE_FLAG = 0x800000;

describe("RobinV4FeeConfig", () => {
  let owner, other, cfg, Factory;

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();
    Factory = await ethers.getContractFactory("RobinV4FeeConfig");
    cfg = await Factory.deploy(owner.address, GOOD);
  });

  it("stores and returns the default params", async () => {
    const d = await cfg.defaults();
    expect(d.buyTaxBps).to.equal(100n);
    expect(d.sellTaxBps).to.equal(100n);
    expect(d.sellFloorShareBps).to.equal(2000n);
    expect(d.buyLpFloorShareBps).to.equal(0n);
    expect(d.buyBufferShareBps).to.equal(2000n);
    expect(d.referralShareBps).to.equal(2500n);
    expect(d.platformGradBps).to.equal(1000n);
    expect(d.creatorGradBps).to.equal(1000n);
    expect(d.ambushGradBps).to.equal(500n);
    expect(d.lpFee).to.equal(10000n);
    expect(d.curveWidth).to.equal(25800n);
  });

  it("owner can retune defaults within caps", async () => {
    await cfg.setDefaults({ ...GOOD, buyTaxBps: 200, sellTaxBps: 50, buyLpFloorShareBps: 3000 });
    const d = await cfg.defaults();
    expect(d.buyTaxBps).to.equal(200n);
    expect(d.buyLpFloorShareBps).to.equal(3000n);
  });

  it("enforces the hard caps and param sanity", async () => {
    await expect(cfg.setDefaults({ ...GOOD, buyTaxBps: 201 })).to.be.revertedWithCustomError(cfg, "BadParam");
    await expect(cfg.setDefaults({ ...GOOD, sellTaxBps: 201 })).to.be.revertedWithCustomError(cfg, "BadParam");
    await expect(cfg.setDefaults({ ...GOOD, sellFloorShareBps: 5001 })).to.be.revertedWithCustomError(cfg, "BadParam");
    await expect(cfg.setDefaults({ ...GOOD, buyLpFloorShareBps: 10001 })).to.be.revertedWithCustomError(cfg, "BadParam");
    await expect(cfg.setDefaults({ ...GOOD, buyBufferShareBps: 10001 })).to.be.revertedWithCustomError(cfg, "BadParam"); // > BPS
    await expect(cfg.setDefaults({ ...GOOD, referralShareBps: 5001 })).to.be.revertedWithCustomError(cfg, "BadParam"); // > MAX_REFERRAL_SHARE_BPS
    await expect(cfg.setDefaults({ ...GOOD, platformGradBps: 2501 })).to.be.revertedWithCustomError(cfg, "BadParam"); // > MAX_GRAD_SHARE_BPS
    await expect(cfg.setDefaults({ ...GOOD, ambushGradBps: 2501 })).to.be.revertedWithCustomError(cfg, "BadParam"); // > MAX_GRAD_SHARE_BPS
    await expect(cfg.setDefaults({ ...GOOD, creatorGradBps: 2501 })).to.be.revertedWithCustomError(cfg, "BadParam"); // > MAX_GRAD_SHARE_BPS
    await expect(cfg.setDefaults({ ...GOOD, buyTaxBps: 0, sellTaxBps: 0 })).to.be.revertedWithCustomError(cfg, "BadParam"); // 0/0 tax bricks the hook
    await expect(cfg.setDefaults({ ...GOOD, lpFee: 10001 })).to.be.revertedWithCustomError(cfg, "BadParam"); // [M-10] > MAX_LP_FEE (1%)
    await expect(cfg.setDefaults({ ...GOOD, lpFee: 1_000_001 })).to.be.revertedWithCustomError(cfg, "BadParam"); // and still > Uniswap max
    await expect(cfg.setDefaults({ ...GOOD, lpFee: 10000 })).to.not.be.reverted; // [M-10] exactly 1% is allowed (production geometry)
    await expect(cfg.setDefaults({ ...GOOD, lpFee: DYNAMIC_FEE_FLAG | 3000 })).to.be.revertedWithCustomError(cfg, "BadParam");
    await expect(cfg.setDefaults({ ...GOOD, startTickMag: 0 })).to.be.revertedWithCustomError(cfg, "BadParam");
    await expect(cfg.setDefaults({ ...GOOD, minGradWidth: 25800 })).to.be.revertedWithCustomError(cfg, "BadParam"); // >= curveWidth
  });

  it("rejects a bad constructor param", async () => {
    await expect(Factory.deploy(owner.address, { ...GOOD, buyTaxBps: 500 })).to.be.revertedWithCustomError(cfg, "BadParam");
  });

  it("gates setDefaults to the owner and disables renounce", async () => {
    await expect(cfg.connect(other).setDefaults(GOOD)).to.be.revertedWithCustomError(cfg, "OwnableUnauthorizedAccount");
    await expect(cfg.renounceOwnership()).to.be.revertedWith("disabled");
  });

  it("supports Ownable2Step transfer", async () => {
    await cfg.transferOwnership(other.address);
    expect(await cfg.owner()).to.equal(owner.address); // not yet accepted
    await cfg.connect(other).acceptOwnership();
    expect(await cfg.owner()).to.equal(other.address);
  });
});
