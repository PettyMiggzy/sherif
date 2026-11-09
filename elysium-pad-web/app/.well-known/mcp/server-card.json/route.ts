import { CONFIG } from '@/lib/config';
import { TOOLS, siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The MCP server card: how a client or registry finds and describes this server without connecting first.
export function GET() {
  const s = siteUrl();
  return Response.json({
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'elysium-pad', title: CONFIG.brand, version: '1.1.0' },
    description: `Launch and trade tokens on ${CONFIG.chainName} (chain ${CONFIG.chainId}): live market data, plus ready-to-sign launch and swap transactions for your own wallet. No key, no sign-up; the server holds no keys and sends nothing.`,
    iconUrl: `${s}/icon.png`,
    documentationUrl: `${s}/docs#mcp`,
    transport: { type: 'streamable-http', endpoint: '/mcp' },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false },
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    links: { openapi: `${s}/api/v1/openapi.json`, llms: `${s}/llms.txt`, llmsFull: `${s}/llms-full.txt`, docs: `${s}/docs` },
  }, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, s-maxage=300' } });
}
