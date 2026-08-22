// REGRESSION TEST for M-1 (see AUDITOR-HANDOFF.md). PresaleVault.finalize handed the WHOLE totalRaised to one
// exact-input swap price-limited at the protocol's own graduation ceiling, while RobinFeeHook.beforeSwap charges
// buyTaxBps on the REQUESTED input regardless of how much actually executes. So a target larger than the curve's
// capacity taxed the entire raise to fill a sliver of it, and socialised the over-charge pro-rata across every
// contributor. finalize now sizes the request to what the freshly-seeded curve can absorb; the surplus never
// enters the swap and leaves through the pro-rata ETH-back path that pooledEthSpent already drives.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { brandedTokenSalt } = require("../helpers/brand");

const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;
const BUY_TAX_BPS = 100n; // 1%

// Hardhat keeps chain state across test FILES; snapshot so this file hands back what it spends.
describe("M-1 — a presale is taxed on what the curve absorbs, not on the whole target", () => {
  let __snap;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  let deployer, platform, creator, a, b, c;
  let pm, dep, reg, feeCfg, factory, presaleFactory, hookF;
  let factoryAddr, depAddr, pmAddr, regAddr;
  let tagN = 0;

  before(async () => {
    [deployer, platform, creator, a, b, c] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
    feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: Number(BUY_TAX_BPS), sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000,
      buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
      // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
      // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
      minFdvWei: 1n, maxFdvWei: (1n << 128n) - 1n,
    });
    factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(),
      await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
    const impl = await (await ethers.getContractFactory("PresaleVault")).deploy();
    presaleFactory = await (await ethers.getContractFactory("PresaleVaultFactory")).deploy(
      await factory.getAddress(), await impl.getAddress()
    );
    factoryAddr = await factory.getAddress();
    depAddr = await dep.getAddress();
    pmAddr = await pm.getAddress();
    regAddr = await reg.getAddress();
    hookF = await ethers.getContractFactory("RobinFeeHook");
  });

  // A SHALLOW curve: capacity is a fraction of the 3 ETH target. reserveSupply must clear the factory's
  // reserve check (>= curveSupply * sqrtGrad/sqrtStart * 1.05 ≈ 0.904 * curveSupply), so keep them equal.
  function shallowCfg(tag) {
    const curveSupply = 2n * 10n ** 17n, reserveSupply = 2n * 10n ** 17n; // 0.2e18 each
    return {
      name: "Robin " + tag, symbol: tag, decimals: 18,
      supply: curveSupply + reserveSupply, curveSupply, reserveSupply, tickSpacing: TS, startTickMag: 0, creator: creator.address,
    };
  }

  async function prepareSalts(tag, cfg) {
    // [brand] the pad token address must end in `1ab5` or the factory reverts BadTokenSuffix — mine the salt
    // from the EXACT cfg being launched. This path reaches the factory via PresaleVault.finalize, and the
    // commitment below binds the mined salt, so presale finalization stays consistent.
    const tokenSalt = await brandedTokenSalt(depAddr, factoryAddr, cfg, ethers.id("tok-" + tag));
    const curveSalt = ethers.id("curve-" + tag);
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenInit = ethers.concat([TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"],
        [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, factoryAddr])]);
    const predictedToken = ethers.getCreate2Address(depAddr, tokenSalt, ethers.keccak256(tokenInit));
    const { salt: hookSalt } = mineHookSalt(depAddr, hookInitCode(hookF.bytecode, pmAddr, factoryAddr, regAddr, predictedToken));
    const commitment = ethers.keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [tokenSalt, hookSalt, curveSalt]));
    return { tokenSalt, hookSalt, curveSalt, commitment, predictedToken };
  }

  async function runPresale(target) {
    const tag = "M1P" + (tagN++);
    const cfg = shallowCfg(tag);
    const salts = await prepareSalts(tag, cfg);
    const now = await time.latest();
    const minC = target / 10n; // three roughly-equal deposits must each clear it
    const args = [cfg, salts.commitment, target, BigInt(now) + 2n * 86400n, target, minC, 86400n];
    const vaultAddr = await presaleFactory.createPresale.staticCall(...args);
    await (await presaleFactory.createPresale(...args)).wait();
    const vault = await ethers.getContractAt("PresaleVault", vaultAddr);
    // a and b take a third each; c covers the exact remainder, so the target is met to the wei without a
    // sub-minimum top-up deposit
    for (const w of [a, b]) await vault.connect(w).deposit({ value: target / 3n });
    await vault.connect(c).deposit({ value: target - (await vault.totalRaised()) });

    // the vault stores neither the hook nor the poolId; Finalized carries the poolId and the hook address is
    // the CREATE2 address of the salt we mined
    const rc = await (await vault.finalize(salts.tokenSalt, salts.hookSalt, salts.curveSalt)).wait();
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Finalized");
    const poolId = ev.args.poolId;
    const hookAddr = ethers.getCreate2Address(depAddr, salts.hookSalt,
      ethers.keccak256(hookInitCode(hookF.bytecode, pmAddr, factoryAddr, regAddr, salts.predictedToken)));
    return { vault, hook: hookF.attach(hookAddr), poolId, target };
  }

  it("the buy tax now tracks what actually swapped, not the whole raise", async () => {
    const TARGET = E(3);
    const { vault, hook, poolId } = await runPresale(TARGET);

    const spent = await vault.pooledEthSpent();
    // referralShareBps is 0, so platform + buffer IS the entire buy tax the hook booked
    const taxed = (await hook.platformOwed(poolId, 0)) + (await hook.bufferOwed(poolId));

    const asPctOfTarget = Number((taxed * 1000000n) / TARGET) / 10000;
    console.log(`   raised ${ethers.formatEther(TARGET)} ETH; curve absorbed ${ethers.formatEther(spent)}; ` +
      `buy tax ${ethers.formatEther(taxed)} ETH = ${asPctOfTarget}% of the target (was 1% of the WHOLE target)`);

    expect(spent).to.be.lt(TARGET); // the curve genuinely could not absorb the raise — the defect's precondition
    expect(taxed).to.be.gt(0n);
    // THE NUMBER THAT MOVED: the tax is 1% of what swapped, not 1% of the target
    expect(taxed).to.equal((spent * BUY_TAX_BPS) / 10000n);
    expect(taxed).to.be.lt((TARGET * BUY_TAX_BPS) / 10000n); // strictly less than the old charge
  });

  it("the surplus comes back to contributors instead of being taxed away", async () => {
    const TARGET = E(3);
    const { vault } = await runPresale(TARGET);
    const spent = await vault.pooledEthSpent();
    const surplus = TARGET - spent;
    expect(surplus).to.be.gt(0n);

    // previewClaim's ETH-back leg is the pro-rata share of exactly that surplus
    const [, ethBackA] = await vault.previewClaim(a.address);
    const contribA = await vault.contribution(a.address);
    expect(ethBackA).to.equal((contribA * surplus) / TARGET);

    // and it is really paid: claiming returns it
    const before = await ethers.provider.getBalance(a.address);
    const rc = await (await vault.connect(a).claim()).wait();
    const net = (await ethers.provider.getBalance(a.address)) - before + rc.gasUsed * rc.gasPrice;
    expect(net).to.equal(ethBackA);
  });

  it("a presale that fits inside the curve is completely unaffected", async () => {
    // capacity for this geometry is ~0.130 ETH, so a 0.1 ETH target spends the WHOLE raise as before
    const TARGET = E("0.1");
    const { vault } = await runPresale(TARGET);
    expect(await vault.pooledEthSpent()).to.equal(TARGET); // amtIn == totalRaised, byte-identical behaviour
    const [, ethBack] = await vault.previewClaim(a.address);
    expect(ethBack).to.equal(0n);
  });
});
