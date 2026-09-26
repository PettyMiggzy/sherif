import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { CONFIG } from '@/lib/config';
import { GOPLUS_FIELDS } from '@/lib/goplus';

export const runtime = 'nodejs';

// GoPlus's token scan, fetched here rather than from the browser so every
// visitor shares one cached copy (GoPlus's free API is keyless but rate
// limited) and only the fields the panel shows are passed on.
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security';
const CACHE = 'public, s-maxage=300, stale-while-revalidate=600';

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const token = params.token.toLowerCase();
  if (!isAddress(token)) return NextResponse.json({ error: 'That is not a token address' }, { status: 400 });
  try {
    const r = await fetch(`${GOPLUS}/${CONFIG.chainId}?contract_addresses=${token}`, { next: { revalidate: 300 } });
    if (!r.ok) throw new Error(`GoPlus answered ${r.status}`);
    const body = (await r.json()) as { code?: number; result?: Record<string, Record<string, unknown>> };
    const raw = body.result?.[token];
    if (!raw) return NextResponse.json({ scan: null }, { headers: { 'cache-control': CACHE } });
    const scan: Record<string, string> = {};
    for (const f of GOPLUS_FIELDS) if (typeof raw[f] === 'string') scan[f] = raw[f] as string;
    return NextResponse.json({ scan }, { headers: { 'cache-control': CACHE } });
  } catch (e) {
    console.error('GET /api/goplus failed', e);
    return NextResponse.json({ error: 'GoPlus is unreachable right now' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
