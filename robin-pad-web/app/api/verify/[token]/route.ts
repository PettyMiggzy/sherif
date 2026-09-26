import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getLaunches } from '@/lib/launches';
import { verifyLaunchToken } from '@/lib/sourcify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/verify/0xToken: get a launch token's source verified on Sourcify
// (see lib/sourcify.ts). The create page calls it right after a launch and
// then asks the explorer to pick the source up. Only tokens this portal
// launched are accepted, so it can't be used to send anything else to
// Sourcify; a token that's already verified costs one lookup.
export async function POST(_req: Request, { params }: { params: { token: string } }) {
  if (!isAddress(params.token)) return NextResponse.json({ error: 'That is not a token address' }, { status: 400 });
  const { launches } = await getLaunches(params.token);
  if (!launches.length) return NextResponse.json({ error: 'Robin Labs Pad did not launch that token.' }, { status: 404 });
  const result = await verifyLaunchToken(launches[0].token, { waitMs: 45_000 });
  return NextResponse.json({ result }, { headers: { 'cache-control': 'no-store' } });
}
