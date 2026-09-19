/*
 * LOCAL DEMO ONLY — deploys the full curve-pad stack to a local Hardhat node (chainId 31337, started with
 * `npx hardhat node`), using MockPermit2/MockPositionManagerV4 in place of the real (differently-pinned-solc)
 * Uniswap v4 periphery contracts — the same substitution the local unit/sim test suite uses. Launches a
 * handful of REAL demo pads through the REAL CurvePadFactoryV4 (real mined hook, real PadToken, real seeded
 * curve) and runs some REAL buy/sell swaps against them so the frontend has real on-chain data to read.
 *
 * NEVER use this script's output against a real network — MockPermit2/MockPositionManagerV4 are not real
 * custody and this uses Hardhat's publicly-known dev private keys.
 *
 * Usage: npx hardhat run scripts/deploy-local-demo.js --network localhost
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

const START = 201600, WIDTH = 23000, GRAD = START - WIDTH, TS = 100, FEE = 10000, MINGRAD = 22800;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000,
  referralShareBps: 2500, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 1500,
  lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
  minFdvWei: ethers.parseEther("0.05"), maxFdvWei: ethers.parseEther("100"),
};

async function deploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(28)} ${await c.getAddress()}`);
  return c;
}

async function launchDemoPad(S, { name, symbol, supplyM, curveShareBps, tag, creator, auctionDays = 0 }) {
  const supply = BigInt(supplyM) * 10n ** 18n;
  const curveSupply = (supply * BigInt(curveShareBps)) / 10000n;
  const reserveSupply = supply - curveSupply;
  const cfg = {
    name, symbol, decimals: 18, supply, curveSupply, reserveSupply,
    tickSpacing: TS, startTickMag: 0, creator: creator.address, noPoolForever: false, lpFee: 10000, auctionDays,
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
  for (const { signer, ethIn } of buyers) {
    await S.sw.connect(signer).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(String(ethIn)), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(String(ethIn)) }
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

  console.log(`Deploying LOCAL DEMO stack (chainId ${network.config.chainId ?? 31337}) as ${deployer.address}\n`);

  const pm = await deploy("PoolManager", [deployer.address]);
  const stateView = await deploy("RobinStateView", [await pm.getAddress()]);
  const dep = await deploy("DeterministicDeployer");
  const reg = await deploy("FeeWalletRegistry", [platform.address, deployer.address]);
  const permit2 = await deploy("MockPermit2");
  const posm = await deploy("MockPositionManagerV4", [await pm.getAddress(), await permit2.getAddress()]);
  const lockVault = await deploy("LockVault", [await posm.getAddress(), await reg.getAddress()]);
  const curveDep = await deploy("CurveV4Deployer", [await dep.getAddress()]);
  const feeCfg = await deploy("RobinV4FeeConfig", [deployer.address, DEFAULTS]);
  const robinStakingV4Deployer = await deploy("RobinStakingV4Deployer", []);
  const auctionVaultDeployer = await deploy("DailyAuctionVaultV4Deployer", [await robinStakingV4Deployer.getAddress()]);
  // [EIP-170] the factory forwards hook deploys here and REVERTS BadConfig() on a zero address.
  const feeHookDeployer = await deploy("FeeHookDeployer", [await dep.getAddress()]);
  const factory = await deploy("CurvePadFactoryV4", [
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress(),
    await auctionVaultDeployer.getAddress(),
    await feeHookDeployer.getAddress(),
  ]);
  await (await lockVault.setFactory(await factory.getAddress())).wait();
  const sw = await deploy("PoolSwapTest", [await pm.getAddress()]);
  const arrowLauncher = await deploy("ArrowLauncher", [await factory.getAddress(), await reg.getAddress(), ethers.parseEther("0.08")]);
  const burnTracker = await deploy("RobinBurnTracker");

  console.log("\nLaunching demo pads...");
  const S = { pm, stateView, dep, reg, permit2, posm, lockVault, curveDep, feeCfg, factory, sw };

  // [HIGH-2] curveShareBps must leave enough reserve to pair the permanent LP at this fixed tick geometry —
  // reuse the exact 73/27 split the production reference geometry (deploy-curve.js) ships with for all three.
  const padA = await launchDemoPad(S, { name: "Robin Demo Alpha", symbol: "RALPHA", supplyM: 1_000_000_000, curveShareBps: 7300, tag: "demo-alpha", creator: creatorA });
  await simulateTrades(S, padA, [{ signer: buyer1, ethIn: 0.8 }, { signer: buyer2, ethIn: 1.5 }, { signer: buyer3, ethIn: 0.3 }]);

  const padB = await launchDemoPad(S, { name: "Robin Demo Beta", symbol: "RBETA", supplyM: 500_000_000, curveShareBps: 7300, tag: "demo-beta", creator: creatorB });
  await simulateTrades(S, padB, [{ signer: buyer2, ethIn: 2.0 }, { signer: buyer1, ethIn: 0.5 }]);

  const padC = await launchDemoPad(S, { name: "Robin Demo Gamma", symbol: "RGAMMA", supplyM: 2_000_000_000, curveShareBps: 7300, tag: "demo-gamma", creator: creatorC });
  await simulateTrades(S, padC, [{ signer: buyer3, ethIn: 3.2 }]);

  // [AUCTION] a 4th pad with a 2-day auction wired on, so the bench UI has a real vault + a real open bidding
  // window to read from without needing a fresh launch first.
  const padD = await launchDemoPad(S, { name: "Robin Demo Delta", symbol: "RDELTA", supplyM: 1_000_000_000, curveShareBps: 7300, tag: "demo-delta", creator: creatorA, auctionDays: 2 });
  const vaultD = await factory.auctionVaultOf(padD.token);
  const vaultC = await ethers.getContractAt("DailyAuctionVaultV4", vaultD);
  await (await vaultC.connect(buyer1).bid(1, { value: ethers.parseEther("0.3") })).wait();
  await (await vaultC.connect(buyer2).bid(1, { value: ethers.parseEther("0.2") })).wait();
  console.log(`  auction vault ${vaultD} — day 1: buyer1 0.3 ETH + buyer2 0.2 ETH bid`);

  const out = {
    chainId: 31337,
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
      robinStakingV4Deployer: await robinStakingV4Deployer.getAddress(),
      auctionVaultDeployer: await auctionVaultDeployer.getAddress(),
      curveFactory: await factory.getAddress(),
      poolSwapTest: await sw.getAddress(),
      arrowLauncher: await arrowLauncher.getAddress(),
      burnTracker: await burnTracker.getAddress(),
    },
    pads: [padA, padB, padC, padD].map((p) => ({
      token: p.token, hook: p.hook, curve: p.curveAddr, poolId: p.poolId,
      name: p.cfg.name, symbol: p.cfg.symbol, auctionDays: p.cfg.auctionDays,
    })),
    auctionVault: vaultD,
  };
  const file = path.join(__dirname, "..", "..", "pad", "js", "deploy.local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
