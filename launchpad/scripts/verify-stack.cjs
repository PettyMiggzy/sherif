/* eslint-disable no-console */
// Verify the one-time INFRA stack on Blockscout after a deploy: the router, factory, reward vault,
// floor-coop factory, platform splitter, and the three deployers. Reads addresses from deploy.json
// (written by scripts/deploy.js). Per-COIN contracts (token/curve/bond) are handled separately by
// scripts/auto-verify.cjs (the 24/7 loop) and scripts/verify-coin.cjs.
//
//   node scripts/verify-stack.cjs                 # verify everything in deploy.json
//   node scripts/verify-stack.cjs padFactory      # just one (by manifest key)
//
// Uses Blockscout's native verifier (no key, no constructor args needed). Compile first so the
// artifacts match what you deployed.
const fs = require("fs");
const path = require("path");
const { BLOCKSCOUT, verifyAddress } = require("./lib/blockscout.cjs");

// manifest key -> its Solidity source + contract name
const INFRA = {
  padRouter: { sol: "contracts/PadRouter.sol", name: "PadRouter" },
  padFactory: { sol: "contracts/CurvePadFactory.sol", name: "CurvePadFactory" },
  rewardVault: { sol: "contracts/RewardVault.sol", name: "RewardVault" },
  floorCoopFactory: { sol: "contracts/FloorCoopFactory.sol", name: "FloorCoopFactory" },
  platformSplitter: { sol: "contracts/PlatformFeeSplitter.sol", name: "PlatformFeeSplitter" },
  launchTokenDeployer: { sol: "contracts/deployers/CurveDeployers.sol", name: "LaunchTokenDeployer" },
  curvePoolDeployer: { sol: "contracts/deployers/CurveDeployers.sol", name: "CurvePoolDeployer" },
  bondDeployer: { sol: "contracts/deployers/CurveDeployers.sol", name: "BondDeployer" },
};

async function main() {
  const only = process.argv[2];
  const manifestPath = process.env.DEPLOY_JSON || path.resolve(__dirname, "..", "deploy.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`no deploy.json at ${manifestPath} — run scripts/deploy.js first (or set DEPLOY_JSON).`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const addrs = manifest.contracts || {};
  const keys = (only ? [only] : Object.keys(INFRA)).filter((k) => INFRA[k] && addrs[k]);
  if (!keys.length) { console.error(`nothing to verify (key "${only || ""}" not in deploy.json)`); process.exit(2); }

  console.log(`Verifying ${keys.length} infra contract(s) on ${BLOCKSCOUT}\n`);
  const results = [];
  for (const k of keys) {
    results.push(await verifyAddress({ addr: addrs[k], ...INFRA[k], label: k }).catch(() => "fail"));
  }
  const good = results.filter((r) => r === "ok" || r === "already").length;
  console.log(`\ndone: ${good}/${keys.length} verified on Blockscout.`);
  process.exit(good === keys.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
