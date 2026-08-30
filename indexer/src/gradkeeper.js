// ─────────────────────────────────────────────────────────────────────────────
// Auto-graduate keeper — bonds a curve coin the instant it's ready, so nobody has to
// win the click-to-mine race by hand. Also sweeps each live curve's LP fees before it bonds.
//
// WHY THIS EXISTS
// CurvePool.ready() is knife-edge: on a token1 coin it is true only while spot sits at/below the
// ceiling tick (`tick <= gradTick`). It flickers block-to-block near graduation. graduate() re-checks
// ready() and reverts NotReady if spot has drifted even a tick shy. A human clicking "Graduate now"
// loses this race on a ~0.1s-block chain — exactly what happened to TROLLCAT (spot was 9 ticks shy the
// block his tx mined). A fast, retrying keeper on this FCFS sequencer wins where a single hand-click can't.
//
// WHAT IT DOES each poll:
//   pick candidate curves (near-ceiling snapshot ∪ periodic full sweep ∪ recently-traded)
//   → ONE batched ready() eth_call (Multicall3)
//   → for each ready curve: graduate.staticCall() dry-run → broadcast legacy type-0 graduate()
//   → watch the receipt out-of-band; on revert, retry next poll (bounded, with timed backoff)
//
// graduate() is permissionless (anyone may call it) and idempotent-guarded (AlreadyGraduated), so a
// stray/racing send just reverts cheaply — it can never move funds or double-bond.
//
// NONCES: a PLAIN wallet (not NonceManager) so every send re-resolves the node's `pending` nonce — a
// transient send error therefore consumes no nonce and can never wedge the sequence. All broadcasts (the
// ready-poll and the fee-sweep) run through one serialize chain so the two internal loops can't grab the
// same pending nonce. For full isolation from the RobinLimit keeper (same process), set GRAD_KEEPER_KEY to
// a dedicated wallet; otherwise it shares KEEPER_KEY and the occasional cross-keeper collision self-heals.
//
// GAS / FUNDING: Robinhood Chain is an Arbitrum-Orbit sequencer — FCFS by arrival, NO priority auction and
// NO public mempool. Gas price buys INCLUSION, not ordering, so we use a modest inclusion floor (base×1.2)
// and rely on aggressive retry, not a "win the block" premium. Each graduation pays the platform 0.5 ETH
// while costing pennies of gas, so with the reward routed back the keeper is self-funding; a balance guard
// skips + alerts (never fires a doomed tx) if it ever runs low.
//
// OFF unless a key is set (GRAD_KEEPER_KEY or KEEPER_KEY) and GRAD_KEEPER != 0. Runs in the keeper container.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import * as Pools from "./poolmaker.js";
import * as Feed from "./feedkeeper.js";
import { mc3 } from "./multicall.js";
import { gradCandidates, liveCurvesAll, recentTradeCurves } from "./db.js";
import { beat } from "./heartbeat.js";

const KEY = process.env.GRAD_KEEPER_KEY || process.env.KEEPER_KEY || "";
const ENABLED = KEY && process.env.GRAD_KEEPER !== "0";

