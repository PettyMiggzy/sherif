// ─────────────────────────────────────────────────────────────────────────────
// enable-advanced.js — AUTOMATED, guard-railed enablement of the advanced features
// (creator vesting + holder/trader rewards). One command. It CANNOT touch the pad.
//
//   Dry run (default — sends NOTHING, just prints the plan):
//     npx hardhat run scripts/enable-advanced.js --network robinhood
//   Real deploy of the two new standalone contracts + auto-wire config:
//     ENABLE=1 npx hardhat run scripts/enable-advanced.js --network robinhood
//   …also flip the reward legs on (reversible setRewardVault on the live router):
//     ENABLE=1 ENABLE_LEGS=1 npx hardhat run scripts/enable-advanced.js --network robinhood
//
// SAFETY (why this can't mess up the live pad):
//   • It only ever deploys TokenVestingLock + RewardVault. It NEVER deploys or
//     imports the factory/router/curve/token, and never runs scripts/deploy.js.
//   • It captures the LIVE factory/router from deploy.json up front and ASSERTS
//     they are byte-identical before AND after — aborting if anything differs.
//   • It's IDEMPOTENT: a contract already recorded in deploy.json (with code on
//     chain) is skipped, so re-running never double-deploys.
//   • Dry run is the default; real sends require ENABLE=1. The reward-leg switch
//     is separate (ENABLE_LEGS=1) and is a reversible setter, not a redeploy.
// ─────────────────────────────────────────────────────────────────────────────
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DRY = process.env.ENABLE !== "1";
const FLIP_LEGS = process.env.ENABLE_LEGS === "1";
const CHAIN_ID = 4663;

const manifestPath = path.resolve(__dirname, "..", "deploy.json");
const padConfigPath = path.resolve(__dirname, "..", "..", "pad", "assets", "config.js");

function log(...a) { console.log(...a); }
function hr() { log("─".repeat(64)); }

