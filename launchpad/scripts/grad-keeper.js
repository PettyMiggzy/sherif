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
// This process polls every coin and calls graduate() the moment ready() flips true.
//
// RPC BUDGET (this daemon runs 24/7 against a shared endpoint, so it is written to be cheap):
//   • ONE batched JSON-RPC request per poll — every coin's ready() goes out in a single HTTP POST
//     (ethers coalesces same-tick calls up to `batchMaxCount`), instead of 2 sequential round-trips per coin.
//   • `ready()` ALONE is the gate: CurvePool.ready() already returns false when `graduated` is true
//     (CurvePool.sol:249), and graduate() re-checks `graduated`+`ready()` on-chain (:256-258), so the separate
//     pre-flight graduated() call was pure waste and is gone. A lost race just reverts and is caught.
//   • The coin list is cached and refetched every COINS_REFRESH_SECS (new coins appear rarely), not every poll.
//   • Coins known graduated (API flag, or graduated by us) are retired from the poll set permanently.
//   • The network is pinned after one detection so ethers never re-issues eth_chainId.
//   • Consecutive RPC failures back off exponentially instead of hammering a struggling endpoint.
//   At the defaults that is ~1 request/60s + a coin-list fetch every 10 min (~1.6k/day), versus ~55k/day for
//   the original 30s × (1 + 2/coin) sequential loop.
//
// Env:
//   RPC_URL             (default https://rpc.mainnet.chain.robinhood.com — the chain node, NOT the shared
//                        api.robinlab.io proxy, which rate-limits and returns 400 `upstream 429`)
//   API_BASE            (default https://api.robinlab.io)  — coin list source
//   KEEPER_PK           the keeper's private key (omit ⇒ forced --dry-run, read-only)
//   POLL_SECS           (default 60)
//   COINS_REFRESH_SECS  (default 600) — how often to refetch the coin list
//   COINS_CACHE         (default ~/.grad-keeper-coins.json) — disk cache of the last good coin list, so the
//                        keeper keeps graduating across an API outage or a restart (the RPC it polls is the
//                        chain's own node and is independent of that API)
//   RPC_BATCH           set to "0" to disable JSON-RPC batching (if the endpoint rejects array payloads)
//   GAS_LIMIT           (default 3500000)
// Flags: --dry-run  (read-only: report ready/graduated status, send NO transactions)
//        --once     (single sweep, then exit)
//
// Run:  KEEPER_PK=0x… node launchpad/scripts/grad-keeper.js
//       node launchpad/scripts/grad-keeper.js --dry-run --once
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Default to the CHAIN's own RPC, not our api.robinlab.io proxy: the proxy fronts this same node, is shared
// with the website/indexer, and was returning HTTP 400 `{"error":"upstream 429"}` for every call — which had
// silently killed this keeper (no graduations were firing). Pointing straight at the chain also removes this
// daemon's load from the proxy entirely. Override with RPC_URL if the chain endpoint ever needs bypassing.
const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const API = process.env.API_BASE || "https://api.robinlab.io";
const POLL = Math.max(5, Number(process.env.POLL_SECS || 60)) * 1000;
const COINS_REFRESH = Math.max(60, Number(process.env.COINS_REFRESH_SECS || 600)) * 1000;
const GAS = BigInt(process.env.GAS_LIMIT || 3_500_000);
const DRY = process.argv.includes("--dry-run") || !process.env.KEEPER_PK;
// One HTTP POST carries every ready() call. 0 ⇒ disable batching for endpoints that reject array payloads.
const BATCH = process.env.RPC_BATCH === "0" ? 1 : 100;

const CURVE_ABI = [
  "function ready() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduate()",
];

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// ── cached state (keeps the steady-state cost at one batched request per poll) ──
let coins = [];          // last known coin list
let coinsAt = 0;         // when it was fetched
const done = new Set();  // curves known graduated — never polled again
const contracts = new Map(); // curve => ethers.Contract (avoid re-instantiating every poll)
let provider = null;     // swappable: downgraded in place if the endpoint rejects batch payloads
let batchOn = BATCH > 1; // auto-downgraded on the first batch rejection
let netPinned = null;
let fails = 0;           // consecutive RPC failures → exponential backoff
let skipTicks = 0;       // ticks to skip while backing off
let quietSince = 0;      // suppress repeated "nothing to watch" spam
// The coin LIST comes from our own API, but the chain RPC we poll does not — so an API outage must not blind
// the keeper. Persist the last good list and fall back to it (survives restarts too).
const CACHE = process.env.COINS_CACHE || path.join(os.homedir(), ".grad-keeper-coins.json");

