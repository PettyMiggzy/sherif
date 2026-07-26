// Deploy the stateless Disperse multisend to Robinhood Chain.
//   npm run deploy:disperse
const { getProvider, getWallet, baseFeeOverrides, loadDisperseArtifact, ethers, CHAIN } = require("./lib");

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const art = loadDisperseArtifact();

  console.log(`Deployer : ${wallet.address}`);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  // This chain's RPC can't eth_estimateGas a deploy ("missing revert data"), so
  // we set an explicit gasLimit — ethers then skips estimation and just sends.
  // Disperse deploys in ~1.02M gas; 2M is a safe ceiling, well under the cap.
  const gasLimit = BigInt(process.env.DEPLOY_GAS_LIMIT || 2_000_000);
  const ov = await baseFeeOverrides(provider, { gasLimit });
  const c = await factory.deploy(ov);
  console.log(`Deploy tx: ${c.deploymentTransaction().hash}  @ ${ethers.formatUnits(ov.gasPrice, "gwei")} gwei`);
  await c.waitForDeployment();
  const addr = await c.getAddress();

  console.log(`\n✓ Disperse deployed at ${addr}`);
  console.log(`  ${CHAIN.explorer}/address/${addr}`);
  console.log(`\nNext:`);
  console.log(`  1) add DISPERSE_ADDRESS=${addr} to .env`);
  console.log(`  2) send Robinhood ETH to your wallet ${wallet.address}`);
  console.log(`  3) npm run watch     (auto-disperses on every deposit)`);
  console.log(`     or npm run disperse:once   (one pass now)`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
