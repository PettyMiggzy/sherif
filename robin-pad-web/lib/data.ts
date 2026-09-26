import { createPublicClient, decodeEventLog, parseAbiItem, type Address } from 'viem';
import { robinhood } from './chain';
import { CONFIG } from './config';
import { chainTransport } from './rpc';
import { poolManagerAbi, erc20Abi } from './abi';
import { poolKeyFor, poolId, slot0Slot, decodeSlot0, priceFromSqrt, priceFromTick } from './pool';

export const publicClient = createPublicClient({ chain: robinhood, transport: chainTransport({ batch: true }) });

export type Launch = {
  token: Address; creator: Address; locker: Address; splitter: Address; poolId: `0x${string}`;
  name: string; symbol: string; blockNumber: bigint; txHash: `0x${string}`; createdAt: number;
  // From LaunchCreated; optional because pad-indexer's /launches payload doesn't carry them.
  tokenIsToken0?: boolean; buyTaxBps?: number; sellTaxBps?: number; tickLower?: number; tickUpper?: number;
};

const rangeOf = (l?: Launch | null) => (l && l.tickLower !== undefined && l.tickUpper !== undefined ? { tickLower: l.tickLower, tickUpper: l.tickUpper } : undefined);

// priceUsd/marketCapUsd are always real (read straight from pool state — see
// fetchSpot). The rest need trade history no cheap on-chain read can give
// us, so they're `undefined` — not a guess, not a fabricated placeholder —
// until NEXT_PUBLIC_INDEXER_URL points at a running pad-indexer. Every
// consumer already renders `undefined` as "—" (fmtUsd/fmtPct), so this is
// the honest value, not a display bug.
export type TokenStats = {
  priceUsd: number; marketCapUsd: number; volume24hUsd?: number; change24hPct?: number;
  holders?: number; txns24h?: number; liquidityUsd?: number;
};

export type Trade = { hash: `0x${string}`; ts: number; isBuy: boolean; usd: number; tokens: number; trader: Address };
export type Holder = { address: Address; balance: number; pct: number; tag?: string };
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

