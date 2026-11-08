import { NextResponse } from 'next/server';
import { CONFIG } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const err = { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } };
const ok = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
const addrParam = { name: 'address', in: 'path', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, description: 'Token address' };

// GET /api/v1/openapi.json: the public API described for tools and code generators.
export async function GET() {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: `${CONFIG.brand} public API`,
      version: '1.0.0',
      description: `Read-only JSON about ${CONFIG.brand} on ${CONFIG.chainName} (chain ${CONFIG.chainId}). No key, no sign-up, CORS open. New launches pay creators ${FEES.creatorPct}% of the tax; the platform takes ${FEES.platformPct}% of the tax and the pool's LP fee. Trading and launching happen on-chain through the contracts listed by /config; this API sends nothing.`,
    },
    servers: [{ url: siteUrl() }],
    paths: {
      '/api/v1/config': { get: { operationId: 'getConfig', summary: 'Chain, RPC, contracts, fee model, pool settings, live flag', responses: { 200: ok('Config') } } },
      '/api/v1/launches': { get: { operationId: 'listLaunches', summary: 'Launches, newest first', parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        { name: 'before', in: 'query', schema: { type: 'string', pattern: '^\\d+$' }, description: 'Only launches below this block number' },
      ], responses: { 200: ok('Launches'), 400: err, 503: err } } },
      '/api/v1/market': { get: { operationId: 'getMarket', summary: 'Live price, market cap and change since launch', parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
      ], responses: { 200: ok('Market rows'), 503: err } } },
      '/api/v1/tokens/{address}': { get: { operationId: 'getToken', summary: 'One launch: pool key, price, pending tax, details', parameters: [addrParam], responses: { 200: ok('Token'), 400: err, 404: err, 503: err } } },
    },
    externalDocs: { description: 'Docs, MCP server and contract guide', url: `${siteUrl()}/docs` },
  };
  return NextResponse.json(spec, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, s-maxage=300' } });
}