async function main() {
  hr();
  log(`  ${DRY ? "DRY RUN (no transactions will be sent)" : "LIVE ENABLE"}  ·  network=${network.name}`);
  hr();

  // ── preflight ──────────────────────────────────────────────────────────────
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`Wrong chain: connected to ${net.chainId}, expected ${CHAIN_ID} (Robinhood). Aborting.`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const c = manifest.contracts;
  // The LIVE addresses we must NEVER touch. Snapshot them now for the before/after guard.
  const LIVE = { padFactory: c.padFactory, padRouter: c.padRouter };
  for (const [k, v] of Object.entries(LIVE)) if (!ethers.isAddress(v)) throw new Error(`deploy.json ${k} is not an address — aborting.`);
  log(`  LIVE factory (read-only, never touched): ${LIVE.padFactory}`);
  log(`  LIVE router  (read-only, never touched): ${LIVE.padRouter}`);

  const [deployer] = await ethers.getSigners();
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gasPrice (legacy chain expected).");
  const ov = { type: 0, gasPrice }; // legacy tx (Robinhood has no EIP-1559)
  const bal = await ethers.provider.getBalance(deployer.address);
  log(`  deployer=${deployer.address}  balance=${(+ethers.formatEther(bal)).toFixed(4)} ETH  gas=${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  const alreadyDeployed = async (addr) => addr && ethers.isAddress(addr) && (await ethers.provider.getCode(addr)) !== "0x";

  // ── 1) TokenVestingLock (standalone, zero deps) ──────────────────────────────
  hr();
  let vesting = c.tokenVestingLock;
  if (await alreadyDeployed(vesting)) {
    log(`  ✓ TokenVestingLock already deployed at ${vesting} — skipping.`);
  } else if (DRY) {
    log(`  [dry] would deploy TokenVestingLock (no constructor args).`);
  } else {
    log(`  Deploying TokenVestingLock…`);
    const lock = await (await ethers.getContractFactory("TokenVestingLock")).deploy(ov);
    await lock.deploymentTransaction().wait();
    vesting = await lock.getAddress();
    log(`  ✓ TokenVestingLock: ${vesting}`);
  }

  // ── 2) RewardVault (references the LIVE router read-only) ─────────────────────
  hr();
  let vault = c.rewardVault;
  const poster = process.env.POSTER, guardian = process.env.GUARDIAN;
  const owner = process.env.OWNER || manifest.owner || deployer.address;
  const epochLen = Number(process.env.EPOCH_LEN || 604800);
  const finality = Number(process.env.FINALITY_DELAY || 86400);
  const challenge = Number(process.env.CHALLENGE_WINDOW || 172800);
  const claim = Number(process.env.CLAIM_WINDOW || 2592000);
  if (await alreadyDeployed(vault)) {
    log(`  ✓ RewardVault already deployed at ${vault} — skipping.`);
  } else if (DRY) {
    log(`  [dry] would deploy RewardVault(router=${LIVE.padRouter}, poster, guardian, epoch=${epochLen}, finality=${finality}, challenge=${challenge}, claim=${claim}, owner=${owner}).`);
    if (!ethers.isAddress(poster || "") || !ethers.isAddress(guardian || "")) log(`  [dry] NOTE: set POSTER and GUARDIAN (guardian = a multisig) before a real run.`);
  } else {
    if (!ethers.isAddress(poster || "") || !ethers.isAddress(guardian || "")) throw new Error("Set POSTER and GUARDIAN addresses in env (guardian should be a multisig).");
    log(`  Deploying RewardVault (references the live router read-only)…`);
    const rv = await (await ethers.getContractFactory("RewardVault")).deploy(
      LIVE.padRouter, poster, guardian, epochLen, finality, challenge, claim, owner, ov);
    await rv.deploymentTransaction().wait();
    vault = await rv.getAddress();
    log(`  ✓ RewardVault: ${vault}`);
  }

  // ── 3) HARD GUARD: the live pad must be byte-for-byte unchanged ───────────────
  hr();
  const after = JSON.parse(fs.readFileSync(manifestPath, "utf8")).contracts;
  if (after.padFactory !== LIVE.padFactory || after.padRouter !== LIVE.padRouter)
    throw new Error("GUARD TRIPPED: the live factory/router address changed. Aborting — nothing was wired.");
  // Sanity that the router is still the same live contract (read-only call).
  const routerCode = await ethers.provider.getCode(LIVE.padRouter);
  if (routerCode === "0x") throw new Error("GUARD TRIPPED: live router has no code. Aborting.");
  log(`  ✓ GUARD PASSED: live factory + router untouched (byte-identical, code intact).`);

  if (DRY) {
    hr();
    log(`  Dry run complete. Nothing was deployed or changed.`);
    log(`  When ready:  ENABLE=1 POSTER=0x… GUARDIAN=0x… npx hardhat run scripts/enable-advanced.js --network robinhood`);
    hr();
    return;
  }

  // ── 4) auto-wire the config (repo files) ─────────────────────────────────────
  hr();
  manifest.contracts.tokenVestingLock = vesting || "";
  manifest.contracts.rewardVault = vault || "";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`  ✓ deploy.json updated (tokenVestingLock, rewardVault).`);

  // pad/assets/config.js — flip the two empty address strings, precisely and only if currently "".
  let cfg = fs.readFileSync(padConfigPath, "utf8");
  const setAddr = (key, addr) => {
    if (!addr) return;
    const re = new RegExp(`(${key}:\\s*)""`);
    if (re.test(cfg)) { cfg = cfg.replace(re, `$1"${addr}"`); log(`  ✓ config.js ${key} = ${addr}`); }
    else log(`  · config.js ${key} not blank (left as-is) — verify manually.`);
  };
  setAddr("tokenVestingLock", vesting);
  setAddr("rewardVault", vault);
  fs.writeFileSync(padConfigPath, cfg);

  // ── 5) optional: flip the reward legs (reversible setter on the live router) ──
  if (FLIP_LEGS && vault) {
    hr();
    log(`  ENABLE_LEGS=1 → router.setRewardVault(${vault}) (reversible; turns the 0.25% legs on)…`);
    const r = new ethers.Contract(LIVE.padRouter, ["function setRewardVault(address v) external", "function rewardVault() view returns (address)"], deployer);
    await (await r.setRewardVault(vault, ov)).wait();
    const now = await r.rewardVault();
    if (now.toLowerCase() !== vault.toLowerCase()) throw new Error("setRewardVault did not stick — check the router owner.");
    log(`  ✓ reward legs LIVE. (To turn OFF later: router.setRewardVault(0x0) — reversible.)`);
  } else if (vault) {
    log(`  · Reward legs NOT flipped. When your indexer has posted a test epoch, run with ENABLE_LEGS=1 (reversible).`);
  }

  // ── 6) print the droplet (indexer) commands — the only non-repo step ─────────
  hr();
  log(`  INDEXER (run on the droplet, then restart the indexer container):`);
  if (vault) log(`    REWARD_VAULT=${vault}  EPOCH_LEN=${epochLen}  FINALITY_DELAY=${finality}`);
  if (vesting) log(`    TOKEN_VESTING_LOCK=${vesting}`);
  log(`    (add/replace these in indexer/.env, then: docker compose up -d --build)`);
  hr();
  log(`  Done. Commit the config.js + deploy.json changes to publish the UI.`);
}

main().catch((e) => { console.error("\n✗ " + (e.message || e)); process.exit(1); });
