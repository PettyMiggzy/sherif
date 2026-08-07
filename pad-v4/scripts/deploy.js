/*
 * Bootstrap the Robin V4 spine on Robinhood Chain (legacy type-0 txs, no EIP-1559).
 * Order matters — see ROBIN-V4-ARCHITECTURE.md §5.2:
 *   DeterministicDeployer → RobinStateView → FeeWalletRegistry → LockVault → PadFactory → lockVault.setFactory
 * Then transfer FeeWalletRegistry ownership to the platform multisig (Ownable2Step) out of band.
 *
 * Usage: ROBINHOOD_RPC=<rpc> PRIVATE_KEY=<key> PLATFORM_WALLET=<addr> \
 *        npx hardhat run scripts/deploy.js --network robinhood
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function legacyDeploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  // hardhat-ethers reads the network's gasPrice hint; force legacy (type-0) explicitly.
  const c = await f.deploy(...args, { type: 0 });
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name.padEnd(22)} ${addr}`);
  return c;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = process.env.PLATFORM_WALLET || deployer.address;
  console.log(`Deploying Robin V4 spine as ${deployer.address} (platform wallet ${platform})\n`);

  const dep = await legacyDeploy("DeterministicDeployer");
  const stateView = await legacyDeploy("RobinStateView", [POOL_MANAGER]);
  const reg = await legacyDeploy("FeeWalletRegistry", [platform, deployer.address]);
  const lockVault = await legacyDeploy("LockVault", [POSITION_MANAGER, await reg.getAddress()]);
  const factory = await legacyDeploy("PadFactory", [
    POOL_MANAGER,
    POSITION_MANAGER,
    PERMIT2,
    await dep.getAddress(),
    await reg.getAddress(),
    await lockVault.getAddress(),
  ]);

  const tx = await lockVault.setFactory(await factory.getAddress(), { type: 0 });
  await tx.wait();
  console.log(`  lockVault.setFactory -> ${await factory.getAddress()}\n`);

  const out = {
    chainId: Number(network.config.chainId || 4663),
    deployer: deployer.address,
    platformWallet: platform,
    poolManager: POOL_MANAGER,
    positionManager: POSITION_MANAGER,
    permit2: PERMIT2,
    deterministicDeployer: await dep.getAddress(),
    stateView: await stateView.getAddress(),
    feeWalletRegistry: await reg.getAddress(),
    lockVault: await lockVault.getAddress(),
    padFactory: await factory.getAddress(),
  };
  const file = path.join(__dirname, "..", "deploy.local.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
  console.log("\nNext: verify on Blockscout, then transfer FeeWalletRegistry ownership to the multisig.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