function saveCoins() {
  try { fs.writeFileSync(CACHE, JSON.stringify(coins)); } catch { /* cache is best-effort, never fatal */ }
}

function loadCoins() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (Array.isArray(c) && c.length) { coins = c; return true; }
  } catch { /* no cache yet */ }
  return false;
}

async function refreshCoins() {
  if (coins.length && Date.now() - coinsAt < COINS_REFRESH) return;
  const r = await fetch(`${API}/api/coins`);
  if (!r.ok) throw new Error(`coins ${r.status}`);
  const d = await r.json();
  coins = (d.coins || []).filter((c) => c.curve).map((c) => ({ sym: c.symbol, curve: c.curve, graduated: !!c.graduated }));
  coinsAt = Date.now();
  for (const c of coins) if (c.graduated) done.add(c.curve); // retire indexer-confirmed graduates
  saveCoins();
}

function curveOf(addr) {
  let c = contracts.get(addr);
  if (!c) { c = new ethers.Contract(addr, CURVE_ABI, provider); contracts.set(addr, c); }
  return c;
}

function makeProvider(batchMax) {
  return new ethers.JsonRpcProvider(RPC, netPinned, { batchMaxCount: batchMax, staticNetwork: netPinned });
}

// Some endpoints (and some proxies in front of them) reject JSON-RPC ARRAY payloads outright. Rather than make
// the operator discover that and set RPC_BATCH=0 by hand, detect it once and downgrade to sequential for good.
const BATCH_REJECTED = /400|bad request|parse error|invalid request|not supported|unsupported/i;
const RATE_LIMITED = /429|rate.?limit|too many/i;

async function sweepReady(live) {
  try {
    return await Promise.all(live.map((c) => curveOf(c.curve).ready()));
  } catch (e) {
    const m = e.shortMessage || e.message || "";
    if (batchOn && BATCH_REJECTED.test(m)) {
      // A 400 does NOT prove batching is the problem: a rate-limited or unhealthy endpoint returns 400 too (ours
      // served HTTP 400 `{"error":"upstream 429"}` for EVERY call), and sequential mode cannot fix that — it just
      // multiplies the requests. Probe with ONE plain call first; only a working single call proves the array
      // payload was at fault. ethers sends a lone queued request as an object, not a 1-element array.
      let singleOk = true;
      try { await curveOf(live[0].curve).ready(); } catch { singleOk = false; }
      if (!singleOk) throw e; // endpoint is unhealthy → fall through to backoff, keep batching for later
      batchOn = false;
      provider = makeProvider(1);
      contracts.clear(); // old instances hold the previous provider
      console.log(ts(), `endpoint rejected a batched payload (${m.slice(0, 80)}) — downgrading to sequential for this run`);
      return await Promise.all(live.map((c) => curveOf(c.curve).ready()));
    }
    throw e;
  }
}