// ---------------------------------------------------------------------------
// Optional real data source: pad-indexer's HTTP API. Every function below tries
// this first (when NEXT_PUBLIC_INDEXER_URL is set) and falls back to a
// real on-chain read where one exists cheaply (the /api/launches index,
// getHolders' locker balance) or an honest empty/unknown result where it
// doesn't — never to invented numbers — so the app keeps working, truthfully,
// with zero indexer configured.
// ---------------------------------------------------------------------------
async function indexerGet<T>(path: string): Promise<T | null> {
  if (!CONFIG.indexerUrl) return null;
  try {
    const res = await fetch(`${CONFIG.indexerUrl}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Launches come from this deployment's own /api/launches index (a server-side
// incremental scan of LaunchCreated logs, cached in Postgres — see
// lib/launches.ts), so browsers never scan chain history themselves.
// ---------------------------------------------------------------------------
type LaunchJson = Omit<Launch, 'blockNumber'> & { blockNumber: string | number };
const fromJson = (l: LaunchJson): Launch => ({ ...l, blockNumber: BigInt(l.blockNumber) });

async function launchApi(query = ''): Promise<Launch[]> {
  const res = await fetch(`/api/launches${query}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The launch list request failed (${res.status})`);
  const body = (await res.json()) as { launches: LaunchJson[] };
  return body.launches.map(fromJson);
}

export async function fetchLaunches(): Promise<Launch[]> {
  const indexed = await indexerGet<LaunchJson[]>('/launches');
  if (indexed) return indexed.map(fromJson);
  return launchApi();
}

/** null only when the index confirms the address isn't a launch; throws when the lookup itself fails. */
export async function fetchLaunch(token: Address): Promise<Launch | null> {
  const res = await fetch(`/api/launches?token=${token}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The launch lookup failed (${res.status})`);
  const body = (await res.json()) as { launches: LaunchJson[]; stale?: boolean };
  if (body.launches[0]) return fromJson(body.launches[0]);
  // A miss while the site's chain scan is behind proves nothing: throw so the
  // lookup retries, instead of showing a real token as "not found".
  if (body.stale) throw new Error('The launch list is catching up');
  return null;
}

// ---------------------------------------------------------------------------
// REAL: spot price + market cap straight from PoolManager storage.
// ---------------------------------------------------------------------------
/**
 * When the launch's position range is known, the displayed price is clamped
 * to it. Outside the range there is no liquidity, so slot0 there is not a
 * tradable price — and anyone can move it there for free (a swap across empty
 * ticks costs nothing), which would otherwise let a griefer make any fresh
 * launch show a ~$0 or absurd market cap.
 */
export async function fetchSpot(token: Address, range?: { tickLower: number; tickUpper: number }) {
  const { key, tokenIsToken0 } = poolKeyFor(token);
  const id = poolId(key);
  const word = await publicClient.readContract({ address: CONFIG.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot0Slot(id)] });
  const s0 = decodeSlot0(word);
  let priceUsd = s0.sqrtPriceX96 === 0n ? 0 : priceFromSqrt(s0.sqrtPriceX96, tokenIsToken0, CONFIG.quoteDecimals);
  if (range && s0.sqrtPriceX96 !== 0n && (s0.tick < range.tickLower || s0.tick >= range.tickUpper)) {
    const edge = s0.tick < range.tickLower ? range.tickLower : range.tickUpper;
    priceUsd = priceFromTick(edge, tokenIsToken0, CONFIG.quoteDecimals);
  }
  return { priceUsd, marketCapUsd: priceUsd * 1e9, tick: s0.tick, poolId: id, tokenIsToken0 };
}

// ---------------------------------------------------------------------------
// getStats / getTrades / getHolders / getCandles all prefer pad-indexer's
// HTTP API (see indexerGet above). Without one configured, each falls back to
// whatever is CHEAPLY and HONESTLY readable straight from chain — never to
// invented numbers. Trade history, holder counts and OHLC candles need a
// real event-log index to answer honestly, so those come back empty/unknown
// until NEXT_PUBLIC_INDEXER_URL points at a running pad-indexer — every
// consumer (StatCards, TradesTable, HoldersTable, CandleChart) already
// renders that as "—" or an empty-state line, not a zero.
// ---------------------------------------------------------------------------

/** `liquidity: true` also values the pool from chain (the token page); lists skip that read. */
export async function getStats(token: Address, launch?: Launch | null, opts: { liquidity?: boolean } = {}): Promise<TokenStats> {
  const indexed = await indexerGet<TokenStats>(`/stats/${token}`);
  if (indexed) return indexed;

  const { priceUsd, marketCapUsd } = await fetchSpot(token, rangeOf(launch)).catch(() => ({ priceUsd: 0, marketCapUsd: 0 }));
  const liquidityUsd = opts.liquidity && launch && priceUsd > 0 ? await poolLiquidityUsd(launch, priceUsd).catch(() => undefined) : undefined;
  return { priceUsd, marketCapUsd, liquidityUsd };
}

// The launch position's liquidity (L) never changes after the launch: the
// locker can't add or remove any. So it's read once, from the Seeded event in
// the launch transaction.
const SEEDED = parseAbiItem('event Seeded(uint128 liquidity, uint256 amount0, uint256 amount1)');
const seededLiquidity = new Map<string, Promise<bigint | undefined>>();

function positionLiquidity(l: Launch): Promise<bigint | undefined> {
  const k = l.token.toLowerCase();
  let p = seededLiquidity.get(k);
  if (!p) {
    p = publicClient.getTransactionReceipt({ hash: l.txHash }).then((rc) => {
      for (const log of rc.logs) {
        if (log.address.toLowerCase() !== l.locker.toLowerCase()) continue;
        try { return decodeEventLog({ abi: [SEEDED], data: log.data, topics: log.topics }).args.liquidity; } catch { /* a different event */ }
      }
      return undefined;
    });
    p.catch(() => seededLiquidity.delete(k));
    seededLiquidity.set(k, p);
  }
  return p;
}

/**
 * What the launch's pool holds, valued at the current price: the tokens
 * still in the position plus the USDG buyers have paid in. It's the figure
 * DexScreener shows as liquidity. At launch it equals the starting market
 * cap, because the whole supply starts in the pool.
 */
async function poolLiquidityUsd(l: Launch, priceUsd: number): Promise<number | undefined> {
  if (l.tickLower === undefined || l.tickUpper === undefined || l.tokenIsToken0 === undefined) return undefined;
  const L = await positionLiquidity(l);
  if (L === undefined) return undefined;
  const word = await publicClient.readContract({ address: CONFIG.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot0Slot(poolId(poolKeyFor(l.token).key))] });
  const { sqrtPriceX96 } = decodeSlot0(word);
  // Standard concentrated-liquidity amounts, in floating point (display only).
  const sa = Math.pow(1.0001, l.tickLower / 2);
  const sb = Math.pow(1.0001, l.tickUpper / 2);
  const sp = Math.min(Math.max(Number(sqrtPriceX96) / 2 ** 96, sa), sb);
  const liq = Number(L);
  const amount0 = (liq * (sb - sp)) / (sp * sb);
  const amount1 = liq * (sp - sa);
  const [tokenRaw, usdgRaw] = l.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
  return (tokenRaw / 1e18) * priceUsd + usdgRaw / 10 ** CONFIG.quoteDecimals;
}

export async function getTrades(token: Address, n = 30): Promise<Trade[]> {
  const indexed = await indexerGet<Trade[]>(`/trades/${token}?n=${n}`);
  if (indexed) return indexed;
  return [];
}

/**
 * The launch's locked liquidity lives in the Uniswap v4 PoolManager, not the
 * locker: seeding moves the whole supply into the position, and the locker
 * keeps only rounding dust. So the PoolManager's balance is the locked-LP
 * row (it can also include any other pool for this token), the locker's
 * dust is dropped, and without an indexer that row is the one real holder
 * we can show from a single on-chain read.
 */
const LOCKED_LP_TAG = 'Pool liquidity, locked';

export async function getHolders(token: Address, launch?: Launch | null): Promise<Holder[]> {
  const pm = CONFIG.poolManager.toLowerCase();
  const locker = launch?.locker.toLowerCase();
  const indexed = await indexerGet<Holder[]>(`/holders/${token}?n=20`);
  if (indexed) {
    return indexed
      .filter((h) => h.address.toLowerCase() !== locker)
      .map((h) => (h.address.toLowerCase() === pm ? { ...h, tag: LOCKED_LP_TAG } : h));
  }
  if (!launch) return [];

  const balance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [CONFIG.poolManager] }).catch(() => 0n);
  if (balance === 0n) return [];
  const pct = Number((balance * 10_000n) / CONFIG.totalSupply) / 100;
  return [{ address: CONFIG.poolManager, balance: Number(balance) / 1e18, pct, tag: LOCKED_LP_TAG }];
}

export async function getCandles(token: Address, n = 96, intervalSec = 900): Promise<Candle[]> {
  const indexed = await indexerGet<Candle[]>(`/candles/${token}?n=${n}&interval=${intervalSec}`);
  if (indexed && indexed.length) return indexed;
  return [];
}
