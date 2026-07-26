// Refresh the on-chain increment to $0.0000814 at the current ETH price.
//   npm run set-unit
const { getProvider, getWallet, legacyOverrides, getContract, resolveUnitWei, ethers } = require("./lib");

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const c = getContract(null, wallet);
  const unitWei = await resolveUnitWei();
  const current = await c.unitWei();
  console.log(`Current unit : ${ethers.formatEther(current)} ETH`);
  console.log(`New unit     : ${ethers.formatEther(unitWei)} ETH  (${unitWei} wei)`);
  if (current === unitWei) { console.log("Unchanged."); return; }
  const ov = await legacyOverrides(provider);
  const tx = await c.setUnitWei(unitWei, ov);
  await tx.wait();
  console.log(`✓ unit updated  ${tx.hash}`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
