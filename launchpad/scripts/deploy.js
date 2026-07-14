/* eslint-disable no-console */
const { ethers, network } = require("hardhat");

// Confirmed Robinhood Chain addresses (verify before mainnet):
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER || deployer.address; // should be a multisig / timelock
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address; // platform fee sink (multisig)

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);
  console.log("WETH:", WETH, "\nV3 Factory:", V3_FACTORY);
  console.log("Owner:", owner, "\nFee recipient:", feeRecipient);

  const tokenDeployer = await (await ethers.getContractFactory("TokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();
  const vaultDeployer = await (await ethers.getContractFactory("VaultDeployer")).deploy();
  await vaultDeployer.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchpadFactory");
  const factory = await Factory.deploy(
    WETH,
    V3_FACTORY,
    feeRecipient,
    owner,
    await tokenDeployer.getAddress(),
    await vaultDeployer.getAddress()
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  const lockerAddr = await factory.locker();

  const FeeRouter = await ethers.getContractFactory("FeeRouter");
  const router = await FeeRouter.deploy(WETH, V3_FACTORY, feeRecipient, owner);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  console.log("\n=== Deployed ===");
  console.log("LaunchpadFactory:", factoryAddr);
  console.log("LiquidityLocker :", lockerAddr);
  console.log("FeeRouter       :", routerAddr);
  console.log("\nNext: verify contracts, transfer owner to a multisig/timelock, and run launch().");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
