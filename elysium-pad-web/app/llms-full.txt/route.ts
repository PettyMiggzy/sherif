import { CONFIG } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { siteUrl } from '@/lib/siteApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /llms-full.txt: the complete recipe for an agent that wants to launch and trade here.
export function GET() {
  const s = siteUrl();
  const text = `# ${CONFIG.brand}: agent guide

${CONFIG.brand} is a token launchpad on ${CONFIG.chainName} (chain ${CONFIG.chainId}, gas in HYPE, USDC quote). Every launch gets its own Uniswap v4 pool against USDC. Liquidity equals the starting market cap ($100 to $1,000,000), there is no bonding curve, and the creator sets a 0 to 10% tax each way. Of that tax the creator receives ${FEES.creatorPct}% and the platform ${FEES.platformPct}%; the pool also charges a 1% LP fee to the platform.

Nothing on this site holds keys or sends transactions. Every write is calldata that YOUR wallet signs and broadcasts to the chain.

## Connect
- MCP (Streamable HTTP, no auth): POST ${s}/mcp
- Server card: ${s}/.well-known/mcp/server-card.json
- OpenAPI 3.1: ${s}/api/v1/openapi.json
- Claude Code: claude mcp add --transport http elysium-pad ${s}/mcp
- JSON config: { "mcpServers": { "elysium-pad": { "type": "http", "url": "${s}/mcp" } } }

## Recipe: launch a token
1. elysium_config (or GET ${s}/api/v1/config): chain id, RPC, contract addresses, and whether launching is live.
2. elysium_prepare_launch { name, symbol, market_cap_usd, buy_tax_pct, sell_tax_pct, from }  (REST: GET ${s}/api/v1/tx/launch?...).
   Returns steps[0] = { to, data, value, chainId, gas }. With "from" it is dry-run on chain first.
3. Sign and send that transaction from your wallet (it needs a little HYPE for gas).
4. The token address is topic 1 of the LaunchCreated event in the receipt, or the newest row of elysium_list_launches.
5. Optional: elysium_details_message { token, description, links, image_sha256 } returns the text the launching wallet signs (personal_sign). POST it with the form fields to ${s}/api/metadata/{token}.
6. Verification of the token's source code on the explorer is requested by the website; to trigger it yourself call POST ${s}/api/verify/{token}.

## Recipe: buy or sell
1. elysium_prepare_trade { token, side: "buy" | "sell", amount, slippage_bps, from }  (REST: GET ${s}/api/v1/tx/trade?...).
   Buy: amount is USDC to spend. Sell: amount is the number of tokens.
2. It returns a live quote (expectedOut, minOut) and steps: an ERC-20 approve to Permit2, a Permit2 approve to the router (both for the exact amount), then the router swap. Send them in order and wait for each to confirm.
3. Selling before anyone has bought fails with "nothing to fill": there is no one to sell to yet.

## Read
- elysium_list_launches, elysium_market (price, market cap, change since launch), elysium_get_token (pool key, pending tax, creator details).
- Any launch's price can be followed on DexScreener once it has had a first swap.

## Limits and honesty
- Launch parameters outside the ranges above are rejected.
- Prices move: always send minOut (the prepare tool does).
- This is a new chain with thin liquidity. Do not present a token's market cap as proof of demand.
`;
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, s-maxage=300' } });
}
