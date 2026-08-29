// ONE COMMAND that stands up the whole staking + fee pipeline and proves it works.
//
//   cd launchpad
//   ROBINHOOD_RPC=<rpc> PRIVATE_KEY=<owner key> \
//     KEEPER=<the keeper wallet address> \
//     npx hardhat run scripts/wire-staking.js --network robinhood
//
// It deploys whatever is missing, makes every connection, then READS EVERY ONE BACK and refuses to
// report success unless it is real. That last part is the point: every failure in this pipeline is
// SILENT — a missing sink makes a flush a no-op rather than an error, an unauthorised feeder makes a
// funding call revert into a keeper log nobody reads — so "it ran without throwing" is not evidence
// that money will move. The verification at the end is.
//
// Re-runnable. Anything already correct is left alone and reported as such.
const { ethers, network } = require("hardhat");

const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const ROBIN = (process.env.ROBIN || "0x6696fe29288b586017e6f264c0091dba6c5ebeaf").trim();

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ZERO = ethers.ZeroAddress;
const ok = [];
const todo = [];

async function main() {
  const [me] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`Wrong chain ${net.chainId}, expected ${CHAIN_ID}.`);

  let gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) gasPrice = BigInt(await ethers.provider.send("eth_gasPrice", []));
  const ov = { type: 0, gasPrice }; // legacy: Orbit L2, no EIP-1559

  const keeper = (process.env.KEEPER || "").trim();
  if (!ethers.isAddress(keeper)) throw new Error("Set KEEPER to the wallet address your keeper box uses.");

  const bal = await ethers.provider.getBalance(me.address);
  console.log(`network=${network.name} chain=${net.chainId}`);
  console.log(`owner=${me.address}  balance=${ethers.formatEther(bal)} ETH`);
  console.log(`keeper=${keeper}\n`);
  if (bal === 0n) throw new Error("Owner wallet has 0 ETH — fund it first.");

  // ── 1. the pieces ────────────────────────────────────────────────────────
  let factoryAddr = (process.env.TIER_STAKING_FACTORY || "").trim();
  let factory;
  if (ethers.isAddress(factoryAddr)) {
    factory = await ethers.getContractAt("RobinTierStakingFactory", factoryAddr);
    console.log(`staking factory:  ${factoryAddr} (existing)`);
  } else {
    factory = await (await ethers.getContractFactory("RobinTierStakingFactory")).deploy(me.address, ov);
    await factory.waitForDeployment();
    factoryAddr = await factory.getAddress();
    console.log(`staking factory:  ${factoryAddr} (deployed)`);
  }

  // The flagship $ROBIN pool has to exist before anything else: every other pool inherits it as the
  // boost source, and a pool created before it exists is permanently unboosted until repaired.
  let robinPool = await factory.poolOf(ROBIN);
  if (eq(robinPool, ZERO)) {
    await (await factory.createPool(ROBIN, true, ov)).wait();
    robinPool = await factory.poolOf(ROBIN);
    console.log(`$ROBIN pool:      ${robinPool} (deployed, self-boosted)`);
  } else {
    console.log(`$ROBIN pool:      ${robinPool} (existing)`);
  }

  let feederAddr = (process.env.STAKING_FEEDER || "").trim();
  let feeder;
  if (ethers.isAddress(feederAddr)) {
    feeder = await ethers.getContractAt("StakingFeeder", feederAddr);
    console.log(`fee feeder:       ${feederAddr} (existing)`);
  } else {
    feeder = await (await ethers.getContractFactory("StakingFeeder")).deploy(me.address, factoryAddr, ov);
    await feeder.waitForDeployment();
    feederAddr = await feeder.getAddress();
    console.log(`fee feeder:       ${feederAddr} (deployed)`);
  }

  // ── 2. the five connections ──────────────────────────────────────────────
  console.log("\nwiring:");
  const step = async (label, read, write) => {
    const before = await read();
    if (before) { console.log(`  ${label}: already set`); ok.push(label); return; }
    await (await write()).wait();
    const after = await read();
    if (after) { console.log(`  ${label}: set`); ok.push(label); }
    else { console.log(`  ${label}: FAILED to stick`); todo.push(label); }
  };

  await step("factory knows the feeder",
    async () => eq(await factory.feeder(), feederAddr),
    () => factory.setFeeder(feederAddr, ov));

  await step("keeper may create pools",
    async () => await factory.isCreator(keeper),
    () => factory.setCreator(keeper, true, ov));

  await step("keeper may move fees",
    async () => await feeder.isOperator(keeper),
    () => feeder.setOperator(keeper, true, ov));

  // The router is only wired if this owner controls it — otherwise it is reported rather than
  // attempted, because a failed onlyOwner call here would look like a script bug.
  const routerAddr = (process.env.ROUTER || "").trim();
  if (ethers.isAddress(routerAddr)) {
    // A call to an address with no code SUCCEEDS with empty returndata, and ethers then fails to
    // decode it — so a mistyped router produced "could not decode result data" instead of "that is
    // not a router". Checked before the call so the message is the actual problem.
    const code = await ethers.provider.getCode(routerAddr);
    if (code === "0x") throw new Error(`ROUTER ${routerAddr} has no contract at it — check the address.`);
    const router = await ethers.getContractAt("PadRouter", routerAddr);
    let rOwner;
    try { rOwner = await router.owner(); }
    catch { throw new Error(`ROUTER ${routerAddr} does not look like a PadRouter (no owner()).`); }
    if (!eq(rOwner, me.address)) {
      console.log(`  router sinks: SKIPPED — the router is owned by ${rOwner}, not you`);
      todo.push(`router.setStakingSink(${feederAddr}) and setRobinSink, from ${rOwner}`);
    } else {
      await step("sell fees flow to the feeder",
        async () => eq(await router.stakingSink(), feederAddr),
        () => router.setStakingSink(feederAddr, ov));
      await step("buy fees flow to the feeder",
        async () => eq(await router.robinSink(), feederAddr),
        () => router.setRobinSink(feederAddr, ov));
    }
  } else {
    console.log("  router sinks: SKIPPED — set ROUTER to wire them");
    todo.push(`router.setStakingSink(${feederAddr}) and router.setRobinSink(${feederAddr})`);
  }

  // ── 3. prove it, do not assume it ────────────────────────────────────────
  console.log("\nverifying (reading everything back off the chain):");
  const p = await ethers.getContractAt("RobinTierStaking", robinPool);
  const checks = [
    ["$ROBIN pool is its own boost source", eq(await p.boostSource(), robinPool)],
    ["$ROBIN pool is owned by you", eq(await p.owner(), me.address)],
    ["you can fund the $ROBIN pool", await p.isRewarder(me.address)],
    ["factory points at the feeder", eq(await factory.feeder(), feederAddr)],
    ["keeper can create pools", await factory.isCreator(keeper)],
    ["keeper can move fees", await feeder.isOperator(keeper)],
    ["feeder trusts this factory", eq(await feeder.registry(), factoryAddr)],
  ];
  let bad = 0;
  for (const [label, good] of checks) { console.log(`  ${good ? "OK  " : "FAIL"}  ${label}`); if (!good) bad++; }

  // The flagship pool predates setFeeder, so it needs the grant directly — the factory no longer owns it.
  if (!(await p.isRewarder(feederAddr))) {
    await (await p.setRewarder(feederAddr, true, ov)).wait();
    console.log("  OK    feeder authorised on the $ROBIN pool (it predated setFeeder)");
  } else {
    console.log("  OK    feeder authorised on the $ROBIN pool");
  }

  console.log("\nPaste into indexer/.env:");
  console.log(`  TIER_STAKING_FACTORY=${factoryAddr}`);
  console.log(`  STAKING_FEEDER=${feederAddr}`);
  console.log(`  POOL_MAKER_KEY=<the private key for ${keeper}>`);
  console.log(`  FEED_KEEPER_KEY=<the private key for ${keeper}>`);
  console.log("\nPaste into pad/assets/config.js CONTRACTS:");
  console.log(`  tierStakingFactory: "${factoryAddr}",`);
  console.log(`  robinTierStaking:   "${robinPool}",`);

  if (todo.length) {
    console.log("\nSTILL TO DO BY HAND:");
    for (const t of todo) console.log(`  - ${t}`);
  }
  if (bad) throw new Error(`${bad} check(s) failed — the pipeline is NOT complete. Nothing above is trustworthy until they pass.`);
  console.log(`\nAll ${checks.length} checks passed.${todo.length ? " Finish the list above and re-run to confirm." : " The pipeline is complete."}`);
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
