// ─────────────────────────────────────────────────────────────────────────────
// Fee keeper — walks fees from the router all the way into stakers' hands.
//
// The money does NOT flow on its own. A trade accrues it in the router and stops there; three
// separate calls have to happen afterwards, and until this existed nobody was making any of them:
//
//   1. router.flushStaking(token)  — that coin's sell-side slice leaves the router for the feeder
//   2. feeder.feedEth(pool, amt)   — the feeder pushes it into that coin's staking pool
//   3. pool.releasePending()       — rewards parked while a pool was empty finally start streaming
//
//   plus router.flushRobin() for the buy-side slice that pays $ROBIN stakers, pad-wide.
//
// ATTRIBUTION IS THE FIDDLY PART. The feeder holds one commingled ETH balance, so it cannot work out
// which coin a given wei came from. This keeper therefore reads a coin's escrow BEFORE flushing it,
// flushes exactly that, and immediately feeds exactly that to that coin's pool — one token at a time,
// serialised. Batching several flushes and then splitting the pot afterwards would mean guessing.
//
// EVERY STEP IS SAFE TO REPEAT AND SAFE TO SKIP. A flush with nothing to flush is a no-op; a feed
// larger than the balance reverts and is retried next pass; a release before the delay does nothing.
// So a crashed pass costs one cycle, never a coin's fees.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { db } from "./db.js";

const ROUTER_ABI = [
  "function stakingEscrow(address) view returns (uint256)",
  "function robinEscrow() view returns (uint256)",
  "function stakingSink() view returns (address)",
  "function robinSink() view returns (address)",
  "function flushStaking(address token)",
  "function flushRobin()",
];
const FEEDER_ABI = [
  "function feedEth(address pool, uint256 amount)",
  "function returnTax(address pool) returns (address asset, uint256 amount)",
  "function registry() view returns (address)",
];
const FACTORY_ABI = ["function poolOf(address stakeToken) view returns (address)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const POOL_ABI = [
  "function releasePending()",
  "function stranded(address) view returns (uint256)",
  "function sweepStranded(address asset) returns (uint256)",
  "function rewardInfo(address) view returns (bool listed, uint32 duration, uint64 periodFinish, uint64 lastUpdateTime, uint256 rewardRate, uint256 rewardPerTokenStored, uint256 pending)",
  "function totalWeight() view returns (uint256)",
  "function weightSince() view returns (uint64)",
  "function PENDING_DELAY() view returns (uint32)",
  "function ETH() view returns (address)",
];

export function enabled() {
  return !!(CFG.feedKeeperKey && CFG.router && CFG.stakingFeeder && CFG.tierStakingFactory);
}

let _wallet = null;
export function keeperAddress() {
  if (!CFG.feedKeeperKey) return null;
  try { return new ethers.Wallet(CFG.feedKeeperKey).address; } catch { return null; }
}

// One transaction at a time, with a locally tracked nonce — the same stale-count problem that made
// credit charges silently fail applies to every relayer in this codebase.
let _queue = Promise.resolve();
let _nonce = null;
function serialize(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.then(() => {}, () => {});
  return run;
}
async function send(provider, contract, method, args) {
  return serialize(async () => {
    let gasPrice = (await provider.getFeeData()).gasPrice;
    if (gasPrice == null) gasPrice = BigInt(await provider.send("eth_gasPrice", []));
    if (_nonce === null) _nonce = await provider.getTransactionCount(keeperAddress(), "pending");
    const n = _nonce;
    try {
      const tx = await contract[method](...args, { type: 0, gasPrice, nonce: n });
      _nonce = n + 1;
      await tx.wait();
      return tx.hash;
    } catch (e) { _nonce = null; throw e; }
  });
}

const fmt = (wei) => Number(ethers.formatEther(wei)).toFixed(6);

