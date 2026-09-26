import 'server-only';
import { createPublicClient, parseAbiItem, type Address } from 'viem';
import { robinhood } from './chain';
import { CONFIG } from './config';
import { chainTransport } from './rpc';
import { readJson, storeConfigured, writeJson } from './store';
import { verificationEnabled, verifyLaunchToken } from './sourcify';
import { waitUntil } from '@vercel/functions';

// The launch list, built from the portal's LaunchCreated events. Launches
// never change once mined, so the list is kept as a snapshot in the site's
// Blob store: a cold server reads the snapshot and only scans the blocks
// after it, and a warm one keeps it in memory. The snapshot is saved again
// whenever new launches show up, or when the scan has moved far enough that
// the next cold start would otherwise re-scan a lot.

const LAUNCH_EVENT = parseAbiItem(
  'event LaunchCreated(address indexed token, address indexed creator, address locker, address splitter, bytes32 poolId, address quoteAsset, bool tokenIsToken0, uint16 buyTaxBps, uint16 sellTaxBps, int24 tickLower, int24 tickUpper, uint160 initSqrtPriceX96, string name, string symbol)',
);
// Robinhood Chain makes ~10 blocks a second (~860k a day). The public RPC serves
// an address-filtered eth_getLogs over millions of blocks, but the backup
// (api.robinlab.io/rpc) caps a query at 100k, so the scan steps 100k at a time
// and either RPC can serve it.
const CHUNK = 99_999n; // inclusive: 100,000 blocks per eth_getLogs
const MAX_CHUNKS_PER_SYNC = 60; // bounds one request's work (~7 days of blocks); a longer backlog finishes over a few requests
const MIN_RESYNC_MS = 2_000;
const PERSIST_EVERY_BLOCKS = 860_000n; // about a day on Robinhood Chain

export const chainClient = createPublicClient({ chain: robinhood, transport: chainTransport() });
const portal = CONFIG.portal.toLowerCase();
const snapshotPath = `index/launches-${CONFIG.chainId}-${portal}.json`;

export type LaunchJson = {
  token: Address; creator: Address; locker: Address; splitter: Address; poolId: `0x${string}`;
  name: string; symbol: string; blockNumber: string; txHash: `0x${string}`; createdAt: number;
  tokenIsToken0: boolean; buyTaxBps: number; sellTaxBps: number; tickLower: number; tickUpper: number;
  /** The pool's opening price (sqrt, Q96), as a decimal string. */
  initSqrtPriceX96: string;
};

type Snapshot = { portal: string; lastBlock: string; launches: LaunchJson[] }; // oldest first

let mem: Snapshot | null = null;
let persistedBlock = -1n;
let lastSync = 0;
let syncing: Promise<boolean> | null = null;

async function load(): Promise<Snapshot> {
  if (mem) return mem;
  const stored = storeConfigured() ? await readJson<Snapshot>(snapshotPath).catch((e) => { console.error('launch snapshot read failed', e); return null; }) : null;
  if (stored && stored.value.portal === portal) {
    mem = stored.value;
    persistedBlock = BigInt(stored.value.lastBlock);
  } else {
    mem = { portal, lastBlock: (CONFIG.portalGenesisBlock - 1n).toString(), launches: [] };
  }
  return mem;
}

