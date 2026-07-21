/* eslint-disable no-console */
// Deploys the current Pad stack (CurvePad + PadRouter + Bond) to Robinhood Chain, or estimates on a fork.
//   Fork estimate (free):  npx hardhat run scripts/deploy.js                       (FORK_RPC in .env)
//   Real deploy:           npx hardhat run scripts/deploy.js --network robinhood    (PRIVATE_KEY in .env)
const { ethers, network } = require("hardhat");

// Confirmed Robinhood Chain infra (same addresses the fork tests run against):
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ETH_USD = Number(process.env.ETH_USD || 1920);
// Curve geometry ("let it ride"). MIN_GRAD_WIDTH = start -> the MINIMUM graduation price. CURVE_WIDTH = start
// -> the CEILING (how far price can ride above the minimum for a thicker floor). Graduation is eligible
// anywhere in between; the later it's clicked, the bigger the raise/floor. All multiples of 200;
// MIN_GRAD_WIDTH < CURVE_WIDTH. For a cheap TEST factory set small widths.
// Calibrated on the fork (scripts/calibrate-curve.js): START ~$2k mcap (buy 2% ≈ $40 to keep entry cheap),
// MIN grad ~$28k mcap / ~2.5 ETH raise (full 0.5 ETH reward per side + ~1.5 ETH floor), CEILING ~$84k mcap.
const START_TICK_MAG = Number(process.env.START_TICK_MAG || 207400);
const CURVE_WIDTH = Number(process.env.CURVE_WIDTH || 38000);
const MIN_GRAD_WIDTH = Number(process.env.MIN_GRAD_WIDTH || 27000);

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
    START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
  ));
  console.log(`  (curve: startTickMag=${START_TICK_MAG} ceilWidth=${CURVE_WIDTH} minGradWidth=${MIN_GRAD_WIDTH})`);
  const wire = await (await router.setFactory(await factory.getAddress())).wait();
  totalGas += wire.gasUsed;
  console.log(`  router.setFactory       (gas ${wire.gasUsed})`);

  // ── reward system: the additive 0.25% trader/holder legs land here ──────────
  // RewardVault needs the router at construction; the router then points its legs at the vault.
  const POSTER = process.env.POSTER || owner;      // the indexer address that posts epoch merkle roots
  const GUARDIAN = process.env.GUARDIAN || owner;  // can veto a bad root inside the challenge window
  const EPOCH_LEN = Number(process.env.EPOCH_LEN || 7 * 24 * 3600);        // 7-day reward epochs (>= 1h)
  const FINALITY_DELAY = Number(process.env.FINALITY_DELAY || 24 * 3600);  // root only postable 1d after epoch end
  const CHALLENGE_WINDOW = Number(process.env.CHALLENGE_WINDOW || 2 * 24 * 3600); // 2d guardian veto window
  const rewardVault = await track("RewardVault", await (await ethers.getContractFactory("RewardVault")).deploy(
    await router.getAddress(), POSTER, GUARDIAN, EPOCH_LEN, FINALITY_DELAY, CHALLENGE_WINDOW, owner
  ));
  const wireRv = await (await router.setRewardVault(await rewardVault.getAddress())).wait();
  totalGas += wireRv.gasUsed;
  console.log(`  router.setRewardVault   (gas ${wireRv.gasUsed})`);

  // ── community locked-LP staking: one vault per token, minted on demand ──────
  const FLOOR_TREASURY = process.env.FLOOR_TREASURY || owner; // receives the 10% open fee + 5% fee cut + penalties
  const floorFactory = await track("FloorCoopFactory", await (await ethers.getContractFactory("FloorCoopFactory")).deploy(
    WETH, V3_FACTORY, FLOOR_TREASURY
  ));

  // ── platform fee splitter (standalone; ships as a 100% passthrough) ─────────
  // Deployed but NOT auto-wired as a fee sink: it auto-routes on receive(), so a payer must use .call (not the
  // 2300-gas .transfer). Wire it in only when enabling the $ROBIN buyback, after confirming the payer's gas.
  const PLATFORM_TREASURY = process.env.PLATFORM_TREASURY || owner;
  const splitter = await track("PlatformFeeSplitter", await (await ethers.getContractFactory("PlatformFeeSplitter")).deploy(
    PLATFORM_TREASURY, owner
  ));
  console.log("");

  const gp = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
  const cost = totalGas * gp;
  const costEth = Number(ethers.formatEther(cost));
  console.log(`TOTAL deploy gas: ${totalGas}`);
  console.log(`gas price:        ${ethers.formatUnits(gp, "gwei")} gwei`);
  console.log(`est. cost:        ${costEth.toFixed(6)} ETH  (~$${(costEth * ETH_USD).toFixed(2)} @ $${ETH_USD}/ETH)`);
  console.log(`\n=== paste into pad/assets/config.js CONTRACTS ===`);
  console.log(`  padRouter:        "${await router.getAddress()}",`);
  console.log(`  padFactory:       "${await factory.getAddress()}",`);
  console.log(`  rewardVault:      "${await rewardVault.getAddress()}",`);
  console.log(`  floorCoopFactory: "${await floorFactory.getAddress()}",`);
  console.log(`  platformSplitter: "${await splitter.getAddress()}",  // standalone until $ROBIN buyback is wired`);
  console.log(`\nreward epochs: ${EPOCH_LEN}s · finalityDelay ${FINALITY_DELAY}s · challenge ${CHALLENGE_WINDOW}s`);
  console.log(`poster=${POSTER}  guardian=${GUARDIAN}  floorTreasury=${FLOOR_TREASURY}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
