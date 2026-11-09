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
      description: `JSON about ${CONFIG.brand} on ${CONFIG.chainName} (chain ${CONFIG.chainId}). No key, no sign-up, CORS open. New launches pay creators ${FEES.creatorPct}% of the tax; the platform takes ${FEES.platformPct}% of the tax and the pool's LP fee. Trading and launching happen on-chain through the contracts listed by /config; the /tx endpoints return transactions for the caller's own wallet to sign; this API holds no keys and sends nothing.`,
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
      '/api/v1/tx/launch': { get: { operationId: 'prepareLaunch', summary: 'Launch transaction for your wallet to sign', parameters: [
        { name: 'name', in: 'query', required: true, schema: { type: 'string', minLength: 2, maxLength: 32 } },
        { name: 'symbol', in: 'query', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9]{2,10}$' } },
        { name: 'market_cap_usd', in: 'query', schema: { type: 'number', minimum: 100, maximum: 1000000, default: 10000 } },
        { name: 'buy_tax_pct', in: 'query', schema: { type: 'number', minimum: 0, maximum: 10, default: 3 } },
        { name: 'sell_tax_pct', in: 'query', schema: { type: 'number', minimum: 0, maximum: 10, default: 3 } },
        { name: 'from', in: 'query', schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, description: 'Signing wallet; enables a dry run and exact gas' },
      ], responses: { 200: ok('Steps to sign'), 400: err } } },
      '/api/v1/tx/trade': { get: { operationId: 'prepareTrade', summary: 'Approvals and swap to buy or sell a launch', parameters: [
        { name: 'token', in: 'query', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
        { name: 'side', in: 'query', required: true, schema: { type: 'string', enum: ['buy', 'sell'] } },
        { name: 'amount', in: 'query', required: true, schema: { type: 'string' }, description: 'Buy: USDC to spend. Sell: tokens to sell.' },
        { name: 'slippage_bps', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 5000, default: 300 } },
        { name: 'from', in: 'query', schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, description: 'Signing wallet; skips approvals already in place' },
      ], responses: { 200: ok('Quote and steps to sign'), 400: err } } },
      '/api/v1/tx/details-message': { get: { operationId: 'detailsMessage', summary: 'Message the launching wallet signs to set the token page', parameters: [
        { name: 'token', in: 'query', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
        { name: 'description', in: 'query', schema: { type: 'string', maxLength: 200 } },
        { name: 'image_sha256', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: ok('Message and how to submit'), 400: err } } },
    },
    externalDocs: { description: 'Docs, MCP server and contract guide', url: `${siteUrl()}/docs` },
  };
  return NextResponse.json(spec, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, s-maxage=300' } });
}
