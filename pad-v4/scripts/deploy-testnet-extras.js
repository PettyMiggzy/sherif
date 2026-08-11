/* Deploy the TESTNET-ONLY swap router (Uniswap's PoolSwapTest) so the staging bench can buy/sell the V4
 * curve pools from a browser. Not for mainnet — production buys route through the real pad router/UI.
 * Run: PRIVATE_KEY=<hot> npx hardhat run scripts/deploy-testnet-extras.js --network robinhoodTestnet */
const { ethers } = require("hardhat");
const POOL_MANAGER = process.env.POOL_MANAGER || "0x8366a39CC670B4001A1121B8F6A443A643e40951";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying testnet extras as ${deployer.address}`);
  const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(POOL_MANAGER, { type: 0 });
  await sw.waitForDeployment();
  const addr = await sw.getAddress();
  console.log(`\n  PoolSwapTest (swap router)  ${addr}\n`);
  console.log("Paste this into the staging bench's “Swap router” field (or ADDR.swapRouter in staging/config.js).");
}
main().catch((e) => { console.error(e); process.exit(1); });
