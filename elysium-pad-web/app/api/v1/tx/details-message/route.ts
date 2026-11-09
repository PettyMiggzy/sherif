import type { NextRequest } from 'next/server';
import { detailsMessage } from '@/lib/agentTx';
import { apiError, apiJson, apiOptions } from '@/lib/publicApi';
import { siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/tx/details-message?token=&description=&image_sha256=&x=&website=&telegram=
// The text the token's creator signs to set its page. Sends nothing.
export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  try {
    return apiJson(detailsMessage({ token: q.token, description: q.description, image_sha256: q.image_sha256, links: { x: q.x, website: q.website, telegram: q.telegram } }, siteUrl()), { maxAge: 0 });
  } catch (e) {
    return apiError((e as Error).message.split('\n')[0].slice(0, 300));
  }
}
export const OPTIONS = apiOptions;
