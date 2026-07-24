// Deploy ONLY the TokenVestingLock — a standalone, dependency-free singleton.
//
//   npx hardhat run scripts/deploy-vesting.js --network robinhood     (PRIVATE_KEY in .env)
//
// SAFETY: this script deploys exactly ONE new contract and touches nothing else.
// It does NOT read, call, or redeploy the factory, router, curves, tokens, or any
// live pad contract. The pad and its users are completely unaffected.
const { ethers, network } = require("hardhat");

async function main() {
  // Refuse to run against the wrong chain (a stray --network would waste ETH on a chain
  // where this contract isn't wanted).
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 4663) throw new Error(`Wrong chain: connected to ${net.chainId}, expected 4663 (Robinhood). Aborting.`);
  const [deployer] = await ethers.getSigners();
  // Robinhood Chain has no EIP-1559 — deploy as a legacy (type-0) tx with explicit gasPrice.
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gasPrice (legacy chain expected)");
  const ov = { type: 0, gasPrice };

  console.log(`network=${network.name}  deployer=${deployer.address}`);
  console.log(`Deploying TokenVestingLock (no constructor args, no dependencies)…`);

  const lock = await (await ethers.getContractFactory("TokenVestingLock")).deploy(ov);
  const rc = await lock.deploymentTransaction().wait();
  const addr = await lock.getAddress();

  console.log(`\n✓ TokenVestingLock deployed: ${addr}  (gas ${rc.gasUsed})`);
  console.log(`  It knows nothing about the factory/router — creators opt in by locking their own tokens.`);
  console.log(`\n=== add to pad/assets/config.js CONTRACTS ===`);
  console.log(`  tokenVestingLock: "${addr}",`);
}

main().catch((e) => { console.error(e); process.exit(1); });
