// Reward scoring + Merkle builder — the off-chain half of the RewardVault design.
//
// The chain (RewardVault) custodies the two 0.25% legs per (coin, epoch, side) and enforces a conservation
// cap: Σ claims ≤ pot. It never scores. THIS module computes the exact per-user weights the chain can't, turns
// them into wei allocations that sum to ≤ the pot, and builds ONE global Merkle root per epoch whose leaves bind
// (epoch, coin, side, user, amount) — the exact leaf the contract verifies.
//
// Scoring spec (frozen; its hash is posted on-chain as `algoHash`, so anyone can recompute and challenge):
//   • Traders side  (funded by the BUY leg):  weight = max(0, Σ buy_tokens − Σ sell_tokens) IN the epoch.
//                                              Rewards net token accumulation; a round-tripper nets ~0.
//   • Holders side  (funded by the SELL leg): weight = balance-seconds = ∫ balance dt over the epoch, where
//                                              balance is reconstructed from the coin's trades (carried in from
//                                              before the epoch + intra-epoch buys/sells), clamped at 0.
//   • Allocation:   amount_i = floor(pot × weight_i / Σ weight).  Σ amount_i ≤ pot by construction; the wei
//                   remainder stays unclaimed and is swept to that coin's floor after the claim window.
//   • Leaf:         keccak256(keccak256(abi.encode(uint256 epoch, address coin, uint8 side, address user,
//                   uint256 amount)))  — identical to the contract and to OZ StandardMerkleTree.
//
// All token/pot math is BigInt: token amounts are wei-scale × supply (≫ 2^53), so SQL REAL would lose precision.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { ethers } from "ethers";
import { db } from "./db.js";
import { CFG } from "./config.js";

// Side enum — matches RewardVault.Side.
export const SIDE = { Traders: 0, Holders: 1 };

// The frozen scoring spec. Its keccak is the on-chain algoHash; changing ANY scoring rule must change this
// string (and therefore the hash), so a root computed under a different rule is provably distinguishable.
export const ALGO_SPEC =
  "RobinLabs-Rewards-v1|traders=max(0,net_token_accumulation_in_epoch)|" +
  "holders=balance_seconds_from_trades(carry_in,clamp0)|alloc=floor(pot*w/sumW)|" +
  "leaf=keccak(keccak(abi.encode(uint256 epoch,address coin,uint8 side,address user,uint256 amount)))";
export const ALGO_HASH = ethers.keccak256(ethers.toUtf8Bytes(ALGO_SPEC));

// StandardMerkleTree leaf encoding — order MUST match abi.encode(epoch, coin, side, user, amount) on-chain.
const LEAF_TYPES = ["uint256", "address", "uint8", "address", "uint256"];

export const epochLen = () => CFG.epochLen;
export const epochBounds = (epoch) => ({ t0: epoch * CFG.epochLen, t1: (epoch + 1) * CFG.epochLen });
export const currentEpoch = (nowSec = Math.floor(Date.now() / 1000)) => Math.floor(nowSec / CFG.epochLen);

// ── reward exclusions + holder min-balance ───────────────────────────────────
// Supply is fixed by CurvePadFactory at 1e9 whole tokens × 1e18.
const TOTAL_SUPPLY_WEI = 1_000_000_000n * 10n ** 18n;
// Min TIME-AVERAGED balance (wei) a wallet must hold across an epoch to accrue HOLDER rewards. Sub-threshold
// wallets drop out of the weight set → their slice stays unclaimed → swept to the coin's floor. 0 disables it.
const HOLDER_MIN_WEI = (TOTAL_SUPPLY_WEI * BigInt(CFG.holderMinBps)) / 10000n;

// ── db access (reward-specific; kept here so the feature is self-contained) ──
// Pots are the SUM of raw Accrued rows for the epoch — DERIVED, not accumulated, so a reorg re-scan (which purges
// + re-inserts accrual rows like trades) can never double-count. Amounts are uint128 wei (a hot coin's epoch pot
// exceeds int64), so we fetch raw rows and sum in BigInt — never in SQL, where INTEGER overflow degrades to float.
const _accrualsForEpoch = db.prepare("SELECT coin, side, amount FROM reward_accruals WHERE epoch = ?");
function potsForEpoch(epoch) {
  const pots = new Map(); // coin -> { trader: BigInt, holder: BigInt }
  for (const r of _accrualsForEpoch.all(epoch)) {
    const p = pots.get(r.coin) || pots.set(r.coin, { trader: 0n, holder: 0n }).get(r.coin);
    if (r.side === SIDE.Traders) p.trader += BigInt(r.amount);
    else p.holder += BigInt(r.amount);
  }
  return pots;
}
// Every trade of a coin up to the epoch end, oldest first — enough to reconstruct balances into and across it.
const _tradesUpTo = db.prepare(
  "SELECT actor, side, tokens, ts FROM trades WHERE token = ? AND ts < ? ORDER BY ts ASC, block ASC, log_index ASC");

