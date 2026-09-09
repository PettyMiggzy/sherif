// ─────────────────────────────────────────────────────────────────────────────
// ROBIN buyback keeper — turns platform revenue into standing demand for $ROBIN.
//
// WHY THIS EXISTS
// The launchpad wants every graduation to bid up its own token. The obvious design — pair every
// graduating coin against ROBIN in a second LP pool — is blocked: ROBIN is itself still on a bonding
// curve (~49% of the way to its 4.2 ETH ceiling, `ready()` false), so that leg would have nothing real
// to price against, and a second pool has to be opened through the factory-gated `beforeInitialize` or
// it becomes an untaxed venue for the same token.
//
// This buys the identical tokenomic with no second pool and no graduate() rewrite: spend platform ETH
// buying ROBIN on the curve it already trades on. That does two things at once — it is recurring,
// structural demand that scales with launch volume, AND it walks ROBIN toward its own graduation, after
// which the paired-pool design becomes possible for real. The keeper is the unblocker, not a substitute.
//
// WHAT IT DOES each tick:
//   stop if ROBIN has graduated (different strategy from there) → balance/gas guard → cooldown →
//   read spot and compare against our own rolling mean → size the buy → staticCall dry-run to get a
//   quote → broadcast a legacy type-0 buyExactInETH with amountOutMin derived from that quote.
//
// THE GUARD THAT MATTERS: A PREDICTABLE BUYER IS FARMABLE.
// A keeper that buys on a fixed schedule with no price limit is free money for anyone who front-runs
// it: push the curve up, let the keeper buy the pump, sell into it. MilestoneVault.buyback already
// solved this shape on-chain — throttle, a cap per buy, a slippage floor, and "spot must track the TWAP
// (blocks buying the burn at a manipulated/pumped spot price)". The same four guards are applied here:
//   • COOLDOWN     — one buy per window, never a burst
//   • SIZE CAP     — a fixed ceiling AND a share of the spendable balance, so no single buy moves price much
//   • DEVIATION    — refuse to buy when spot has run UP away from our own rolling mean of observed spot.
//                    Rather than depend on pool observation cardinality (these pads seed with 1), the
//                    keeper keeps its own EMA across polls. Buying a dip is fine; buying a spike is not.
//   • amountOutMin — the only guard that is enforced ON-CHAIN, derived from a same-block staticCall
//                    quote, so the price cannot move between simulate and mine.
//   • JITTER       — size and cadence are randomised inside their bounds so the schedule is not a clock
//                    somebody else can set their watch by.
//
// HONEST SCOPE: every guard here except amountOutMin is CLIENT-SIDE. A compromised keeper key can ignore
// them. The blast radius is bounded by what the wallet is funded with — fund it per-period, not with a
// treasury. The on-chain version of this belongs in a contract like MilestoneVault if it ever holds size.
//
// OFF unless BUYBACK_KEEPER_KEY (or KEEPER_KEY) and BUYBACK_TOKEN are set and BUYBACK_KEEPER != 0.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { beat } from "./heartbeat.js";

const KEY = process.env.BUYBACK_KEEPER_KEY || process.env.KEEPER_KEY || "";
const TOKEN = (process.env.BUYBACK_TOKEN || "").toLowerCase();
const ENABLED = !!KEY && !!TOKEN && process.env.BUYBACK_KEEPER !== "0";

const POLL_MS = Number(process.env.BUYBACK_POLL_MS || 60_000);
const COOLDOWN_MS = Number(process.env.BUYBACK_COOLDOWN_MS || 3_600_000); // one buy an hour by default
const MAX_SLIP_BPS = BigInt(process.env.BUYBACK_MAX_SLIP_BPS || 100); // 1% off the dry-run quote
const MAX_TICK_DEV = Number(process.env.BUYBACK_MAX_TICK_DEV || 200); // refuse a spot this far ABOVE our mean
const EMA_ALPHA = Number(process.env.BUYBACK_EMA_ALPHA || 0.1); // rolling-mean weight per poll
const JITTER_BPS = Number(process.env.BUYBACK_JITTER_BPS || 2000); // ±20% on size and cadence
const GAS_MULT = Number(process.env.BUYBACK_GAS_MULT || 1.2);

