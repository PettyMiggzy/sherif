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
 *   npx hardhat run scripts/deploy-v2.js --network robinhood    # real (see below for what PRIVATE_KEY needs)
 *
 * PRIVATE_KEY just needs ETH to pay gas — it does NOT need to be any existing owner. The router this script
 * deploys is owned by the deploying key at construction and only handed to the real owner (OWNER=, or the
 * live v1 router's owner() if unset) at the end (step 6), so `router.setFactory` below always succeeds
 * regardless of who is deploying. What DOES require the deploying key to genuinely BE the resolved owner is
 * `setAuctionVaultDeployer` (step 7, skipped otherwise — see DEPLOY_AUCTION below) and `setFdvBand` (step 8,
 * same skip). Deploying from a different funded key is fine; those two steps just print instructions instead.
 *
 * The one thing that DOES stop the script outright: if OWNER resolves to the lost hot deployer key
 * (0x2aA74C8d…, see LIVE_DEPLOYMENT.md), it refuses to construct anything Ownable to that address — that
 * would repeat exactly how the live v2 factory got its own setters permanently stranded.
 *
 * DEPLOY_AUCTION=true opts into deploying RobinStakingDeployer + DailyAuctionVaultDeployer and wiring the
 * daily-auction feature. LEFT UNSET (the default), those two contracts are not deployed at all and
 * `auctionVaultDeployer` stays at address(0) — auctionDays > 0 reverts BadValue, same as the live v1
 * factory today. This is deliberate: an adversarial audit of DailyAuctionVault.sol found 6 HIGH-severity
 * findings (a permissionless closeDay that can freeze bidder funds forever once spot reaches the
 * graduation ceiling, an unprotected sandwichable burn-buy, no reserve price, capped-refund ETH silently
 * paid to the platform instead of bidders, and a first-staker exploit on the lazily-deployed staking pool)
 * — none of them fixed yet. Do not set DEPLOY_AUCTION=true until they are, and re-run the adversarial audit
 * before doing so.
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

// [A] The hot deployer key that originally deployed the v1 stack is LOST — see LIVE_DEPLOYMENT.md's "READ
// FIRST" section, written after a search of the server and the workstation came up empty. `deploy.json`'s
// `owner` field is a snapshot from that original 2026-07-24 deploy and was never updated after the fact; it
// still names the lost key. The live v2 factory is already stuck this way (owner() on-chain resolves to it,
// and its three owner-only setters — setFdvBand/setStakingShares/setPlatform — are permanently unreachable).
// Deploying a v3 factory the same way would repeat that exactly: `setAuctionVaultDeployer` (whether or not
// this run turns the auction on) and `setFdvBand` would both go dead on arrival.
//
// So: HARD REFUSE to construct anything owned by that address, from any source (env, manifest, or the
// on-chain default below) — this is not a warning-and-continue, because continuing spends the whole
// deploy's gas (~18.4M) and the mistake is not fixable afterward.
const LOST_DEPLOYER_KEY = "0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8".toLowerCase();
function assertNotLostKey(addr, label) {
  if (String(addr || "").toLowerCase() === LOST_DEPLOYER_KEY) {
    throw new Error(
      `${label} resolved to ${addr}, the LOST hot deployer key (see LIVE_DEPLOYMENT.md). Nobody can sign ` +
      `for this address anymore — a factory constructed Ownable(${addr}) would have every owner-only setter ` +
      `(setAuctionVaultDeployer, setFdvBand, setPlatform, setFeeConfig on the router) permanently dead, ` +
      `exactly like the stranded live v2 factory. Pass OWNER=<the real cold-wallet owner> explicitly.`
    );
  }
}

// [L] Every prior generation this script has ever produced, oldest to newest, read off whatever
// `deploy.vN.json` files already exist on disk (deploy.json itself is the unnumbered v1). Used twice below:
// to pick a fresh output filename so a later generation never overwrites an earlier one's manifest, and to
// fold every generation's factory/router into the printed indexer instructions rather than just the newest
// two. A real run of this script has been called `deploy-v2.js` since the second generation and is now
// producing (at least) the third — the name undersells what it does, but renaming it is a bigger, separate
// change than tonight's fixes, so this reads its own output history instead of trusting the filename.
function readPriorGenerations(dir) {
  const gens = [];
  for (let n = 2; ; n++) {
    const p = path.join(dir, `deploy.v${n}.json`);
    if (!fs.existsSync(p)) break;
    try { gens.push({ n, path: p, manifest: JSON.parse(fs.readFileSync(p, "utf8")) }); } catch { break; }
  }
  return gens;
}

async function main() {
  const repoRoot = path.join(__dirname, "..");
  const live = JSON.parse(fs.readFileSync(path.join(repoRoot, "deploy.json"), "utf8"));
  const C = live.contracts;
  const priorGenerations = readPriorGenerations(repoRoot); // [{n, path, manifest}] for v2, v3, ... that exist
  const [deployer] = await ethers.getSigners();

  // Owner resolution, in order: explicit OWNER= env (always wins) > the LIVE v1 router's own owner() (the
  // actual current cold-wallet owner, verified on-chain rather than trusted from a JSON snapshot that has
  // already gone stale once) > deploy.json's owner field, only as a last resort for a devnet rehearsal where
  // the legacy router address is a stub and owner() has nothing to answer.
  let owner = process.env.OWNER;
  let ownerSource = "OWNER env";
  if (!owner) {
    try {
      const legacyRouter = new ethers.Contract(C.padRouter, ["function owner() view returns (address)"], ethers.provider);
      owner = await legacyRouter.owner();
      ownerSource = `live owner() on the v1 router ${C.padRouter}`;
    } catch {
      owner = live.owner;
      ownerSource = "deploy.json (owner() call failed — on a devnet rehearsal this is expected)";
    }
  }
  assertNotLostKey(owner, `Resolved owner (${ownerSource})`);
  console.log(`owner=${owner}  (source: ${ownerSource})`);

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
  //     CurvePadFactory.sol) specifically so every OTHER existing call site keeps working unchanged.
  //
  // NOT DEPLOYED unless DEPLOY_AUCTION=true (see the file header). An adversarial audit found the vault has
  // 6 HIGH-severity findings, none fixed: closeDay is permissionless and can freeze bidder ETH + tokens
  // forever once spot reaches the graduation ceiling (no rescue path — this is not an edge case, it's the
  // designed outcome of the vault's own burn-buy); the burn-buy itself is an unprotected, sandwichable
  // market order; there is no reserve price (a 1-wei bid takes a whole day's tranche); a capped day's
  // unspent ETH is paid to the platform instead of refunded to bidders; and the lazily-deployed staking
  // pool can be atomically first-staked by whoever calls closeDay. Deploying these contracts even unwired
  // would put a real address on chain that a future owner might casually flip on later without re-reading
  // this comment — leaving them undeployed is the safer default until the vault is fixed and re-audited.
  const DEPLOY_AUCTION = String(process.env.DEPLOY_AUCTION || "").toLowerCase() === "true";
  let robinStakingDeployer = null, dailyAuctionVaultDeployer = null, dailyAuctionVaultDeployerAddr = ethers.ZeroAddress;
  if (DEPLOY_AUCTION) {
    console.log("\n  DEPLOY_AUCTION=true — deploying the (unaudited-fix) auction contracts:");
    robinStakingDeployer = await track(
      "RobinStakingDeployer",
      await (await ethers.getContractFactory("RobinStakingDeployer")).deploy()
    );
    dailyAuctionVaultDeployer = await track(
      "DailyAuctionVaultDeployer",
      await (await ethers.getContractFactory("DailyAuctionVaultDeployer")).deploy(await robinStakingDeployer.getAddress())
    );
    dailyAuctionVaultDeployerAddr = await dailyAuctionVaultDeployer.getAddress();
  } else {
    console.log("\n  DEPLOY_AUCTION not set — auction contracts NOT deployed (auctionDays > 0 will revert BadValue,");
    console.log("    same as the live v1 factory today). See the file header for why.");
  }

  // 5) authorize it on the LIVE router (allowlist — v1 stays authorized unless you revoke it below)
  await (await router.setFactory(factoryAddr)).wait();
  console.log(`\n  router.setFactory(${factoryAddr}) — authorized`);
  if (!(await router.isFactory(factoryAddr))) throw new Error("router did not authorize the v2 factory");

  // [I] The router keeps its OWN feeConfig slot, separate from the one passed to the factory's constructor,
  // and `_distribute` branches on it: unset means the legacy platform/creator/floor split, where the Bond
  // floor gets 0% of trade fees instead of the advertised 10% and the creator gets 0% of every buy instead
  // of 45%. scripts/deploy.js (the original v1 deploy) calls this; this script never did — verified on
  // chain, the live v1 router's feeConfig() returns the real FeeConfig address while the live v2 router's
  // returns the zero address. That is not a hypothetical: it is what shipped last time. Called here, while
  // `deployer` still owns the freshly-deployed router (same reason setFactory above needs no owner check).
  await (await router.setFeeConfig(C.feeConfig)).wait();
  console.log(`  router.setFeeConfig(${C.feeConfig}) — wired`);
  if ((await router.feeConfig()).toLowerCase() !== C.feeConfig.toLowerCase()) {
    throw new Error(`router.feeConfig() read back wrong after setFeeConfig(${C.feeConfig}) — do not proceed`);
  }

  // 6) hand the router to its real owner. Ownable2Step, so this only NOMINATES — the treasury key must
  //    call acceptOwnership() to finish. Deliberate: a two-step handover cannot strand the router on an
  //    address nobody controls, which a one-step transfer to a mistyped key would.
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await router.transferOwnership(owner)).wait();
    console.log(`  router.transferOwnership(${owner}) — PENDING, call acceptOwnership() from that key`);
  }

  // 7) wire the auction feature onto the factory, ONLY if DEPLOY_AUCTION=true deployed the vault deployer
  //    above. `setAuctionVaultDeployer` is onlyOwner — and UNLIKE the router above, the factory is
  //    constructed ALREADY owned by `owner` (`Ownable(owner_)` in its constructor, no pending/accept step),
  //    so `deployer` can only make this call when it genuinely IS the owner. When the real owner is a
  //    separate treasury key this script holds no key for, it cannot sign for it — surface that loudly
  //    instead of silently leaving the feature off, which is exactly the trap the live v1 deploy fell into
  //    (nothing in that deploy ever called this setter, so every `auctionDays > 0` launch on the live
  //    factory reverts BadValue to this day).
  let auctionWired = false;
  if (!DEPLOY_AUCTION) {
    console.log(`  factory.setAuctionVaultDeployer — NOT CALLED (DEPLOY_AUCTION not set; see file header).`);
  } else if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    await (await factory.setAuctionVaultDeployer(dailyAuctionVaultDeployerAddr)).wait();
    auctionWired = (await factory.auctionVaultDeployer()).toLowerCase() === dailyAuctionVaultDeployerAddr.toLowerCase();
    console.log(`  factory.setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr}) — auction feature ON`);
  } else {
    console.log(`  factory.setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr}) — NOT CALLED: the factory's`);
    console.log(`    owner is ${owner}, not the deploying key (${deployer.address}). Call this from that key —`);
    console.log(`    until then auctionDays > 0 reverts BadValue on every v2 launch (feature off).`);
  }

  // 8) optional valuation-band retune. [L] Guarded with the SAME owner check as step 7 — `setFdvBand` is
  //    onlyOwner on a factory that, like the auction setter above, is owned by `owner` from construction.
  //    Unguarded, a non-owner run with MIN_FDV_ETH/MAX_FDV_ETH set deployed all seven contracts (18.39M gas)
  //    and then reverted OwnableUnauthorizedAccount — after spending the gas, before the manifest was ever
  //    written. Skip-and-instruct instead, matching step 7's pattern exactly.
  if (MIN_FDV_ETH && MAX_FDV_ETH) {
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      await (await factory.setFdvBand(ethers.parseEther(MIN_FDV_ETH), ethers.parseEther(MAX_FDV_ETH))).wait();
      console.log(`  setFdvBand(${MIN_FDV_ETH} .. ${MAX_FDV_ETH} ETH)`);
    } else {
      console.log(`  setFdvBand(${MIN_FDV_ETH} .. ${MAX_FDV_ETH} ETH) — NOT CALLED: the factory's owner is`);
      console.log(`    ${owner}, not the deploying key (${deployer.address}). Call this from that key instead —`);
      console.log(`    until then the band stays at the factory's own default (see below).`);
    }
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
      // The optional 0-4 day daily-tranche auction. null unless DEPLOY_AUCTION=true deployed it (see file
      // header — undeployed by default pending a fix + re-audit of DailyAuctionVault.sol).
      robinStakingDeployer: robinStakingDeployer ? await robinStakingDeployer.getAddress() : null,
      dailyAuctionVaultDeployer: DEPLOY_AUCTION ? dailyAuctionVaultDeployerAddr : null,
    },
    auctionFeature: {
      deployed: DEPLOY_AUCTION,
      wired: auctionWired,
      note: !DEPLOY_AUCTION
        ? "NOT DEPLOYED — DailyAuctionVault.sol has 6 open HIGH findings from an adversarial audit; " +
          "see the file header. auctionDays > 0 reverts BadValue, same as the live v1 factory."
        : auctionWired
        ? "factory.auctionVaultDeployer() is set — auctionDays > 0 works on this factory."
        : `deployed but NOT wired — factory owner (${owner}) must call setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr}) before any auctionDays > 0 launch will work.`,
    },
    // [L] The reward legs (0.25% trader + 0.25% holder, paid in real ETH via RewardVault) are OFF on this
    // router — `setRewardVault` is never called, and `rewardVault` defaults to address(0), which the router
    // itself treats as "skip the leg, charge nothing" (verified: REWARD_BUY_BPS/REWARD_SELL_BPS both read as
    // 0 when unset). That is a safe default, not a bug — a coin on this router is genuinely not charged for
    // a leg that goes nowhere. What would NOT be safe is pointing this router at the EXISTING live vault
    // (${C.rewardVault ?? "n/a"}): that vault's own `router` is immutable to whichever router registered it
    // first, so `accrue` would revert `OnlyRouter`, the router's own try/catch would swallow that silently,
    // and the 0.25%/0.25% would then be genuinely deducted from every trade and never reach anyone. Recorded
    // here so this is a decision on record, not a thing nobody remembers deciding.
    rewardVault: { wired: false, note: "OFF by design — see the comment above this field in deploy-v2.js. pad/rewards.html should not advertise these legs for coins on this router until a real vault is deployed and wired for it." },
    // [L] Every generation this deploy history has produced, not just the immediately-prior one — so a
    // client reading this manifest can always find every live factory/router, however many deploys back.
    legacy: {
      v1: { padFactory: C.padFactory, padRouter: C.padRouter, bondDeployer: C.bondDeployer, stillAuthorized: await router.isFactory(C.padFactory) },
      priorGenerations: priorGenerations.map((g) => ({
        generation: g.n,
        padFactory: g.manifest?.contracts?.padFactory,
        padRouter: g.manifest?.contracts?.padRouter,
      })),
      note: "every one of these stays live and untouched — a coin's fee config is register-once per router, so none of them can ever be moved to this deploy's router.",
    },
    reused: { feeConfig: C.feeConfig },
  };
  // [L] deploy.v{N}.json is the TRACKED manifest of a real mainnet deploy — every address the site, the
  // indexer and the verifier read for that generation. Defaulting to a FIXED "deploy.v2.json" meant every
  // later generation this script ever produces overwrites the one before it on disk — this script has been
  // reused for the third generation already, which would otherwise have clobbered the second's real, live,
  // currently-serving-traffic manifest the moment it ran. N is one past the highest `deploy.vN.json` already
  // on disk (v1 is the unnumbered deploy.json). DEPLOY_V2_OUT still overrides outright, for a devnet
  // rehearsal that should not touch any tracked file at all.
  const nextGen = 2 + priorGenerations.length;
  const outPath = process.env.DEPLOY_V2_OUT || path.join(repoRoot, `deploy.v${nextGen}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\ntotal gas ${totalGas}`);
  console.log(`\nwritten to ${outPath}`);
  console.log(`\nNEXT, in this order:`);
  // [L] Printed bare, this command has no way to know a RobinTierStakingFactory + $ROBIN pool + StakingFeeder
  // already exist — TIER_STAKING_FACTORY/STAKING_FEEDER unset means wire-staking.js DEPLOYS FRESH ONES (see
  // its own source), a second flagship $ROBIN pool included. Look the live ones up and print the command with
  // them filled in. tierStakingFactory's address is read from pad/assets/config.js (the front-end's own
  // record of it — nothing in launchpad/ tracks it, it's a different, already-deployed product); its feeder
  // is then read LIVE off that factory's own `feeder()` rather than hardcoded, so this stays correct even if
  // the feeder is ever re-pointed.
  let tierStakingFactory = "", stakingFeeder = "";
  const cfgPath = path.join(__dirname, "..", "..", "pad", "assets", "config.js");
  try {
    const cfg = fs.readFileSync(cfgPath, "utf8");
    const m = cfg.match(/tierStakingFactory:\s*"([^"]*)"/);
    if (m && m[1]) {
      tierStakingFactory = m[1];
      const tsf = new ethers.Contract(tierStakingFactory, ["function feeder() view returns (address)"], ethers.provider);
      stakingFeeder = await tsf.feeder();
    }
  } catch { /* config unreadable or feeder() call failed — fall through and warn below */ }
  console.log(`  1. wire-staking.js, with ROUTER set to the new router — it makes all five connections`);
  console.log(`     and reads every one back:`);
  if (tierStakingFactory && stakingFeeder) {
    console.log(`       KEEPER=<keeper address> ROUTER=${routerAddr} \\`);
    console.log(`         TIER_STAKING_FACTORY=${tierStakingFactory} STAKING_FEEDER=${stakingFeeder} \\`);
    console.log(`         npx hardhat run scripts/wire-staking.js --network robinhood`);
    console.log(`     (TIER_STAKING_FACTORY/STAKING_FEEDER point at the EXISTING live ones — leaving them`);
    console.log(`      unset would deploy a SECOND staking factory, feeder and $ROBIN pool.)`);
  } else {
    console.log(`       KEEPER=<keeper address> ROUTER=${routerAddr} \\`);
    console.log(`         npx hardhat run scripts/wire-staking.js --network robinhood`);
    console.log(`     *** WARNING: could not read the live TIER_STAKING_FACTORY/STAKING_FEEDER (${cfgPath}`);
    console.log(`     unreadable, or feeder() reverted). Running the command above AS PRINTED deploys a`);
    console.log(`     SECOND staking factory + feeder + $ROBIN pool. Look up the real addresses first and`);
    console.log(`     pass TIER_STAKING_FACTORY=/STAKING_FEEDER= explicitly. ***`);
  }
  // The router slot to fill is the FIRST EMPTY one, never an occupied one. Every generation's router keeps
  // its own coins forever (register-once), so overwriting `padRouterV2` with this address does not migrate
  // those coins — it strands them: the site would probe an address that has never heard of them and fall
  // through to the legacy router, where they are not registered either, and every trade on them would fail.
  // Read the config rather than hardcode a slot name, so this stays right for the generation after next.
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
  // Fixed numbering from here on (not renumbered by which branch fired) — a step that doesn't apply says so
  // in place rather than disappearing and shifting every number after it, which is its own way to mislead an
  // operator skimming a printed list.
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`  3. acceptOwnership() on the new router, from ${owner}. Until that happens the router is`);
    console.log(`     still owned by the deploying key — launches work either way, but governance does not.`);
  } else {
    console.log(`  3. (no ownership handover — the deploying key IS ${owner}, so the router is already its.)`);
  }
  console.log(`  4. Verify on Blockscout:  node scripts/verify-sourcify.cjs`);
  if (!DEPLOY_AUCTION) {
    console.log(`  5. (auction feature: deliberately NOT deployed — see the file header. Nothing to do here.)`);
  } else if (!auctionWired) {
    console.log(`  5. REQUIRED for the auction feature: from ${owner}, call`);
    console.log(`       factory.setAuctionVaultDeployer(${dailyAuctionVaultDeployerAddr})`);
    console.log(`     on ${factoryAddr} — until this runs, every auctionDays > 0 launch reverts BadValue.`);
  } else {
    console.log(`  5. (auction feature: already wired — setAuctionVaultDeployer ran inline above.)`);
  }
  // The indexer defaults to a hardcoded factory/router pair. A coin launched here emits `Launched` from a
  // factory that list does not contain, so it never appears on the site's browse page, `recordOf` returns a
  // zero dev for it (failing the creator gate), and its router-routed trades are credited to a contract
  // address instead of the trader. Widening those two env lists is not optional polish — without it the
  // coin is invisible.
  //
  // [L] The union must include EVERY generation, not just legacy + new — priorGenerations (computed at the
  // top of main()) already reads every deploy.vN.json on disk, so this folds in v2, v3, ... however many
  // there are, not just whichever one this script happened to hardcode. Skip without a factory/router (a
  // generation's manifest that predates that field, or failed to parse) rather than pollute the list with
  // undefined.
  const allFactories = [C.padFactory, ...priorGenerations.map((g) => g.manifest?.contracts?.padFactory), factoryAddr].filter(Boolean);
  const allRouters = [C.padRouter, ...priorGenerations.map((g) => g.manifest?.contracts?.padRouter), routerAddr].filter(Boolean);
  console.log(`  6. indexer/.env on the droplet — ADD, do not replace:`);
  console.log(`       FACTORIES=${[...new Set(allFactories)].join(",")}`);
  console.log(`       ROUTERS=${[...new Set(allRouters)].join(",")}`);
  console.log(`       STAKING_ROUTER=${routerAddr}   (single-valued: the fee sweeper can only target one)`);
  if (!priorGenerations.length) {
    console.log(`     (no deploy.vN.json found alongside this script besides the one just written — if an`);
    console.log(`      earlier generation's factory/router is live and just isn't recorded on disk here,`);
    console.log(`      add its addresses to both lists above by hand.)`);
  }
  console.log(`\nWhat you do NOT need to do:`);
  console.log(`  • Nothing on the legacy router (${C.padRouter}). It is untouched and keeps every coin`);
  console.log(`    launched before now — a coin's fee config is register-once, so those can never move.`);
  console.log(`    The site asks the chain which router owns a coin, so both keep working side by side.`);
  console.log(`  • No removeFactory. The v1 factory was never authorized on THIS router — it is on the`);
  console.log(`    legacy one, where it has to stay for those coins to keep trading.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