const POLL_MS = Number(process.env.GRAD_POLL_MS || 1000);
const MIN_PROGRESS = Number(process.env.GRAD_MIN_PROGRESS || 0.9);
const SWEEP_MS = Number(process.env.GRAD_SWEEP_MS || 5000);       // full-sweep cadence (fast, cheap: one batched read)
const RECENT_S = Number(process.env.GRAD_RECENT_S || 120);        // seed candidates traded within this window
const GAS_MULT = Number(process.env.GRAD_GAS_MULT || 1.2);        // inclusion floor over base fee (NOT a priority auction)
const MAX_ATTEMPTS = Number(process.env.GRAD_MAX_ATTEMPTS || 50); // broadcasts before a timed park
const PARK_MS = Number(process.env.GRAD_PARK_MS || 300_000);      // park a chronic oscillator this long, then retry
const WAIT_MS = Number(process.env.GRAD_WAIT_MS || 20_000);       // bound the receipt wait so nothing hangs
// A hand-edited malformed value must not crash the whole keeper process (this module is statically imported
// by keeper.js). Guard the BigInt parse and reject a nonsensical 0 cap (which would starve graduate() of gas).
const GAS_CAP = (() => {
  try { const v = BigInt(process.env.GRAD_GAS_CAP || 12_000_000); return v > 0n ? v : 12_000_000n; } catch { return 12_000_000n; }
})();
// Balance guard: skip + alert (don't fire a doomed tx) when the keeper's ETH would cover fewer than this
// many worst-case graduations. Keeps it from silently running dry. ~cap*floor per bond ≈ tiny on an L2.
const MIN_BALANCE_WEI = (() => {
  try { return ethers.parseEther(process.env.GRAD_MIN_BALANCE || "0.01"); } catch { return ethers.parseEther("0.01"); }
})();

// LP-fee sweep: collect the curve's accrued Uniswap 1% fees to the wired platform/creator wallets BEFORE the
// coin bonds (at graduation they'd sweep into the Bond anyway). Runs on a slow cadence, gated by a WETH-side
// value floor so a collect (gas ~pennies) is never fired for dust. The token-side fees ride along for free.
const FEE_ENABLED = ENABLED && process.env.GRAD_FEE_KEEPER !== "0";
const FEE_MS = Number(process.env.GRAD_FEE_MS || 600_000);           // sweep cadence (10 min)
const FEE_MIN_WETH = (() => {                                        // only collect when the ETH-side clears this
  try { return ethers.parseEther(process.env.GRAD_FEE_MIN_WETH || "0.01"); } catch { return ethers.parseEther("0.01"); }
})();

const CURVE_ABI = [
  "function ready() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduate()",
  "function collectFees() returns (uint256 wethFees, uint256 tokenFees)",
];
const CURVE_IFACE = new ethers.Interface(CURVE_ABI);

// Legacy (type-0) gas price floored above the latest base fee (mirrors keeper.js / the pad's safeGasPrice).
async function legacyGasPrice(provider) {
  let gp = 0n, base = 0n;
  try { gp = (await provider.getFeeData()).gasPrice || 0n; } catch {}
  try { const b = await provider.getBlock("latest"); base = (b && b.baseFeePerGas) || 0n; } catch {}
  const mult = BigInt(Math.round(GAS_MULT * 100));
  const floor = base > 0n ? (base * mult) / 100n : ethers.parseUnits("0.1", "gwei");
  return gp > floor ? gp : floor;
}

// Union the candidate sets into a unique curve->meta map, honoring the periodic full sweep.
let _lastSweep = 0;
function pickCurves(nowMs) {
  const out = new Map(); // curve(lowercased) -> { token, curve, symbol }
  const add = (rows) => { for (const r of rows) { if (r.curve) out.set(r.curve.toLowerCase(), r); } };
  try { add(gradCandidates.all({ minProgress: MIN_PROGRESS })); } catch (e) { console.log("[grad] gradCandidates:", e.message); }
  try { add(recentTradeCurves.all({ since: Math.floor(nowMs / 1000) - RECENT_S })); } catch (e) { console.log("[grad] recentTradeCurves:", e.message); }
  if (nowMs - _lastSweep >= SWEEP_MS) {
    _lastSweep = nowMs;
    try { add(liveCurvesAll.all()); } catch (e) { console.log("[grad] liveCurvesAll:", e.message); }
  }
  return [...out.values()];
}

const isTimeout = (e) => !!e && (e.code === "TIMEOUT" || /timeout/i.test((e && e.message) || "")) && !(e && e.receipt);