// Per-coin infra addresses (curve, pool/LP, bond), joined with the global sinks to build the exclusion set.
const _coinAddrs = db.prepare("SELECT curve, pool, bond FROM coins WHERE token = ?");
// Addresses that must NEVER earn rewards (either side): the token itself, its bonding curve, its Uniswap
// pool (holds the LP), its Bond; and globally the router, the RewardVault, the factory, the dev vesting-lock,
// and the zero/dead burn sinks. filter(Boolean) tolerates any unset global.
function excludedFor(coin) {
  const s = new Set([
    coin, CFG.rewardVault, CFG.tokenVestingLock,
    ...(CFG.routers && CFG.routers.length ? CFG.routers : [CFG.router]),
    ...(CFG.factories && CFG.factories.length ? CFG.factories : [CFG.factory]),
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
  ].filter(Boolean).map((a) => String(a).toLowerCase()));
  const r = _coinAddrs.get(coin) || {};
  for (const a of [r.curve, r.pool, r.bond]) if (a) s.add(String(a).toLowerCase());
  return s;
}

// Distribute `pot` (wei, BigInt) across `weights` (Map<user,BigInt>) proportionally, floor each, so Σ ≤ pot.
// Returns Map<user, BigInt amount> for the non-zero allocations only.
//
// `totalOverride`, when given, is used as the denominator instead of Σ(weights). This is how the holder
// leg routes sub-threshold wallets' slice to the floor: `weights` holds only ELIGIBLE holders, but the
// denominator is the balance-seconds of ALL holders — so the eligible set receives only its true pro-rata
// share and the sub-threshold remainder is never allocated (stays unclaimed → swept to the coin's floor).
function allocate(pot, weights, totalOverride) {
  const out = new Map();
  if (pot <= 0n) return out;
  let total = totalOverride != null ? totalOverride : 0n;
  if (totalOverride == null) for (const w of weights.values()) total += w;
  if (total <= 0n) return out; // nobody → whole pot stays unclaimed → swept to floor
  for (const [user, w] of weights) {
    if (w <= 0n) continue;
    const amt = (pot * w) / total; // floor
    if (amt > 0n) out.set(user, amt);
  }
  return out;
}

// Compute both sides' weights for one coin in [t0, t1) from its trade history.
// Returns { trader: Map<user,BigInt net>, holder: Map<user,BigInt balanceSeconds> }.
function coinWeights(coin, t0, t1) {
  const rows = _tradesUpTo.all(coin, t1);
  const excl = excludedFor(coin);       // infra + sinks never accrue (either side)
  const balBefore = new Map();          // running balance strictly before t0 (carry-in)
  const events = new Map();             // user -> [{ts, delta}] within [t0, t1)
  const traderNet = new Map();          // user -> net token accumulation within [t0, t1)
  for (const r of rows) {
    if (excl.has(String(r.actor).toLowerCase())) continue; // skip curve/pool/bond/router/vault/etc.
    const delta = r.side === "buy" ? BigInt(r.tokens) : -BigInt(r.tokens);
    if (r.ts < t0) {
      balBefore.set(r.actor, (balBefore.get(r.actor) || 0n) + delta);
    } else {
      (events.get(r.actor) || events.set(r.actor, []).get(r.actor)).push({ ts: r.ts, delta });
      traderNet.set(r.actor, (traderNet.get(r.actor) || 0n) + delta);
    }
  }
  // Trader weight = max(0, net accumulation in-epoch).
  const trader = new Map();
  for (const [u, net] of traderNet) if (net > 0n) trader.set(u, net);

  // Holder weight = balance-seconds. Integrate balance over [t0, t1) for every user who held or traded.
  // `holder` holds only wallets that clear the min-holding floor; `holderTotal` is the balance-seconds of
  // ALL holders (incl. sub-threshold), used as the allocation denominator so the sub-threshold share is
  // routed to the floor rather than redistributed to whales.
  const holder = new Map();
  let holderTotal = 0n;
  const users = new Set([...balBefore.keys(), ...events.keys()]);
  for (const u of users) {
    let bal = balBefore.get(u) || 0n;
    if (bal < 0n) bal = 0n;             // trade-derived carry-in can dip negative on unseen P2P inflow; clamp
    let last = t0;
    let bs = 0n;
    const evs = events.get(u) || [];
    for (const e of evs) {
      const dt = BigInt(e.ts - last);
      if (dt > 0n) bs += bal * dt;
      bal += e.delta;
      if (bal < 0n) bal = 0n;
      last = e.ts;
    }
    const tail = BigInt(t1 - last);
    if (tail > 0n) bs += bal * tail;
    if (bs <= 0n) continue;
    holderTotal += bs;                  // every holder counts toward the denominator…
    // …but only those clearing the min-holding floor (balance-seconds ÷ epoch length = time-avg balance) earn.
    if (bs / BigInt(t1 - t0) >= HOLDER_MIN_WEI) holder.set(u, bs);
  }
  return { trader, holder, holderTotal };
}

