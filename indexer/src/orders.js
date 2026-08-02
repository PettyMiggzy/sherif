// ─────────────────────────────────────────────────────────────────────────────
// RobinLimit order store — off-chain home for signed limit / DCA orders.
//
// The maker signs an EIP-712 order in the browser and POSTs {order, signature} here. We verify
// the signature against the maker (so nobody can plant an order for someone else), key it by the
// SAME EIP-712 hash the contract uses, and store it. The keeper reads open orders and calls
// execute() on-chain; the pad's portfolio lists a maker's open orders and cancels them.
//
// This store is a convenience index, NOT custody or authority: the contract is the source of
// truth for fills and cancels. The whole module is inert until CFG.robinLimit is set (deployed).
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { db } from "./db.js";
import { CFG } from "./config.js";

db.exec(`
CREATE TABLE IF NOT EXISTS limit_orders (
  hash        TEXT PRIMARY KEY,
  maker       TEXT NOT NULL,
  sell_token  TEXT NOT NULL,
  buy_token   TEXT NOT NULL,
  order_json  TEXT NOT NULL,   -- the exact signed order (string fields), for the keeper + re-verify
  signature   TEXT NOT NULL,
  expiry      INTEGER NOT NULL,
  slices      INTEGER NOT NULL,
  cancelled   INTEGER DEFAULT 0,
  created_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lo_maker ON limit_orders(maker);
`);
// `filled` (slices done) + `attempts` (keeper static-call reverts) are added defensively so an older
// db upgrades cleanly. `attempts` is how we sink never-fillable junk below fresh orders (see openOrders).
{
  const cols = db.prepare("PRAGMA table_info(limit_orders)").all().map((c) => c.name);
  if (!cols.includes("filled")) db.exec("ALTER TABLE limit_orders ADD COLUMN filled INTEGER DEFAULT 0");
  if (!cols.includes("attempts")) db.exec("ALTER TABLE limit_orders ADD COLUMN attempts INTEGER DEFAULT 0");
}

const MAX_OPEN_PER_MAKER = Number(process.env.MAX_OPEN_ORDERS_PER_MAKER || 25);
const MAX_OPEN_GLOBAL = Number(process.env.MAX_OPEN_ORDERS_GLOBAL || 20000); // backstop against a Sybil flood

// INSERT OR REPLACE would DELETE+reinsert on a hash (PK) conflict, resetting `filled`/`attempts` back
// to their defaults (and clearing `cancelled`), so a re-POST of the same order would wipe the keeper's
// fill progress and resurrect a cancelled order. The order is immutable (the hash is deterministic over
// its fields), so a re-post must be a no-op that keeps the existing row and its progress.
const insertStmt = db.prepare(`INSERT INTO limit_orders
  (hash, maker, sell_token, buy_token, order_json, signature, expiry, slices, cancelled, created_ts)
  VALUES (@hash, @maker, @sell_token, @buy_token, @order_json, @signature, @expiry, @slices, 0, @created_ts)
  ON CONFLICT(hash) DO NOTHING`);
