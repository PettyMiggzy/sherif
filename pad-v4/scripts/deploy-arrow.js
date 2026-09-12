/*
 * Deploy the Arrow migration launcher (ArrowLauncher) against an already-deployed curve suite.
 * Reads deploy.curve.json (written by scripts/deploy-curve.js) for the factory + fee registry addresses,
 * so this must run AFTER deploy-curve.js against the same chain.
 *
 * `platformFee` is an IMMUTABLE constructor arg (see ArrowLauncher.sol) — there is no setter, so retuning it
 * means deploying a fresh ArrowLauncher. Default below targets ~$200 (see ARROW_FEE_ETH override + the comment
 * at its definition for the price snapshot this was calibrated against); pass ARROW_FEE_ETH explicitly to set
 * a precise figure as ETH's price moves rather than trusting a stale default.
 *
 * Usage: ROBINHOOD_RPC=<rpc> PRIVATE_KEY=<key> [ARROW_FEE_ETH=0.08] \
 *        npx hardhat run scripts/deploy-arrow.js --network robinhood
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// [migration fee] ~$200 in ETH, snapshotted against ETH ≈ $2,540 (Sep 2026) — a flat fee to cover the real
// gas/API cost of a migration with margin (per ROBIN-PAD-NEXT-GEN-IDEAS.md's "Migration feature" section:
// bumped up from an initial $100 idea specifically to keep that margin). This DRIFTS as ETH's price moves —
// the whole point of making `platformFee` an immutable constructor arg instead of ArrowLauncher's old hardcoded
// `PLATFORM_FEE = 0.5 ether` constant is that retuning this no longer means silently shipping a stale number
// baked into bytecode; it means deliberately setting ARROW_FEE_ETH before the next deploy.
const ARROW_FEE_ETH = process.env.ARROW_FEE_ETH || "0.08";

async function legacyDeploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args, { type: 0 });
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(24)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const curveDeployFile = path.join(__dirname, "..", "deploy.curve.json");
  if (!fs.existsSync(curveDeployFile)) {
    throw new Error(`${curveDeployFile} not found — run scripts/deploy-curve.js against this chain first`);
  }
  const curveDeploy = JSON.parse(fs.readFileSync(curveDeployFile, "utf8"));
  const curveFactory = curveDeploy.contracts.curveFactory;
  const feeRegistry = curveDeploy.contracts.feeWalletRegistry;
  if (!curveFactory || !feeRegistry) {
    throw new Error("deploy.curve.json is missing contracts.curveFactory / contracts.feeWalletRegistry");
  }

  const platformFee = ethers.parseEther(ARROW_FEE_ETH);
  console.log(`Deploying ArrowLauncher as ${deployer.address}`);
  console.log(`  curveFactory  ${curveFactory}`);
  console.log(`  feeRegistry   ${feeRegistry}`);
  console.log(`  platformFee   ${ARROW_FEE_ETH} ETH (${platformFee} wei)\n`);

  const launcher = await legacyDeploy("ArrowLauncher", [curveFactory, feeRegistry, platformFee]);

  const out = {
    ...curveDeploy,
    contracts: {
      ...curveDeploy.contracts,
      arrowLauncher: await launcher.getAddress(),
    },
    arrowPlatformFeeEth: ARROW_FEE_ETH,
  };
  fs.writeFileSync(curveDeployFile, JSON.stringify(out, null, 2));
  console.log(`\nUpdated ${curveDeployFile} with contracts.arrowLauncher`);
  console.log("\nNext: per ARROW.md's 'Post-graduation wiring is still the operator's job' — an Arrow launch");
  console.log("graduates instantly but does NOT wire staking/treasury/floor; that stays a manual post-hoc step.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
