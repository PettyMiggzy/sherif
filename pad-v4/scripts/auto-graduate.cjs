/* eslint-disable no-console */
// AUTO-GRADUATE keeper — fires graduate() automatically the instant a curve pad hits its ceiling (~4.2 ETH
// raised, i.e. the curve is fully sold). Graduation can't run inside the crossing buy on V4 (it needs its own
// PoolManager.unlock, and you're already inside the singleton's lock during a swap), so this keeper watches the
// pools and calls graduate() as soon as ready() flips — automatic from the creator's/traders' point of view.
// The graduation work runs on the curve's own ETH; the keeper only pays the trigger gas (no reimbursement).
//
//   Run forever:  ROBINHOOD_RPC=<rpc> KEEPER_PRIVATE_KEY=<key> node scripts/auto-graduate.cjs
//   One sweep:    ... node scripts/auto-graduate.cjs --once
//
// Config (env):
//   ROBINHOOD_RPC / RPC_URL   JSON-RPC endpoint      (default: Robinhood Chain public RPC)
//   KEEPER_PRIVATE_KEY        signer for graduate()  (REQUIRED — a hot keeper wallet, needs a little gas)
//   FACTORY                   CurvePadFactoryV4 addr (else read from deploy.curve.json)
//   START_BLOCK / POLL_MS / CONFIRMATIONS / CHUNK / STATE_FILE   (see defaults below)
//
// Idempotent + crash-safe: progress persisted; a curve already graduated is skipped; graduate() is permissionless
// so a missed tick self-heals on the next pass. Read-only except the graduate() call itself.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

let manifest = {};
for (const p of [process.env.DEPLOY_JSON, path.resolve(__dirname, "..", "deploy.curve.json"), path.resolve(__dirname, "..", "deploy.json")]) {
  if (!p) continue;
  try { manifest = JSON.parse(fs.readFileSync(p, "utf8")); break; } catch { /* try next */ }
}

const RPC_URL = process.env.ROBINHOOD_RPC || process.env.RPC_URL || "https://robinhoodchain.blockscout.com/api/eth-rpc";
const KEY = process.env.KEEPER_PRIVATE_KEY || "";
const FACTORY = (process.env.FACTORY || (manifest.contracts && manifest.contracts.curveFactory) || "").toLowerCase();
const START_BLOCK = Number(process.env.START_BLOCK || manifest.curveFactoryBlock || 0);
const POLL_MS = Number(process.env.POLL_MS || 15000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 3);
const CHUNK = Number(process.env.CHUNK || 5000);
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, ".auto-graduate-state.json");

const FACTORY_IFACE = new ethers.Interface([
  "event CurvePadLaunched(uint256 indexed index, address indexed token, address indexed creator, address hook, address curve, bytes32 poolId)",
]);
const LAUNCHED = FACTORY_IFACE.getEvent("CurvePadLaunched").topicHash;
const CURVE_ABI = [
  "function ready() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduate()",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.curves) s.curves = {}; // curve -> "watching" | "graduated"
    return s;
  } catch { return { lastBlock: Math.max(0, START_BLOCK - 1), curves: {} }; }
}
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 0));

// discover new curves the factory launched in [from,to]
async function discover(provider, from, to, state) {
  const logs = await provider.getLogs({ fromBlock: from, toBlock: to, address: FACTORY, topics: [LAUNCHED] });
  for (const lg of logs) {
    const a = FACTORY_IFACE.parseLog(lg).args;
    const c = a.curve.toLowerCase();
    if (!state.curves[c]) state.curves[c] = "watching";
  }
}

// try to graduate every watched-and-ready curve
async function tick(provider, wallet, state) {
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;
  let from = state.lastBlock + 1;
  for (; from <= safeHead; from += CHUNK) {
    const hi = Math.min(from + CHUNK - 1, safeHead);
    await discover(provider, from, hi, state);
    state.lastBlock = hi;
    saveState(state);
  }
  for (const [addr, status] of Object.entries(state.curves)) {
    if (status === "graduated") continue;
    const curve = new ethers.Contract(addr, CURVE_ABI, wallet);
    try {
      if (await curve.graduated()) { state.curves[addr] = "graduated"; saveState(state); continue; }
      if (!(await curve.ready())) continue; // not at the ceiling yet
      console.log(`[${new Date().toISOString()}] ${addr} is READY → graduating…`);
      const tx = await curve.graduate({ type: 0 });
      const rc = await tx.wait();
      console.log(`  ✅ graduated ${addr} in ${rc.hash} (block ${rc.blockNumber})`);
      state.curves[addr] = "graduated";
      saveState(state);
    } catch (e) {
      console.log(`  … ${addr}: ${(e.shortMessage || e.message || "").slice(0, 100)} (retry next pass)`);
    }
  }
}

async function main() {
  if (!FACTORY) { console.error("FACTORY env (or deploy.curve.json) required — the CurvePadFactoryV4 address"); process.exit(2); }
  if (!KEY) { console.error("KEEPER_PRIVATE_KEY env required — a hot keeper wallet that pays the trigger gas"); process.exit(2); }
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(KEY, provider);
  const state = loadState();
  console.log(`auto-graduate: factory ${FACTORY} · keeper ${wallet.address} · from block ${state.lastBlock + 1}`);

  if (process.argv.includes("--once")) { await tick(provider, wallet, state); return; }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(provider, wallet, state); }
    catch (e) { console.error(`[${new Date().toISOString()}] pass error:`, e.shortMessage || e.message); }
    await sleep(POLL_MS);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
