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
  // Deployed owned by the DEPLOYER, then handed to `owner` at the end. Constructing it owned by `owner`
  // directly looked tidier and was a dead end: `setFactory` below is onlyOwner, so unless the deploying key
  // IS the treasury key the script deploys five contracts and then cannot authorize the factory — the exact
  // half-deployed state the owner check was written to avoid. Deploy, wire, then hand over.
  console.log("deploying the v2 router (the live one stays untouched and keeps its coins):");
  const routerC = await track("PadRouter(v2)", await (await ethers.getContractFactory("PadRouter")).deploy(WETH, deployer.address));
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

  // 4b) RobinStakingDeployer + DailyAuctionVaultDeployer — the two thin deployers behind the optional 0-4 day
  //     daily-tranche pre-launch auction (DailyAuctionVault.sol / RobinStaking.sol). `auctionVaultDeployer` on
  //     CurvePadFactory is owner-settable rather than a constructor arg (see its doc comment in
  //     CurvePadFactory.sol) specifically so every OTHER existing call site keeps working unchanged — but that
  //     also means nothing wires it on by default. Deploy both here and wire it in step 7 below, or every v2
  //     launch with auctionDays > 0 reverts BadValue forever, exactly like the live v1 factory today (nothing
  //     in this repo ever called the setter for it).
  const robinStakingDeployer = await track(
    "RobinStakingDeployer",
    await (await ethers.getContractFactory("RobinStakingDeployer")).deploy()
  );
  const dailyAuctionVaultDeployer = await track(
    "DailyAuctionVaultDeployer",
    await (await ethers.getContractFactory("DailyAuctionVaultDeployer")).deploy(await robinStakingDeployer.getAddress())
  );
  const dailyAuctionVaultDeployerAddr = await dailyAuctionVaultDeployer.getAddress();

  // 5) authorize it on the LIVE router (allowlist — v1 stays authorized unless you revoke it below)
  await (await router.setFactory(factoryAddr)).wait();
  console.log(`\n  router.setFactory(${factoryAddr}) — authorized`);
  if (!(await router.isFactory(factoryAddr))) throw new Error("router did not authorize the v2 factory");

  // 6) hand the router to its real owner. Ownable2Step, so this only NOMINATES — the treasury key must
  //    call acceptOwnership() to finish. Deliberate: a two-step handover cannot strand the router on an
  //    address nobody controls, which a one-step transfer to a mistyped key would.
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await router.transferOwnership(owner)).wait();
    console.log(`  router.transferOwnership(${owner}) — PENDING, call acceptOwnership() from that key`);
  }

  // 7) wire the auction feature onto the factory. `setAuctionVaultDeployer` is onlyOwner — and UNLIKE the
  //    router above, the factory is constructed ALREADY owned by `owner` (`Ownable(owner_)` in its
  //    constructor, no pending/accept step), so `deployer` can only make this call when it genuinely IS the
  //    owner. When the real owner is a separate treasury key this script holds no key for, it cannot sign for
  //    it — surface that loudly instead of silently leaving the feature off, which is exactly the trap the
  //    live v1 deploy fell into (nothing in this repo ever called this setter, so every `auctionDays > 0`
  //    launch on the live factory reverts BadValue to this day).
  let auctionWired = false;
  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    await (await factory.setAuctionVaultDeployer(dailyAuctionVaultDeployerAddr)).wait();
    auctionWired = (await factory.auctionVaultDeployer()).toLowerCase() === dailyAuctionVaultDeployerAddr.toLowerCase();
    console.log(`  factory.setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr}) — auction feature ON`);
  } else {
    console.log(`  factory.setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr}) — NOT CALLED: the factory's`);
    console.log(`    owner is ${owner}, not the deploying key (${deployer.address}). Call this from that key —`);
    console.log(`    until then auctionDays > 0 reverts BadValue on every v2 launch (feature off).`);
  }

  // 8) optional valuation-band retune
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
      // The optional 0-4 day daily-tranche auction. robinStakingDeployer backs DailyAuctionVaultDeployer (its
      // one constructor arg) and is never referenced directly anywhere else — recorded here purely so it's
      // easy to find if a zero-bid auction day's lazily-deployed RobinStaking pool ever needs auditing.
      robinStakingDeployer: await robinStakingDeployer.getAddress(),
      dailyAuctionVaultDeployer: dailyAuctionVaultDeployerAddr,
    },
    auctionFeature: {
      wired: auctionWired,
      note: auctionWired
        ? "factory.auctionVaultDeployer() is set — auctionDays > 0 works on this factory."
        : `NOT wired — factory owner (${owner}) must call setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr}) before any auctionDays > 0 launch will work.`,
    },
    legacy: { padRouter: C.padRouter, note: "still live, still owns every coin launched before this deploy" },
    reused: { feeConfig: C.feeConfig },
    v1: { padFactory: C.padFactory, bondDeployer: C.bondDeployer, stillAuthorized: await router.isFactory(C.padFactory) },
  };
  // deploy.v2.json is the TRACKED manifest of the real mainnet deploy — every address the site, the indexer
  // and the verifier read. A devnet rehearsal of this script used to overwrite it in place, which is how a
  // localhost address ends up committed as if it were live. OUT lets a rehearsal write somewhere else; left
  // unset, a real deploy still lands exactly where it always did.
  const outPath = process.env.DEPLOY_V2_OUT || path.join(__dirname, "..", "deploy.v2.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\ntotal gas ${totalGas}`);
  console.log(`\nwritten to ${outPath}`);
  console.log(`\nNEXT, in this order:`);
  console.log(`  1. wire-staking.js, with ROUTER set to the new router — it makes all five connections`);
  console.log(`     and reads every one back:`);
  console.log(`       KEEPER=<keeper address> ROUTER=${routerAddr} \\`);
  console.log(`         npx hardhat run scripts/wire-staking.js --network robinhood`);
  // The router slot to fill is the FIRST EMPTY one, never an occupied one. Every generation's router keeps
  // its own coins forever (register-once), so overwriting `padRouterV2` with this address does not migrate
  // those coins — it strands them: the site would probe an address that has never heard of them and fall
  // through to the legacy router, where they are not registered either, and every trade on them would fail.
  // Read the config rather than hardcode a slot name, so this stays right for the generation after next.
  const cfgPath = path.join(__dirname, "..", "..", "pad", "assets", "config.js");
  let slot = "padRouterV2";
  try {
    const cfg = fs.readFileSync(cfgPath, "utf8");
    for (let i = 2; i <= 9; i++) {
      const m = cfg.match(new RegExp(`padRouterV${i}\\s*:\\s*"([^"]*)"`));
      if (!m) break;                       // no such slot in config yet — stop at the last one that exists
      slot = `padRouterV${i}`;
      if (!m[1]) break;                    // empty: this is the slot to fill
    }
  } catch { /* config not readable from here — fall back to the name below and let a human check */ }
  console.log(`  2. pad/assets/config.js — BOTH of these, and EVERY existing padRouter* stays exactly as it is:`);
  console.log(`       padFactory:   "${factoryAddr}",`);
  console.log(`       ${slot}:  "${routerAddr}",`);
  console.log(`     (${slot} is the first EMPTY router slot in that file — do NOT overwrite a filled one,`);
  console.log(`      it would strand every coin registered on it. Add a new slot if none is empty, and add`);
  console.log(`      the matching ABI entry + ROUTER_TIERS entry in wallet.js alongside it.)`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`  3. acceptOwnership() on the new router, from ${owner}. Until that happens the router is`);
    console.log(`     still owned by the deploying key — launches work either way, but governance does not.`);
  } else {
    console.log(`  3. (no ownership handover — the deploying key IS ${owner}, so the router is already its.)`);
  }
  console.log(`  4. Verify on Blockscout:  node scripts/verify-sourcify.cjs`);
  if (!auctionWired) {
    console.log(`  5. REQUIRED for the auction feature: from ${owner}, call`);
    console.log(`       factory.setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr})`);
    console.log(`     on ${factoryAddr} — until this runs, every auctionDays > 0 launch reverts BadValue.`);
  }
  // The indexer defaults to a hardcoded factory/router pair. A coin launched here emits `Launched` from a
  // factory that list does not contain, so it never appears on the site's browse page, `recordOf` returns a
  // zero dev for it (failing the creator gate), and its router-routed trades are credited to a contract
  // address instead of the trader. Widening those two env lists is not optional polish — without it the
  // coin is invisible.
  console.log(`  ${auctionWired ? 5 : 6}. indexer/.env on the droplet — ADD, do not replace:`);
  console.log(`       FACTORIES=${[...new Set([C.padFactory, factoryAddr])].join(",")}   (plus any factory already listed)`);
  console.log(`       ROUTERS=${[...new Set([C.padRouter, routerAddr])].join(",")}   (plus any router already listed)`);
  console.log(`       STAKING_ROUTER=${routerAddr}   (single-valued: the fee sweeper can only target one)`);
  console.log(`\nWhat you do NOT need to do:`);
  console.log(`  • Nothing on the legacy router (${C.padRouter}). It is untouched and keeps every coin`);
  console.log(`    launched before now — a coin's fee config is register-once, so those can never move.`);
  console.log(`    The site asks the chain which router owns a coin, so both keep working side by side.`);
  console.log(`  • No removeFactory. The v1 factory was never authorized on THIS router — it is on the`);
  console.log(`    legacy one, where it has to stay for those coins to keep trading.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
