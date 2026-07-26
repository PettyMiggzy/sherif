// Deploy RobinDistributor to Robinhood Chain with an initial increment.
//   npm run deploy
// Uses plain ethers with a legacy tx (chain 4663 has no EIP-1559).
const { getProvider, getWallet, legacyOverrides, loadArtifact, resolveUnitWei, ethers, CHAIN } = require("./lib");

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const art = loadArtifact();
  const unitWei = await resolveUnitWei();

  console.log(`Deployer   : ${wallet.address}`);
  console.log(`Increment  : ${ethers.formatEther(unitWei)} ETH  (${unitWei} wei)`);

  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const ov = await legacyOverrides(provider);
  const contract = await factory.deploy(unitWei, ov);
  console.log(`Deploy tx  : ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  console.log(`\n✓ Deployed RobinDistributor at ${addr}`);
  console.log(`  ${CHAIN.explorer}/address/${addr}`);
  console.log(`\nNext:`);
  console.log(`  1) add CONTRACT_ADDRESS=${addr} to .env`);
  console.log(`  2) npm run load          # push the 1000 recipients on-chain (batched)`);
  console.log(`  3) send the ETH to distribute to ${addr}`);
  console.log(`  4) npm run plan  &&  npm run distribute`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
