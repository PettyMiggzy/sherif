// Deploy the TIERED staking stack — RobinTierStakingFactory + the flagship $ROBIN pool.
//
// This is not a redeploy of deploy-staking.js. That script stands up the older flat, no-lock pools
// (StakingFactory / RobinStaking) and they are unrelated contracts; the two can coexist. This one
// stands up RobinTierStaking: a stake picks a term (flexible / 7 / 30 / 60 / 90 / 180 / 365 days)
// that multiplies its share of every reward, an early exit costs 15% of principal to the stakers
// who stayed, and 10M STAKED $ROBIN adds a boost that applies across every pool.
//
// Node 22 + Hardhat. Robinhood Chain is an Orbit L2 with NO EIP-1559, so every tx is legacy
// (type-0) with an explicit gasPrice.
//
//   cd launchpad
//   ROBINHOOD_RPC=<write-capable RPC> PRIVATE_KEY=<funded deployer> \
//     [KEEPER=<addr allowed to create pools without a human>] \
//     [EXTRA_REWARDS=0xaaa,0xbbb] [REWARD_DURATION=604800] \
//     npx hardhat run scripts/deploy-tier-staking.js --network robinhood
//
// WHY THE FACTORY IS DEPLOYED EVEN THOUGH THERE IS ONLY ONE POOL TODAY. The site reads
// `pools()` to decide what to render. Pinning a single pool address into config.js works exactly
// once — the next coin that wants staking needs a config edit, a rebuild and a redeploy of the
// site. With the factory, a new pool appears on the staking page the moment it is created, and
// the keeper can create it with no human in the loop.
const { ethers, network } = require("hardhat");

