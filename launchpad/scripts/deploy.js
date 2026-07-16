/* eslint-disable no-console */
// Deploys the current Pad stack (CurvePad + PadRouter + Bond) to Robinhood Chain, or estimates on a fork.
//   Fork estimate (free):  npx hardhat run scripts/deploy.js                       (FORK_RPC in .env)
//   Real deploy:           npx hardhat run scripts/deploy.js --network robinhood    (PRIVATE_KEY in .env)
const { ethers, network } = require("hardhat");

// Confirmed Robinhood Chain infra (same addresses the fork tests run against):
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ETH_USD = Number(process.env.ETH_USD || 1920);
// Curve geometry. Production = ~$30k graduation FDV / ~4 ETH raise (calibrated on the fork: startMag 201600
// + width 21800 -> raise ≈ 3.96 ETH, grad FDV ≈ $30k, start FDV ≈ $4k). At graduation the creator receives
// 25% of the raise (~1 ETH) as a launch incentive; the remaining ~3 ETH funds the Bond floor. For a cheap
// TEST factory set e.g. START_TICK_MAG=207200 CURVE_WIDTH=4000 (graduates after a few $). Multiples of 200.
const START_TICK_MAG = Number(process.env.START_TICK_MAG || 201600);
const CURVE_WIDTH = Number(process.env.CURVE_WIDTH || 21800);

async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER || deployer.address; // admin + platform fee sink (use a multisig for prod)
  const platform = process.env.PLATFORM || owner; // Sherwood LP fees + graduation sweep

  console.log(`network=${network.name}  deployer=${deployer.address}`);
  console.log(`owner=${owner}\nplatform=${platform}\n`);

  let totalGas = 0n;
  const track = async (name, contract) => {
    const rc = await contract.deploymentTransaction().wait();
    totalGas += rc.gasUsed;
    console.log(`  ${name.padEnd(20)} ${await contract.getAddress()}  (gas ${rc.gasUsed})`);
    return contract;
  };

  console.log("deploying:");
  // stateless deployers can be REUSED across factories (pass their addresses to save gas)
  const reuse = async (name, addr, factoryName) => {
    if (addr) { console.log(`  ${name.padEnd(20)} ${addr}  (reused)`); return await ethers.getContractAt(factoryName, addr); }
    return await track(name, await (await ethers.getContractFactory(factoryName)).deploy());
  };
  const ltd = await reuse("LaunchTokenDeployer", process.env.LTD, "LaunchTokenDeployer");
  const cpd = await reuse("CurvePoolDeployer", process.env.CPD, "CurvePoolDeployer");
  const bd = await reuse("BondDeployer", process.env.BD, "BondDeployer");
  const router = await track("PadRouter", await (await ethers.getContractFactory("PadRouter")).deploy(WETH, owner));
  const factory = await track("CurvePadFactory", await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3_FACTORY, platform, owner, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
    START_TICK_MAG, CURVE_WIDTH
  ));
  console.log(`  (curve: startTickMag=${START_TICK_MAG} width=${CURVE_WIDTH})`);
  const wire = await (await router.setFactory(await factory.getAddress())).wait();
  totalGas += wire.gasUsed;
  console.log(`  router.setFactory       (gas ${wire.gasUsed})\n`);

  const gp = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
  const cost = totalGas * gp;
  const costEth = Number(ethers.formatEther(cost));
  console.log(`TOTAL deploy gas: ${totalGas}`);
  console.log(`gas price:        ${ethers.formatUnits(gp, "gwei")} gwei`);
  console.log(`est. cost:        ${costEth.toFixed(6)} ETH  (~$${(costEth * ETH_USD).toFixed(2)} @ $${ETH_USD}/ETH)`);
  console.log(`\n=== paste into pad/assets/config.js CONTRACTS ===`);
  console.log(`  padRouter:  "${await router.getAddress()}",`);
  console.log(`  padFactory: "${await factory.getAddress()}",`);
}

main().catch((e) => { console.error(e); process.exit(1); });
