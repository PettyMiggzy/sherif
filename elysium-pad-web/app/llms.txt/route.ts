import { CONFIG } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /llms.txt: a plain-text map of the site for AI agents.
export function GET() {
  const s = siteUrl();
  const text = `# ${CONFIG.brand}

> A token launchpad on ${CONFIG.chainName} (chain ${CONFIG.chainId}, gas in HYPE). Each launch opens its own Uniswap v4 pool against USDC with liquidity equal to its starting market cap ($100 to $1M), no bonding curve. Creators set a 0-10% tax each way and receive ${FEES.creatorPct}% of it; the platform takes ${FEES.platformPct}% of the tax and the pool's 1% LP fee.

## For agents
- MCP server (Streamable HTTP, no key): ${s}/mcp  tools: elysium_config, elysium_list_launches, elysium_market, elysium_get_token, elysium_prepare_launch, elysium_prepare_trade, elysium_details_message, elysium_launch_link, elysium_trade_link, elysium_deals_link
- MCP server card: ${s}/.well-known/mcp/server-card.json
- Full agent guide: ${s}/llms-full.txt
- OpenAPI: ${s}/api/v1/openapi.json
- JSON API: ${s}/api/v1/config, /api/v1/launches, /api/v1/market, /api/v1/tokens/{address}
- Transactions for your own wallet (GET): ${s}/api/v1/tx/launch, /api/v1/tx/trade, /api/v1/tx/details-message
- Docs (contracts, swap encoding, fees, events): ${s}/docs

## Pages
- ${s}/ launchpad home
- ${s}/create launch a token
- ${s}/explore all launches
- ${s}/deals discount swap for sell-side LP-fee tokens (${FEES.deskDiscountPct}% under the pool)
- ${s}/leaderboard rankings

Nothing here holds keys or sends transactions: the prepare tools and /api/v1/tx return calldata your own wallet signs; link tools return URLs a person opens.
`;
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, s-maxage=300' } });
}
