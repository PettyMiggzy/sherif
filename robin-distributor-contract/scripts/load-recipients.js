// Push the recipient list on-chain in batches (each addRecipients tx must stay
// under the 2^24 per-tx gas cap). Idempotent-ish: skips recipients already stored.
//   npm run load
const { getProvider, getWallet, legacyOverrides, getContract, loadRecipients, ethers } = require("./lib");

const BATCH = Number(process.env.LOAD_BATCH || 200); // ~200 pushes ≈ a few M gas

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const c = getContract(null, wallet);
  const recipients = loadRecipients();

  const already = Number(await c.recipientCount());
  console.log(`On-chain recipients: ${already} / target ${recipients.length}`);
  if (already >= recipients.length) { console.log("Already loaded. Nothing to do."); return; }

  for (let start = already; start < recipients.length; start += BATCH) {
    const batch = recipients.slice(start, start + BATCH);
    const ov = await legacyOverrides(provider);
    const tx = await c.addRecipients(batch, ov);
    const rc = await tx.wait();
    console.log(`  +${batch.length} (total ${start + batch.length})  gas ${rc.gasUsed}  ${tx.hash}`);
  }
  console.log(`\n✓ Loaded ${Number(await c.recipientCount())} recipients.`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
