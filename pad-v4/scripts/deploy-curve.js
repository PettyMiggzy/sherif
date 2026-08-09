/*
 * Bootstrap the Robin V4 "curve-on-V4" suite on Robinhood Chain (legacy type-0 txs, no EIP-1559).
 * Deploys the free single-sided bonding-curve launch stack + the governed v2 fee/economics config.
 *
 * Order (each depends on the prior):
 *   DeterministicDeployer → RobinStateView → FeeWalletRegistry → LockVault → CurveV4Deployer
 *     → RobinV4FeeConfig (governed v2 defaults) → CurvePadFactoryV4 → lockVault.setFactory
 *
 * The FeeConfig defaults are FORWARD-ONLY governance: retune them for FUTURE launches with
 * feeConfig.setDefaults(...) — never a factory redeploy. Live pads keep the fee they were born with.
 *
 * Post-deploy (out of band): transfer FeeWalletRegistry + RobinV4FeeConfig ownership to the platform
 * multisig (both Ownable2Step), then run  FACTORY=<curveFactory> node scripts/auto-verify.cjs --once.
 *
 * Usage: ROBINHOOD_RPC=<rpc> PRIVATE_KEY=<key> PLATFORM_WALLET=<addr> \
 *        npx hardhat run scripts/deploy-curve.js --network robinhood
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Governed v2 DEFAULT launch params (stamped IMMUTABLY per-pad at launch; retunable for future launches only).
// Geometry magnitudes are tick-spacing-aligned for ts=60 (201600/60, 25800/60, 22800/60 are integers).
const DEFAULTS = {
  buyTaxBps: Number(process.env.BUY_TAX_BPS || 100), // 1% buy trade tax → platform
  sellTaxBps: Number(process.env.SELL_TAX_BPS || 100), // 1% sell trade tax → creator + floor
  sellFloorShareBps: Number(process.env.SELL_FLOOR_SHARE_BPS || 2000), // 20% of the sell tax → floor (0.2% of trade)
  buyLpFloorShareBps: Number(process.env.BUY_LP_FLOOR_SHARE_BPS || 2000), // 20% of the buy LP fee → floor at grad
  lpFee: Number(process.env.LP_FEE || 10000), // 1% static pool LP fee
  startTickMag: Number(process.env.START_TICK_MAG || 201600), // curve top (launch price magnitude)
  curveWidth: Number(process.env.CURVE_WIDTH || 25800), // start → graduation ceiling span
  minGradWidth: Number(process.env.MIN_GRAD_WIDTH || 22800), // informational min-grad marker (< curveWidth)
  gradRewardWei: (process.env.GRAD_REWARD_WEI ? BigInt(process.env.GRAD_REWARD_WEI) : ethers.parseEther("0.5")).toString(),
};

async function legacyDeploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args, { type: 0 });
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(24)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = process.env.PLATFORM_WALLET || deployer.address;
  console.log(`Deploying Robin V4 curve suite as ${deployer.address} (platform wallet ${platform})\n`);

  const dep = await legacyDeploy("DeterministicDeployer");
  const stateView = await legacyDeploy("RobinStateView", [POOL_MANAGER]);
  const reg = await legacyDeploy("FeeWalletRegistry", [platform, deployer.address]);
  const lockVault = await legacyDeploy("LockVault", [POSITION_MANAGER, await reg.getAddress()]);
  const curveDeployer = await legacyDeploy("CurveV4Deployer", [await dep.getAddress()]);
  const feeConfig = await legacyDeploy("RobinV4FeeConfig", [deployer.address, DEFAULTS]);
  const factory = await legacyDeploy("CurvePadFactoryV4", [
    POOL_MANAGER,
    POSITION_MANAGER,
    PERMIT2,
    await stateView.getAddress(),
    await dep.getAddress(),
    await curveDeployer.getAddress(),
    await feeConfig.getAddress(),
    await reg.getAddress(),
    await lockVault.getAddress(),
  ]);

  const setTx = await lockVault.setFactory(await factory.getAddress(), { type: 0 });
  const rc = await setTx.wait();
  console.log(`  lockVault.setFactory -> ${await factory.getAddress()}\n`);

  const curveFactory = await factory.getAddress();
  const out = {
    chainId: Number(network.config.chainId || 4663),
    deployer: deployer.address,
    platformWallet: platform,
    poolManager: POOL_MANAGER,
    positionManager: POSITION_MANAGER,
    permit2: PERMIT2,
    // block the factory landed in — auto-verify.cjs backfills from here
    curveFactoryBlock: rc.blockNumber,
    defaults: DEFAULTS,
    contracts: {
      deterministicDeployer: await dep.getAddress(),
      stateView: await stateView.getAddress(),
      feeWalletRegistry: await reg.getAddress(),
      lockVault: await lockVault.getAddress(),
      curveDeployer: await curveDeployer.getAddress(),
      feeConfig: await feeConfig.getAddress(),
      curveFactory,
    },
  };
  const file = path.join(__dirname, "..", "deploy.curve.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
  console.log("\nNext:");
  console.log("  1. transfer FeeWalletRegistry + RobinV4FeeConfig ownership to the platform multisig (Ownable2Step)");
  console.log(`  2. FACTORY=${curveFactory} node scripts/auto-verify.cjs --once   (verify token/hook/curve on Blockscout)`);
  console.log("  3. per graduated pad: deploy RobinFloorVault + RobinAmbushVault + DualStaking, then");
  console.log("     curve.setFloor(floor) / curve.setStaking(staking) (platform-gated, one-shot each)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