/// One full pass. Returns a small summary for the log.
export async function sweepOnce(provider) {
  if (!enabled()) return null;
  if (!_wallet) _wallet = new ethers.Wallet(CFG.feedKeeperKey, provider);
  const router = new ethers.Contract(CFG.router, ROUTER_ABI, _wallet);
  const feeder = new ethers.Contract(CFG.stakingFeeder, FEEDER_ABI, _wallet);
  const factory = new ethers.Contract(CFG.tierStakingFactory, FACTORY_ABI, provider);

  // The router refuses to move anything while its sinks are unset, and would do so SILENTLY — the
  // flush is a no-op, not a revert — so it is checked once here rather than leaving a keeper that
  // looks healthy while nothing ever arrives.
  const [stakingSink, robinSink] = await Promise.all([router.stakingSink(), router.robinSink()]);
  if (stakingSink === ethers.ZeroAddress && robinSink === ethers.ZeroAddress) {
    console.warn("[feed] router sinks are unset — call setStakingSink/setRobinSink or fees never leave the router");
    return null;
  }

  let fedCoins = 0, fedWei = 0n, released = 0, taxed = 0;

  // ── per-coin sell-side slices ────────────────────────────────────────────
  let rows = [];
  try { rows = db.prepare("SELECT token, symbol FROM coins WHERE graduated = 1").all(); } catch { rows = []; }
  for (const r of rows) {
    let owed;
    try { owed = await router.stakingEscrow(r.token); } catch { continue; }
    if (owed < CFG.feedMinWei) continue; // not worth the gas yet; it keeps accruing

    let pool;
    try { pool = await factory.poolOf(r.token); } catch { continue; }
    if (!pool || /^0x0{40}$/i.test(pool)) continue; // no pool yet — the pool-maker will get to it

    try {
      // Read, flush, feed — exactly this amount, to exactly this pool, before touching another coin.
      await send(provider, router, "flushStaking", [r.token]);
      await send(provider, feeder, "feedEth", [pool, owed]);
      fedCoins++; fedWei += owed;
      console.log(`[feed] ${r.symbol || r.token} → ${fmt(owed)} ETH into ${pool}`);
    } catch (e) {
      console.warn(`[feed] ${r.symbol || r.token}: ${(e && e.shortMessage) || (e && e.message) || e}`);
    }
  }

  // ── the pad-wide buy-side slice for $ROBIN stakers ───────────────────────
  try {
    const owed = await router.robinEscrow();
    if (owed >= CFG.feedMinWei) {
      const robinPool = await factory.poolOf(CFG.platformToken);
      if (robinPool && !/^0x0{40}$/i.test(robinPool)) {
        await send(provider, router, "flushRobin", []);
        await send(provider, feeder, "feedEth", [robinPool, owed]);
        fedWei += owed;
        console.log(`[feed] $ROBIN stakers → ${fmt(owed)} ETH (from buys across the pad)`);
      }
    }
  } catch (e) {
    console.warn("[feed] robin slice:", (e && e.shortMessage) || (e && e.message) || e);
  }

  // ── early-exit tax, sent home ────────────────────────────────────────────
  // Breaking a lock costs 15%, paid in the staked coin, and that 15% belongs to the people still staked
  // in that same pool. It gets there in two hops — pool.sweepStranded moves it to the feeder, then
  // feeder.returnTax pushes it back in — and NEITHER hop is ours to gate: both are permissionless, and
  // the stake page has a button for them. The keeper does it anyway so nobody has to notice and nobody
  // waits on a stranger. Neither call can send the money anywhere but back into the pool it came from.
  for (const r of rows) {
    let pool;
    try { pool = await factory.poolOf(r.token); } catch { continue; }
    if (!pool || /^0x0{40}$/i.test(pool)) continue;
    try {
      const p = new ethers.Contract(pool, POOL_ABI, _wallet);
      const pot = await p.stranded(r.token);
      if (pot > 0n) await send(provider, p, "sweepStranded", [r.token]);
      // Read the feeder's balance rather than trusting `pot`: someone else may have swept it already,
      // in which case the coin is sitting in the feeder waiting and there is still work to do here.
      const coin = new ethers.Contract(r.token, ERC20_ABI, _wallet);
      const held = await coin.balanceOf(CFG.stakingFeeder);
      if (held === 0n) continue;
      await send(provider, feeder, "returnTax", [pool]);
      taxed++;
      console.log(`[feed] ${r.symbol || r.token} → sent ${fmt(held)} of early-exit tax back to its stakers`);
    } catch (e) {
      console.warn(`[feed] tax return ${r.symbol || r.token}:`, (e && e.shortMessage) || (e && e.message) || e);
    }
  }

  // ── parked rewards whose delay has elapsed ───────────────────────────────
  // A pool funded while empty holds its rewards back for PENDING_DELAY so the first staker cannot
  // take the lot. Nothing releases them on its own unless somebody stakes, so the keeper does it.
  for (const r of rows) {
    let pool;
    try { pool = await factory.poolOf(r.token); } catch { continue; }
    if (!pool || /^0x0{40}$/i.test(pool)) continue;
    try {
      const p = new ethers.Contract(pool, POOL_ABI, _wallet);
      const [ethAsset, weight, since, delay] = await Promise.all([
        p.ETH(), p.totalWeight(), p.weightSince(), p.PENDING_DELAY(),
      ]);
      if (weight === 0n || since === 0n) continue;
      if (BigInt(Math.floor(Date.now() / 1000)) < BigInt(since) + BigInt(delay)) continue;
      const info = await p.rewardInfo(ethAsset);
      if (info.pending === 0n) continue;
      await send(provider, p, "releasePending", []);
      released++;
      console.log(`[feed] ${r.symbol || r.token} → released ${fmt(info.pending)} ETH of parked rewards`);
    } catch { /* a pool that will not release is retried next pass */ }
  }

  return { fedCoins, fedWei, released, taxed };
}

export async function runFeedKeeper(provider) {
  if (!enabled()) {
    console.log("[feed] fee keeper OFF (needs FEED_KEEPER_KEY, STAKING_FEEDER, TIER_STAKING_FACTORY)");
    return;
  }
  console.log(`[feed] fee keeper ON as ${keeperAddress()} — sweeping every ${Math.round(CFG.feedIntervalMs / 1000)}s`);
  for (;;) {
    try {
      const r = await sweepOnce(provider);
      if (r && (r.fedCoins || r.released || r.taxed)) {
        console.log(`[feed] pass done: ${r.fedCoins} pool(s) funded with ${fmt(r.fedWei)} ETH, ${r.released} release(s), ${r.taxed} tax return(s)`);
      }
    } catch (e) { console.log("[feed] pass error:", (e && e.message) || e); }
    await new Promise((r) => setTimeout(r, CFG.feedIntervalMs));
  }
}

export function stats() {
  return { enabled: enabled(), keeper: keeperAddress(), router: CFG.router || null, feeder: CFG.stakingFeeder || null };
}
