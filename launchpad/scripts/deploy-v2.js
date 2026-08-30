/* eslint-disable no-console */
/*
 * deploy-v2.js — stand up the SECOND pad alongside the live one.
 *
 * This is NOT a redeploy. The live factory (deploy.json `padFactory`) keeps running and the coin already
 * launched on it keeps trading, untouched. v2 is a parallel factory that new launches point at.
 *
 * Only FOUR contracts are new. Everything else is reused live, which is possible because:
 *   • PadRouter carries an isFactory ALLOWLIST (`setFactory` is add, not set-once), explicitly so one router can
 *     serve two factories.
 *   • FeeConfig, WETH and the Uniswap v3 factory are shared infrastructure.
 *
 * The LaunchTokenDeployer used to be reused too — it is permissionless and stateless, and folds msg.sender into
 * its CREATE2 salt so two factories cannot collide. It is NEW here for one reason: the `1ab5` brand. Every coin
 * address must now carry that suffix, which means every launch needs a salt mined off-chain, which means the
 * client needs the coin's init-code hash — and the only contract that can serve that hash honestly is the one
 * embedding the creation code it will deploy. The live deployer predates `tokenInitCodeHash()`, so a client
 * pointed at it has no way to mine and every launch would revert BadTokenSuffix.
 *
 * What v2 changes, versus what is live today:
 *   1. DEEP BOUNTY WALL — the H-5 fix. The live wall starts 200 ticks (~2%) below spot and is farmable by
 *      holding the price down into it. v2 starts it at 9000 (~59% below), past the measured profitability
 *      crossover. This is why the new BondDeployer exists: the wall band is stamped by the deployer.
 *   2. NO ANTI-SNIPE GUARD — zero GuardConfig, permanently.
 *   3. CREATOR-CHOSEN SUPPLY — `launchWithSupplyAndSalt`, bounded by an FDV band rather than by supply.
 *   4. THE `1ab5` BRAND — every coin address ends in `1ab5`, enforced in the contract. `launch(p)` and
 *      `launchWithSupply(p, s, m)` now revert SaltRequired; callers mine a salt and use the salted
 *      entrypoints. THIS BREAKS EVERY EXISTING CALLER, which is why it ships with a new factory address:
 *      the site, the Telegram bot and the SDK must all be repointed and updated together.
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
  console.log(`legacy router=${C.padRouter} (untouched — keeps every coin launched before now)`);
  console.log(`      feeConfig=${C.feeConfig} (reused)`);
  console.log(`        (the launch-token and curve-pool deployers are both NEW — see below)`);
  console.log(`v1 factory (stays live)=${C.padFactory}\n`);

  let totalGas = 0n;
  const track = async (name, c) => {
    const rc = await c.deploymentTransaction().wait();
    totalGas += rc.gasUsed;
    console.log(`  ${name.padEnd(20)} ${await c.getAddress()}   gas ${rc.gasUsed}`);
    return c;
  };

  // ── the router: a NEW one, deployed here, NOT the live one ────────────────────────────────────
  //
  // This script used to reuse the live router and only allowlist the new factory on it. That path is now
  // dead: CurvePadFactory calls `registerWithStaking`, which carries the per-coin staking and $ROBIN slices,
  // and the live router predates it — verified on chain, `stakingSink()` and `robinSink()` both revert
  // there. Pointed at the live router, EVERY LAUNCH WOULD REVERT on the register call.
  //
  // And the live router cannot simply be replaced. A coin's fee config is register-once per router (the
  // contract reverts `AlreadySet`), so every coin already trading is bound to the old one and can never be
  // moved. Two routers is therefore the shape of the thing, not a migration step: the old one keeps its
  // coins for good, this one takes every coin from here on, and the client asks the chain which is which
  // via `configOf(token).set` rather than guessing from a launch date.
  //
  // Nothing about the live router is touched. It is not upgraded, not re-owned, not revoked — a coin
  // trading today trades exactly the same way tomorrow.
  console.log("deploying the v2 router (the live one stays untouched and keeps its coins):");
  const routerC = await track("PadRouter(v2)", await (await ethers.getContractFactory("PadRouter")).deploy(WETH, owner));
  const routerAddr = await routerC.getAddress();
  const router = routerC;


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

  // 3) a NEW LaunchTokenDeployer. It gained tokenInitCodeHash()/predict(), which is what lets a client mine
  //    the mandatory `1ab5` address against the code that will actually be deployed. Reusing the live one
  //    would leave every client unable to mine, and every launch reverting BadTokenSuffix.
  const launchTokenDeployer = await track(
    "LaunchTokenDeployer",
    await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy()
  );

  // 4) the v2 factory, pointed at ALL THREE new deployers and the LIVE everything-else
  const factory = await track(
    "CurvePadFactory(v2)",
    await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform, owner, routerAddr,
      await launchTokenDeployer.getAddress(), await curvePoolDeployer.getAddress(), await bondDeployer.getAddress(), C.feeConfig,
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    )
  );
  const factoryAddr = await factory.getAddress();

  // 5) authorize it on the LIVE router (allowlist — v1 stays authorized unless you revoke it below)
  // The new router is constructed owned by `owner`. If that is not the deploying key, this call cannot be
  // made from here — fail loudly rather than leaving a factory on chain that no router will accept.
  if ((await router.owner()).toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`the v2 router is owned by ${await router.owner()}, not the deployer — run setFactory(${factoryAddr}) from that key`);
  }
  await (await router.setFactory(factoryAddr)).wait();
  console.log(`\n  router.setFactory(${factoryAddr}) — authorized`);
  if (!(await router.isFactory(factoryAddr))) throw new Error("router did not authorize the v2 factory");

  // 6) optional valuation-band retune
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
      // The clients read this off the factory (`tokenDeployer()`), but record it here too — it is the contract
      // that serves the init-code hash every miner needs, so it is the first thing to check if launches start
      // reverting BadTokenSuffix.
      launchTokenDeployer: await launchTokenDeployer.getAddress(),
      padRouter: routerAddr, // the v2 router — put this in pad/assets/config.js as `padRouterV2`
    },
    legacy: { padRouter: C.padRouter, note: "still live, still owns every coin launched before this deploy" },
    reused: { feeConfig: C.feeConfig },
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