async function tick(provider, wallet) {
  if (skipTicks > 0) { skipTicks--; return; }
  try {
    await refreshCoins();
  } catch (e) {
    // Fall back to the last good list rather than going blind — the chain RPC is still reachable.
    if (!coins.length && loadCoins()) console.log(ts(), `coin fetch failed (${e.message}) — using ${coins.length} cached coins`);
    else console.log(ts(), "coin fetch failed:", e.message);
  }
  if (!coins.length) return;

  const live = coins.filter((c) => !done.has(c.curve));
  if (!live.length) {
    if (Date.now() - quietSince > 3600_000) { console.log(ts(), "all coins graduated — idle"); quietSince = Date.now(); }
    return;
  }

  // ONE batched request: every ready() is issued in the same event-loop tick, so ethers coalesces them
  // into a single JSON-RPC array payload. ready() is false when graduated, so it is the whole gate.
  let states;
  try {
    states = await sweepReady(live);
    fails = 0;
  } catch (e) {
    const m = e.shortMessage || e.message || "";
    fails++;
    // A rate-limited endpoint needs a LONGER pause than a transient error — backing off slowly here is the
    // difference between letting it recover and keeping it pinned at 429.
    const cap = RATE_LIMITED.test(m) ? 60 : 30;
    skipTicks = Math.min(2 ** fails, cap);
    console.log(ts(), `ready() sweep failed (${fails}):`, m, `— backing off ${skipTicks} polls`);
    return;
  }

  let readyCount = 0;
  for (let i = 0; i < live.length; i++) {
    const c = live[i];
    if (DRY) console.log(ts(), `  ${c.sym.padEnd(10)} ready=${states[i]}`);
    if (!states[i]) continue;
    readyCount++;
    if (DRY) { console.log(ts(), `  🎓 ${c.sym} is READY — [dry-run] would graduate ${c.curve}`); continue; }
    try {
      console.log(ts(), `🎓 ${c.sym} READY — graduating ${c.curve} …`);
      const tx = await curveOf(c.curve).connect(wallet).graduate({ gasLimit: GAS });
      console.log(ts(), `  sent ${tx.hash}`);
      await tx.wait();
      done.add(c.curve); // retire it — never polled again
      console.log(ts(), `  ✅ ${c.sym} graduated`);
    } catch (e) {
      const m = e.shortMessage || e.message;
      // AlreadyGraduated ⇒ someone beat us to it; retire it rather than retrying forever.
      if (/AlreadyGraduated/i.test(m)) { done.add(c.curve); console.log(ts(), `  ${c.sym} already graduated elsewhere — retired`); }
      else console.log(ts(), `  ${c.sym} error:`, m);
    }
  }
  if (DRY) console.log(ts(), `swept ${live.length} coins, ${readyCount} ready (dry-run — no tx sent)`);
}

// Detect the network, retrying forever. A daemon must NEVER exit because the RPC was briefly unreachable:
// doing so hands systemd a crash-loop (Restart=always) that spins every RestartSec and can trip its start
// limit, leaving the keeper permanently dead exactly when the chain comes back.
async function connect() {
  for (let i = 0; ; i++) {
    try {
      const probe = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
      return await probe.getNetwork();
    } catch (e) {
      const wait = Math.min(2 ** i, 60);
      console.log(ts(), `RPC ${RPC} unreachable (${e.shortMessage || e.message}) — retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function main() {
  // Pin the network after ONE detection so ethers never re-issues eth_chainId on later calls.
  netPinned = await connect();
  const net = netPinned;
  provider = makeProvider(BATCH);

  let wallet = null;
  if (!DRY) {
    wallet = new ethers.Wallet(process.env.KEEPER_PK, provider); // local, no RPC — safe before any call
    try {
      const bal = await provider.getBalance(wallet.address);
      console.log(ts(), `keeper ${wallet.address}  balance ${ethers.formatEther(bal)} ETH`);
    } catch (e) {
      // Informational only — never a reason to refuse to start.
      console.log(ts(), `keeper ${wallet.address}  (balance unavailable: ${e.shortMessage || e.message})`);
    }
  }
  console.log(
    ts(),
    `grad-keeper up — chainId ${net.chainId}, poll ${POLL / 1000}s, coin-list refresh ${COINS_REFRESH / 1000}s, ` +
    `batch ${batchOn ? "on (auto-downgrades if rejected)" : "off"}, mode ${DRY ? "DRY-RUN (read-only)" : "LIVE"}`
  );
  await tick(provider, wallet).catch((e) => console.log(ts(), "first tick failed:", e.shortMessage || e.message));
  if (process.argv.includes("--once")) return;
  setInterval(() => tick(provider, wallet).catch((e) => console.log(ts(), "tick error:", e.message)), POLL);
}

// Reaching here means a non-network fault (bad KEEPER_PK, bad env) — those are worth exiting on, since a
// restart cannot fix them and a loud failure is better than a daemon that silently does nothing.
main().catch((e) => { console.error(ts(), "fatal:", e.shortMessage || e.message); process.exit(1); });
