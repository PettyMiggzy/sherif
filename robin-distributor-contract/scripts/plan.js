// Read-only preview of the split for the contract's current balance.
//   npm run plan
const { getProvider, getContract, safeGetBalance, getEthUsd, ethers } = require("./lib");

async function main() {
  const provider = getProvider();
  const c = getContract(null, provider);
  const addr = await c.getAddress();

  const mode = (process.env.DISTRIBUTE_MODE || "fixed").toLowerCase();
  const unit = await c.unitWei();
  let ethUsd = null;
  try { ethUsd = (await getEthUsd()).price; } catch { /* price optional for preview */ }
  const usd = (wei) => (ethUsd == null ? "—" : "$" + (Number(ethers.formatEther(wei)) * ethUsd).toFixed(6));

  const line = "─".repeat(64);
  console.log(line);
  console.log(`Contract       ${addr}`);
  console.log(`Mode           ${mode}`);
  console.log(`Increment      ${ethers.formatEther(unit)} ETH  ≈ ${usd(unit)} per step`);

  if (mode === "even") {
    const [balance, totalUnits, base, extra, n, funded] = await c.previewRound();
    console.log(`Recipients     ${n}`);
    console.log(`Balance        ${ethers.formatEther(balance)} ETH  ≈ ${usd(balance)}`);
    console.log(line);
    console.log(`Wallets funded ${funded} / ${n}`);
    if (funded > 0n) {
      const lo = base * unit, hi = (base + (extra > 0n ? 1n : 0n)) * unit;
      console.log(`Per wallet     ${ethers.formatEther(lo)}${hi > lo ? "–" + ethers.formatEther(hi) : ""} ETH` +
        `  (${base} step${base === 1n ? "" : "s"}${extra > 0n ? `, ${extra} get +1` : ""})`);
    }
    const distributed = totalUnits * unit;
    console.log(`Distributed    ${ethers.formatEther(distributed)} ETH  ≈ ${usd(distributed)}`);
    console.log(`Leftover dust  ${ethers.formatEther(balance - distributed)} ETH  (stays in contract)`);
  } else {
    const [balance, , , n, funded, needForAll] = await c.previewFixedRound();
    console.log(`Recipients     ${n}`);
    console.log(`Balance        ${ethers.formatEther(balance)} ETH  ≈ ${usd(balance)}`);
    console.log(`Need for all   ${ethers.formatEther(needForAll)} ETH  ≈ ${usd(needForAll)}  (value only; gas is paid by your wallet)`);
    console.log(line);
    console.log(`Wallets funded ${funded} / ${n}   × one step (${ethers.formatEther(unit)} ETH ≈ ${usd(unit)} each)`);
    console.log(`Distributed    ${ethers.formatEther(BigInt(funded) * unit)} ETH  ≈ ${usd(BigInt(funded) * unit)}`);
  }
  console.log(line);
  console.log(`Run: npm run distribute   (startRound + batched payouts; DISTRIBUTE_MODE=${mode})`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
