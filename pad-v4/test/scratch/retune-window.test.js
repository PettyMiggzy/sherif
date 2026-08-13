const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");

const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;

async function deployStack(deployer, platform) {
  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
  const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
  const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
  const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
  const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
  const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
    platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
    lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
  });
  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, lockVault, curveDep, feeCfg, factory };
}

describe("SCRATCH — feeConfig retune window vs. an open presale", () => {
  let signers, deployer, platform, creator, S, presaleFactory, impl;
  let factoryAddr, depAddr, pmAddr, regAddr, tagN = 0;

  before(async () => {
    signers = await ethers.getSigners();
    [deployer, platform, creator] = [signers[0], signers[1], signers[2]];
    S = await deployStack(deployer, platform);
    impl = await (await ethers.getContractFactory("PresaleVault")).deploy();
    presaleFactory = await (await ethers.getContractFactory("PresaleVaultFactory")).deploy(
      await S.factory.getAddress(), await impl.getAddress()
    );
    factoryAddr = await S.factory.getAddress();
    depAddr = await S.dep.getAddress();
    pmAddr = await S.pm.getAddress();
    regAddr = await S.reg.getAddress();
  });

  function makeCfg(tag) {
    const curveSupply = 100000n * 10n ** 18n, reserveSupply = 100000n * 10n ** 18n;
    return {
      name: "Robin " + tag, symbol: tag, decimals: 18,
      supply: curveSupply + reserveSupply, curveSupply, reserveSupply, tickSpacing: TS, creator: creator.address,
    };
  }

  async function prepareSalts(tag, cfg) {
    const tokenSalt = ethers.id("tok-" + tag);
    const curveSalt = ethers.id("curve-" + tag);
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenInit = ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, factoryAddr]),
    ]);
    const predictedToken = ethers.getCreate2Address(depAddr, tokenSalt, ethers.keccak256(tokenInit));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(depAddr, hookInitCode(HookF.bytecode, pmAddr, factoryAddr, regAddr, predictedToken));
    const commitment = ethers.keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [tokenSalt, hookSalt, curveSalt]));
    return { tokenSalt, hookSalt, curveSalt, commitment };
  }

  async function openAndFund(tagPrefix) {
    const tag = tagPrefix + (tagN++);
    const cfg = makeCfg(tag);
    const salts = await prepareSalts(tag, cfg);
    const now = await time.latest();
    const vaultAddr = await presaleFactory.createPresale.staticCall(
      cfg, salts.commitment, E(3), BigInt(now) + 2n * 86400n, E(2), E("0.1"), 86400n
    );
    await (await presaleFactory.createPresale(
      cfg, salts.commitment, E(3), BigInt(now) + 2n * 86400n, E(2), E("0.1"), 86400n
    )).wait();
    const vault = await ethers.getContractAt("PresaleVault", vaultAddr);
    await vault.connect(signers[3]).deposit({ value: E(2) }); // alice
    await vault.connect(signers[4]).deposit({ value: E(1) }); // bob
    expect(await vault.totalRaised()).to.equal(E(3));
    return { vault, vaultAddr, salts, cfg };
  }

  it("owner setDefaults mid-presale reprices already-collected contributor ETH", async () => {
    // Two identical presales, both fully subscribed under the ADVERTISED geometry.
    const A = await openAndFund("A");
    const B = await openAndFund("B");

    // A finalizes under the advertised defaults
    await (await A.vault.finalize(A.salts.tokenSalt, A.salts.hookSalt, A.salts.curveSalt)).wait();
    const boughtA = await A.vault.totalTokensBought();
    const spentA = await A.vault.pooledEthSpent();

    // owner retunes geometry — in-cap, tick-aligned, accepted with no timelock
    await (await S.feeCfg.connect(deployer).setDefaults({
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: 60, curveWidth: 3000, minGradWidth: MINGRAD,
    })).wait();

    // B finalizes with the SAME 3 ETH — no revert, no KeyMismatch
    await (await B.vault.finalize(B.salts.tokenSalt, B.salts.hookSalt, B.salts.curveSalt)).wait();
    const boughtB = await B.vault.totalTokensBought();
    const spentB = await B.vault.pooledEthSpent();

    console.log("  A tokens:", ethers.formatEther(boughtA), " ethSpent:", ethers.formatEther(spentA));
    console.log("  B tokens:", ethers.formatEther(boughtB), " ethSpent:", ethers.formatEther(spentB));
    console.log("  token delta %:", Number((boughtA - boughtB) * 10000n / boughtA) / 100);

    // post-buy pool prices, to see whether the token loss is nominal (price) or real (value)
    const idA = await S.factory.poolOf(await A.vault.token());
    const idB = await S.factory.poolOf(await B.vault.token());
    const [spA, tickA] = await S.stateView.getSlot0(idA);
    const [spB, tickB] = await S.stateView.getSlot0(idB);
    console.log("  post-buy tick A:", tickA.toString(), " B:", tickB.toString());
    // value of the presale bag in ETH at the resulting spot price: tokens / (price token-per-ETH)
    // price1/0 = (sqrtP/2^96)^2  => ETH value = tokens / price
    const Q = 2n ** 96n;
    const valA = (boughtA * Q * Q) / (BigInt(spA) * BigInt(spA));
    const valB = (boughtB * Q * Q) / (BigInt(spB) * BigInt(spB));
    console.log("  bag ETH-value at post-buy spot A:", ethers.formatEther(valA), " B:", ethers.formatEther(valB));
    console.log("  share of total supply A:", Number(boughtA * 10n ** 8n / (200000n * 10n ** 18n)) / 1e8,
                " B:", Number(boughtB * 10n ** 8n / (200000n * 10n ** 18n)) / 1e8);

    // claims still pay out at the new price — contributors have no exit
    const pv = await B.vault.previewClaim(signers[3].address);
    console.log("  bob/alice preview after retune (alice 2 ETH):", ethers.formatEther(pv[0]));
  });

  it("does the retune also break/limit anything harder — try the extreme in-cap geometry", async () => {
    // how far can geometry legally move? startTickMag must be >0 and ts-aligned; curveWidth > minGradWidth.
    await expect(S.feeCfg.connect(deployer).setDefaults({
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: 60, curveWidth: 60, minGradWidth: 1800,
    })).to.be.reverted; // minGradWidth >= curveWidth
    // non-owner cannot
    await expect(S.feeCfg.connect(signers[5]).setDefaults({
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: 60, curveWidth: 3000, minGradWidth: MINGRAD,
    })).to.be.reverted;
  });
});
