// REGRESSION TEST for H-4 (see AUDITOR-HANDOFF.md). StockPadFactory.launch pulls the stock seed from
// msg.sender (launch is not payable; the caller must have approved the factory) but refunded the unused stock
// to cfg.creator — and refunded the factory's WHOLE balance of it, not this launch's remainder. The stock path
// is the only launch path where funder and creator are two explicitly-modelled, distinct roles, and the
// remainder is not a corner case: _mintSeedLp sizes with getLiquidityForAmounts, which binds on ONE leg, so the
// other is over-supplied by construction. Measured: 100,000e18 pulled, 100e18 reached the pool, 99,900e18 —
// 99.9% of the payer's balance — silently and irreversibly sent to the creator.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { bindSalt, brandedTokenSalt, tokenInitCode } = require("../helpers/brand");

const FLAGS = 0x20ccn, MASK = 0x3fffn;
const SQRT_1_1 = 79228162514264337593543950336n;
const E = (x) => ethers.parseEther(String(x));

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("H-4 — the stock seed's remainder goes back to whoever paid it", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const TS = 60, FEE = 3000;
  const LP_TOKEN = E(100); // 1e20 — the binding leg at a 1:1 price
  const STOCK_SEED = E(100000); // 1e23 — over-supplied by construction
  let owner, platform, payer, creator, floorSink, stakingSink;
  let pm, permit2, posm, lockVault, dep, reg, stock, stockReg, factory;

  before(async () => {
    [owner, platform, payer, creator, floorSink, stakingSink] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();

    stockReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    stock = await (await ethers.getContractFactory("MockStock")).deploy(await stockReg.getAddress(), 10n ** 27n);
    await stockReg.setRegistered(await stock.getAddress(), true); // [H-2] the registry attests the stock

    // [H-2] the registry is pinned on the factory, and the curb adapter is derived from (stock, registry)
    const fhd = await (await ethers.getContractFactory("FeeHookDeployer")).deploy(await dep.getAddress());
    factory = await (await ethers.getContractFactory("StockPadFactory")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(),
      await dep.getAddress(), await reg.getAddress(), await lockVault.getAddress(), await stockReg.getAddress(),
      await fhd.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());

    // the PAYER funds the launch; the CREATOR is someone else entirely — the modelled arrangement
    await stock.transfer(payer.address, STOCK_SEED);
    await stock.connect(payer).approve(await factory.getAddress(), ethers.MaxUint256);
  });

  const cfgFor = () => ({
    name: "Pad", symbol: "PAD", decimals: 18, supply: E(1000000),
    lpTokenAmount: LP_TOKEN, stockSeed: STOCK_SEED, sqrtPriceX96: SQRT_1_1, tickSpacing: TS, fee: FEE,
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, guardWindow: 3600,
    stock: stock.target, creator: creator.address,
    floorRecipient: floorSink.address, stakingRecipient: stakingSink.address,
  });

  // mine tokenSalt so the pad token carries the `1ab5` brand suffix AND sorts ABOVE the stock,
  // and hookSalt for the 0x20CC flags (hook init-code embeds the predicted token, so token mining runs first)
  async function mineSalts(cfg) {
    const depAddr = await dep.getAddress();
    const factoryAddr = await factory.getAddress();
    const PadToken = await ethers.getContractFactory("PadToken");
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const stockAddr = await stock.getAddress();

    const tokenSalt = await brandedTokenSalt(depAddr, factoryAddr, cfg, undefined,
      (addr) => BigInt(addr) > BigInt(stockAddr));
    const tokenAddr = ethers.getCreate2Address(depAddr, bindSalt(cfg, tokenSalt),
      ethers.keccak256(tokenInitCode(PadToken.bytecode, cfg, factoryAddr)));

    let hookSalt;
    const hookInit = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"],
      [await pm.getAddress(), await factory.getAddress(), await reg.getAddress(), tokenAddr])]);
    const hookHash = ethers.keccak256(hookInit);
    for (let i = 0n; ; i++) {
      const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(depAddr, salt, hookHash);
      if ((BigInt(a) & MASK) === FLAGS) { hookSalt = salt; break; }
    }
    return { tokenSalt, hookSalt, tokenAddr };
  }

  it("refunds the unused stock to the PAYER, not to cfg.creator", async () => {
    const cfg = cfgFor();
    const { tokenSalt, hookSalt } = await mineSalts(cfg);

    expect(await stock.balanceOf(payer.address)).to.equal(STOCK_SEED);
    expect(await stock.balanceOf(creator.address)).to.equal(0n);

    await factory.connect(payer).launch(cfg, tokenSalt, hookSalt);

    const reachedPool = await stock.balanceOf(await pm.getAddress());
    const payerLeft = await stock.balanceOf(payer.address);
    const creatorGot = await stock.balanceOf(creator.address);
    console.log(`   of ${ethers.formatEther(STOCK_SEED)} stock: ${ethers.formatEther(reachedPool)} reached the pool, ` +
      `${ethers.formatEther(payerLeft)} back to the payer, ${ethers.formatEther(creatorGot)} to the creator (was 99,900)`);

    expect(reachedPool).to.be.gt(0n);
    expect(creatorGot).to.equal(0n); // the whole defect: this used to be 99,900e18
    expect(payerLeft).to.equal(STOCK_SEED - reachedPool); // every unused wei came back
    expect(await stock.balanceOf(await factory.getAddress())).to.equal(0n); // nothing stranded
  });

  it("the pad token remainder still goes to the creator — that one was always correct", async () => {
    const token = await ethers.getContractAt("PadToken", (await factory.launches(0)).token);
    // the factory minted the whole supply to itself; everything not seeded is the creator's
    expect(await token.balanceOf(creator.address)).to.equal(E(1000000) - (await token.balanceOf(await pm.getAddress())));
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
  });

  it("stock parked in the factory by any other means does not leave with the next launcher", async () => {
    // the refund is now this launch's delta, not balanceOf(factory) — so a stray balance stays put
    const stray = E(7);
    await stock.transfer(await factory.getAddress(), stray);

    const payer2 = creator; // a different launcher this time
    await stock.transfer(payer2.address, STOCK_SEED);
    await stock.connect(payer2).approve(await factory.getAddress(), ethers.MaxUint256);

    const cfg = { ...cfgFor(), name: "Pad2", symbol: "PAD2" };
    const { tokenSalt, hookSalt } = await mineSalts(cfg);
    const before = await stock.balanceOf(payer2.address);
    await factory.connect(payer2).launch(cfg, tokenSalt, hookSalt);
    const spent = before - (await stock.balanceOf(payer2.address));

    expect(await stock.balanceOf(await factory.getAddress())).to.equal(stray); // untouched
    expect(spent).to.be.lt(STOCK_SEED); // they got their own remainder back...
    expect(spent).to.be.gt(0n); // ...and paid only for what the pool took
  });
});
