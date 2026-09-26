import 'server-only';
import { NextResponse } from 'next/server';
import { parseAbi, type Address, type Hex } from 'viem';
import { CONFIG } from './config';
import { chainClient, type LaunchJson } from './launches';
import { decodeSlot0, poolId, poolKeyFor, priceFromSqrt, priceFromTick, slot0Slot } from './pool';

// Shared pieces of the public API (/api/v1/*): open to every origin, no key,
// and cached briefly at Vercel's edge so bots polling hard don't each cost
// an RPC round trip.

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export function apiJson(body: unknown, init: { status?: number; maxAge?: number } = {}) {
  const maxAge = init.maxAge ?? 3;
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: {
      ...CORS_HEADERS,
      'cache-control': maxAge > 0 ? `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 10}` : 'no-store',
    },
  });
}

export const apiError = (error: string, status = 400) => apiJson({ error }, { status, maxAge: 0 });
export const apiOptions = () => new NextResponse(null, { status: 204, headers: CORS_HEADERS });

const extsloadManyAbi = parseAbi(['function extsload(bytes32[] slots) view returns (bytes32[])']);
const hookLiveAbi = parseAbi(['function isAuthorizedPortal(address) view returns (bool)']);

export async function padIsLive(): Promise<boolean> {
  return chainClient.readContract({ address: CONFIG.hook, abi: hookLiveAbi, functionName: 'isAuthorizedPortal', args: [CONFIG.portal] });
}

export type MarketRow = {
  address: Address; name: string; symbol: string;
  priceUsd: number; marketCapUsd: number; changeSinceLaunchPct: number;
  sqrtPriceX96: string; tick: number;
  buyTaxBps: number; sellTaxBps: number; createdAt: number;
};

const SUPPLY = Number(CONFIG.totalSupply / 10n ** 18n);

/** Live price of each launch, read for all of them in one eth_call. */
export async function marketFor(launches: LaunchJson[]): Promise<MarketRow[]> {
  if (!launches.length) return [];
  const ids = launches.map((l) => poolId(poolKeyFor(l.token).key));
  const words = await chainClient.readContract({ address: CONFIG.poolManager, abi: extsloadManyAbi, functionName: 'extsload', args: [ids.map(slot0Slot)] });
  return launches.map((l, i) => {
    const s = decodeSlot0(words[i] as Hex);
    const price = priceFromSqrt(s.sqrtPriceX96, l.tokenIsToken0, CONFIG.quoteDecimals);
    // The pool opens exactly at the edge of its single-sided position.
    const open = priceFromTick(l.tokenIsToken0 ? l.tickLower : l.tickUpper, l.tokenIsToken0, CONFIG.quoteDecimals);
    return {
      address: l.token, name: l.name, symbol: l.symbol,
      priceUsd: price, marketCapUsd: price * SUPPLY,
      changeSinceLaunchPct: open > 0 ? (price / open - 1) * 100 : 0,
      sqrtPriceX96: s.sqrtPriceX96.toString(), tick: s.tick,
      buyTaxBps: l.buyTaxBps, sellTaxBps: l.sellTaxBps, createdAt: l.createdAt,
    };
  });
}
