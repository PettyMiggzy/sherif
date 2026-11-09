import { CONFIG } from '@/lib/config';
import { siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The older "AI plugin" manifest, which many agent frameworks still read: it points at the OpenAPI description.
export function GET() {
  const s = siteUrl();
  return Response.json({
    schema_version: 'v1',
    name_for_human: CONFIG.brand,
    name_for_model: 'elysium_pad',
    description_for_human: `Launch and trade tokens on ${CONFIG.chainName}.`,
    description_for_model: `Read live launches and prices on ${CONFIG.brand} (${CONFIG.chainName}, chain ${CONFIG.chainId}) and build launch and swap transactions that the caller signs with its own wallet. No key needed. An MCP server is also available at ${s}/mcp.`,
    auth: { type: 'none' },
    api: { type: 'openapi', url: `${s}/api/v1/openapi.json` },
    logo_url: `${s}/icon.png`,
    contact_email: '',
    legal_info_url: `${s}/about`,
  }, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, s-maxage=300' } });
}
