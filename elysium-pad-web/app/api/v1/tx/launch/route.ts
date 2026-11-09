import type { NextRequest } from 'next/server';
import { prepareLaunch } from '@/lib/agentTx';
import { apiError, apiJson, apiOptions } from '@/lib/publicApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/tx/launch?name=&symbol=&market_cap_usd=&buy_tax_pct=&sell_tax_pct=&from=
// Returns the launch transaction for the caller's own wallet to sign. Sends nothing.
export async function GET(req: NextRequest) {
  try {
    return apiJson(await prepareLaunch(Object.fromEntries(req.nextUrl.searchParams)), { maxAge: 0 });
  } catch (e) {
    return apiError((e as Error).message.split('\n')[0].slice(0, 300));
  }
}
export const OPTIONS = apiOptions;