// Compute the full allocation set for one finalized epoch. Returns:
//   { epoch, root, algoHash, leaves:[[epoch,coin,side,user,amount(str)]...],
//     entries:[{coin,side,user,amount(str),proof:[...]}], perCoin:{coin:{traderPot,holderPot,traderAlloc,holderAlloc}} }
// `root` is null when the epoch has no eligible leaves (empty pots or no holders) — nothing to post.
export function computeEpoch(epoch) {
  const { t0, t1 } = epochBounds(epoch);
  const pots = potsForEpoch(epoch);
  const leafValues = [];       // [epoch, coin, side, user, amountStr]
  const perCoin = {};
  for (const [coin, pot] of pots) {
    const traderPot = pot.trader;
    const holderPot = pot.holder;
    if (traderPot === 0n && holderPot === 0n) continue;
    const { trader, holder, holderTotal } = coinWeights(coin, t0, t1);
    const traderAlloc = allocate(traderPot, trader);
    const holderAlloc = allocate(holderPot, holder, holderTotal); // sub-threshold share → floor
    let tSum = 0n, hSum = 0n;
    for (const [u, a] of traderAlloc) { leafValues.push([BigInt(epoch), coin, SIDE.Traders, u, a]); tSum += a; }
    for (const [u, a] of holderAlloc) { leafValues.push([BigInt(epoch), coin, SIDE.Holders, u, a]); hSum += a; }
    perCoin[coin] = {
      traderPot: traderPot.toString(), holderPot: holderPot.toString(),
      traderAlloc: tSum.toString(), holderAlloc: hSum.toString(),
    };
  }
  if (leafValues.length === 0) {
    return { epoch, root: null, algoHash: ALGO_HASH, leaves: [], entries: [], perCoin };
  }
  // ONE global tree over all coins' leaves for the epoch (the contract verifies against this single root).
  const tree = StandardMerkleTree.of(leafValues, LEAF_TYPES);
  const entries = [];
  for (const v of leafValues) {
    entries.push({
      coin: v[1], side: Number(v[2]), user: v[3], amount: v[4].toString(), proof: tree.getProof(v),
    });
  }
  return {
    epoch,
    root: tree.root,
    algoHash: ALGO_HASH,
    leaves: leafValues.map((v) => [v[0].toString(), v[1], Number(v[2]), v[3], v[4].toString()]),
    entries,
    perCoin,
  };
}

// One user's allocations across all coins in an epoch — works for an OPEN epoch too (a live provisional
// estimate against the pot accrued so far), which is what the pad shows as "pending / accruing this epoch".
// No proofs (the epoch isn't finalized); returns [{ coin, side, amount }].
export function userAllocations(user, epoch) {
  user = user.toLowerCase();
  const { t0, t1 } = epochBounds(epoch);
  const out = [];
  for (const [coin, pot] of potsForEpoch(epoch)) {
    const { trader, holder, holderTotal } = coinWeights(coin, t0, t1);
    const ta = allocate(pot.trader, trader).get(user);
    const ha = allocate(pot.holder, holder, holderTotal).get(user);
    if (ta && ta > 0n) out.push({ coin, side: SIDE.Traders, amount: ta.toString() });
    if (ha && ha > 0n) out.push({ coin, side: SIDE.Holders, amount: ha.toString() });
  }
  return out;
}

// Recompute a single leaf hash exactly as the contract does — used by tests to prove parity.
export function leafHash(epoch, coin, side, user, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(LEAF_TYPES, [epoch, coin, side, user, amount]));
  return ethers.keccak256(inner);
}
