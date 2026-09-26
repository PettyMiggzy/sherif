import type { NextRequest } from 'next/server';
import { isAddress, parseAbi } from 'viem';
import { CONFIG } from '@/lib/config';
import { chainClient, getLaunches } from '@/lib/launches';
import { poolId, poolKeyFor } from '@/lib/pool';
import { apiError, apiJson, apiOptions, marketFor } from '@/lib/publicApi';
import { getTokenMeta, storeConfigured } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const pendingTaxAbi = parseAbi(['function pendingTax(bytes32) view returns (uint256)']);

// One launch: pool details, live price, tax waiting to be flushed, and the
// creator's description and links.
export async function GET(req: NextRequest, { params }: { params: { address: string } }) {
  const token = params.address.toLowerCase();
  if (!isAddress(token)) return apiError('That is not a token address');
  try {
    const { launches } = await getLaunches(token);
    const launch = launches[0];
    if (!launch) return apiError('Robin Labs Pad did not launch that token.', 404);
    const { key } = poolKeyFor(launch.token);
    const [[market], pendingTax, meta] = await Promise.all([
      marketFor([launch]),
      chainClient.readContract({ address: CONFIG.hook, abi: pendingTaxAbi, functionName: 'pendingTax', args: [poolId(key)] }),
      storeConfigured() ? getTokenMeta(token).catch(() => null) : Promise.resolve(null),
    ]);
    const signed = !!meta && meta.signedAt > 0;
    return apiJson({
      launch,
      poolKey: key,
      market: { ...market, pendingTaxUsdg: pendingTax.toString() },
      meta: meta && {
        description: meta.description,
        image: meta.imageKey ? `${req.nextUrl.origin}/api/metadata/${token}/image?v=${encodeURIComponent(meta.imageKey)}` : null,
        links: signed ? meta.links : {},
      },
    }, { maxAge: 3 });
  } catch (e) {
    console.error('GET /api/v1/tokens failed', e);
    return apiError('Token data is unreachable for a moment. Try again shortly.', 503);
  }
}

export const OPTIONS = apiOptions;
