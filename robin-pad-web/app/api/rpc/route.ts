// POST /api/rpc: this site's read-only relay to its backup Robinhood Chain RPC (RPC_FALLBACK_URL, a paid
// provider whose key stays on the server). Browsers use it only when the chain's public RPC fails (see
// lib/rpc.ts). Read calls only, no transactions; no CORS headers, so other sites' pages can't use
// it; and a per-address rate limit.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const READ_METHODS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getCode',
  'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
]);
const MAX_BATCH = 100;
const PER_MINUTE = 240;

type RpcItem = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  if (!ip) return false;
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] >= 60_000) hits.delete(k);
  return recent.length > PER_MINUTE;
}

const rpcError = (status: number, code: number, message: string, id: unknown = null) =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  const ip = (req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim();
  if (limited(ip)) return rpcError(429, -32005, 'Too many requests');
  const backup = process.env.RPC_FALLBACK_URL;
  if (!backup) return rpcError(503, -32000, 'No backup RPC');

  const raw = await req.text();
  if (raw.length > 200_000) return rpcError(413, -32600, 'Request too large');
  let payload: RpcItem | RpcItem[];
  try {
    payload = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, 'Parse error');
  }
  const items = Array.isArray(payload) ? payload : [payload];
  if (!items.length || items.length > MAX_BATCH) return rpcError(400, -32600, `Send 1 to ${MAX_BATCH} calls`);
  for (const it of items) {
    const ok = it && it.jsonrpc === '2.0' && typeof it.method === 'string' && READ_METHODS.has(it.method)
      && (it.params === undefined || Array.isArray(it.params));
    if (!ok) return rpcError(400, -32601, 'Only read calls go through this relay', it?.id ?? null);
  }

  try {
    const r = await fetch(backup, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return rpcError(502, -32000, 'Backup RPC unreachable');
  }
}
