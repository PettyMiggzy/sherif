import { CONFIG } from '@/lib/config';
import { siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A short list of the MCP servers on this domain, for clients that look under /.well-known.
export function GET() {
  const s = siteUrl();
  return Response.json({
    version: '1.0',
    servers: [{ name: 'elysium-pad', title: CONFIG.brand, url: `${s}/mcp`, transport: 'streamable-http', authentication: 'none', serverCard: `${s}/.well-known/mcp/server-card.json` }],
    mcpServers: { 'elysium-pad': { type: 'http', url: `${s}/mcp` } },
  }, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, s-maxage=300' } });
}
