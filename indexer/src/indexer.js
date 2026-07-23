// The indexer: a reorg-safe log poller. Each tick it scans a block window in
// CHUNK-sized getLogs calls, decodes our four events, and writes them. It only
// advances the cursor to (head - CONFIRMATIONS) and re-scans the last window each
// tick, so a tip reorg is corrected on the next pass. All writes are idempotent.
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { iface, TOPICS, ERC20, CURVE, POOL } from "./abi.js";
import {
  db, getCursor, setCursor, setHeadTs, upsertCoin, markGraduated, ungraduateFrom, insertTrade,
  coinByCurve, purgeTradesFrom, setGeometry,
  setSnapshot, coinGeom, insertAccrual, purgeAccrualsFrom,
} from "./db.js";

const WETH = (process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73").toLowerCase();
const TOTAL_SUPPLY = 1_000_000_000; // 1B whole tokens — mcap = wethPerToken * supply

// WETH-per-token from a Uniswap sqrtPriceX96, given which side is token0.
function priceFromSqrt(sqrtX96, token0) {
  const Q96 = 2n ** 96n;
  const sqrt = BigInt(sqrtX96);
  const p1per0 = Number((sqrt * sqrt * 10n ** 18n) / (Q96 * Q96)) / 1e18; // token1 per token0
  // If our token IS token0, price(token1=WETH per token0) is WETH-per-token.
  return token0 === WETH ? (p1per0 > 0 ? 1 / p1per0 : 0) : p1per0;
}

// Progress along [startTick → ceiling], clamped 0..1 (mirrors the frontend).
function frac(tick, startTick, gradTick) {
  const span = Math.abs(gradTick - startTick) || 1;
  return Math.max(0, Math.min(1, Math.abs(tick - startTick) / span));
}

const provider = new ethers.JsonRpcProvider(CFG.rpcUrl, undefined, { staticNetwork: true });
const tsCache = new Map(); // block -> unix ts, so we don't re-fetch a block repeatedly

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Public RPCs rate-limit and occasionally 500 under load. Retry with backoff so
// a transient hiccup doesn't abort a scan. Kept small — the loop retries anyway.
async function withRetry(fn, label, tries = 5) {
  let wait = 500;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries) throw e;
      console.warn(`[indexer] ${label} retry ${i}/${tries - 1}: ${e.shortMessage || e.message || e}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
}

async function blockTs(bn) {
  if (tsCache.has(bn)) return tsCache.get(bn);
  const b = await withRetry(() => provider.getBlock(bn), `getBlock.${bn}`);
  const ts = b ? Number(b.timestamp) : Math.floor(Date.now() / 1000);
  tsCache.set(bn, ts);
  if (tsCache.size > 5000) tsCache.delete(tsCache.keys().next().value);
  return ts;
}

async function nameSymbol(token) {
  try {
    const c = new ethers.Contract(token, ERC20, provider);
    const name = await withRetry(() => c.name(), "erc20.name", 3);
    const symbol = await withRetry(() => c.symbol(), "erc20.symbol", 3);
    return { name, symbol };
  } catch {
    return { name: null, symbol: null };
  }
}

// Pull every relevant log in [from,to]. Robinhood Chain's Blockscout RPC rejects
// an address-array filter ("invalid address"), so we query per contract: the
// factory (Launched), the router (Bought/Sold), and Graduated by topic0 across
// any curve (matched back to its coin by log.address).
async function getLogsRange(from, to) {
  // Sequential (not parallel) — Blockscout 500s if you fan out too many getLogs
  // at once. Each call is retried independently.
  const launched = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, address: CFG.factory, topics: [TOPICS.Launched] }), "getLogs.launched");
  const trades = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, address: CFG.router, topics: [[TOPICS.Bought, TOPICS.Sold]] }), "getLogs.trades");
  // Graduated is curve-emitted with no indexed token, so we query by topic0 across
  // any address and match back by log.address.
  const grads = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, topics: [TOPICS.Graduated] }), "getLogs.grads");
  // RewardVault Accrued (0.25% legs) — only when a vault is configured.
  const accruals = CFG.rewardVault
    ? await withRetry(() =>
        provider.getLogs({ fromBlock: from, toBlock: to, address: CFG.rewardVault, topics: [TOPICS.Accrued] }), "getLogs.accruals")
    : [];
  // Merge + order by (block, logIndex) for deterministic application.
  return [...launched, ...trades, ...grads, ...accruals].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.index - b.index);
}

// Decode one log and gather EVERYTHING it needs from the chain (block ts, token
// name/symbol, curve geometry, initial snapshot) — all network I/O, done OUTSIDE any db
// transaction. Returns a list of pure-synchronous db write closures for the caller to run
// inside the atomic commit, plus (for trades) the pool it touched so we snapshot it once
// per window. `geom` and `curves` are in-window overlays so a coin launched earlier in the
// SAME pass is visible to a later trade/graduation before the pass has been committed.
async function prepareLog(log, geom, curves) {
  let parsed;
  try { parsed = iface.parseLog(log); } catch { return null; }
  if (!parsed) return null;
  const ts = await blockTs(log.blockNumber);
  const a = parsed.args;
  const writes = [];

  if (parsed.name === "Launched") {
    const token = a.token.toLowerCase();
    const curve = a.curve.toLowerCase();
    const pool = a.pool.toLowerCase();
    const { name, symbol } = await nameSymbol(token);
    const coinRow = {
      token, curve, pool, dev: a.dev.toLowerCase(), name, symbol,
      launch_block: log.blockNumber, launch_ts: ts, launch_tx: log.transactionHash,
      dev_bought: a.devBought.toString(),
    };
    writes.push(() => upsertCoin.run(coinRow));
    curves.set(curve, token);
    // Read the curve geometry once (start + ceiling never change) + an initial snapshot, so
    // the coin shows correct progress the moment it lands. Remember the geometry in-window
    // so a same-pass trade can snapshot before the launch row is committed.
    const gv = await readGeometryValues(curve, pool);
    if (gv) {
      const g = { token, pool, ...gv };
      geom.set(token, g);
      writes.push(() => setGeometry.run({
        token, start_tick: gv.start_tick, min_grad_tick: gv.min_grad_tick,
        grad_tick: gv.grad_tick, grad_target: gv.grad_target, token0: gv.token0,
      }));
      const snap = await readSnapshotValues(g);
      if (snap) writes.push(() => setSnapshot.run({ token, ...snap, snap_ts: ts }));
    }
    return { writes };
  }

  if (parsed.name === "Bought" || parsed.name === "Sold") {
    const buy = parsed.name === "Bought";
    const token = a.token.toLowerCase();
    const row = {
      tx: log.transactionHash, log_index: log.index,
      token, side: buy ? "buy" : "sell",
      actor: (buy ? a.buyer : a.seller).toLowerCase(),
      eth: (buy ? a.ethIn : a.ethOut).toString(),
      tokens: (buy ? a.tokensOut : a.tokensIn).toString(),
      fee: a.fee.toString(), block: log.blockNumber, ts,
    };
    writes.push(() => insertTrade.run(row));
    // The pool moved — flag this token so we re-snapshot it once per chunk.
    return { writes, touched: token, ts };
  }

  if (parsed.name === "Accrued") {
    // epoch is an indexed arg (= block.timestamp / EPOCH on-chain) — authoritative, no recompute.
    const row = {
      tx: log.transactionHash, log_index: log.index,
      coin: a.coin.toLowerCase(), epoch: Number(a.epoch), side: Number(a.side),
      amount: a.amount.toString(), block: log.blockNumber, ts,
    };
    writes.push(() => insertAccrual.run(row));
    return { writes };
  }

  if (parsed.name === "Graduated") {
    // Emitted by the curve; log.address is the curve. Only act if we know it — either
    // already indexed, or launched earlier in THIS same (not-yet-committed) pass.
    const curve = log.address.toLowerCase();
    if (!curves.has(curve) && !coinByCurve.get(curve)) return null;
    const row = {
      curve, grad_block: log.blockNumber, grad_ts: ts,
      raised_weth: a.raisedWeth.toString(), bond: a.bond.toLowerCase(),
    };
    writes.push(() => markGraduated.run(row));
    return { writes };
  }
  return null;
}

// Read the curve's fixed geometry (ticks) + token0 orientation. Pure network read —
// returns the values (or null on failure); the caller emits the db write into the commit.
async function readGeometryValues(curve, pool) {
  try {
    const c = new ethers.Contract(curve, CURVE, provider);
    const p = new ethers.Contract(pool, POOL, provider);
    const [startTick, minGradTick, gradTick, gradTarget, token0] = await Promise.all([
      withRetry(() => c.startTick(), "curve.startTick", 3),
      withRetry(() => c.minGradTick(), "curve.minGradTick", 3),
      withRetry(() => c.gradTick(), "curve.gradTick", 3),
      withRetry(() => c.gradTarget(), "curve.gradTarget", 3),
      withRetry(() => p.token0(), "pool.token0", 3),
    ]);
    return {
      start_tick: Number(startTick), min_grad_tick: Number(minGradTick),
      grad_tick: Number(gradTick), grad_target: Number(gradTarget), token0: token0.toLowerCase(),
    };
  } catch (e) {
    console.warn(`[indexer] geometry read failed for ${curve}: ${e.shortMessage || e.message}`);
    return null;
  }
}

// Read one coin's live snapshot (progress + mcap) from its pool tick. Pure network read —
// `g` is its geometry ({ pool, token0, start_tick, grad_tick }, from the in-window overlay
// or the db). Returns the snapshot values (or null); the caller emits the db write.
async function readSnapshotValues(g) {
  if (!g || !g.pool || g.start_tick === null || g.start_tick === undefined || g.token0 === null || g.token0 === undefined) return null;
  try {
    const p = new ethers.Contract(g.pool, POOL, provider);
    const slot0 = await withRetry(() => p.slot0(), "pool.slot0", 3);
    const tick = Number(slot0.tick);
    const wethPerToken = priceFromSqrt(slot0.sqrtPriceX96, g.token0);
    return {
      last_tick: tick,
      progress: frac(tick, g.start_tick, g.grad_tick),
      mcap_eth: wethPerToken * TOTAL_SUPPLY,
    };
  } catch (e) {
    console.warn(`[indexer] snapshot failed for ${g.token || g.pool}: ${e.shortMessage || e.message}`);
    return null;
  }
}

let head = 0;
export const getHead = () => head;

// One scan pass. Returns the number of logs applied.
export async function tick() {
  head = await provider.getBlockNumber();
  const safeHead = head - CFG.confirmations;
  if (safeHead < CFG.startBlock) return 0;

  const stored = getCursor();
  // Start at the stored cursor minus a reorg window (re-scan the tip); first run
  // starts at the configured deploy block.
  const reorgWindow = Math.max(CFG.confirmations * 4, 12);
  let from = stored === null ? CFG.startBlock : Math.max(CFG.startBlock, stored - reorgWindow + 1);
  if (from > safeHead) return 0;

  // In-window overlays so a coin launched earlier in THIS pass is visible (for graduation
  // matching + snapshots) before the pass has been committed.
  const geom = new Map();   // token -> geometry read this pass
  const curves = new Map(); // curve -> token, for coins launched this pass

  let applied = 0;
  let reached = from - 1;   // highest block whose window is committed
  let firstChunk = true;
  for (let lo = from; lo <= safeHead; lo += CFG.chunk) {
    const hi = Math.min(lo + CFG.chunk - 1, safeHead);

    // ── network phase — ALL RPC I/O, outside any transaction ──────────────────────────
    // Fetch the window's logs and enrich each (block ts, name/symbol, geometry, pool tick),
    // building a list of pure-synchronous db write closures. Nothing is written yet.
    const logs = await getLogsRange(lo, hi);
    const writes = [];
    const touched = new Map(); // token -> latest ts, deduped so a busy pool is read once
    for (const log of logs) {
      const p = await prepareLog(log, geom, curves);
      if (!p) continue;
      for (const w of p.writes) writes.push(w);
      if (p.touched) touched.set(p.touched, p.ts);
    }
    // One snapshot per pool that traded this chunk — bounds RPC to ACTIVITY, not coin
    // count. A pool with 500 trades is still one slot0 read. Read now; write in the commit.
    for (const [token, ts] of touched) {
      const snap = await readSnapshotValues(geom.get(token) || coinGeom.get(token));
      if (snap) writes.push(() => setSnapshot.run({ token, ...snap, snap_ts: ts }));
    }

    // ── commit phase — ONE atomic transaction ────────────────────────────────────────
    // Purge the re-scanned reorg window (first chunk only — the window [from, stored] is
    // ≤ reorgWindow blocks, so it lies entirely within this first chunk) and re-insert its
    // rows in the SAME transaction, so a reader never observes the window emptied. Later
    // chunks are all NEW blocks (> stored) that no reader had, so they need no purge. The
    // transaction body is pure synchronous better-sqlite3 — all network I/O happened above.
    const doPurge = firstChunk && stored !== null;
    db.transaction(() => {
      if (doPurge) { purgeTradesFrom.run(from); purgeAccrualsFrom.run(from); ungraduateFrom.run(from); }
      for (const w of writes) w();
      setCursor(hi);
    })();
    firstChunk = false;
    reached = hi;
    applied += logs.length;
  }

  // Advance the reward-poster completeness gate ONLY to the block the cursor actually
  // reached, and only AFTER the loop has committed it — head_ts must never run ahead of the
  // indexed cursor, or the poster could post a root over an incomplete accrual set. Lagging
  // is safe (the poster just waits); running ahead is the bug. Best-effort, outside any tx.
  if (reached >= from) { try { setHeadTs(await blockTs(reached)); } catch {} }
  return applied;
}

export async function runLoop() {
  const startFrom = getCursor();
  console.log(`[indexer] rpc=${CFG.rpcUrl}`);
  console.log(`[indexer] factory=${CFG.factory} router=${CFG.router}`);
  console.log(`[indexer] cursor=${startFrom ?? `(fresh, from block ${CFG.startBlock})`}`);
  for (;;) {
    try {
      const n = await tick();
      if (n) console.log(`[indexer] cursor=${getCursor()} head=${head} (+${n} logs)`);
    } catch (e) {
      console.error(`[indexer] tick error: ${e.message || e}`);
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs));
  }
}
