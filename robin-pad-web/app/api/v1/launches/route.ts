import type { NextRequest } from 'next/server';
import { getLaunches } from '@/lib/launches';
import { apiError, apiJson, apiOptions, padIsLive } from '@/lib/publicApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Launches, newest first. ?limit= (1-200, default 50), ?before=<block> to page back.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
  const before = q.get('before');
  if (before !== null && !/^\d+$/.test(before)) return apiError('before has to be a block number');
  try {
    const [{ launches, stale }, live] = await Promise.all([getLaunches(), padIsLive().catch(() => false)]);
    const list = before === null ? launches : launches.filter((l) => BigInt(l.blockNumber) < BigInt(before));
    return apiJson({ live, stale, launches: list.slice(0, limit) });
  } catch (e) {
    console.error('GET /api/v1/launches failed', e);
    return apiError('The launch list is catching up. Try again in a moment.', 503);
  }
}

export const OPTIONS = apiOptions;