async function scan(): Promise<boolean> {
  const snap = await load();
  const tip = await chainClient.getBlockNumber({ cacheTime: 0 });
  let from = BigInt(snap.lastBlock) + 1n;
  if (from > tip) return false;
  const known = new Set(snap.launches.map((l) => l.token.toLowerCase()));
  let found = 0;
  const fresh: string[] = [];
  for (let chunks = 0; from <= tip && chunks < MAX_CHUNKS_PER_SYNC; chunks++) {
    const to = from + CHUNK > tip ? tip : from + CHUNK;
    const logs = await chainClient.getLogs({ address: CONFIG.portal, event: LAUNCH_EVENT, fromBlock: from, toBlock: to, strict: true });
    const stamps = new Map<bigint, number>();
    for (const bn of new Set(logs.map((l) => l.blockNumber))) stamps.set(bn, Number((await chainClient.getBlock({ blockNumber: bn })).timestamp));
    for (const l of logs) {
      const a = l.args;
      if (known.has(a.token.toLowerCase())) continue;
      known.add(a.token.toLowerCase());
      snap.launches.push({
        token: a.token, creator: a.creator, locker: a.locker, splitter: a.splitter, poolId: a.poolId,
        name: a.name, symbol: a.symbol, blockNumber: l.blockNumber.toString(), txHash: l.transactionHash,
        createdAt: stamps.get(l.blockNumber) ?? 0, tokenIsToken0: a.tokenIsToken0, buyTaxBps: a.buyTaxBps,
        sellTaxBps: a.sellTaxBps, tickLower: a.tickLower, tickUpper: a.tickUpper, initSqrtPriceX96: a.initSqrtPriceX96.toString(),
      });
      found++;
      fresh.push(a.token);
    }
    snap.lastBlock = to.toString();
    from = to + 1n;
  }
  if (fresh.length) scheduleVerification(fresh);
  if (storeConfigured() && (found > 0 || BigInt(snap.lastBlock) - persistedBlock >= PERSIST_EVERY_BLOCKS)) {
    // Never move the stored snapshot backwards if another server got further.
    const stored = await readJson<Snapshot>(snapshotPath).catch(() => null);
    if (!stored || BigInt(stored.value.lastBlock) < BigInt(snap.lastBlock)) {
      const ok = await writeJson(snapshotPath, snap, { ifMatch: stored ? stored.etag : null }).catch((e) => { console.error('launch snapshot write failed', e); return false; });
      if (ok) persistedBlock = BigInt(snap.lastBlock);
    }
  }
  return true;
}

/** Scans new blocks (throttled). Returns true when it actually scanned. */
export async function syncLaunches(force = false): Promise<boolean> {
  if (!force && Date.now() - lastSync < MIN_RESYNC_MS) return false;
  // A forced scan must see blocks mined after it was asked for. A scan already
  // in flight may have read the chain tip before a brand-new launch landed, so
  // wait for it and then scan again rather than reusing its answer (reusing it
  // made a token looked up right after launching come back "not a launch").
  if (force && syncing) await syncing.catch(() => false);
  if (syncing) return syncing;
  syncing = scan().finally(() => { lastSync = Date.now(); syncing = null; });
  return syncing;
}

/**
 * Launches, newest first (optionally just one token). If the chain scan
 * fails it serves what's already known and says so with `stale`. A token
 * lookup that misses forces one fresh scan, so a launch made seconds ago
 * resolves even inside the throttle window.
 */
export async function getLaunches(token?: string): Promise<{ launches: LaunchJson[]; stale: boolean }> {
  let stale = false;
  let scanned = false;
  try { scanned = await syncLaunches(); } catch (e) { stale = true; console.error('launch sync failed', e); }
  const pick = () => {
    const all = [...(mem?.launches ?? [])].reverse();
    return token ? all.filter((l) => l.token.toLowerCase() === token.toLowerCase()) : all;
  };
  let list = pick();
  if (token && list.length === 0 && !stale && !scanned) {
    try { await syncLaunches(true); list = pick(); } catch (e) { stale = true; console.error('forced launch sync failed', e); }
  }
  return { launches: list, stale };
}

/**
 * New launches get their source verified on Sourcify in the background
 * (lib/sourcify.ts), whether they came from this site or straight from the
 * contract (bots, scripts). waitUntil keeps the work alive after the response
 * on Vercel. A cold start without a stored snapshot rescans old launches too,
 * which only costs one "already verified?" lookup each; capped per scan.
 */
function scheduleVerification(tokens: string[]) {
  if (!verificationEnabled()) return;
  const job = (async () => { for (const t of tokens.slice(-25)) await verifyLaunchToken(t); })();
  try { waitUntil(job); } catch { /* outside Vercel the promise simply runs */ }
}
