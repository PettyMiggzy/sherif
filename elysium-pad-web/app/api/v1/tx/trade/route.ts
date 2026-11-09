import type { NextRequest } from 'next/server';
import { prepareTrade } from '@/lib/agentTx';
import { apiError, apiJson, apiOptions } from '@/lib/publicApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/tx/trade?token=&side=buy|sell&amount=&slippage_bps=&from=
// Returns approvals and the swap for the caller's own wallet to sign, with a live quote. Sends nothing.
export async function GET(req: NextRequest) {
  try {
    return apiJson(await prepareTrade(Object.fromEntries(req.nextUrl.searchParams)), { maxAge: 0 });
  } catch (e) {
    return apiError((e as Error).message.split('\n')[0].slice(0, 300));
  }
}
export const OPTIONS = apiOptions;