export async function runGradKeeper() {
  if (!ENABLED) {
    console.log("[grad] disabled (set GRAD_KEEPER_KEY or KEEPER_KEY, GRAD_KEEPER!=0 to run)");
    // Beat anyway, flagged off. Otherwise /health cannot tell "deliberately disabled" from "container
    // dead", and those need very different reactions.
    beat({ grad: false, pools: Pools.enabled(), reason: "no key, or GRAD_KEEPER=0" });
    return;
  }

  // Startup with retry/backoff so a transient provider hiccup doesn't leave the keeper silently dead for the
  // life of the process (a plain-wallet getAddress is local, so this almost never trips — but it's cheap insurance).
  let provider, signer, address;
  for (let i = 0; ; i++) {
    try {
      provider = new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
      signer = new ethers.Wallet(KEY, provider);            // PLAIN wallet: every send re-resolves pending nonce
      address = await signer.getAddress();
      break;
    } catch (e) {
      const wait = Math.min(30_000, 2000 * (i + 1));
      console.log(`[grad] startup failed (${(e && e.message) || e}), retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.log(`[grad] running as ${address}, poll ${POLL_MS}ms, minProgress ${MIN_PROGRESS}, gasMult ${GAS_MULT}`);

  const inFlight = new Set();          // curve -> a graduate() tx is broadcast and not yet resolved
  const attempts = new Map();          // curve -> broadcasts since last success/park
  const parkedUntil = new Map();       // curve -> ms timestamp until which we skip it
  const sentAt = new Map();            // curve -> last graduate() broadcast ts (dup-guard for a slow/pending tx)
  const feeInFlight = new Set();       // curve -> a collectFees() sweep tx is in flight
  let lowBalanceWarnedAt = 0;

  // Serialize ALL broadcasts through one chain so the ready-poll and the fee-sweep (which share this wallet)
  // never resolve the same `pending` nonce concurrently. A send that throws before broadcast consumes no
  // nonce, so the next serialized send re-reads pending and is still correct — no wedge is possible.
  let _sendChain = Promise.resolve();
  function serializeSend(fn) {
    const p = _sendChain.then(fn, fn);
    _sendChain = p.then(() => {}, () => {});
    return p;
  }
  const prune = (cl) => { attempts.delete(cl); parkedUntil.delete(cl); sentAt.delete(cl); };

  if (FEE_ENABLED) { console.log(`[grad] LP-fee sweep every ${Math.round(FEE_MS / 1000)}s (min ${ethers.formatEther(FEE_MIN_WETH)} ETH-side)`); feeLoop(); }
  if (Pools.enabled()) {
    console.log(`[pools] auto staking pools ON — maker ${Pools.makerAddress()}, factory ${CFG.tierStakingFactory}`);
    poolLoop();
  } else {
    // Said out loud, because the silent version of this is "coins quietly never get staking pools".
    console.log("[pools] auto staking pools OFF (set TIER_STAKING_FACTORY and POOL_MAKER_KEY to enable)");
  }
  // Runs alongside: creating a pool and FILLING it are separate jobs, and a pool nobody funds pays
  // nothing. Its own loop so a slow sweep can never delay a graduation.
  Feed.runFeedKeeper(provider);

  for (;;) {
    try { await tick(); } catch (e) { console.log("[grad] tick error:", (e && e.message) || e); }
    // Liveness for /health, written from THIS container. The enabled-flags ride along because the
    // expensive failure here is not a crash -- it is a keeper running happily with `pools` switched off,
    // graduating coins that then silently never get a staking pool. Surfacing the switch is the point.
    beat({
      keeper: address,
      pollMs: POLL_MS,
      grad: true,
      pools: Pools.enabled(),
      feed: Feed.enabled(),
    });
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // true = we're too low to safely broadcast (throttled alert). null balance (RPC blip) is treated as
  // "unknown" → do NOT alert and do NOT block; a genuinely underfunded send just fails cleanly and is caught.
  function lowBalance(bal, n, kind) {
    if (bal == null || bal >= MIN_BALANCE_WEI) return false;
    if (Date.now() - lowBalanceWarnedAt > 60_000) {
      lowBalanceWarnedAt = Date.now();
      console.log(`[grad] ⚠ LOW BALANCE ${ethers.formatEther(bal)} ETH < ${ethers.formatEther(MIN_BALANCE_WEI)} — ${n} ${kind} pending but NOT firing. TOP UP ${address}.`);
    }
    return true;
  }

  async function tick() {
    const nowMs = Date.now();
    const cands = pickCurves(nowMs).filter((c) => {
      const cl = c.curve.toLowerCase();
      if (inFlight.has(cl)) return false;
      const s = sentAt.get(cl);
      if (s && nowMs - s < WAIT_MS) return false;   // a recent send may still be mining — don't duplicate it
      const until = parkedUntil.get(cl);
      if (until && nowMs < until) return false;
      if (until && nowMs >= until) { parkedUntil.delete(cl); attempts.set(cl, 0); } // park expired → retry fresh
      return true;
    });
    if (!cands.length) return;

    // ONE batched ready() across every candidate.
    const readies = await mc3(provider, cands.map((c) => ({ target: c.curve, iface: CURVE_IFACE, fn: "ready", args: [] })));
    const ready = cands.filter((_, i) => readies[i] && readies[i][0] === true);
    if (!ready.length) return;

    let bal = null;
    try { bal = await provider.getBalance(address); } catch {}
    if (lowBalance(bal, ready.length, "coin(s) ready")) return;

    const gasPrice = await legacyGasPrice(provider);
    for (const c of ready) {
      const cl = c.curve.toLowerCase();
      if (inFlight.has(cl)) continue;
      const curve = new ethers.Contract(c.curve, CURVE_ABI, signer);
      // Dry-run at head: a static call that reverts means spot already drifted shy (or it already bonded).
      try { await curve.graduate.staticCall(); }
      catch (e) { if (e && e.revert && e.revert.name === "AlreadyGraduated") prune(cl); continue; }
      let gas = GAS_CAP;
      try { gas = (await curve.graduate.estimateGas()) * 125n / 100n; } catch {}
      if (gas > GAS_CAP) gas = GAS_CAP;

      inFlight.add(cl);
      sentAt.set(cl, Date.now());
      attempts.set(cl, (attempts.get(cl) || 0) + 1);
      try {
        const tx = await serializeSend(() => curve.graduate({ type: 0, gasPrice, gasLimit: gas }));
        console.log(`[grad] ${c.symbol || c.token} → graduate() sent ${tx.hash} (attempt ${attempts.get(cl)})`);
        tx.wait(1, WAIT_MS).then((rc) => {
          if (rc && rc.status === 1) {
            console.log(`[grad] ✅ GRADUATED ${c.symbol || c.token} — tx ${rc.hash}`); prune(cl);
            // Fire-and-forget: the coin is bonded and that is what mattered. A staking pool is a
            // convenience, and nothing about it may delay, block or fail the graduation loop.
            Pools.ensurePoolFor(provider, c.token, c.symbol).catch(() => {});
          }
          else { sentAt.delete(cl); onFail(cl, "reverted"); }         // mined & reverted → retry immediately
        }).catch((e) => {
          if (isTimeout(e)) { console.log(`[grad] ${cl} wait timed out, may still mine — holding re-fire ${Math.round(WAIT_MS / 1000)}s`); }
          else { sentAt.delete(cl); onFail(cl, (e && e.shortMessage) || (e && e.message) || "wait error"); }
        }).finally(() => inFlight.delete(cl));
      } catch (e) {
        inFlight.delete(cl); sentAt.delete(cl);                        // never broadcast → free it for the next poll
        onFail(cl, (e && e.shortMessage) || (e && e.message) || "send error");
      }
    }
  }

  function onFail(cl, why) {
    const n = attempts.get(cl) || 0;
    if (n >= MAX_ATTEMPTS) {
      parkedUntil.set(cl, Date.now() + PARK_MS);
      console.log(`[grad] parking ${cl} for ${Math.round(PARK_MS / 1000)}s after ${n} attempts (${why})`);
    } else {
      console.log(`[grad] retry ${cl} next poll (${why})`);
    }
  }

  // Reconcile every graduated coin against the registry on a slow timer. The live hook above covers
  // coins that bond from now on; this covers the ones that bonded before this shipped, and anything
  // the live hook lost to a failed transaction.
  async function poolLoop() {
    for (;;) {
      try {
        const made = await Pools.backfill(provider);
        if (made) console.log(`[pools] backfill reconciled ${made} coin(s)`);
      } catch (e) { console.log("[pools] backfill error:", (e && e.message) || e); }
      await new Promise((r) => setTimeout(r, CFG.poolBackfillMs));
    }
  }

  async function feeLoop() {
    for (;;) {
      try { await feeSweep(); } catch (e) { console.log("[grad] fee-sweep error:", (e && e.message) || e); }
      await new Promise((r) => setTimeout(r, FEE_MS));
    }
  }

  // Collect accrued LP fees on every live curve whose ETH-side fee clears the floor, BEFORE it bonds.
  async function feeSweep() {
    const curves = liveCurvesAll.all();
    if (!curves.length) return;
    // Batched read of pending (wethFees, tokenFees). collectFees() is a WRITE, but issued via eth_call
    // (Multicall3 aggregate3) it only simulates — returning the amounts WITHOUT collecting. A curve without
    // collectFees() (pre-v2) or with nothing to collect just yields null and is skipped.
    let pend;
    try { pend = await mc3(provider, curves.map((c) => ({ target: c.curve, iface: CURVE_IFACE, fn: "collectFees", args: [] }))); }
    catch (e) { console.log("[grad] fee-sweep read failed:", e.message); return; }
    const due = curves.filter((c, i) => {
      if (feeInFlight.has(c.curve.toLowerCase())) return false;
      const r = pend[i];
      return r && r[0] >= FEE_MIN_WETH; // gate on the ETH-side; the token-side comes along in the same collect
    });
    if (!due.length) return;

    let bal = null;
    try { bal = await provider.getBalance(address); } catch {}
    if (lowBalance(bal, due.length, "fee sweep(s)")) return;

    const gasPrice = await legacyGasPrice(provider);
    for (const c of due) {
      const cl = c.curve.toLowerCase();
      if (feeInFlight.has(cl)) continue;
      const curve = new ethers.Contract(c.curve, CURVE_ABI, signer);
      let gas = GAS_CAP;
      try { gas = (await curve.collectFees.estimateGas()) * 125n / 100n; } catch {}
      if (gas > GAS_CAP) gas = GAS_CAP;
      feeInFlight.add(cl);
      try {
        const tx = await serializeSend(() => curve.collectFees({ type: 0, gasPrice, gasLimit: gas }));
        console.log(`[grad] fee-sweep ${c.symbol || c.token} → collectFees ${tx.hash}`);
        tx.wait(1, WAIT_MS)
          .then((rc) => { if (rc && rc.status === 1) console.log(`[grad] 🪙 swept LP fees ${c.symbol || c.token} — tx ${rc.hash}`); })
          .catch((e) => console.log(`[grad] fee-sweep ${cl} unconfirmed (${(e && e.shortMessage) || (e && e.message) || "wait"}), retries next sweep`))
          .finally(() => feeInFlight.delete(cl));
      } catch (e) {
        feeInFlight.delete(cl);
        console.log(`[grad] fee-sweep send failed ${cl}: ${(e && e.shortMessage) || (e && e.message) || e}`);
      }
    }
  }
}

// Allow `node src/gradkeeper.js` to run it directly (standalone).
if (import.meta.url === `file://${process.argv[1]}`) runGradKeeper();
