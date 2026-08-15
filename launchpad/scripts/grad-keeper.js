/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// grad-keeper — always-on graduation keeper for the LIVE v3 (CurvePool).
//
// WHY THIS EXISTS: on the live CurvePool, graduation is NOT automatic. The router caps buys AT the ceiling
// (gradSqrtPriceX96, never overshoots), but `graduate()` is a SEPARATE permissionless call that pays NO caller
// bounty — so no third-party bot is incentivized to fire it, and there is no auto-grad inside the buy tx (that
// behavior lives only in the non-deployed BondingCurve). Without this daemon a coin that reaches the ceiling sits
// tradeable-but-capped, with its Bond floor unposted, until someone manually graduates it.
//
// This process polls every coin and calls graduate() the moment ready() flips true. Run it on the operator box
// BEFORE any coin nears the ceiling (ROBIN is the closest, ~49%).
//
// Env:
//   RPC_URL     (default https://api.robinlab.io/rpc)
//   API_BASE    (default https://api.robinlab.io)  — coin list source
//   KEEPER_PK   the keeper's private key (omit ⇒ forced --dry-run, read-only)
//   POLL_SECS   (default 30)
//   GAS_LIMIT   (default 3500000)
// Flags: --dry-run  (read-only: report ready/graduated status, send NO transactions)
//
// Run:  KEEPER_PK=0x… node launchpad/scripts/grad-keeper.js
//       node launchpad/scripts/grad-keeper.js --dry-run
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://api.robinlab.io/rpc";
const API = process.env.API_BASE || "https://api.robinlab.io";
const POLL = Math.max(5, Number(process.env.POLL_SECS || 30)) * 1000;
const GAS = BigInt(process.env.GAS_LIMIT || 3_500_000);
const DRY = process.argv.includes("--dry-run") || !process.env.KEEPER_PK;

const CURVE_ABI = [
  "function ready() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduate()",
];

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function fetchCoins() {
  const r = await fetch(`${API}/api/coins`);
  if (!r.ok) throw new Error(`coins ${r.status}`);
  const d = await r.json();
  return (d.coins || []).filter((c) => c.curve).map((c) => ({ sym: c.symbol, curve: c.curve, graduated: !!c.graduated }));
}

async function tick(provider, wallet) {
  let coins;
  try { coins = await fetchCoins(); } catch (e) { console.log(ts(), "coin fetch failed:", e.message); return; }
  let readyCount = 0;
  for (const c of coins) {
    if (c.graduated) continue;
    try {
      const curve = new ethers.Contract(c.curve, CURVE_ABI, provider);
      if (await curve.graduated()) continue; // re-check on-chain (indexer can lag)
      const ready = await curve.ready();
      if (DRY) console.log(ts(), `  ${c.sym.padEnd(10)} ready=${ready}`);
      if (!ready) continue;
      readyCount++;
      if (DRY) { console.log(ts(), `  🎓 ${c.sym} is READY — [dry-run] would graduate ${c.curve}`); continue; }
      console.log(ts(), `🎓 ${c.sym} READY — graduating ${c.curve} …`);
      const tx = await curve.connect(wallet).graduate({ gasLimit: GAS });
      console.log(ts(), `  sent ${tx.hash}`);
      await tx.wait();
      console.log(ts(), `  ✅ ${c.sym} graduated`);
    } catch (e) {
      console.log(ts(), `  ${c.sym} error:`, e.shortMessage || e.message);
    }
  }
  if (DRY) console.log(ts(), `swept ${coins.length} coins, ${readyCount} ready (dry-run — no tx sent)`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  let wallet = null;
  if (!DRY) {
    wallet = new ethers.Wallet(process.env.KEEPER_PK, provider);
    const bal = await provider.getBalance(wallet.address);
    console.log(ts(), `keeper ${wallet.address}  balance ${ethers.formatEther(bal)} ETH`);
  }
  console.log(ts(), `grad-keeper up — chainId ${net.chainId}, poll ${POLL / 1000}s, mode ${DRY ? "DRY-RUN (read-only)" : "LIVE"}`);
  // one immediate tick, then loop
  await tick(provider, wallet);
  if (process.argv.includes("--once")) return;
  setInterval(() => tick(provider, wallet).catch((e) => console.log(ts(), "tick error:", e.message)), POLL);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