const ROBIN = (process.env.ROBIN || "0x6696fe29288b586017e6f264c0091dba6c5ebeaf").trim();
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const WEEK = 7 * 24 * 60 * 60;

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong chain ${net.chainId}, expected ${CHAIN_ID}. Set CHAIN_ID to override for a dry run.`);
  }
  if (!ethers.isAddress(ROBIN)) throw new Error("ROBIN is not an address.");

  // legacy gasPrice (no EIP-1559 on Orbit)
  let gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) gasPrice = BigInt(await ethers.provider.send("eth_gasPrice", []));
  const ov = { type: 0, gasPrice };

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`network=${network.name} chain=${net.chainId}`);
  console.log(`deployer=${deployer.address}  balance=${ethers.formatEther(bal)} ETH  gasPrice=${gasPrice}`);
  if (bal === 0n) throw new Error("Deployer has 0 ETH — fund it first.");

  // The deployer becomes the owner of the factory AND, through it, of every pool the factory makes.
  // Check the stake token is real before spending gas: a typo here deploys a pool for a token that
  // does not exist, and `poolOf` would then permanently point the site at it.
  const erc = new ethers.Contract(ROBIN, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], ethers.provider);
  let sym;
  try { sym = await erc.symbol(); } catch { throw new Error(`No ERC-20 at ${ROBIN} — check the ROBIN address.`); }
  console.log(`stake token=${ROBIN} (${sym})\n`);

  // 1) The registry.
  const fac = await (await ethers.getContractFactory("RobinTierStakingFactory")).deploy(deployer.address, ov);
  await fac.waitForDeployment();
  const facAddr = await fac.getAddress();
  console.log("RobinTierStakingFactory:", facAddr);

  // 2) The flagship pool, self-boosted. `selfBoost = true` is for THIS POOL ONLY: it makes the pool
  //    its own boost source, which is what "hold 10M staked $ROBIN" means. Passing true for any other
  //    token would mean staking that coin boosts that coin — a worthless token minting its own
  //    multiplier — so every later pool is created with false and inherits this one.
  await (await fac.createPool(ROBIN, true, ov)).wait();
  const pool = await fac.poolOf(ROBIN);
  console.log("$ROBIN tier pool:       ", pool);

  // 3) Prove the wiring rather than assume it. A pool with the wrong boost source is invisible when
  //    it is wrong: it works perfectly and silently boosts nobody. Same for the rewarder handover —
  //    the pool's constructor makes its DEPLOYER (the factory) a rewarder, and an owner who cannot
  //    fund the pool they own does not surface until the first reward never arrives.
  const p = await ethers.getContractAt("RobinTierStaking", pool);
  const [src, owner, ownerIsRewarder, facIsRewarder, stakeTok] = await Promise.all([
    p.boostSource(), p.owner(), p.isRewarder(deployer.address), p.isRewarder(facAddr), p.stakeToken(),
  ]);
  if (!eq(src, pool)) throw new Error(`FLAGSHIP NOT SELF-BOOSTED: boostSource=${src}, expected ${pool}`);
  if (!eq(owner, deployer.address)) throw new Error(`Pool owner is ${owner}, expected ${deployer.address}`);
  if (!ownerIsRewarder) throw new Error("Owner is NOT a rewarder — it could never fund this pool.");
  if (facIsRewarder) throw new Error("Factory is still a rewarder — the handover did not complete.");
  if (!eq(stakeTok, ROBIN)) throw new Error(`Pool stakes ${stakeTok}, expected ${ROBIN}`);
  console.log("  wiring verified:        self-boosted, owned by deployer, deployer can fund, factory cannot");

  // 4) Optional extra reward assets. The pool already lists its stake token and native ETH; anything
  //    else (a stock token, say) has to be listed before it can be funded at all.
  const extras = (process.env.EXTRA_REWARDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const duration = Number(process.env.REWARD_DURATION || WEEK);
  for (const asset of extras) {
    if (!ethers.isAddress(asset)) throw new Error(`EXTRA_REWARDS contains a non-address: ${asset}`);
    await (await p.listReward(asset, duration, ov)).wait();
    console.log(`  listed reward asset:    ${asset} (streams over ${duration}s)`);
  }

  // 5) Optional automation slot. A creator may ADD pools to the registry; it can never control one,
  //    because pools are owned by the factory's owner. That is what lets graduation mint a pool for a
  //    new coin without handing the automation key any authority over rewards or the boost.
  const keeper = (process.env.KEEPER || "").trim();
  if (keeper && !eq(keeper, deployer.address)) {
    if (!ethers.isAddress(keeper)) throw new Error(`KEEPER is not an address: ${keeper}`);
    await (await fac.setCreator(keeper, true, ov)).wait();
    console.log("  pool-creator slot:      ", keeper);
  }

  console.log("\nPaste into pad/assets/config.js CONTRACTS:");
  console.log(`  tierStakingFactory: "${facAddr}",`);
  console.log(`  robinTierStaking:   "${pool}",`);

  console.log("\nTHEN, IN THIS ORDER — the ordering is not cosmetic:");
  console.log("  1. Verify both on robinhoodchain.blockscout.com.");
  console.log("  2. Paste the addresses into config.js and ship the site. The page is gated on these");
  console.log("     being set and renders a labelled preview until they are.");
  console.log("  3. Get REAL stakers in BEFORE you fund anything. Rewards that land in an empty pool");
  console.log("     wait, then start the instant the FIRST staker appears — when that one account is");
  console.log("     100% of the weight and takes 100% of what streams until somebody else arrives.");
  console.log("     Measured: one wei, alone for a day, took a seventh of a 1,000,000 reward.");
  console.log("  4. Set the reward duration BEFORE funding, not after. setRewardDuration does not");
  console.log("     re-rate a stream already running — it only applies to the next deposit.");

  console.log("\nHOW REWARDS GET IN — they never arrive on their own:");
  console.log("  Nothing at graduation routes here. CurvePool.graduate sends every unsold token to");
  console.log("  the Bond (the floor LP + the sell wall), so a pool pays out only what is put into it.");
  console.log("  • ETH:    pool.notifyRewardETH{value: x}()  — or just send ETH from a rewarder address");
  console.log("  • ERC-20: approve(pool, x) then pool.notifyReward(asset, x)");
  console.log("  • Either one from the staking page's funding panel, which shows for a rewarder wallet.");

  console.log("\nADDING A POOL FOR A LAUNCHED COIN (this is the automatable part):");
  console.log(`  factory.createPool(<coin>, false)   // false = inherit the $ROBIN boost source`);
  console.log("  It shows up on the staking page immediately. No config change, no site redeploy.");
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
