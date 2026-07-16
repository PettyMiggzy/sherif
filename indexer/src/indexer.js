// The indexer: a reorg-safe log poller. Each tick it scans a block window in
// CHUNK-sized getLogs calls, decodes our four events, and writes them. It only
// advances the cursor to (head - CONFIRMATIONS) and re-scans the last window each
// tick, so a tip reorg is corrected on the next pass. All writes are idempotent.
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { iface, TOPICS, ERC20 } from "./abi.js";
import {
  db, getCursor, setCursor, upsertCoin, markGraduated, insertTrade,
  coinByCurve, setCoinNameSymbol, purgeTradesFrom,
} from "./db.js";

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
  const grads = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, topics: [TOPICS.Graduated] }), "getLogs.grads");
  // Merge + order by (block, logIndex) for deterministic application.
  return [...launched, ...trades, ...grads].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.index - b.index);
}

async function applyLog(log) {
  let parsed;
  try { parsed = iface.parseLog(log); } catch { return; }
  if (!parsed) return;
  const ts = await blockTs(log.blockNumber);
  const a = parsed.args;

  if (parsed.name === "Launched") {
    const token = a.token.toLowerCase();
    const { name, symbol } = await nameSymbol(token);
    upsertCoin.run({
      token, curve: a.curve.toLowerCase(), pool: a.pool.toLowerCase(),
      dev: a.dev.toLowerCase(), name, symbol,
      launch_block: log.blockNumber, launch_ts: ts, launch_tx: log.transactionHash,
      dev_bought: a.devBought.toString(),
    });
    return;
  }

  if (parsed.name === "Bought" || parsed.name === "Sold") {
    const buy = parsed.name === "Bought";
    insertTrade.run({
      tx: log.transactionHash, log_index: log.index,
      token: a.token.toLowerCase(), side: buy ? "buy" : "sell",
      actor: (buy ? a.buyer : a.seller).toLowerCase(),
      eth: (buy ? a.ethIn : a.ethOut).toString(),
      tokens: (buy ? a.tokensOut : a.tokensIn).toString(),
      fee: a.fee.toString(), block: log.blockNumber, ts,
    });
    return;
  }

  if (parsed.name === "Graduated") {
    // Emitted by the curve; log.address is the curve. Only act if we know it.
    const curve = log.address.toLowerCase();
    if (!coinByCurve.get(curve)) return;
    markGraduated.run({
      curve, grad_block: log.blockNumber, grad_ts: ts,
      raised_weth: a.raisedWeth.toString(), bond: a.bond.toLowerCase(),
    });
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

  // Delete any trades in the re-scanned window so orphaned-block rows can't linger.
  if (stored !== null) {
    const del = db.transaction(() => purgeTradesFrom.run(from));
    del();
  }

  let applied = 0;
  for (let lo = from; lo <= safeHead; lo += CFG.chunk) {
    const hi = Math.min(lo + CFG.chunk - 1, safeHead);
    const logs = await getLogsRange(lo, hi);
    // Apply sequentially — each log may make its own enrichment RPC calls, and
    // firing them all at once trips the public RPC's rate limit.
    for (const log of logs) await applyLog(log);
    applied += logs.length;
    setCursor(hi);
  }
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
