// Deploy the ROBIN staking stack — RewardConverter + StakingFactory + the flagship $ROBIN pool.
// Node 22 + Hardhat. Robinhood Chain is an Orbit L2 with NO EIP-1559, so every tx is legacy (type-0)
// with an explicit gasPrice.
//
//   cd launchpad
//   ROBINHOOD_RPC=<write-capable RPC> PRIVATE_KEY=<funded deployer> \
//     SWAP_ROUTER=<Uniswap SwapRouter02 on 4663> \
//     [KEEPER=<addr that calls convertAndFund>] \
//     node scripts/deploy-staking.js
//
// SWAP_ROUTER is the same SwapRouter02 the pad's RobinSwap uses (read it off the deployed RobinSwap via
// `swapRouter()` if you don't have it handy). After it prints the addresses, paste them into
// pad/assets/config.js (stakingFactory / robinStaking / rewardConverter) and verify on Blockscout.
const { ethers } = require("hardhat");

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ROBIN = "0x6696fe29288b586017e6f264c0091dba6c5ebeaf"; // $ROBIN LABS
const SGOV = "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5"; // tokenized T-bill (pre-fund; no liquid WETH pool)
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // deepest WETH pool of the stock names
const WEEK = 7 * 24 * 60 * 60;

async function main() {
  const swapRouter = (process.env.SWAP_ROUTER || "").trim();
  if (!ethers.isAddress(swapRouter)) throw new Error("Set SWAP_ROUTER to the Uniswap SwapRouter02 on chain 4663.");

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 4663) throw new Error(`Wrong chain ${net.chainId}, expected 4663.`);
  const keeper = (process.env.KEEPER || deployer.address).trim();

  // legacy gasPrice (no EIP-1559 on Orbit)
  let gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) gasPrice = BigInt(await ethers.provider.send("eth_gasPrice", []));
  const ov = { type: 0, gasPrice };

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address, "| balance", ethers.formatEther(bal), "ETH | gasPrice", gasPrice.toString());
  if (bal === 0n) throw new Error("Deployer has 0 ETH — fund it first.");

  // 1) RewardConverter(WETH, swapRouter, owner)
  const conv = await (await ethers.getContractFactory("RewardConverter")).deploy(WETH, swapRouter, deployer.address, ov);
  await conv.waitForDeployment();
  const convAddr = await conv.getAddress();
  console.log("RewardConverter:", convAddr);

  // 2) StakingFactory(owner, platformRewarder=converter) — the converter can fund every pool it creates
  const factory = await (await ethers.getContractFactory("StakingFactory")).deploy(deployer.address, convAddr, ov);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("StakingFactory: ", factoryAddr);

  // 3) The flagship $ROBIN pool: stake ROBIN, earn ETH (default) + SGOV (T-bill, pre-funded) + NVDA (auto-convert)
  const tx = await factory.createPool(ROBIN, [SGOV, NVDA], [WEEK, WEEK], deployer.address, ov);
  await tx.wait();
  const pool = await factory.poolOf(ROBIN);
  console.log("$ROBIN pool:    ", pool, "(rewards: ETH + SGOV + NVDA)");

  // 4) authorize the keeper on the converter (it calls convertAndFund / fundEth / fundToken)
  if (keeper.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await conv.setKeeper(keeper, true, ov)).wait();
    console.log("Keeper set:     ", keeper);
  }

  console.log("\nPaste into pad/assets/config.js CONTRACTS:");
  console.log(`  stakingFactory: "${factoryAddr}",`);
  console.log(`  robinStaking:   "${pool}",`);
  console.log(`  rewardConverter:"${convAddr}",`);
  console.log("\nThen verify all three on robinhoodchain.blockscout.com and fund rewards:");
  console.log("  • ETH/NVDA: send ETH to the converter, then keeper calls convertAndFund / fundEth");
  console.log("  • SGOV: send SGOV to the converter, then keeper calls fundToken (no liquid pool yet)");
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
