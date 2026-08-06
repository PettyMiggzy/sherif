// ─────────────────────────────────────────────────────────────────────────────
// Auto-graduate keeper — bonds a curve coin the instant it's ready, so nobody has to
// win the click-to-mine race by hand.
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
// GAS / FUNDING: Robinhood Chain is an Arbitrum-Orbit sequencer — first-come-first-served by arrival,
// NO priority auction and NO public mempool. Gas price buys INCLUSION, not ordering, so we use a modest
// inclusion floor (base×1.2) and rely on aggressive per-block retry, not a "win the block" premium. Each
// graduation pays the platform 0.5 ETH while costing pennies of gas, so with the reward routed back the
// keeper is self-funding; a balance guard skips + alerts (never fires a doomed tx) if it ever runs low.
//
// OFF unless KEEPER_KEY is set (and GRAD_KEEPER != 0). Runs inside the existing keeper container.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { mc3 } from "./multicall.js";
import { gradCandidates, liveCurvesAll, recentTradeCurves } from "./db.js";

const KEY = process.env.KEEPER_KEY || "";
const ENABLED = KEY && process.env.GRAD_KEEPER !== "0";

const POLL_MS = Number(process.env.GRAD_POLL_MS || 1000);
const MIN_PROGRESS = Number(process.env.GRAD_MIN_PROGRESS || 0.9);
const SWEEP_MS = Number(process.env.GRAD_SWEEP_MS || 5000);       // full-sweep cadence (fast, cheap: one batched read)
const RECENT_S = Number(process.env.GRAD_RECENT_S || 120);        // seed candidates traded within this window
const GAS_MULT = Number(process.env.GRAD_GAS_MULT || 1.2);        // inclusion floor over base fee (NOT a priority auction)
const GAS_CAP = BigInt(process.env.GRAD_GAS_CAP || 12_000_000);   // graduate() is heavy (deploys Bond + mints LP)
const MAX_ATTEMPTS = Number(process.env.GRAD_MAX_ATTEMPTS || 50); // broadcasts before a timed park
const PARK_MS = Number(process.env.GRAD_PARK_MS || 300_000);      // park a chronic oscillator this long, then retry
const WAIT_MS = Number(process.env.GRAD_WAIT_MS || 20_000);       // bound the receipt wait so nothing hangs
// Balance guard: skip + alert (don't fire a doomed tx) when the keeper's ETH would cover fewer than this
// many worst-case graduations. Keeps it from silently running dry. ~cap*floor per bond ≈ tiny on an L2.
const MIN_BALANCE_WEI = (() => {
  try { return ethers.parseEther(process.env.GRAD_MIN_BALANCE || "0.01"); } catch { return ethers.parseEther("0.01"); }
})();

const CURVE_ABI = [
  "function ready() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduate()",
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

export async function runGradKeeper() {
  if (!ENABLED) { console.log("[grad] disabled (set KEEPER_KEY, GRAD_KEEPER!=0 to run)"); return; }
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
  // NonceManager: two coins hitting the ceiling in one poll get sequential nonces even before the
  // sequencer's pending-nonce reflects the first send.
  const signer = new ethers.NonceManager(new ethers.Wallet(KEY, provider));
  const address = await signer.getAddress();
  console.log(`[grad] running as ${address}, poll ${POLL_MS}ms, minProgress ${MIN_PROGRESS}, gasMult ${GAS_MULT}`);

  const inFlight = new Set();          // curve -> a graduate() tx is broadcast and not yet resolved
  const attempts = new Map();          // curve -> broadcasts since last success/park
  const parkedUntil = new Map();       // curve -> ms timestamp until which we skip it
  let lowBalanceWarnedAt = 0;

  for (;;) {
    try { await tick(); } catch (e) { console.log("[grad] tick error:", (e && e.message) || e); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  async function tick() {
    const nowMs = Date.now();
    let cands = pickCurves(nowMs).filter((c) => {
      const cl = c.curve.toLowerCase();
      if (inFlight.has(cl)) return false;
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

    // Balance guard — never fire a doomed tx if we're running low; alert instead (throttled).
    let bal = 0n;
    try { bal = await provider.getBalance(address); } catch {}
    if (bal < MIN_BALANCE_WEI) {
      if (nowMs - lowBalanceWarnedAt > 60_000) {
        lowBalanceWarnedAt = nowMs;
        console.log(`[grad] ⚠ LOW BALANCE ${ethers.formatEther(bal)} ETH < ${ethers.formatEther(MIN_BALANCE_WEI)} — ${ready.length} coin(s) ready to bond but NOT firing. TOP UP ${address}.`);
      }
      return;
    }

    const gasPrice = await legacyGasPrice(provider);
    for (const c of ready) {
      const cl = c.curve.toLowerCase();
      if (inFlight.has(cl)) continue;
      const curve = new ethers.Contract(c.curve, CURVE_ABI, signer);
      // Dry-run at head: a static call that reverts means spot already drifted shy — skip cheaply, retry next poll.
      try { await curve.graduate.staticCall(); }
      catch { continue; }
      let gas = GAS_CAP;
      try { gas = (await curve.graduate.estimateGas()) * 125n / 100n; } catch {}
      if (gas > GAS_CAP) gas = GAS_CAP;

      inFlight.add(cl);
      attempts.set(cl, (attempts.get(cl) || 0) + 1);
      try {
        const tx = await curve.graduate({ type: 0, gasPrice, gasLimit: gas });
        console.log(`[grad] ${c.symbol || c.token} → graduate() sent ${tx.hash} (attempt ${attempts.get(cl)})`);
        // Watch out-of-band so the poll loop stays responsive.
        tx.wait(1, WAIT_MS).then((rc) => {
          if (rc && rc.status === 1) { console.log(`[grad] ✅ GRADUATED ${c.symbol || c.token} — tx ${rc.hash}`); attempts.set(cl, 0); }
          else { onFail(cl, "reverted"); }
        }).catch((e) => onFail(cl, (e && e.shortMessage) || (e && e.message) || "wait error"))
          .finally(() => inFlight.delete(cl));
      } catch (e) {
        inFlight.delete(cl);
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
      // benign: spot drifted shy between staticCall and mine — will retry next poll
      console.log(`[grad] retry ${cl} next poll (${why})`);
    }
  }
}

// Allow `node src/gradkeeper.js` to run it directly (standalone).
if (import.meta.url === `file://${process.argv[1]}`) runGradKeeper();
