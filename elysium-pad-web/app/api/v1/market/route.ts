import type { NextRequest } from 'next/server';
import { getLaunches } from '@/lib/launches';
import { apiError, apiJson, apiOptions, marketFor, padIsLive } from '@/lib/publicApi';
import { getImageIndex, storeConfigured } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live price, market cap and change since launch of the newest launches,
// for tickers and screeners. ?limit= (1-100, default 30).
export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') ?? 30) || 30, 1), 100);
  try {
    const [{ launches }, live, images] = await Promise.all([
      getLaunches(),
      padIsLive().catch(() => false),
      storeConfigured() ? getImageIndex().catch(() => ({} as Record<string, string>)) : Promise.resolve({} as Record<string, string>),
    ]);
    const rows = await marketFor(launches.slice(0, limit));
    const origin = req.nextUrl.origin;
    return apiJson({
      live,
      updatedAt: Math.floor(Date.now() / 1000),
      tokens: rows.map((r) => {
        const key = images[r.address.toLowerCase()];
        return { ...r, image: key ? `${origin}/api/metadata/${r.address.toLowerCase()}/image?v=${encodeURIComponent(key)}` : null };
      }),
    }, { maxAge: 5 });
  } catch (e) {
    console.error('GET /api/v1/market failed', e);
    return apiError('Prices are unreachable for a moment. Try again shortly.', 503);
  }
}

export const OPTIONS = apiOptions;
