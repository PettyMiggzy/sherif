/* eslint-disable no-console */
/*
 * deploy-v2.js — stand up the SECOND pad alongside the live one.
 *
 * This is NOT a redeploy. The live factory (deploy.json `padFactory`) keeps running and the coin already
 * launched on it keeps trading, untouched. v2 is a parallel factory that new launches point at.
 *
 * Only THREE contracts are new. Everything else is reused live, which is possible because:
 *   • PadRouter carries an isFactory ALLOWLIST (`setFactory` is add, not set-once), explicitly so one router can
 *     serve two factories.
 *   • LaunchTokenDeployer and CurvePoolDeployer are permissionless and stateless — "reused across factories" by
 *     their own design note. The token deployer folds msg.sender into its CREATE2 salt, so two factories cannot
 *     collide on an address.
 *   • FeeConfig, WETH and the Uniswap v3 factory are shared infrastructure.
 *
 * What v2 changes, versus what is live today:
 *   1. DEEP BOUNTY WALL — the H-5 fix. The live wall starts 200 ticks (~2%) below spot and is farmable by
 *      holding the price down into it. v2 starts it at 9000 (~59% below), past the measured profitability
 *      crossover. This is why the new BondDeployer exists: the wall band is stamped by the deployer.
 *   2. NO ANTI-SNIPE GUARD — zero GuardConfig, permanently.
 *   3. CREATOR-CHOSEN SUPPLY — `launchWithSupply`, bounded by an FDV band rather than by supply.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v2.js                        # fork dry-run / gas estimate (FORK_RPC)
 *   npx hardhat run scripts/deploy-v2.js --network robinhood    # real (PRIVATE_KEY = the ROUTER OWNER)
 *
 * The deployer key MUST be the PadRouter owner, or step 3 cannot authorize the new factory and v2 launches
 * revert at `register`. Check before spending gas: the script fails loudly rather than half-deploying.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

// Curve geometry — UNCHANGED from the live factory on purpose. v2 is a security + supply change, not a
// re-calibration; keeping these identical means the raise/mcap numbers in SPEC.md still hold.
const START_TICK_MAG = Number(process.env.START_TICK_MAG || 201600);
const CURVE_WIDTH = Number(process.env.CURVE_WIDTH || 23000);
const MIN_GRAD_WIDTH = Number(process.env.MIN_GRAD_WIDTH || 22800);

// [H-5] The Bounty wall band. See contracts/BondGeometry.sol for why it is deep and what that trades away.
const BOUNTY_NEAR = Number(process.env.BOUNTY_NEAR || 9000);
const BOUNTY_FAR = Number(process.env.BOUNTY_FAR || 15600);

// Optional: retune the creator-chosen-supply valuation band at deploy time. Left unset, the factory seeds it
// to +/-32x of its own default launch, which is already sane.
const MIN_FDV_ETH = process.env.MIN_FDV_ETH;
const MAX_FDV_ETH = process.env.MAX_FDV_ETH;

async function main() {
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.json"), "utf8"));
  const C = live.contracts;
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER || live.owner;
  const platform = process.env.PLATFORM || live.platform;

  console.log(`network=${network.name}  deployer=${deployer.address}`);
  console.log(`reusing router=${C.padRouter}\n        feeConfig=${C.feeConfig}`);
  console.log(`        launchTokenDeployer=${C.launchTokenDeployer}   (curve pool deployer is NEW — see below)`);
  console.log(`v1 factory (stays live)=${C.padFactory}\n`);

  const router = await ethers.getContractAt("PadRouter", C.padRouter);
  const routerOwner = await router.owner();
  if (routerOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    // Fail HERE, not after two contracts are already on chain and unusable.
    throw new Error(`deployer is not the PadRouter owner (${routerOwner}) — it cannot authorize the new factory`);
  }

  let totalGas = 0n;
  const track = async (name, c) => {
    const rc = await c.deploymentTransaction().wait();
    totalGas += rc.gasUsed;
    console.log(`  ${name.padEnd(20)} ${await c.getAddress()}   gas ${rc.gasUsed}`);
    return c;
  };

  // 1) the new BondDeployer — this is what carries the deep wall into every v2 coin's Bond
  console.log(`deploying (wall ${BOUNTY_NEAR} -> ${BOUNTY_FAR} ticks below spot):`);
  const bondDeployer = await track(
    "BondDeployer",
    await (await ethers.getContractFactory("BondDeployer")).deploy(BOUNTY_NEAR, BOUNTY_FAR)
  );

  // 2) a NEW CurvePoolDeployer. CurvePool changed (the ETH side of the LP fee now pays 100% to the platform),
  //    and CurvePool's bytecode is inlined in its deployer — so the live one would still mint the OLD pool.
  const curvePoolDeployer = await track(
    "CurvePoolDeployer",
    await (await ethers.getContractFactory("CurvePoolDeployer")).deploy()
  );

  // 3) the v2 factory, pointed at BOTH new deployers and the LIVE everything-else
  const factory = await track(
    "CurvePadFactory(v2)",
    await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform, owner, C.padRouter,
      C.launchTokenDeployer, await curvePoolDeployer.getAddress(), await bondDeployer.getAddress(), C.feeConfig,
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    )
  );
  const factoryAddr = await factory.getAddress();

  // 3) authorize it on the LIVE router (allowlist — v1 stays authorized unless you revoke it below)
  await (await router.setFactory(factoryAddr)).wait();
  console.log(`\n  router.setFactory(${factoryAddr}) — authorized`);
  if (!(await router.isFactory(factoryAddr))) throw new Error("router did not authorize the v2 factory");

  // 4) optional valuation-band retune
  if (MIN_FDV_ETH && MAX_FDV_ETH) {
    await (await factory.setFdvBand(ethers.parseEther(MIN_FDV_ETH), ethers.parseEther(MAX_FDV_ETH))).wait();
    console.log(`  setFdvBand(${MIN_FDV_ETH} .. ${MAX_FDV_ETH} ETH)`);
  }
  console.log(`  fdv band: ${ethers.formatEther(await factory.minFdvWei())} .. ${ethers.formatEther(await factory.maxFdvWei())} ETH`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    owner,
    platform,
    note: "v2 pad — deployed ALONGSIDE v1, which stays live. See DEPLOY-V2.md.",
    bountyNear: BOUNTY_NEAR,
    bountyFar: BOUNTY_FAR,
    contracts: {
      padFactory: factoryAddr,
      bondDeployer: await bondDeployer.getAddress(),
      curvePoolDeployer: await curvePoolDeployer.getAddress(),
    },
    reused: { padRouter: C.padRouter, feeConfig: C.feeConfig, launchTokenDeployer: C.launchTokenDeployer },
    v1: { padFactory: C.padFactory, bondDeployer: C.bondDeployer, stillAuthorized: await router.isFactory(C.padFactory) },
  };
  fs.writeFileSync(path.join(__dirname, "..", "deploy.v2.json"), JSON.stringify(out, null, 2));

  console.log(`\ntotal gas ${totalGas}`);
  console.log(`\nwritten to deploy.v2.json`);
  console.log(`\nNEXT, and none of it is optional:`);
  console.log(`  1. Verify both contracts on Blockscout.`);
  console.log(`  2. Point the UI's padFactory at ${factoryAddr} (pad/assets/config.js).`);
  console.log(`  3. DECIDE on v1: it is still authorized, so a coin can still launch on it and get the`);
  console.log(`     SHALLOW, farmable wall. To close that: router.removeFactory(${C.padFactory}).`);
  console.log(`     That cannot disturb any live coin — register is once-only and already done for them.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
