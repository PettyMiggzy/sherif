import { NextResponse, type NextRequest } from 'next/server';
import { CONFIG } from '@/lib/config';
import { TOOLS } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /mcp: a stateless MCP server (Streamable HTTP, JSON replies) for AI
// agents. Read tools return the same data as /api/v1; the "link" tools build
// URLs a person opens to sign in their own wallet, and the prepare tools return
// transactions an agent signs with its own wallet. It holds no keys, signs
// nothing and sends no transactions.

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id',
};

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(m: Rpc) {
  const id = m.id;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(id, -32600, 'Invalid request');
  if (id === undefined) return null; // a notification: no reply
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.protocolVersion ?? '');
      return ok(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'elysium-pad', title: CONFIG.brand, version: '1.1.0' },
        instructions: `${CONFIG.brand} launches tokens on ${CONFIG.chainName} (chain ${CONFIG.chainId}), each in its own Uniswap v4 pool against USDC. Read tools are live chain data. To act on chain, call elysium_prepare_launch or elysium_prepare_trade and sign the returned steps with your own wallet (this server never holds keys); the link tools are for a human to open. Start with elysium_config.`,
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { title: name.replace(/^elysium_/, '').replace(/_/g, ' '), readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${String(m.params?.name)}`);
      try {
        const out = await tool.run((m.params?.arguments ?? {}) as Record<string, unknown>);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false });
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default: return fail(id, -32601, `Method not found: ${m.method}`);
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json(fail(null, -32600, 'Request too large'), { status: 413, headers: CORS });
  let body: Rpc | Rpc[];
  try { body = JSON.parse(raw); } catch { return NextResponse.json(fail(null, -32700, 'Parse error'), { status: 400, headers: CORS }); }
  const batch = Array.isArray(body);
  const items: Rpc[] = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > 20) return NextResponse.json(fail(null, -32600, 'Send 1 to 20 messages'), { status: 400, headers: CORS });
  const replies = (await Promise.all(items.map((m) => handle(m)))).filter((r) => r !== null);
  if (!replies.length) return new NextResponse(null, { status: 202, headers: CORS });
  return NextResponse.json(batch ? replies : replies[0], { headers: { ...CORS, 'cache-control': 'no-store' } });
}

// No server-initiated streams: this server only answers POSTs.
// A GET from a person or a crawler gets a pointer to everything; an MCP client that asks for an event stream gets 405, which the spec allows.
export function GET(req: NextRequest) {
  if ((req.headers.get('accept') ?? '').includes('text/event-stream')) return new NextResponse('This MCP server answers POST requests only.', { status: 405, headers: { ...CORS, allow: 'POST, OPTIONS' } });
  const base = (CONFIG.siteUrl || 'https://elysiumpad.world').replace(/\/+$/, '');
  return NextResponse.json({
    name: 'elysium-pad', title: CONFIG.brand, transport: 'streamable-http', endpoint: `${base}/mcp`, method: 'POST', auth: 'none',
    tools: TOOLS.map((t) => t.name), serverCard: `${base}/.well-known/mcp/server-card.json`, openapi: `${base}/api/v1/openapi.json`, llms: `${base}/llms.txt`, docs: `${base}/docs`,
  }, { headers: { ...CORS, 'cache-control': 'public, s-maxage=300' } });
}
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: CORS });