const parseEth = (v, dflt) => {
  try { return ethers.parseEther(v || dflt); } catch { return ethers.parseEther(dflt); }
};
const PER_BUY_WEI = parseEth(process.env.BUYBACK_PER_BUY_ETH, "0.01"); // hard ceiling on one buy
const MIN_BALANCE_WEI = parseEth(process.env.BUYBACK_MIN_BALANCE, "0.01"); // gas reserve, never spent
const MAX_BPS = BigInt(process.env.BUYBACK_MAX_BPS || 500); // and never more than 5% of spendable per buy
const GAS_CAP = (() => {
  try { const v = BigInt(process.env.BUYBACK_GAS_CAP || 3_000_000); return v > 0n ? v : 3_000_000n; }
  catch { return 3_000_000n; }
})();

const ROUTER_ABI = [
  "function buyExactInETH(address token, uint256 amountOutMin, uint256 deadline) payable returns (uint256 tokenOut)",
];
const CURVE_ABI = ["function ready() view returns (bool)", "function pool() view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIdx, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
];

let meanTick = null; // our own rolling mean of observed spot — no pool observation cardinality needed
let lastBuyAt = 0;
let tokenIsToken0 = null; // price orientation, resolved once
const stats = { polls: 0, buys: 0, skipped: {}, spentWei: 0n };

const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; return null; };
const jitter = (n) => {
  // deterministic-free jitter is the point: an attacker must not be able to predict the next buy
  const span = (Number(n) * JITTER_BPS) / 10_000;
  return Math.max(0, Number(n) - span + Math.random() * span * 2);
};

/// Is the token MORE EXPENSIVE than our rolling mean? Orientation depends on the pool's token sort:
/// with the pad token as token1 a HIGHER tick means more token per WETH — i.e. CHEAPER. Getting this
/// backwards would invert the guard into "only buy pumps", so it is resolved from the pool itself.
export function tooExpensive(tick, _mean, _isToken0) {
  const mean = _mean === undefined ? meanTick : _mean;
  const isT0 = _isToken0 === undefined ? tokenIsToken0 : _isToken0;
  if (mean === null) return false;
  const richer = isT0 ? tick - mean : mean - tick;
  return richer > MAX_TICK_DEV;
}

export async function runBuybackKeeper(provider) {
  if (!ENABLED) {
    console.log("[buyback] disabled (needs BUYBACK_KEEPER_KEY + BUYBACK_TOKEN, and BUYBACK_KEEPER != 0)");
    return;
  }
  const p = provider || new ethers.JsonRpcProvider(CFG.rpc);
  const signer = new ethers.Wallet(KEY, p); // plain wallet: a failed send consumes no nonce
  const router = new ethers.Contract(CFG.router, ROUTER_ABI, signer);
  console.log(`[buyback] armed — wallet ${signer.address} buying ${TOKEN} via router ${CFG.router}`);

  const curveAddr = process.env.BUYBACK_CURVE || "";
  const curve = curveAddr ? new ethers.Contract(curveAddr, CURVE_ABI, p) : null;
  let pool = null;

  for (;;) {
    try { await tick(p, signer, router, curve, () => pool, (v) => { pool = v; }); }
    catch (e) { console.log(`[buyback] poll error: ${(e && e.shortMessage) || (e && e.message) || e}`); }
    beat("buyback");
    await new Promise((r) => setTimeout(r, jitter(POLL_MS)));
  }
}

