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
    // [H-5] addFloor never reverts — it PARKS. Surface why, so a floor that has silently stopped deploying is
    // diagnosable from the keeper log instead of needing a trace. R_ORACLE in particular means the gate was
    // never armed (hook.armFloorGate), which is a wiring bug, not a market condition.
    await tryStep("floor gate status", async () => {
      const REASONS = {
        1: "R_ORACLE — hook unreadable/unarmed/armed for another band (CHECK hook.armFloorGate)",
        2: "R_SPOT — live spot is inside/above the band (the floor is doing its job)",
        3: "R_WARMUP — armed less than MIN_BELOW_DURATION ago",
        4: "R_BELOW — the band was touched too recently (gate)",
        5: "R_TWAP — the window average is not below the band",
        6: "R_DWELL — legacy poke dwell",
        7: "R_COOLDOWN — legacy pace limiter",
        8: "R_BUDGET — this episode's commit allowance is exhausted",
      };
      const st = await floor.gateStatus();
      const parked = await floor.parkedQuote();
      console.log(
        `    gate: armed=${st.armed} warm=${st.warm} spot=${st.spot} ` +
        `parked=${ethers.formatEther(parked)} ETH allowance=${ethers.formatEther(st.allowance)} ETH`
      );
      if (!st.armed) console.log(`    ${REASONS[1]}`);
      const ev = await floor.queryFilter(floor.filters.FloorParked(), -2000).catch(() => []);
      if (ev.length) console.log(`    last park reason: ${REASONS[Number(ev[ev.length - 1].args.reason)] || "?"}`);
      return null; // read-only step: nothing to wait on
    });
    await tryStep("collect wall LP fees", () => floor.collectFloorFees({ type: 0 }));
  }
  console.log("\nsweep complete");
}

main().catch((e) => { console.error(e); process.exit(1); });
