import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getLaunches } from '@/lib/launches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? undefined;
  if (token !== undefined && !isAddress(token)) return NextResponse.json({ error: 'That is not a token address' }, { status: 400 });
  try {
    const { launches, stale } = await getLaunches(token);
    // Short shared cache for the full list; token lookups that miss are never
    // cached, so a brand-new launch resolves on the very next request.
    const cache = token && launches.length === 0 ? 'no-store' : 'public, s-maxage=5, stale-while-revalidate=30';
    return NextResponse.json({ launches, stale }, { headers: { 'cache-control': cache } });
  } catch (e) {
    console.error('GET /api/launches failed', e);
    return NextResponse.json({ error: 'launch list unavailable, retry shortly' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
