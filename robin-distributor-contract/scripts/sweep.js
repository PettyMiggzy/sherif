// Sweep leftover ETH (and optionally ROBIN) out of every wallet the bot ever used,
// back to SWEEP_TO (default: your distributor wallet). Reads keys.json (the pool) AND
// used-wallets.jsonl (the fresh-mode wallets).
//
//   node scripts/sweep.js            # DRY RUN — just reports how much is recoverable
//   node scripts/sweep.js --go       # actually sweep the ETH back
//   node scripts/sweep.js --go --robin   # also pull the ROBIN tokens (see note below)
//
// Note: sweeping ROBIN consolidates it to one address, which REDUCES your holder count
// (bad for trending). Leave --robin off unless you specifically want the tokens back.
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { getProvider, getWallet, baseFeeGasPrice, ethers } = require("./lib");

const ROOT = path.join(__dirname, "..");
const GO = process.argv.includes("--go");
const SWEEP_ROBIN = process.env.SWEEP_ROBIN === "1" || process.argv.includes("--robin");
const ROBIN = process.env.TOKEN_OUT || "0x6696FE29288B586017E6f264c0091DBA6C5ebeaf";
const CONC = Number(process.env.SWEEP_CONCURRENCY || 10);
const ETH_USD = Number(process.env.ETH_USD || 1887);
const ROBIN_USD = Number(process.env.ROBIN_USD || 0.00001417);

function loadAllKeys() {
  const seen = new Set(), out = [];
  const add = (k) => { if (k && k.privateKey && k.address && !seen.has(k.address.toLowerCase())) { seen.add(k.address.toLowerCase()); out.push(k); } };
  // current pool + every regeneration backup (keys.json.bak-*) so no old pool is missed
  for (const f of fs.readdirSync(ROOT)) {
    if (f === "keys.json" || /^keys\.json\.bak-/.test(f)) { try { JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")).forEach(add); } catch {} }
  }
  const uw = path.join(ROOT, "used-wallets.jsonl");
  if (fs.existsSync(uw)) fs.readFileSync(uw, "utf8").trim().split("\n").filter(Boolean).forEach((l) => { try { add(JSON.parse(l)); } catch {} });
  return out;
}

async function main() {
  const provider = getProvider();
  const sweepTo = ethers.getAddress(process.env.SWEEP_TO || getWallet(provider).address);
  const keys = loadAllKeys();
  if (!keys.length) { console.log("No wallet keys found (keys.json / used-wallets.jsonl). Nothing to sweep."); return; }
  const gasPrice = await baseFeeGasPrice(provider);
  const erc20 = new ethers.Interface([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ]);
  const ethReserve = 23000n * gasPrice;   // leave enough to pay for the sweep tx itself
  const ROBIN_GAS = 65000n;

  console.log(`${GO ? "SWEEPING" : "DRY RUN"} ${keys.length} wallets → ${sweepTo}${SWEEP_ROBIN ? "  (+ROBIN)" : ""}  @ ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  let totalEth = 0n, totalRobin = 0n, sweptEth = 0n, sweptRobin = 0n, ethTxs = 0, robinTxs = 0, withEth = 0, withRobin = 0;
  let idx = 0;
  async function worker() {
    while (idx < keys.length) {
      const k = keys[idx++];
      const wallet = new ethers.Wallet(k.privateKey, provider);
      let bal = 0n; try { bal = await provider.getBalance(k.address, "latest"); } catch {}
      let rob = 0n;
      if (SWEEP_ROBIN) { try { const r = await provider.call({ to: ROBIN, data: erc20.encodeFunctionData("balanceOf", [k.address]) }); rob = erc20.decodeFunctionResult("balanceOf", r)[0]; } catch {} }
      if (bal > 0n) withEth++;
      if (rob > 0n) withRobin++;
      totalEth += bal; totalRobin += rob;

      if (GO && SWEEP_ROBIN && rob > 0n && bal > ROBIN_GAS * gasPrice + ethReserve) {
        try {
          const tx = await wallet.sendTransaction({ to: ROBIN, data: erc20.encodeFunctionData("transfer", [sweepTo, rob]), type: 0, gasPrice, gasLimit: ROBIN_GAS });
          await tx.wait(); sweptRobin += rob; robinTxs++;
          bal = await provider.getBalance(k.address, "latest").catch(() => bal);
        } catch { /* leave it */ }
      }
      if (GO && bal > ethReserve) {
        const value = bal - ethReserve;
        try { const tx = await wallet.sendTransaction({ to: sweepTo, value, type: 0, gasPrice, gasLimit: 21000n }); await tx.wait(); sweptEth += value; ethTxs++; } catch { /* leave it */ }
      }
      if (idx % 100 === 0) console.log(`  …scanned ${idx}/${keys.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, keys.length) }, worker));

  const usd = (wei) => "$" + (Number(ethers.formatEther(wei)) * ETH_USD).toFixed(2);
  const rusd = (t) => "$" + (Number(ethers.formatUnits(t, 18)) * ROBIN_USD).toFixed(2);
  console.log(`\nFOUND across ${keys.length} wallets:`);
  console.log(`  ETH:   ${ethers.formatEther(totalEth)}  (~${usd(totalEth)})  in ${withEth} wallets`);
  console.log(`  ROBIN: ${Number(ethers.formatUnits(totalRobin, 18)).toFixed(2)}  (~${rusd(totalRobin)})  in ${withRobin} wallets`);
  if (GO) {
    console.log(`\nSWEPT → ${sweepTo}:`);
    console.log(`  ${usd(sweptEth)} ETH in ${ethTxs} txs` + (SWEEP_ROBIN ? `  +  ${rusd(sweptRobin)} ROBIN in ${robinTxs} txs` : ""));
  } else {
    console.log(`\nDry run only. Re-run with  --go  to sweep the ETH back${SWEEP_ROBIN ? " (and --robin to include tokens)" : " (add --robin to also pull ROBIN)"}.`);
  }
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