const byMakerStmt = db.prepare(`SELECT * FROM limit_orders WHERE maker = ? ORDER BY created_ts DESC LIMIT 200`);
// Open = not cancelled, not expired, and not fully filled (filled < slices). Ordered by `attempts`
// FIRST so orders that keep reverting when the keeper probes them (never-fillable junk / Sybil flood)
// sink below fresh orders — a legitimate new order (attempts 0) always outranks probed junk, so it
// can't be starved out of the window. created_ts breaks ties.
const openStmt = db.prepare(`SELECT * FROM limit_orders WHERE cancelled = 0 AND expiry > ? AND filled < slices ORDER BY attempts ASC, created_ts ASC LIMIT 2000`);
const openCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM limit_orders WHERE maker = ? AND cancelled = 0 AND expiry > ? AND filled < slices`);
const globalOpenStmt = db.prepare(`SELECT COUNT(*) AS n FROM limit_orders WHERE cancelled = 0 AND expiry > ? AND filled < slices`);
const cancelStmt = db.prepare(`UPDATE limit_orders SET cancelled = 1 WHERE hash = ? AND maker = ?`);
const cancelAnyStmt = db.prepare(`UPDATE limit_orders SET cancelled = 1 WHERE hash = ?`);
const setFilledStmt = db.prepare(`UPDATE limit_orders SET filled = @filled WHERE hash = @hash`);
const bumpAttemptsStmt = db.prepare(`UPDATE limit_orders SET attempts = attempts + 1 WHERE hash = ?`);
const pruneExpiredStmt = db.prepare(`DELETE FROM limit_orders WHERE expiry < ?`); // reclaim long-dead rows

export const enabled = () => /^0x[0-9a-f]{40}$/.test(CFG.robinLimit);

// Is this order hash in our store (and still open)? Gates the cancel path so a random hash never
// costs an on-chain call.
const existsStmt = db.prepare("SELECT 1 FROM limit_orders WHERE hash = ? AND cancelled = 0");
export const orderExists = (hash) => !!existsStmt.get(hash);

function domain() {
  return { name: "RobinLimit", version: "1", chainId: CFG.chainId, verifyingContract: ethers.getAddress(CFG.robinLimit) };
}
const TYPES = { Order: [
  { name: "maker", type: "address" }, { name: "sellToken", type: "address" }, { name: "buyToken", type: "address" },
  { name: "sliceIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "slices", type: "uint256" },
  { name: "interval", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "salt", type: "uint256" },
] };

const FIELDS = ["maker", "sellToken", "buyToken", "sliceIn", "minOut", "slices", "interval", "expiry", "salt"];
const isAddr = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const isUint = (x) => { try { return typeof x === "string" && /^[0-9]{1,78}$/.test(x) && BigInt(x) >= 0n; } catch { return false; } };

// Validate the raw order shape (all values are decimal strings, addresses are hex). Returns a
// normalized order object or throws. Does NOT check the signature (that's verifyAndHash).
function normalize(o) {
  if (!o || typeof o !== "object") throw new Error("bad order");
  for (const f of FIELDS) if (!(f in o)) throw new Error("missing " + f);
  if (!isAddr(o.maker) || !isAddr(o.sellToken) || !isAddr(o.buyToken)) throw new Error("bad address");
  for (const f of ["sliceIn", "minOut", "slices", "interval", "expiry", "salt"]) if (!isUint(String(o[f]))) throw new Error("bad " + f);
  if (BigInt(o.sliceIn) === 0n) throw new Error("zero amount");
  if (BigInt(o.slices) === 0n) throw new Error("zero slices");
  // A zero minOut = no price floor = an unprotected, sandwichable slice. Reject it here as well as
  // on-chain, so such an order can never even be stored.
  if (BigInt(o.minOut) === 0n) throw new Error("minOut must be > 0");
  // exactly one leg must be WETH (an ETH-quoted venue), mirroring the contract
  const w = CFG.weth, s = o.sellToken.toLowerCase(), b = o.buyToken.toLowerCase();
  if (!((s === w) !== (b === w))) throw new Error("one leg must be WETH");
  const out = {};
  for (const f of FIELDS) out[f] = f === "maker" || f === "sellToken" || f === "buyToken" ? ethers.getAddress(o[f]) : String(o[f]);
  return out;
}

// Verify the maker's signature and return the canonical { order, hash }. Throws on any mismatch.
export function verifyAndHash(rawOrder, signature) {
  if (!enabled()) throw new Error("orders not enabled");
  const order = normalize(rawOrder);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("bad signature");
  let recovered;
  try { recovered = ethers.verifyTypedData(domain(), TYPES, order, signature); }
  catch { throw new Error("signature check failed"); }
  if (recovered.toLowerCase() !== order.maker.toLowerCase()) throw new Error("signature does not match maker");
  const hash = ethers.TypedDataEncoder.hash(domain(), TYPES, order);
  return { order, hash };
}

export function saveOrder(rawOrder, signature, nowSec) {
  const { order, hash } = verifyAndHash(rawOrder, signature);
  if (Number(order.expiry) <= nowSec) throw new Error("already expired");
  // Cap open orders per maker so a self-signing spammer can't grow the table (and the keeper's
  // working set) without bound. Re-saving an existing order (same hash) is fine — it REPLACEs.
  const existing = db.prepare("SELECT 1 FROM limit_orders WHERE hash = ?").get(hash);
  if (!existing) {
    if (openCountStmt.get(order.maker.toLowerCase(), nowSec).n >= MAX_OPEN_PER_MAKER) {
      throw new Error(`too many open orders (max ${MAX_OPEN_PER_MAKER}); cancel some first`);
    }
    if (globalOpenStmt.get(nowSec).n >= MAX_OPEN_GLOBAL) throw new Error("order book is full, try again later");
  }
  insertStmt.run({
    hash, maker: order.maker.toLowerCase(), sell_token: order.sellToken.toLowerCase(), buy_token: order.buyToken.toLowerCase(),
    order_json: JSON.stringify(order), signature, expiry: Number(order.expiry), slices: Number(order.slices), created_ts: nowSec,
  });
  return { hash, order };
}

// A maker's open orders (not cancelled, not expired, not fully filled) shaped for the portfolio UI,
// including how many slices the keeper has filled so far so the panel shows real progress.
export function ordersForMaker(maker, nowSec) {
  return byMakerStmt.all(maker.toLowerCase())
    .filter((r) => !r.cancelled && r.expiry > nowSec && (r.filled || 0) < r.slices)
    .map((r) => ({ hash: r.hash, order: JSON.parse(r.order_json), filled: r.filled || 0, createdTs: r.created_ts }));
}

// All open orders (for the keeper). Also opportunistically reclaims long-expired rows.
export function openOrders(nowSec) {
  try { pruneExpiredStmt.run(nowSec); } catch { /* best-effort */ }
  return openStmt.all(nowSec).map((r) => ({ hash: r.hash, order: JSON.parse(r.order_json), signature: r.signature }));
}

// The keeper records how many slices it has filled, so the order retires from the open set once
// complete and the portfolio can show N/M.
export function setFilled(hash, filled) {
  try { setFilledStmt.run({ hash, filled }); } catch { /* best-effort */ }
}

// The keeper calls this when an order static-call-reverts (not fillable now), so chronic
// never-fillable orders accrue attempts and sink below fresh orders in openOrders().
export function bumpAttempts(hash) {
  try { bumpAttemptsStmt.run(hash); } catch { /* best-effort */ }
}

// Mark cancelled. If `maker` is given, only the maker can cancel their own; else unconditional
// (used when the keeper/indexer observes an on-chain Cancelled event).
export function cancelOrder(hash, maker) {
  if (maker) return cancelStmt.run(hash, maker.toLowerCase()).changes > 0;
  return cancelAnyStmt.run(hash).changes > 0;
}

// Read the contract's public `cancelled(hash)` so the /api/orders/cancel endpoint only ever hides
// an order the maker ACTUALLY cancelled on-chain — the contract stays the source of truth, and no
// unauthenticated caller can hide someone else's live order from their portfolio.
let _prov = null;
const LIMIT_ABI = ["function cancelled(bytes32) view returns (bool)"];
export async function verifyCancelledOnChain(hash) {
  if (!enabled()) return false;
  try {
    if (!_prov) _prov = new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
    const c = new ethers.Contract(ethers.getAddress(CFG.robinLimit), LIMIT_ABI, _prov);
    return !!(await c.cancelled(hash));
  } catch { return false; }
}
