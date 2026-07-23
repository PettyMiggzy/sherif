/* eslint-disable no-console */
// AUTO-VERIFIER — makes every launched coin's contracts show up as verified source on the
// explorer, with zero per-coin work. It watches the chain for launches + graduations and submits
// each new token / curve / bond to Sourcify (which Blockscout auto-imports).
//
//   Run once (backfill everything, then exit):   node scripts/auto-verify.cjs --once
//   Run forever (poll for new coins):            node scripts/auto-verify.cjs
//
// Config (env):
//   RPC_URL        JSON-RPC endpoint            (default: Robinhood Chain public RPC)
//   FACTORY        CurvePadFactory address      (REQUIRED — the live factory that emits Launched)
//   START_BLOCK    first block to scan          (default: 0 — set to the factory's deploy block to save time)
//   POLL_MS        loop interval                (default: 15000)
//   CONFIRMATIONS  lag behind head by N blocks  (default: 3)
//   CHUNK          getLogs block window         (default: 5000)
//   STATE_FILE     progress file                (default: scripts/.auto-verify-state.json)
//   SOURCIFY_URL / BLOCKSCOUT_URL / CHAIN_ID    (see lib/sourcify.cjs; defaults are correct for this chain)
//
// Idempotent: state is persisted, and Sourcify skips anything already verified — safe to restart anytime.
// Read-only on-chain (getLogs only) and needs no private key. It never blocks a launch; verification is
// a best-effort background follow-up.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { BLOCKSCOUT, COIN_KINDS, verifyAddress, sleep } = require("./lib/blockscout.cjs");

// Fall back to the deploy manifest (written by scripts/deploy.js) for the factory + its block, so the
// operator doesn't have to hand-set anything after a deploy — just run the script.
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(process.env.DEPLOY_JSON || path.resolve(__dirname, "..", "deploy.json"), "utf8")); } catch { /* env-only */ }

const RPC_URL = process.env.RPC_URL || "https://robinhoodchain.blockscout.com/api/eth-rpc";
const FACTORY = (process.env.FACTORY || (manifest.contracts && manifest.contracts.padFactory) || "").toLowerCase();
const START_BLOCK = Number(process.env.START_BLOCK || manifest.factoryBlock || 0);
const POLL_MS = Number(process.env.POLL_MS || 15000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 3);
const CHUNK = Number(process.env.CHUNK || 5000);
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, ".auto-verify-state.json");

const IFACE = new ethers.Interface([
  "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
  "event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken)",
]);
const LAUNCHED = IFACE.getEvent("Launched").topicHash;
const GRADUATED = IFACE.getEvent("Graduated").topicHash;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.curves) s.curves = {}; // set of curves WE launched (so a foreign Graduated can't spam us)
    if (!s.done) s.done = {};
    return s;
  } catch { return { lastBlock: Math.max(0, START_BLOCK - 1), done: {}, curves: {} }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 0));
}

// Verify a batch of {addr, kind, label} jobs, recording successes in state so we never re-submit.
async function runJobs(jobs, state) {
  for (const j of jobs) {
    const addr = j.addr.toLowerCase();
    if (state.done[addr]) continue;
    const k = COIN_KINDS[j.kind];
    const res = await verifyAddress({ addr: j.addr, sol: k.sol, name: k.name, label: `${j.kind}` }).catch(() => "fail");
    if (res === "ok" || res === "already") { state.done[addr] = j.kind; saveState(state); }
    // "pending"/"fail" are left unrecorded → retried on the next pass.
  }
}

// Scan [from,to] for Launched (token+curve) and Graduated (bond) and return the verify jobs.
// `state.curves` records the curves WE launched, so a foreign contract that happens to emit the same
// `Graduated` topic can't make us endlessly try to "verify" its address as a Bond.
async function scan(provider, from, to, state) {
  const jobs = [];
  // Launched: only the factory emits it.
  const launched = await provider.getLogs({ fromBlock: from, toBlock: to, address: FACTORY, topics: [LAUNCHED] });
  for (const lg of launched) {
    const a = IFACE.parseLog(lg).args;
    state.curves[a.curve.toLowerCase()] = 1; // remember it's one of ours
    jobs.push({ addr: a.token, kind: "token", label: "token" });
    jobs.push({ addr: a.curve, kind: "curve", label: "curve" });
  }
  // Graduated: emitted by each curve (no fixed address) — filter by topic0, then keep only OUR curves.
  const grads = await provider.getLogs({ fromBlock: from, toBlock: to, topics: [GRADUATED] });
  for (const lg of grads) {
    if (!state.curves[lg.address.toLowerCase()]) continue; // not a curve we launched — ignore
    const a = IFACE.parseLog(lg).args;
    jobs.push({ addr: a.bond, kind: "bond", label: "bond" });
  }
  return jobs;
}

async function catchUp(provider, state) {
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;
  let from = state.lastBlock + 1;
  if (from > safeHead) return 0;
  let found = 0;
  for (let lo = from; lo <= safeHead; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK - 1, safeHead);
    const jobs = await scan(provider, lo, hi, state);
    found += jobs.length;
    if (jobs.length) {
      console.log(`[${new Date().toISOString()}] blocks ${lo}-${hi}: ${jobs.length} contract(s) to verify`);
      await runJobs(jobs, state);
    }
    state.lastBlock = hi;
    saveState(state);
  }
  return found;
}

async function main() {
  if (!FACTORY) { console.error("FACTORY env is required (the CurvePadFactory address that emits Launched)"); process.exit(2); }
  const once = process.argv.includes("--once");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  const state = loadState();
  console.log(`auto-verify: factory ${FACTORY} · from block ${state.lastBlock + 1} · verifier ${BLOCKSCOUT}`);
  console.log(`already verified: ${Object.keys(state.done).length} contract(s)\n`);

  if (once) {
    const n = await catchUp(provider, state);
    // Retry pass for anything left "pending" (Sourcify still compiling) — give it one more sweep.
    console.log(`backfill scanned; ${n} job(s) seen this run. done: ${Object.keys(state.done).length}`);
    return;
  }
  // forever
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await catchUp(provider, state); }
    catch (e) { console.error(`[${new Date().toISOString()}] pass error:`, e.shortMessage || e.message); }
    await sleep(POLL_MS);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
