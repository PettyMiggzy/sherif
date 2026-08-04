// Deploy ONLY the Disperse helper (multi-send for airdrops + "split my dev buy").
//
//   npx hardhat run scripts/deploy-disperse.js --network robinhood     (PRIVATE_KEY in .env)
//
// SAFETY: deploys ONE new, owner-less, non-custodial utility contract. It has NO
// constructor args and NO connection to the factory/router/curves/tokens — it
// only ever moves a caller's own funds to the caller's own list. Nothing existing
// is touched or redeployed. After it confirms, paste the printed address into
// pad/assets/config.js CONTRACTS.disperse and verify it on the explorer.
const { ethers } = require("hardhat");

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 4663) {
    throw new Error(`Wrong chain: connected to ${net.chainId}, expected 4663 (Robinhood). Aborting.`);
  }
  const [deployer] = await ethers.getSigners();

  // Legacy gas (this chain has no EIP-1559), floored above the moving base fee.
  let gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gasPrice (legacy chain expected)");
  try {
    const blk = await ethers.provider.getBlock("latest");
    const floor = ((blk?.baseFeePerGas ?? 0n) * 12n) / 10n;
    if (floor > gasPrice) gasPrice = floor;
  } catch {}
  const ov = { type: 0, gasPrice };

  console.log("Deployer:", deployer.address, "| chain:", Number(net.chainId), "| gasPrice:", gasPrice.toString());
  const Disperse = await ethers.getContractFactory("Disperse");
  const disperse = await Disperse.deploy(ov);
  await disperse.waitForDeployment();
  const addr = await disperse.getAddress();

  console.log("\nDisperse deployed at:", addr);
  console.log("Next steps:");
  console.log("  1. Set CONTRACTS.disperse =", `"${addr}"`, "in pad/assets/config.js");
  console.log("  2. Verify:  npx hardhat verify --network robinhood", addr);
  console.log("     (or the project's auto-verify script)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
