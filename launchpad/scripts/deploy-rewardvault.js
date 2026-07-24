// Deploy ONLY the RewardVault and (optionally) flip the switch on the LIVE router.
//
//   npx hardhat run scripts/deploy-rewardvault.js --network robinhood     (PRIVATE_KEY in .env)
//
// SAFETY: this deploys ONE new contract (the vault) and — only if ENABLE_LEGS=1 —
// calls router.setRewardVault(vault) ON THE ALREADY-DEPLOYED router. It NEVER
// redeploys the router, factory, curves, or tokens. setRewardVault is a setter
// (re-settable, reversible) that just turns the 0.25% reward legs on; existing
// coin configs are register-once and untouched.
//
// Env: POSTER, GUARDIAN, OWNER (addresses); EPOCH_LEN, FINALITY_DELAY,
//      CHALLENGE_WINDOW, CLAIM_WINDOW (seconds); ENABLE_LEGS=1 to flip the switch.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gasPrice (legacy chain expected)");
  const ov = { type: 0, gasPrice };

  // The LIVE router — READ from deploy.json, never redeployed.
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "deploy.json"), "utf8"));
  const router = manifest.contracts.padRouter;
  if (!ethers.isAddress(router)) throw new Error("no padRouter in deploy.json");

  const poster = process.env.POSTER;
  const guardian = process.env.GUARDIAN;
  const owner = process.env.OWNER || manifest.owner || deployer.address;
  const epochLen = Number(process.env.EPOCH_LEN || 604800); // 7 days (repo standard)
  const finality = Number(process.env.FINALITY_DELAY || 86400); // 24h — MUST equal the indexer's FINALITY_DELAY
  const challenge = Number(process.env.CHALLENGE_WINDOW || 172800); // 2 days
  const claim = Number(process.env.CLAIM_WINDOW || 2592000); // 30 days
  if (!ethers.isAddress(poster) || !ethers.isAddress(guardian)) {
    throw new Error("set POSTER and GUARDIAN addresses in env (guardian should be a multisig)");
  }

  console.log(`network=${network.name}  deployer=${deployer.address}`);
  console.log(`LIVE router (read-only): ${router}`);
  console.log(`vault params: poster=${poster} guardian=${guardian} owner=${owner}`);
  console.log(`  epoch=${epochLen}s finality=${finality}s challenge=${challenge}s claim=${claim}s`);

  const vault = await (await ethers.getContractFactory("RewardVault")).deploy(
    router, poster, guardian, epochLen, finality, challenge, claim, owner, ov);
  const rc = await vault.deploymentTransaction().wait();
  const addr = await vault.getAddress();
  console.log(`\n✓ RewardVault deployed: ${addr}  (gas ${rc.gasUsed})`);

  if (process.env.ENABLE_LEGS === "1") {
    // Only the CURRENT router owner can do this. It's a setter on the live router — NOT a redeploy.
    console.log(`\nENABLE_LEGS=1 → calling router.setRewardVault(${addr}) on the LIVE router…`);
    const r = new ethers.Contract(router, ["function setRewardVault(address v) external"], deployer);
    await (await r.setRewardVault(addr, ov)).wait();
    console.log(`✓ reward legs are now LIVE (0.25% buy→traders, 0.25% sell→holders).`);
  } else {
    console.log(`\nSwitch NOT flipped. When ready, the router OWNER runs:`);
    console.log(`  router.setRewardVault("${addr}")   // turns the 0.25% legs on; reversible`);
  }

  console.log(`\n=== update config ===`);
  console.log(`  pad/assets/config.js CONTRACTS.rewardVault = "${addr}"`);
  console.log(`  deploy.json contracts.rewardVault = "${addr}"`);
  console.log(`  indexer .env: REWARD_VAULT=${addr}  EPOCH_LEN=${epochLen}  FINALITY_DELAY=${finality}  (must match this deploy)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
