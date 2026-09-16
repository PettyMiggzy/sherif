/*
 * ARC LOCAL DEMO — same pattern as deploy-local-demo.js (fresh mock Uniswap v4 infra, real
 * CurvePadFactoryV4/RobinCurveV4/RobinFeeHook, real trades), but with the curve geometry
 * RECALIBRATED for Arc's native currency (USDC, ~$1/unit) instead of Robinhood Chain's ETH
 * (~$1,932/unit at the time deploy-curve.js's defaults were tuned).
 *
 * WHY startTickMag CHANGES AND curveWidth DOESN'T:
 * curveWidth is the tick SPAN from launch to graduation ceiling — a ratio (currently ~10x), so it
 * is currency-agnostic and stays identical on any chain. startTickMag is the ABSOLUTE starting
 * price, which is what has to move when the native currency's real-world value per unit changes.
 * Copying Robinhood Chain's startTickMag=201600 onto Arc unchanged would price the curve as if 1
 * native-USDC unit were worth ~$1,932 (it's worth ~$1) — the pad would graduate on ~$4 raised
 * instead of the intended ~$7,800. That is not a cosmetic bug; it is a broken product.
 *
 * THE MATH (verified against deploy-curve.js's own documented reference point):
 *   Robinhood Chain: startTickMag 201600 -> price 1.0001^201600 ~= 5.68e8 token/ETH
 *                     -> 1e9-supply FDV = 1e9 / 5.68e8 ~= 1.76 ETH ~= $3,400 (implies ETH ~= $1,932)
 *   Target (SAME real-dollar start): $3,400 / 1e9 tokens = 3.4e-6 USDC/token
 *                     -> need 1.0001^tick = 1/3.4e-6 = 294,118 -> tick = ln(294118)/ln(1.0001) ~= 125,924
 *                     -> rounded to the nearest tickSpacing=100 multiple: 125900
 * curveWidth (23000, ~10x) and minGradWidth (22800) are UNCHANGED — same shape, repositioned start.
 * minFdvWei/maxFdvWei bounds scale the same way: 0.05-100 ETH ($97-$193,200) -> ~100-200000 native
 * USDC-equivalent units (still called *Wei/parseEther in code — that just means "18-decimal units",
 * not literally ether; Arc's native 18-decimal interface uses the exact same parseEther() math).
 *
 * NEVER use this script's output against a real network — MockPermit2/MockPositionManagerV4 are not
 * real custody and this uses Hardhat's publicly-known dev private keys. Run against a plain (non-forked)
 * node reporting Arc's real chainId for realism:
 *   HARDHAT_CHAIN_ID=5042 npx hardhat node --hostname 0.0.0.0 --port 8545
 *   npx hardhat run scripts/deploy-arc-demo.js --network localhost
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { mineHookSalt, hookInitCode } = require("./mine");
const { brandedTokenSalt, predictPadToken } = require("../test/helpers/brand");

const abi = ethers.AbiCoder.defaultAbiCoder();
const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;

const START = 125900, WIDTH = 23000, GRAD = START - WIDTH, TS = 100, FEE = 10000, MINGRAD = 22800;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000,
  referralShareBps: 2500, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 1500,
  lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
  minFdvWei: ethers.parseEther("100"), maxFdvWei: ethers.parseEther("200000"),
};

async function deploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(28)} ${await c.getAddress()}`);
  return c;
}

async function launchDemoPad(S, { name, symbol, supplyM, curveShareBps, tag, creator }) {
  const supply = BigInt(supplyM) * 10n ** 18n;
  const curveSupply = (supply * BigInt(curveShareBps)) / 10000n;
  const reserveSupply = supply - curveSupply;
  const cfg = {
    name, symbol, decimals: 18, supply, curveSupply, reserveSupply,
    tickSpacing: TS, startTickMag: 0, creator: creator.address, noPoolForever: false,
  };
  const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id(tag));
  const TokenF = await ethers.getContractFactory("PadToken");
  const predictedToken = predictPadToken(await S.dep.getAddress(), await S.factory.getAddress(), cfg, tokenSalt, TokenF.bytecode);
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    await S.dep.getAddress(),
    hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predictedToken)
  );
  const curveSalt = ethers.id(tag + "-curve");
  const ret = await S.factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  await (await S.factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  console.log(`  launched ${symbol.padEnd(6)} token=${ret[0]} curve=${ret[2]}`);
  return { token: ret[0], hook: ret[1], curveAddr: ret[2], poolId: ret[3], cfg };
}

async function simulateTrades(S, pad, buyers) {
  const key = { currency0: ZERO, currency1: pad.token, fee: FEE, tickSpacing: TS, hooks: pad.hook };
  for (const { signer, nativeIn } of buyers) {
    await S.sw.connect(signer).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(String(nativeIn)), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(String(nativeIn)) }
    );
  }
  // one seller sells a slice back, so the chart shows two-sided activity
  const tok = await ethers.getContractAt("PadToken", pad.token);
  const seller = buyers[0].signer;
  const bal = await tok.balanceOf(seller.address);
  if (bal > 0n) {
    await tok.connect(seller).approve(await S.sw.getAddress(), ethers.MaxUint256);
    await S.sw.connect(seller).swap(
      key, { zeroForOne: false, amountSpecified: -(bal / 4n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
  }
}

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, platform, creatorA, creatorB, creatorC, buyer1, buyer2, buyer3] = signers;

  const liveChainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`Deploying ARC LOCAL DEMO stack (chainId ${liveChainId}) as ${deployer.address}\n`);
  if (liveChainId !== 5042) {
    console.log(`  WARNING: expected chainId 5042 (Arc mainnet) for realism — got ${liveChainId}.`);
    console.log(`  Start the node with HARDHAT_CHAIN_ID=5042 npx hardhat node --hostname 0.0.0.0 --port 8545\n`);
  }

  const pm = await deploy("PoolManager", [deployer.address]);
  const stateView = await deploy("RobinStateView", [await pm.getAddress()]);
  const dep = await deploy("DeterministicDeployer");
  const reg = await deploy("FeeWalletRegistry", [platform.address, deployer.address]);
  const permit2 = await deploy("MockPermit2");
  const posm = await deploy("MockPositionManagerV4", [await pm.getAddress(), await permit2.getAddress()]);
  const lockVault = await deploy("LockVault", [await posm.getAddress(), await reg.getAddress()]);
  const curveDep = await deploy("CurveV4Deployer", [await dep.getAddress()]);
  const feeCfg = await deploy("RobinV4FeeConfig", [deployer.address, DEFAULTS]);
  const factory = await deploy("CurvePadFactoryV4", [
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress(),
  ]);
  await (await lockVault.setFactory(await factory.getAddress())).wait();
  const sw = await deploy("PoolSwapTest", [await pm.getAddress()]);
  const arrowLauncher = await deploy("ArrowLauncher", [await factory.getAddress(), await reg.getAddress(), ethers.parseEther("150")]);
  const burnTracker = await deploy("RobinBurnTracker");

  console.log("\nLaunching demo pads...");
  const S = { pm, stateView, dep, reg, permit2, posm, lockVault, curveDep, feeCfg, factory, sw };

  // Same 73/27 curve/reserve split as the production reference geometry — that split is about
  // pairing the permanent LP correctly at graduation, unrelated to which currency is native.
  const padA = await launchDemoPad(S, { name: "Arc Demo Alpha", symbol: "AALPHA", supplyM: 1_000_000_000, curveShareBps: 7300, tag: "arc-demo-alpha", creator: creatorA });
  await simulateTrades(S, padA, [{ signer: buyer1, nativeIn: 1500 }, { signer: buyer2, nativeIn: 2800 }, { signer: buyer3, nativeIn: 580 }]);

  const padB = await launchDemoPad(S, { name: "Arc Demo Beta", symbol: "ABETA", supplyM: 500_000_000, curveShareBps: 7300, tag: "arc-demo-beta", creator: creatorB });
  await simulateTrades(S, padB, [{ signer: buyer2, nativeIn: 3800 }, { signer: buyer1, nativeIn: 950 }]);

  const padC = await launchDemoPad(S, { name: "Arc Demo Gamma", symbol: "AGAMMA", supplyM: 2_000_000_000, curveShareBps: 7300, tag: "arc-demo-gamma", creator: creatorC });
  await simulateTrades(S, padC, [{ signer: buyer3, nativeIn: 6100 }]);

  // Real proof the recalibration landed correctly: read the curve's own start/grad sqrt prices back
  // and print the implied FDV in native-USDC units (~= USD, since Arc's native unit is ~$1).
  console.log("\nVerifying recalibrated economics against padA's live curve state:");
  const curveA = await ethers.getContractAt("RobinCurveV4", padA.curveAddr);
  const startTick = await curveA.startTick();
  const gradTickVal = await curveA.gradTick();
  console.log(`  startTick=${startTick} gradTick=${gradTickVal} (width=${Number(startTick) - Number(gradTickVal)}, expect ${WIDTH})`);

  const out = {
    chainId: 5042,
    rpcUrl: "http://127.0.0.1:8545",
    deployedAt: new Date().toISOString(),
    accounts: {
      deployer: deployer.address, platform: platform.address,
      creatorA: creatorA.address, creatorB: creatorB.address, creatorC: creatorC.address,
      buyer1: buyer1.address, buyer2: buyer2.address, buyer3: buyer3.address,
    },
    contracts: {
      poolManager: await pm.getAddress(),
      stateView: await stateView.getAddress(),
      deterministicDeployer: await dep.getAddress(),
      feeWalletRegistry: await reg.getAddress(),
      permit2: await permit2.getAddress(),
      positionManager: await posm.getAddress(),
      lockVault: await lockVault.getAddress(),
      curveDeployer: await curveDep.getAddress(),
      feeConfig: await feeCfg.getAddress(),
      curveFactory: await factory.getAddress(),
      poolSwapTest: await sw.getAddress(),
      arrowLauncher: await arrowLauncher.getAddress(),
      burnTracker: await burnTracker.getAddress(),
    },
    pads: [padA, padB, padC].map((p) => ({
      token: p.token, hook: p.hook, curve: p.curveAddr, poolId: p.poolId,
      name: p.cfg.name, symbol: p.cfg.symbol,
    })),
  };
  const file = path.join(__dirname, "..", "..", "pad", "js", "deploy.arc.local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
