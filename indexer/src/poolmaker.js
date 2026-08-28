// ─────────────────────────────────────────────────────────────────────────────
// Auto pool-maker — every coin that bonds gets its own staking pool, with no human involved.
//
// WHY THIS LIVES IN THE KEEPER AND NOT IN `graduate()`. Putting `createPool` inside the graduation
// transaction is the obvious design and it is the dangerous one: `graduate()` is the single function
// in the whole system that must never fail. If it reverts, the raised ETH sits in the curve with no
// rescue path. Every external call added there is a new way to strand a coin's entire raise — for a
// convenience that does not need to be atomic with anything. So the pool is created afterwards, in a
// separate transaction, by the keeper that already watches for graduations. A failure here costs a
// retry; a failure inside graduate() costs the raise.
//
// It is also IDEMPOTENT and BACKFILLING, which matters more than it sounds: coins that bonded before
// this shipped have no pool, and a keeper that only reacts to live events would leave them without
// one forever. Every pass reconciles the full set of graduated coins against `poolOf`.
//
// The keeper's address must hold a CREATOR slot on the factory (`setCreator(keeper, true)`). That
// slot is permission to ADD a pool to the registry and nothing else — pools are owned by the
// factory's owner — so this key cannot configure rewards, change the boost, or touch anyone's stake.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { db } from "./db.js";

const FACTORY_ABI = [
  "function poolOf(address stakeToken) view returns (address)",
  "function createPool(address stakeToken, bool selfBoost) returns (address)",
  "function isCreator(address) view returns (bool)",
  "function openCreation() view returns (bool)",
  "function owner() view returns (address)",
];

export function enabled() {
  return !!(CFG.tierStakingFactory && CFG.poolMakerKey);
}

let _wallet = null;
let _factory = null;
function factory(provider) {
  if (_factory) return _factory;
  _wallet = new ethers.Wallet(CFG.poolMakerKey, provider);
  _factory = new ethers.Contract(CFG.tierStakingFactory, FACTORY_ABI, _wallet);
  return _factory;
}
export function makerAddress() {
  if (!CFG.poolMakerKey) return null;
  try { return new ethers.Wallet(CFG.poolMakerKey).address; } catch { return null; }
}

// Sends are serialised with a locally tracked nonce for the same reason the credits relayer is: a
// transaction count read straight after a send can come back STALE, and two pool creations in one
// batch then collide on the same nonce and one silently does nothing.
let _queue = Promise.resolve();
let _nonce = null;
function serialize(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.then(() => {}, () => {});
  return run;
}

const _failures = new Map(); // token => consecutive failures, to back off a coin that cannot work

/// Create the pool for `token` unless one exists. Returns the pool address, or null if it did not
/// happen — never throws, because this runs inside the graduation keeper and must not disturb it.
export async function ensurePoolFor(provider, token, label) {
  if (!enabled()) return null;
  const t = String(token).toLowerCase();
  if ((_failures.get(t) || 0) >= 5) return null; // parked: something about this coin does not work

  try {
    const f = factory(provider);
    const existing = await f.poolOf(t);
    if (!/^0x0{40}$/i.test(existing)) return existing;

    // `selfBoost` is FALSE for every launched coin, always. True makes a pool its own boost source,
    // which is only ever correct for the flagship $ROBIN pool — on any other token it would mean
    // "staking this coin boosts this coin", letting a worthless token mint its own multiplier.
    const sent = await serialize(async () => {
      let gasPrice = (await provider.getFeeData()).gasPrice;
      if (gasPrice == null) gasPrice = BigInt(await provider.send("eth_gasPrice", []));
      const from = makerAddress();
      if (_nonce === null) _nonce = await provider.getTransactionCount(from, "pending");
      const n = _nonce;
      try {
        const tx = await f.createPool(t, false, { type: 0, gasPrice, nonce: n });
        _nonce = n + 1;
        await tx.wait();
        return tx.hash;
      } catch (e) { _nonce = null; throw e; }
    });

    const pool = await f.poolOf(t);
    _failures.delete(t);
    console.log(`[pools] ${label || t} → staking pool ${pool} (tx ${String(sent).slice(0, 12)}…)`);
    return pool;
  } catch (e) {
    const n = (_failures.get(t) || 0) + 1;
    _failures.set(t, n);
    const why = (e && e.shortMessage) || (e && e.message) || String(e);
    // A creator slot that was never granted is the most likely cause and it is silent otherwise —
    // every coin would just quietly never get a pool.
    console.warn(`[pools] could not create a pool for ${label || t} (attempt ${n}): ${why}`);
    if (n === 1 && /NotCreator/i.test(why)) {
      console.warn(`[pools] the keeper ${makerAddress()} is not a creator on ${CFG.tierStakingFactory} — call setCreator(keeper, true)`);
    }
    return null;
  }
}

/// Reconcile every graduated coin against the registry. Cheap: one `poolOf` read per coin, and a
/// write only for the ones actually missing.
export async function backfill(provider) {
  if (!enabled()) return 0;
  let rows = [];
  try {
    rows = db.prepare("SELECT token, symbol FROM coins WHERE graduated = 1 ORDER BY grad_ts ASC").all();
  } catch { return 0; }
  let made = 0;
  for (const r of rows) {
    const pool = await ensurePoolFor(provider, r.token, r.symbol);
    if (pool) made++;
  }
  return made;
}

export function stats() {
  return { enabled: enabled(), maker: makerAddress(), factory: CFG.tierStakingFactory || null, parked: _failures.size };
}
