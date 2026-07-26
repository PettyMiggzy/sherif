// Run one distribution round: startRound() then distribute() in batches until
// every recipient is paid. Batching keeps each tx under the per-tx gas cap.
//   npm run distribute            (uses current on-chain unit)
//   REFRESH_UNIT=1 npm run distribute   (set unit to $0.0000814 @ live price first)
const { getProvider, getWallet, legacyOverrides, getContract, resolveUnitWei, ethers } = require("./lib");

const BATCH = Number(process.env.DISTRIBUTE_BATCH || 200); // sends per tx (< gas cap)

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const c = getContract(null, wallet);

  const n = Number(await c.recipientCount());
  if (n === 0) throw new Error("No recipients on-chain. Run `npm run load` first.");

  if (process.env.REFRESH_UNIT === "1") {
    const unitWei = await resolveUnitWei();
    if ((await c.unitWei()) !== unitWei) {
      const ov = await legacyOverrides(provider);
      const tx = await c.setUnitWei(unitWei, ov);
      await tx.wait();
      console.log(`unit set → ${ethers.formatEther(unitWei)} ETH`);
    }
  }

  // MODE: "fixed" = exactly one $0.0000814 step per wallet (default here),
  //       "even"  = split the whole balance evenly across all wallets.
  const mode = (process.env.DISTRIBUTE_MODE || "fixed").toLowerCase();

  if (await c.roundActive()) {
    console.log("A round is already active — resuming from the current cursor.");
  } else if (mode === "even") {
    const [balance, totalUnits, , , , funded] = await c.previewRound();
    if (funded === 0n) { console.log(`Balance ${ethers.formatEther(balance)} ETH — nothing to distribute.`); return; }
    await (await c.startRound(await legacyOverrides(provider))).wait();
    console.log(`Even round started: balance ${ethers.formatEther(balance)} ETH, ${totalUnits} units, ${funded}/${n} funded.`);
  } else {
    const [balance, , , , funded, needForAll] = await c.previewFixedRound();
    if (funded === 0n) { console.log(`Balance ${ethers.formatEther(balance)} ETH — nothing to distribute (need ≥ one step).`); return; }
    if (funded < BigInt(n)) {
      console.log(`⚠ balance funds only ${funded}/${n} wallets at one step each. ` +
        `Send ${ethers.formatEther(needForAll)} ETH total to cover all ${n}.`);
    }
    await (await c.startFixedRound(await legacyOverrides(provider))).wait();
    console.log(`Fixed round started: ${funded}/${n} wallets × one step (${ethers.formatEther(await c.unitWei())} ETH each).`);
  }

  // Pay in batches until cursor reaches n.
  for (;;) {
    const cursor = Number(await c.cursor());
    if (!(await c.roundActive()) || cursor >= n) break;
    const ov = await legacyOverrides(provider);
    const tx = await c.distribute(BATCH, ov);
    const rc = await tx.wait();
    console.log(`  distribute(${BATCH}) cursor ${cursor}→${Math.min(cursor + BATCH, n)}  gas ${rc.gasUsed}  ${tx.hash}`);
  }

  const paid = await c.roundPaid();
  console.log(`\n✓ Round complete. Paid ${ethers.formatEther(paid)} ETH. Leftover stays in the contract.`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
