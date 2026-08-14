const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 4 — StockQuoteAdapter (RobinBlue seam). Proves the deploy-time allow-list gate, the
// corporate-action curb signal, the display scalar, and the never-reverting tradeable() status.

describe("StockQuoteAdapter — RobinBlue stock-pad seam", () => {
  let owner, alice, bob, registry, otherRegistry, stock, adapter;

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    otherRegistry = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    stock = await (await ethers.getContractFactory("MockStock")).deploy(await registry.getAddress(), 10n ** 27n);
    await registry.setRegistered(await stock.getAddress(), true); // [H-2] the pinned registry attests the stock
    adapter = await (await ethers.getContractFactory("StockQuoteAdapter")).deploy(
      await stock.getAddress(), await registry.getAddress()
    );
  });

  it("gates at deploy: only a stock governed by the expected registry can be wired", async () => {
    // registry mismatch → revert
    await expect(
      (await ethers.getContractFactory("StockQuoteAdapter")).deploy(await stock.getAddress(), await otherRegistry.getAddress())
    ).to.be.revertedWithCustomError(adapter, "RegistryMismatch");
    // a non-stock (registry address 0) → revert
    const notStock = await (await ethers.getContractFactory("MockStock")).deploy(ethers.ZeroAddress, 1n);
    await expect(
      (await ethers.getContractFactory("StockQuoteAdapter")).deploy(await notStock.getAddress(), await registry.getAddress())
    ).to.be.reverted;
  });

  it("is a quote adapter: stock quote, 18 dec, zero yield", async () => {
    expect(await adapter.quote()).to.equal(await stock.getAddress());
    expect(await adapter.quoteDecimals()).to.equal(18n);
    expect(await adapter.harvest(alice.address)).to.equal(0n);
  });

  it("signals a scheduled corporate action to the hook curb, else 0", async () => {
    expect(await adapter.scheduledEffectiveAt()).to.equal(0n); // none pending
    await stock.scheduleMultiplier(2n * 10n ** 18n, 1893456000); // a split effective at some future time
    expect(await adapter.scheduledEffectiveAt()).to.equal(1893456000n);
  });

  it("displayScalar tracks uiMultiplier; marketDataStale tracks oraclePaused", async () => {
    expect(await adapter.displayScalar()).to.equal(10n ** 18n);
    await stock.setUiMultiplier(4n * 10n ** 18n);
    expect(await adapter.displayScalar()).to.equal(4n * 10n ** 18n);
    expect(await adapter.marketDataStale()).to.equal(false);
    await stock.setOraclePaused(true);
    expect(await adapter.marketDataStale()).to.equal(true);
  });

  it("tradeable() is false on stock pause / registry pause / blocked party, true otherwise, and NEVER reverts", async () => {
    expect(await adapter.tradeable([alice.address, bob.address])).to.equal(true);

    await stock.setPaused(true);
    expect(await adapter.tradeable([alice.address])).to.equal(false);
    await stock.setPaused(false);

    await registry.setPaused(true);
    expect(await adapter.tradeable([alice.address])).to.equal(false);
    await registry.setPaused(false);

    await registry.setBlocked(bob.address, true);
    expect(await adapter.tradeable([alice.address, bob.address])).to.equal(false);
    expect(await adapter.tradeable([alice.address])).to.equal(true); // bob not in the set
    await registry.setBlocked(bob.address, false);

    // even if the stock's paused() getter REVERTS, tradeable never reverts (returns false, safe default)
    await stock.setBreakGetters(true);
    expect(await adapter.tradeable([alice.address])).to.equal(false);
  });
});
