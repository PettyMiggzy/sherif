// Deploy ONLY RobinLimit — the non-custodial limit-order / DCA executor.
//
//   npx hardhat run scripts/deploy-robinlimit.js --network robinhood     (PRIVATE_KEY in .env)
//
// SAFETY: this deploys exactly ONE new contract and touches nothing else. RobinLimit only ever
// CALLS the routing venue (padRouter) the same way a normal user does; it does NOT read, modify,
// or redeploy the factory, router, curves, tokens, the $ROBIN token, or any live pad contract.
// The pad and its users are completely unaffected by this deploy.
//
// IMPORTANT: this contract moves user funds. Review RobinLimit.REVIEW.md + get an independent audit
// BEFORE running this against mainnet. It is intentionally not deployed for you.
const { ethers, network } = require("hardhat");

// The routing venue + owner. Defaults: the LIVE padRouter (limit orders on pad coins) and the cold
// wallet as owner. Override with env vars if you want RobinSwap or a different owner.
const WETH  = process.env.ROBINLIMIT_WETH  || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // WETH9 on 4663
const VENUE = process.env.ROBINLIMIT_VENUE || "0xA6BaAB820809C7fC8350311776627298f91F07eC"; // LIVE PadRouter
const OWNER = process.env.ROBINLIMIT_OWNER || "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf"; // cold wallet

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 4663) throw new Error(`Wrong chain: connected to ${net.chainId}, expected 4663 (Robinhood). Aborting.`);

  // Preflight: the venue + WETH must actually be contracts (a typo'd address would deploy a bricked executor).
  for (const [name, addr] of [["WETH", WETH], ["venue", VENUE]]) {
    if (!ethers.isAddress(addr)) throw new Error(`${name} is not a valid address: ${addr}`);
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`${name} (${addr}) has no code on chain ${net.chainId}. Aborting.`);
  }
  if (!ethers.isAddress(OWNER)) throw new Error(`owner is not a valid address: ${OWNER}`);

  const [deployer] = await ethers.getSigners();
  // Robinhood Chain has no EIP-1559 — deploy as a legacy (type-0) tx with an explicit gasPrice floored
  // above the latest base fee so it doesn't sit unmined.
  let gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gasPrice (legacy chain expected)");
  try { const blk = await ethers.provider.getBlock("latest"); const floor = ((blk?.baseFeePerGas ?? 0n) * 12n) / 10n; if (floor > gasPrice) gasPrice = floor; } catch {}
  const ov = { type: 0, gasPrice };

  console.log(`network=${network.name}  chainId=${net.chainId}  deployer=${deployer.address}`);
  console.log(`Deploying RobinLimit(WETH=${WETH}, venue=${VENUE}, owner=${OWNER})…`);

  const rl = await (await ethers.getContractFactory("RobinLimit")).deploy(WETH, VENUE, OWNER, ov);
  const rc = await rl.deploymentTransaction().wait();
  const addr = await rl.getAddress();

  console.log(`\n✓ RobinLimit deployed: ${addr}  (gas ${rc.gasUsed})`);
  console.log(`  Routes through venue ${VENUE}; owner (fee tuner) is ${OWNER}.`);
  console.log(`\n=== 1) verify source on Blockscout ===`);
  console.log(`  npx hardhat verify --network robinhood ${addr} ${WETH} ${VENUE} ${OWNER}`);
  console.log(`\n=== 2) wire the frontend: pad/assets/config.js CONTRACTS ===`);
  console.log(`  robinLimit: "${addr}",`);
  console.log(`\n=== 3) wire the indexer: droplet .env, then restart ===`);
  console.log(`  ROBIN_LIMIT=${addr}`);
  console.log(`  WETH=${WETH}`);
  console.log(`\n=== 4) run the keeper (funded hot wallet, NOT the deployer/cold key) ===`);
  console.log(`  KEEPER_KEY=0x<hot-wallet-key> node src/keeper.js   (in the indexer service)`);
  console.log(`\nThe Automations panel appears on the portfolio once step 2 deploys to the site.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
