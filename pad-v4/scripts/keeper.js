/*
 * Robin V4 revenue keeper — run on a schedule (cron / pm2 / a droplet loop). For every launched pad
 * in deploy.local.json it does a best-effort sweep (each step try/caught, so "nothing to claim" is a
 * no-op, never a crash):
 *   1. lockVault.collectFees(lpTokenId)        — realize the locked seed-LP fees into the vault
 *   2. lockVault.claimPlatform(lpTokenId, 0)   — quote/buy-side LP fee → platform treasury
 *   3. lockVault.claimStaking(lpTokenId, 1)    — token/sell-side LP fee → the reward keeper (this wallet)
 *   4. stakingPool.fundToken(TOKEN, token, bal)— stream the swept token to stakers (safe measured pull)
 *   5. hook.claimFloor(poolId, 0)              — the 0.2% sell-tax carve → the floor vault
 *   6. floorVault.addFloor()                   — deploy the carve into the permanent buy-wall
 *   7. floorVault.collectFloorFees()           — the wall's own LP fees → platform
 * Then, across every presale the PresaleVaultFactory has ever opened:
 *   8. presaleVault.withdrawPlatformFee()      — the platform's cut of a raise that succeeded
 * The keeper only MOVES already-owed funds to their fixed on-chain destinations; it can never redirect
 * them (every recipient is immutable in the contracts), so a compromised keeper key cannot steal — the
 * worst it can do is not run.
 *
 * Usage: PRIVATE_KEY (=reward keeper) ROBINHOOD_RPC  npx hardhat run scripts/keeper.js --network robinhood
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TOKEN_SIDE = 0;

async function tryStep(label, fn) {
  try {
    const tx = await fn();
    if (tx && tx.wait) await tx.wait();
    console.log(`   ✓ ${label}`);
  } catch (e) {
    const msg = (e.shortMessage || e.message || "").split("\n")[0];
    console.log(`   · ${label} — skipped (${msg.slice(0, 60)})`);
  }
}

async function main() {
  const file = path.join(__dirname, "..", "deploy.local.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const launches = d.launches || [];
  if (launches.length === 0) return console.log("no launches to sweep");

  const [keeper] = await ethers.getSigners();
  const lockVault = await ethers.getContractAt("LockVault", d.lockVault);

  for (const L of launches) {
    console.log(`\n▸ ${L.symbol} (${L.token})`);
    const hook = await ethers.getContractAt("RobinFeeHook", L.hook);
    const floor = await ethers.getContractAt("RobinFloorVault", L.floorVault);
    const token = await ethers.getContractAt("PadToken", L.token);
    const pool = L.stakingPool ? await ethers.getContractAt("DualStaking", L.stakingPool) : null;

    await tryStep("collect LP fees", () => lockVault.collectFees(L.lpTokenId, { type: 0 }));
    await tryStep("platform LP (quote)", () => lockVault.claimPlatform(L.lpTokenId, 0, { type: 0 }));
    await tryStep("staking LP (token) -> keeper", () => lockVault.claimStaking(L.lpTokenId, 1, { type: 0 }));

    if (pool) {
      const bal = await token.balanceOf(keeper.address);
      if (bal > 0n) {
        await tryStep("approve pool", () => token.approve(L.stakingPool, bal, { type: 0 }));
        await tryStep("fund stakers (token stream)", () => pool.fundToken(TOKEN_SIDE, L.token, bal, { type: 0 }));
      }
    }

    await tryStep("claim floor carve", () => hook.claimFloor(L.poolId, 0, { type: 0 }));
    await tryStep("deploy carve into wall", () => floor.addFloor({ type: 0 }));
    await tryStep("collect wall LP fees", () => floor.collectFloorFees({ type: 0 }));
  }
  await sweepPresaleFees(d);

  console.log("\nsweep complete");
}

// The presale platform cut accrues inside each vault at finalize() and sits there until someone pulls it.
// The pull is permissionless and has no deadline, and the destination is read from the fee registry rather
// than passed in, so this loop cannot misdirect anything — but nothing else calls it, so without this the
// default outcome is that the fee is earned and never collected.
async function sweepPresaleFees(d) {
  if (!d.presaleVaultFactory) return console.log("\nno presale factory in deploy.local.json — skipping");
  const f = await ethers.getContractAt("PresaleVaultFactory", d.presaleVaultFactory);
  const n = Number(await f.presaleCount());
  if (n === 0) return console.log("\nno presales opened yet");
  console.log(`\n▸ presale fees (${n} vault${n === 1 ? "" : "s"})`);
  for (let i = 0; i < n; i++) {
    const addr = await f.presales(i);
    const v = await ethers.getContractAt("PresaleVault", addr);
    // Read first so an unfinalized or already-paid vault costs a view call rather than a reverted tx.
    const [fee, paid] = await Promise.all([v.platformFee(), v.platformFeePaid()]);
    if (fee === 0n || paid) continue;
    await tryStep(`withdraw ${ethers.formatEther(fee)} ETH from ${addr}`, () => v.withdrawPlatformFee({ type: 0 }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
