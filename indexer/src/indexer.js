// The indexer: a reorg-safe log poller. Each tick it scans a block window in
// CHUNK-sized getLogs calls, decodes our four events, and writes them. It only
// advances the cursor to (head - CONFIRMATIONS) and re-scans the last window each
// tick, so a tip reorg is corrected on the next pass. All writes are idempotent.
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { iface, TOPICS, ERC20, CURVE, POOL } from "./abi.js";
import { mc3 } from "./multicall.js";
import {
  db, getCursor, setCursor, setHeadTs, upsertCoin, markGraduated, ungraduateFrom, insertTrade,
  coinByCurve, purgeTradesFrom, setGeometry,
  setSnapshot, coinGeom, insertAccrual, purgeAccrualsFrom, insertDevLock, purgeDevLocksFrom,
  liveCoinsAll, coinsGraduatedSince, coinsGraduatedInRewardWindow, coinsMissingGeometry, purgeTradesScoped,
  tradeCountForToken, getMeta, setMeta,
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

// A live curve tick MUST sit inside the curve's band: buys walk the tick from startTick down to the
// graduation ceiling (gradTick), and a non-graduated pool can't legitimately be outside that range.
// A read far beyond either end (a hiccupped slot0, or a flash micro-swap that momentarily prints an
// extreme spot like Uniswap's MIN/MAX tick ±887272) is NOT real curve state. Persisting it would clamp
// progress to 100% — falsely flashing "ready to graduate" — and blow mcap up to a garbage number. We
// allow one full curve span of slack on each side (rounding / near-ceiling overshoot) and reject the rest.
function tickInBand(tick, startTick, gradTick) {
  if (!Number.isFinite(tick)) return false;
  const lo = Math.min(startTick, gradTick), hi = Math.max(startTick, gradTick);
  const span = (hi - lo) || 1;
  return tick >= lo - span && tick <= hi + span;
}

// Reads go through CFG.readOrder: FREE endpoints first, the paid RPC as the backstop, Blockscout last. Ordering
// is the whole cost story here — the paid endpoint should be answering the calls a free one could not, not
// every call.
//
// This used to bail out to a single paid provider whenever RPC_BACKUP was unset, which is the default. Keeping
// that guard would have made the free-first ordering a silent no-op on exactly the configuration it was written
// for. The only thing that can short-circuit now is genuinely having one endpoint.
function makeProvider() {
  if (CFG.readOrder.length <= 1) {
    return new ethers.JsonRpcProvider(CFG.readOrder[0] || CFG.rpcUrl, undefined, { staticNetwork: true });
  }
  try {
    const net = { chainId: CFG.chainId, name: "robinhood" };
    // CFG.readOrder is free endpoints first, then the paid RPC, then Blockscout. With quorum 1 the
    // FallbackProvider asks the lowest priority number first and only escalates when that one errors or
    // stalls — so the paid endpoint is touched when a free one fails, not on every call.
    //
    // stallTimeout is what makes "free first" pay rather than just hurt: a free endpoint that has started
    // rate-limiting usually goes SLOW before it goes wrong, and without a stall bound every read would sit
    // there waiting instead of escalating. Two seconds is long enough for an honest answer and short enough
    // that a throttled endpoint doesn't hold up a pass.
    const cfgs = CFG.readOrder.map((url, i) => ({
      provider: new ethers.JsonRpcProvider(url, net, { staticNetwork: true }),
      priority: i + 1, weight: 1, stallTimeout: 2000,
    }));
    if (cfgs.length === 1) return cfgs[0].provider;
    return new ethers.FallbackProvider(cfgs, net, { quorum: 1 });
  } catch { return new ethers.JsonRpcProvider(CFG.rpcUrl, undefined, { staticNetwork: true }); }
}
const provider = makeProvider();

// eth_getLogs is ~90% of this indexer's RPC compute, so this is the call whose routing decides the bill.
// LOGS_RPC pins log polling to ONE specific endpoint (a self-hosted node, say) instead of the ordered list.
//
// Leaving it empty is now the good default rather than the lazy one: log polling inherits the free-first
// FallbackProvider above, so it already prefers the free endpoints and only reaches the paid one when a free
// one stalls or errors. Setting LOGS_RPC OPTS OUT of that ordering for logs — which is right for a node you
// run and wrong for anything metered.
//
// Do NOT point this at the public Blockscout endpoint: it rate-limits the per-pool getLogs burst, so every
// pass would 429 through it and fall through anyway — all of the latency, none of the saving. It sits last in
// CFG.readOrder for exactly that reason.
const LOGS_RPC = (process.env.LOGS_RPC || "").trim();
const logsProvider = (LOGS_RPC && LOGS_RPC !== CFG.rpcUrl)
  ? new ethers.JsonRpcProvider(LOGS_RPC, undefined, { staticNetwork: true })
  : provider;
const tsCache = new Map(); // block -> unix ts, so we don't re-fetch a block repeatedly

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── sequencer feed (optional, OFF by default) ────────────────────────────────
// `eth_getLogs` is ~90% of this indexer's RPC compute, and the reason is the timer: one getLogs PER POOL every
// POLL_MS, whether or not anything happened. On a quiet pad almost every one of those comes back empty and is
// paid for anyway.
//
// The sequencer relay fixes the guessing. It is not an RPC — it carries no logs and cannot replace one — but it
// broadcasts every transaction as the sequencer accepts it, so it can answer "did anything touch us?" for free.
// When it is healthy the timer stretches to FEED_IDLE_MS and a real transaction is what wakes the loop; when it
// is not, everything falls straight back to POLL_MS and behaves exactly as it did before.
//
// Set FEED_URL to switch it on, e.g. wss://feed.mainnet.chain.robinhood.com/feed. Unset = unchanged behaviour.
// Costs about 64 GB/day of INBOUND bandwidth — free on most hosts, but check yours before enabling.
const FEED_URL = (process.env.FEED_URL || "").trim();
// The safety net, and it must stay finite: the feed matches addresses by their raw bytes, so an address a
// contract computes rather than receives would never appear and would be missed entirely. This timer is what
// makes the indexer correct; the feed only makes it cheap.
const FEED_IDLE_MS = Number(process.env.FEED_IDLE_MS || 120000);

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

// getLogs against the free logs RPC first; if it fails after retries, fall back to
// the paid RPC ONCE so a Blockscout hiccup can never stall the indexer.
async function getLogs(filter, label) {
  try { return await withRetry(() => logsProvider.getLogs(filter), label); }
  catch (e) {
    if (logsProvider === provider) throw e;
    console.warn(`[indexer] ${label} free logs-RPC failed, falling back to paid RPC: ${e.shortMessage || e.message || e}`);
    return await withRetry(() => provider.getLogs(filter), `${label}.fallback`);
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
// factory (Launched) and Graduated by topic0 across any curve (matched back to its
// coin by log.address). Trades come from the pools' own Swap events, scanned
// separately in getPoolSwaps (bots/DexScreener bypass our router).
async function getLogsRange(from, to) {
  // Sequential (not parallel) — Blockscout 500s if you fan out too many getLogs
  // at once. Each call is retried independently.
  // BOTH factories in one union filter. Watching only the primary meant a coin launched on the other
  // never produced a row and simply did not exist to the site.
  const _factories = (CFG.factories && CFG.factories.length ? CFG.factories : [CFG.factory]).filter(Boolean);
  const launched = await getLogs({ fromBlock: from, toBlock: to, address: _factories, topics: [TOPICS.Launched] }, "getLogs.launched");
  // Graduated is curve-emitted with no indexed token, so we query by topic0 across
  // any address and match back by log.address.
  const grads = await getLogs({ fromBlock: from, toBlock: to, topics: [TOPICS.Graduated] }, "getLogs.grads");
  // RewardVault Accrued (0.25% legs) — only when a vault is configured.
  const accruals = CFG.rewardVault
    ? await getLogs({ fromBlock: from, toBlock: to, address: CFG.rewardVault, topics: [TOPICS.Accrued] }, "getLogs.accruals")
    : [];
  // TokenVestingLock ScheduleCreated (dev-bag locks) — only when the locker is configured.
  const vestings = CFG.tokenVestingLock
    ? await getLogs({ fromBlock: from, toBlock: to, address: CFG.tokenVestingLock, topics: [TOPICS.ScheduleCreated] }, "getLogs.vestings")
    : [];
  // Merge + order by (block, logIndex) for deterministic application.
  return [...launched, ...grads, ...accruals, ...vestings].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.index - b.index);
}

// Side-channel: map (tx, token, side) -> the REAL trader, from the router's own
// Bought/Sold events.
//
// Why this exists: a pad sell routes tokens INTO the router (`sell()` swaps into
// address(this) before unwrapping WETH->ETH back to the seller), so the pool Swap's
// `recipient` is the ROUTER, not the seller. The router is an excluded address, so scoring
// sells purely off the Swap `recipient` drops EVERY pad sell from reward weights (buys keep
// msg.sender as recipient, so only sells are affected). The router's Sold(token, seller, …)
// event carries the true seller; we index it ONLY to correct the actor. We deliberately do
// NOT insert trades from these events — the pool Swap stays the single trade feed so direct
// DEX/bot/aggregator volume is still captured exactly once (see abi.js).
async function routerActorMap(from, to) {
  const map = new Map();
  const routers = (CFG.routers && CFG.routers.length ? CFG.routers : [CFG.router]).filter(Boolean);
  if (!routers.length) return map;
  // Both live routers in ONE getLogs -- an address array is a union filter, so this stays a single
  // request per pass rather than one per router.
  const logs = await getLogs(
    { fromBlock: from, toBlock: to, address: routers, topics: [[TOPICS.Bought, TOPICS.Sold]] },
    "getLogs.routerTrades");
  for (const log of logs) {
    let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
    if (!parsed || (parsed.name !== "Bought" && parsed.name !== "Sold")) continue;
    const buy = parsed.name === "Bought";
    const token = parsed.args.token.toLowerCase();
    const actor = (buy ? parsed.args.buyer : parsed.args.seller).toLowerCase();
    map.set(`${log.transactionHash}:${token}:${buy ? "buy" : "sell"}`, actor);
  }
  return map;
}

// Correct a decoded pool-Swap trade whose recipient is the router (every pad sell, plus
// internal buybacks) to the real EOA from the router-event side-channel. Falls back to the
// router (an excluded address) when there's no matching router event — e.g. the platform
// buyback, which must NOT score as a user trade. Exported for regression testing.
export function correctRouterActor(row, routerActor) {
  if (!row) return row;
  // Membership, not equality: a v2-launched coin's pad trades arrive with the V2 router as recipient, and
  // comparing against one hardcoded router left those credited to the router's own address.
  const routers = (CFG.routers && CFG.routers.length ? CFG.routers : [CFG.router]).filter(Boolean);
  if (routers.includes(row.actor)) {
    const real = routerActor.get(`${row.tx}:${String(row.token).toLowerCase()}:${row.side}`);
    if (real) return { ...row, actor: real };
  }
  return row;
}

// Scan the Uniswap Swap events for a set of pools over [from,to]. One getLogs per
// pool (Robinhood's RPC rejects address arrays; a topic0-only scan would pull every
// unrelated pool on the chain). Sequential to avoid Blockscout 500s under fan-out.
async function getPoolSwaps(pools, from, to) {
  const out = [];
  for (const p of pools) {
    const logs = await getLogs({ fromBlock: from, toBlock: to, address: p.pool, topics: [TOPICS.Swap] },
      `getLogs.swap.${p.pool.slice(0, 10)}`);
    for (const l of logs) out.push(l);
  }
  return out;
}

// Turn one pool Swap into a trade row. `coin` = { token, token0 } (both lowercased).
// Amounts are signed from the POOL's view: a negative delta means the pool PAID OUT.
// So a negative token delta = tokens left the pool = a BUY; positive = a SELL.
function decodeSwap(log, coin) {
  let parsed;
  try { parsed = iface.parseLog(log); } catch { return null; }
  if (!parsed || parsed.name !== "Swap") return null;
  const a = parsed.args;
  const tokenIsToken0 = coin.token0 === coin.token;
  const tokenDelta = tokenIsToken0 ? a.amount0 : a.amount1;
  const wethDelta = tokenIsToken0 ? a.amount1 : a.amount0;
  const buy = tokenDelta < 0n; // pool sent our token out -> someone bought
  const eth = buy ? wethDelta : -wethDelta;      // buy: WETH in (+); sell: WETH out (+)
  const tokens = buy ? -tokenDelta : tokenDelta; // absolute token amount moved
  return {
    tx: log.transactionHash, log_index: log.index,
    token: coin.token, side: buy ? "buy" : "sell",
    // The swap recipient — the best cheap proxy for the trader without a per-swap
    // getTransaction (often an aggregator/router). Client refines with live balanceOf.
    actor: a.recipient.toLowerCase(),
    eth: (eth < 0n ? -eth : eth).toString(),
    tokens: (tokens < 0n ? -tokens : tokens).toString(),
    fee: "0", block: log.blockNumber,
  };
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
      // Surface the pool so this pass's swap scan (incl. the atomic dev-buy Swap in
      // this very block) picks it up immediately, not a pass later.
      return { writes, newPool: { pool, token, token0: gv.token0 } };
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

  if (parsed.name === "ScheduleCreated") {
    // TokenVestingLock dev-bag lock. Schedule fields are immutable; PK on id makes inserts idempotent.
    const row = {
      id: Number(a.id), token: a.token.toLowerCase(), beneficiary: a.beneficiary.toLowerCase(),
      total: a.total.toString(), start: Number(a.start), cliff: Number(a.cliff),
      duration: Number(a.duration), block: log.blockNumber, ts,
    };
    writes.push(() => insertDevLock.run(row));
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
    if (!tickInBand(tick, g.start_tick, g.grad_tick)) {
      // Out-of-band spot: discard, keep the last good snapshot rather than serving a fake 100%/garbage-mcap.
      console.warn(`[indexer] discarding out-of-band tick ${tick} for ${g.token || g.pool} (band ${g.grad_tick}..${g.start_tick})`);
      return null;
    }
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

const POOL_IFACE = new ethers.Interface(POOL);
// Batch slot0 for MANY pools into ONE eth_call, returning token -> snapshot values. Preserves the
// exact per-token math of readSnapshotValues. On a whole-batch failure it falls back to per-pool
// reads, so it can only ever reduce RPC calls; per-pool failures are skipped (as the single path does).
async function readSnapshotsBatch(entries) {
  const out = new Map();
  const valid = entries.filter((e) =>
    e.g && e.g.pool && e.g.start_tick !== null && e.g.start_tick !== undefined && e.g.token0 !== null && e.g.token0 !== undefined);
  if (!valid.length) return out;
  let res;
  try {
    res = await withRetry(
      () => mc3(provider, valid.map((e) => ({ target: e.g.pool, iface: POOL_IFACE, fn: "slot0", args: [] }))),
      "multicall.slot0", 3);
  } catch (e) {
    console.warn(`[indexer] batch snapshot failed, per-pool fallback: ${e.shortMessage || e.message}`);
    for (const e2 of valid) { const s = await readSnapshotValues(e2.g); if (s) out.set(e2.token, s); }
    return out;
  }
  valid.forEach((e, i) => {
    const r = res[i];
    if (!r) return;                 // per-pool failure: skip (matches the single-read try/catch)
    try {
      const tick = Number(r.tick);
      if (!tickInBand(tick, e.g.start_tick, e.g.grad_tick)) {  // out-of-band spot: skip, keep last good snapshot
        console.warn(`[indexer] discarding out-of-band tick ${tick} for ${e.token} (band ${e.g.grad_tick}..${e.g.start_tick})`);
        return;
      }
      const wethPerToken = priceFromSqrt(r.sqrtPriceX96, e.g.token0);
      out.set(e.token, { last_tick: tick, progress: frac(tick, e.g.start_tick, e.g.grad_tick), mcap_eth: wethPerToken * TOTAL_SUPPLY });
    } catch { /* skip malformed decode */ }
  });
  return out;
}

let head = 0;
export const getHead = () => head;

// One scan pass. Returns the number of logs applied.
export async function tick() {
  head = await provider.getBlockNumber();
  // getLogs is served by the (possibly free) logsProvider. NEVER scan past its head: a free
  // node lagging the paid head could return a clamped range WITHOUT erroring (so the getLogs
  // fallback wouldn't fire) and we'd advance the cursor over blocks it never returned → missed
  // trades/accruals. Bounding the head to min(paid, free) means we index slightly behind the free
  // node's tip at worst, never skipping. If the free head read fails, fall back to the paid head
  // (a truly erroring node makes getLogs throw → its own fallback covers it).
  if (logsProvider !== provider) {
    try { head = Math.min(head, await logsProvider.getBlockNumber()); } catch { /* keep paid head */ }
  }
  const safeHead = head - CFG.confirmations;
  if (safeHead < CFG.startBlock) return 0;

  const stored = getCursor();
  // If the safe head has RECEDED below our committed cursor (a transient tip regression, or an RPC
  // briefly returning a lower head), skip this pass. The first-chunk purge below deletes block >= from,
  // but only the [from, safeHead] loop re-inserts; proceeding here would drop committed trades/accruals
  // in the (safeHead, stored] gap that this pass never re-writes. Waiting for the head to recover is safe
  // (the cursor stays put; the next pass re-scans the reorg window normally once safeHead >= stored).
  if (stored !== null && safeHead < stored) return 0;
  // Start at the stored cursor minus a reorg window (re-scan the tip); first run
  // starts at the configured deploy block.
  const reorgWindow = Math.max(CFG.confirmations * 4, 12);
  let from = stored === null ? CFG.startBlock : Math.max(CFG.startBlock, stored - reorgWindow + 1);
  if (from > safeHead) return 0;

  // In-window overlays so a coin launched earlier in THIS pass is visible (for graduation
  // matching + snapshots) before the pass has been committed.
  const geom = new Map();   // token -> geometry read this pass
  const curves = new Map(); // curve -> token, for coins launched this pass
  // Pools whose Swap events we scan this pass: every live coin from the db, plus any
  // launched mid-pass (added below). pool(lc) -> { pool, token, token0 }.
  const poolMap = new Map();
  for (const c of liveCoinsAll.all()) {
    if (c.pool && c.token0) poolMap.set(c.pool.toLowerCase(), { pool: c.pool.toLowerCase(), token: c.token, token0: c.token0 });
  }
  // Also re-scan pools of coins that graduated within this purge window, so the purge (which deletes
  // trades by block, ignoring graduation) can re-insert their final on-curve trades instead of losing them.
  for (const c of coinsGraduatedSince.all({ from })) {
    if (c.pool && c.token0) poolMap.set(c.pool.toLowerCase(), { pool: c.pool.toLowerCase(), token: c.token, token0: c.token0 });
  }
  // And keep scanning a graduated coin's pool until its graduation reward-epoch is safely past finalization
  // (one epoch + the finality delay), so post-graduation DEX sells are indexed before the poster finalizes
  // that epoch's weights. Adding pools can only make the trade history MORE complete, never corrupt it (#39).
  const rewardCutoff = Math.floor(Date.now() / 1000) - (CFG.epochLen + CFG.finalityDelay);
  for (const c of coinsGraduatedInRewardWindow.all({ cutoff: rewardCutoff })) {
    if (c.pool && c.token0) poolMap.set(c.pool.toLowerCase(), { pool: c.pool.toLowerCase(), token: c.token, token0: c.token0 });
  }

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
      if (p.newPool) poolMap.set(p.newPool.pool, p.newPool);
    }
    // The real trade feed: every Swap on every known pool this window (buys/sells that
    // bypass our router included). Decode -> trade rows; flag each pool touched.
    const swapLogs = await getPoolSwaps([...poolMap.values()], lo, hi);
    // The true trader for a router-mediated sell (recipient == router) comes from the
    // router's Sold event, not the pool Swap recipient. Fetch that side-channel once.
    const routerActor = await routerActorMap(lo, hi);
    for (const sl of swapLogs) {
      const coin = poolMap.get(sl.address.toLowerCase());
      if (!coin) continue;
      const row = correctRouterActor(decodeSwap(sl, coin), routerActor);
      if (!row) continue;
      row.ts = await blockTs(sl.blockNumber);
      writes.push(() => insertTrade.run(row));
      touched.set(coin.token, row.ts);
    }
    // One snapshot per pool that traded this chunk — bounds RPC to ACTIVITY, not coin count.
    // All touched pools' slot0 reads are batched into ONE eth_call via Multicall3 (was one
    // slot0 per pool), and the per-token snap_ts is preserved. Read now; write in the commit.
    const snaps = await readSnapshotsBatch([...touched.keys()].map((token) => ({ token, g: geom.get(token) || coinGeom.get(token) })));
    for (const [token, ts] of touched) {
      const snap = snaps.get(token);
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
      if (doPurge) {
        // Scope the trades purge to ONLY the pools re-scanned this pass (the exact poolMap membership),
        // via a subquery so it costs O(1) bound params. A global block-only purge would delete an aged-out
        // coin's recent trades that nothing re-inserts (under-counting it forever); enumerating the tokens
        // as parameters would exceed SQLite's ~32k host-parameter limit at launchpad scale and wedge
        // indexing. Accrual/dev-lock/graduation purges are topic-sourced (not poolMap) and stay global.
        purgeTradesScoped.run({ from, cutoff: rewardCutoff });
        purgeAccrualsFrom.run(from); purgeDevLocksFrom.run(from); ungraduateFrom.run(from);
      }
      for (const w of writes) w();
      setCursor(hi);
    })();
    firstChunk = false;
    reached = hi;
    applied += logs.length + swapLogs.length;
  }

  // Advance the reward-poster completeness gate ONLY to the block the cursor actually
  // reached, and only AFTER the loop has committed it — head_ts must never run ahead of the
  // indexed cursor, or the poster could post a root over an incomplete accrual set. Lagging
  // is safe (the poster just waits); running ahead is the bug. Best-effort, outside any tx.
  if (reached >= from) { try { setHeadTs(await blockTs(reached)); } catch {} }
  return applied;
}

// One-time swap backfill: coins launched BEFORE pool-Swap indexing existed had their
// trades (all of them — bots swap the pool directly) scanned past by the cursor and
// never recorded. Re-scan each such coin's [launch_block, cursor] once for its pool's
// Swap events. Idempotent (inserts DO NOTHING on conflict) and gated by a per-coin meta
// flag so a restart doesn't re-scan. New coins never need this — tick() catches their
// swaps live. Runs only when the cursor is already past the coin's launch.
// Recover any coin orphaned by a transient RPC failure during its one-time launch geometry read: its
// token0/start_tick are NULL, so it is excluded from every pool scan and stays permanently invisible with
// its reward pot swept unclaimed. Re-read geometry each loop until it succeeds; returns how many were
// recovered so the caller can backfill their pool history (backfillSwaps skips already-backfilled coins).
async function reconcileGeometry() {
  const broken = coinsMissingGeometry.all();
  if (!broken.length) return 0;
  let fixed = 0;
  for (const c of broken) {
    if (!c.curve || !c.pool) continue;
    const gv = await readGeometryValues(c.curve, c.pool);
    if (!gv) continue; // still failing (RPC still down / bad addresses) — retry next loop
    db.transaction(() => setGeometry.run({
      token: c.token, start_tick: gv.start_tick, min_grad_tick: gv.min_grad_tick,
      grad_tick: gv.grad_tick, grad_target: gv.grad_target, token0: gv.token0,
    }))();
    fixed++;
    console.log(`[indexer] reconciled geometry for ${c.token} (was orphaned by a launch-time RPC failure)`);
  }
  return fixed;
}

async function backfillSwaps() {
  const cursor = getCursor();
  if (cursor === null) return; // fresh db — the normal forward scan covers everything
  for (const c of liveCoinsAll.all()) {
    if (!c.pool || !c.token0 || c.launch_block == null) continue;
    const flag = `backfilled:${c.token}`;
    if (getMeta(flag)) continue;
    const already = tradeCountForToken.get(c.token)?.n || 0;
    const coin = { token: c.token, token0: c.token0, pool: c.pool.toLowerCase() };
    let inserted = 0, lastTs = null;
    try {
      for (let lo = c.launch_block; lo <= cursor; lo += CFG.chunk) {
        const hi = Math.min(lo + CFG.chunk - 1, cursor);
        const logs = await getPoolSwaps([coin], lo, hi);
        const rows = [];
        for (const l of logs) {
          const row = decodeSwap(l, coin);
          if (!row) continue;
          row.ts = await blockTs(l.blockNumber);
          lastTs = row.ts;
          rows.push(row);
        }
        if (rows.length) {
          db.transaction(() => { for (const r of rows) insertTrade.run(r); })();
          inserted += rows.length;
        }
      }
      setMeta(flag, "1"); // completed cleanly — never re-scan this coin
      if (inserted) {
        const snap = await readSnapshotValues(coinGeom.get(c.token));
        if (snap && lastTs) setSnapshot.run({ token: c.token, ...snap, snap_ts: lastTs });
        console.log(`[indexer] backfilled ${inserted} pool swaps for ${c.symbol || c.token} (had ${already})`);
      }
    } catch (e) {
      // Leave the flag unset so the next start retries this coin from scratch.
      console.warn(`[indexer] backfill failed for ${c.symbol || c.token}: ${e.shortMessage || e.message || e}`);
    }
  }
}

/// Everything worth watching on the feed: the factory (launches), the router (routed trades), and every live
/// pool (trades that bypass the router entirely). Rebuilt each pass so a coin launched a minute ago is visible
/// to the feed rather than waiting on the safety timer.
function feedAddresses() {
  const out = [...(CFG.factories && CFG.factories.length ? CFG.factories : [CFG.factory]),
               ...(CFG.routers && CFG.routers.length ? CFG.routers : [CFG.router])];
  try {
    for (const c of liveCoinsAll.all()) { if (c.pool) out.push(c.pool); if (c.token) out.push(c.token); }
  } catch { /* db not ready yet — the two above are enough to start */ }
  return out.filter(Boolean);
}

export async function runLoop() {
  const startFrom = getCursor();
  console.log(`[indexer] rpc=${CFG.rpcUrl}`);
  console.log(`[indexer] factories=${(CFG.factories || [CFG.factory]).join(",")} routers=${(CFG.routers || [CFG.router]).join(",")}`);
  console.log(`[indexer] cursor=${startFrom ?? `(fresh, from block ${CFG.startBlock})`}`);

  let feed = null;
  if (FEED_URL) {
    const { startFeed } = await import("./feed.js");
    feed = startFeed({ url: FEED_URL, addresses: feedAddresses() });
    console.log(`[indexer] feed on: waking on real activity, safety poll every ${FEED_IDLE_MS}ms (was every ${CFG.pollMs}ms)`);
  }

  try { await backfillSwaps(); } catch (e) { console.error(`[indexer] backfill error: ${e.message || e}`); }
  let watching = 0;
  for (;;) {
    try {
      // Recover any launch-time-orphaned coin, then backfill its pool history so it isn't missing trades.
      const recovered = await reconcileGeometry();
      if (recovered) { try { await backfillSwaps(); } catch (e) { console.error(`[indexer] post-reconcile backfill error: ${e.message || e}`); } }
      const n = await tick();
      if (n) console.log(`[indexer] cursor=${getCursor()} head=${head} (+${n} logs)`);
      // Re-arm AFTER the tick, so a coin discovered in this pass is watched from the next one.
      if (feed) {
        const now = feed.setAddresses(feedAddresses());
        if (now !== watching) { console.log(`[feed] watching ${now} addresses`); watching = now; }
      }
    } catch (e) {
      console.error(`[indexer] tick error: ${e.message || e}`);
    }

    if (feed && feed.healthy()) {
      // Sleep long, and let a real transaction cut it short.
      await feed.waitForWork(FEED_IDLE_MS);
    } else {
      // No feed, or it dropped: the original timer, unchanged. Correctness never depended on the feed.
      await new Promise((r) => setTimeout(r, CFG.pollMs));
    }
  }
}