async function tick(p, signer, router, curve, getPool, setPool) {
  stats.polls++;

  // 1) Stop once ROBIN graduates — from there it has a real pool and this strategy is the wrong one.
  if (curve) {
    try { if (await curve.ready()) return skip("graduated"); } catch {}
    if (!getPool()) {
      try { setPool(new ethers.Contract(await curve.pool(), POOL_ABI, p)); } catch {}
    }
  }

  // 2) Track spot and keep the rolling mean current EVERY poll, including polls we do not buy on —
  //    otherwise a quiet period would leave the mean stale and the deviation guard meaningless.
  const poolC = getPool();
  if (poolC) {
    try {
      if (tokenIsToken0 === null) tokenIsToken0 = (await poolC.token0()).toLowerCase() === TOKEN;
      const [, t] = await poolC.slot0();
      const spot = Number(t);
      meanTick = meanTick === null ? spot : meanTick + EMA_ALPHA * (spot - meanTick);
      if (tooExpensive(spot)) return skip("spot-above-mean");
    } catch { /* an unreadable pool must not stop the keeper; the on-chain amountOutMin still binds */ }
  }

  // 3) Cooldown — one buy per window, never a burst.
  if (lastBuyAt && Date.now() - lastBuyAt < jitter(COOLDOWN_MS)) return skip("cooldown");

  // 4) Size it. Never touch the gas reserve, never exceed the per-buy ceiling, never exceed a share of
  //    what is spendable — so a well-funded wallet still cannot move price much in one go.
  const bal = await p.getBalance(signer.address);
  if (bal <= MIN_BALANCE_WEI) return skip("low-balance");
  const spendable = bal - MIN_BALANCE_WEI;
  let amount = (spendable * MAX_BPS) / 10_000n;
  if (amount > PER_BUY_WEI) amount = PER_BUY_WEI;
  amount = BigInt(Math.floor(jitter(amount)));
  if (amount === 0n) return skip("dust");

  // 5) Dry-run for a quote in the same state we are about to broadcast into, then derive the ON-CHAIN
  //    slippage floor from it. This is the only guard an attacker cannot step around.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  let quote;
  try {
    quote = await router.buyExactInETH.staticCall(TOKEN, 0n, deadline, { value: amount });
  } catch (e) {
    return skip(`dry-run:${(e && e.shortMessage) || "revert"}`);
  }
  if (!quote || quote === 0n) return skip("zero-quote");
  const minOut = (quote * (10_000n - MAX_SLIP_BPS)) / 10_000n;

  // 6) Broadcast. Legacy type-0 — this chain has no EIP-1559 and gas buys inclusion, not ordering.
  const fee = await p.getFeeData();
  const gasPrice = BigInt(Math.floor(Number(fee.gasPrice || 0n) * GAS_MULT)) || fee.gasPrice || 0n;
  let gas = GAS_CAP;
  try {
    gas = (await router.buyExactInETH.estimateGas(TOKEN, minOut, deadline, { value: amount })) * 125n / 100n;
  } catch {}
  if (gas > GAS_CAP) gas = GAS_CAP;

  const tx = await router.buyExactInETH(TOKEN, minOut, deadline, {
    value: amount, type: 0, gasPrice, gasLimit: gas,
  });
  lastBuyAt = Date.now();
  stats.buys++;
  stats.spentWei += amount;
  console.log(`[buyback] bid ${ethers.formatEther(amount)} ETH for ROBIN (minOut ${minOut}) — tx ${tx.hash}`);
  tx.wait(1, 20_000)
    .then((rc) => { if (rc && rc.status === 1) console.log(`[buyback] ✅ filled — tx ${rc.hash}`); })
    .catch(() => console.log("[buyback] unconfirmed; next tick re-evaluates"));
  return null;
}

export function buybackStats() {
  return { enabled: ENABLED, token: TOKEN || null, meanTick, lastBuyAt, ...stats, spentWei: String(stats.spentWei) };
}

// Allow `node src/buybackkeeper.js` to run it standalone, like the other keepers.
if (import.meta.url === `file://${process.argv[1]}`) runBuybackKeeper();
