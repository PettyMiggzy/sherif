import 'server-only';
import { NextRequest } from 'next/server';
import { isAddress } from 'viem';
import { CONFIG } from './config';
import { FEES } from './fees';
import { detailsMessage, prepareLaunch, prepareTrade } from './agentTx';
import { GET as configGET } from '@/app/api/v1/config/route';
import { GET as launchesGET } from '@/app/api/v1/launches/route';
import { GET as marketGET } from '@/app/api/v1/market/route';
import { GET as tokenGET } from '@/app/api/v1/tokens/[address]/route';

// The public site's URL, for links handed to people and agents.
export const siteUrl = () => (CONFIG.siteUrl || 'https://elysiumpad.world').replace(/\/+$/, '');

async function json(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => ({ error: 'Unreadable answer' }));
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  return body;
}
const req = (path: string) => new NextRequest(`${siteUrl()}${path}`);

/** The tools of the MCP server (app/mcp/route.ts). Reads call the same code as /api/v1; "link" tools only build URLs. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

const num = (v: unknown, lo: number, hi: number, label: string): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label} has to be a number from ${lo} to ${hi}`);
  return n;
};
const addr = (v: unknown): string => {
  if (typeof v !== 'string' || !isAddress(v)) throw new Error('address has to be a 0x token address');
  return v.toLowerCase();
};

export const TOOLS: Tool[] = [
  {
    name: 'elysium_config',
    description: `Chain, RPC, every contract address, fee model and pool settings of ${CONFIG.brand}, and whether launching is live.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => json(await configGET()),
  },
  {
    name: 'elysium_list_launches',
    description: 'Tokens launched on Elysium Pad, newest first (token, creator, pool, taxes, ticks, block, time).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }, before: { type: 'string', description: 'Block number: only launches below it (paging).' } }, additionalProperties: false },
    run: async (a) => {
      const q = new URLSearchParams({ limit: String(a.limit ?? 20) });
      if (a.before !== undefined) q.set('before', String(a.before));
      return json(await launchesGET(req(`/api/v1/launches?${q}`)));
    },
  },
  {
    name: 'elysium_market',
    description: 'Live price (USDC), market cap and change since launch for the newest launches.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    run: async (a) => json(await marketGET(req(`/api/v1/market?limit=${encodeURIComponent(String(a.limit ?? 20))}`))),
  },
  {
    name: 'elysium_get_token',
    description: 'One launch: pool key, live price and market cap, tax waiting to flush, creator description and links.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'Token address (0x…)' } }, required: ['address'], additionalProperties: false },
    run: async (a) => {
      const address = addr(a.address);
      return json(await tokenGET(req(`/api/v1/tokens/${address}`), { params: { address } }));
    },
  },
  {
    name: 'elysium_launch_link',
    description: `Builds a link that opens the create page pre-filled. The person confirms and signs in their own wallet; nothing is sent from here. Market cap $100 to $1M, liquidity equals market cap, tax 0 to 10% each way, creator gets ${FEES.creatorPct}% of the tax.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 32 }, symbol: { type: 'string', description: '2-10 letters or digits' },
        market_cap_usd: { type: 'number', minimum: 100, maximum: 1000000, default: 10000 },
        buy_tax_pct: { type: 'number', minimum: 0, maximum: 10, default: 3 }, sell_tax_pct: { type: 'number', minimum: 0, maximum: 10, default: 3 },
      },
      required: ['name', 'symbol'], additionalProperties: false,
    },
    run: async (a) => {
      const name = String(a.name ?? '').trim();
      const symbol = String(a.symbol ?? '').toUpperCase();
      if (name.length < 2 || name.length > 32) throw new Error('name has to be 2 to 32 characters');
      if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new Error('symbol has to be 2 to 10 letters or digits');
      const mc = num(a.market_cap_usd ?? 10000, 100, 1_000_000, 'market_cap_usd');
      const buy = num(a.buy_tax_pct ?? 3, 0, 10, 'buy_tax_pct');
      const sell = num(a.sell_tax_pct ?? 3, 0, 10, 'sell_tax_pct');
      const q = new URLSearchParams({ name, symbol, mc: String(mc), buyTax: String(buy), sellTax: String(sell) });
      return { url: `${siteUrl()}/create?${q}`, note: 'Open it, connect a wallet on this network, and sign the launch.' };
    },
  },
  {
    name: 'elysium_prepare_launch',
    description: `Builds the transaction that launches a token, ready for the agent's own wallet to sign and send (this server holds no keys and sends nothing). Market cap $100 to $1M, liquidity equals market cap, tax 0 to 10% each way, creator gets ${FEES.creatorPct}% of the tax. Pass \`from\` (the wallet address) to dry-run it on chain first and get an exact gas limit.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 32 }, symbol: { type: 'string', description: '2-10 letters or digits' },
        market_cap_usd: { type: 'number', minimum: 100, maximum: 1000000, default: 10000 },
        buy_tax_pct: { type: 'number', minimum: 0, maximum: 10, default: 3 }, sell_tax_pct: { type: 'number', minimum: 0, maximum: 10, default: 3 },
        from: { type: 'string', description: 'Wallet that will sign (optional, enables the dry run)' },
      },
      required: ['name', 'symbol'], additionalProperties: false,
    },
    run: async (a) => prepareLaunch(a),
  },
  {
    name: 'elysium_prepare_trade',
    description: 'Builds the transactions to buy (spend USDC) or sell (spend the token) a launch: exact-amount approvals, then the router swap, with a live quote and a minimum-out slippage guard. The agent signs and sends each step in order from its own wallet. Pass `from` to skip approvals already in place.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token address (0x…)' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        amount: { type: 'string', description: 'Buy: USDC to spend (e.g. "25.5"). Sell: tokens to sell (e.g. "1000000").' },
        slippage_bps: { type: 'integer', minimum: 0, maximum: 5000, default: 300 },
        from: { type: 'string', description: 'Wallet that will sign (optional)' },
      },
      required: ['token', 'side', 'amount'], additionalProperties: false,
    },
    run: async (a) => prepareTrade(a),
  },
  {
    name: 'elysium_details_message',
    description: 'For a token the agent launched: returns the exact message its wallet signs (personal_sign) to set the token page (description, links, image), and how to POST it. Only the launching wallet can edit a token\'s page.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string' }, description: { type: 'string', maxLength: 200 },
        links: { type: 'object', properties: { x: { type: 'string' }, website: { type: 'string' }, telegram: { type: 'string' } }, additionalProperties: false },
        image_sha256: { type: 'string', description: '0x SHA-256 of the image file, if one will be uploaded' },
      },
      required: ['token'], additionalProperties: false,
    },
    run: async (a) => detailsMessage(a, siteUrl()),
  },
  {
    name: 'elysium_trade_link',
    description: 'Link to a token page, where the market swap (buy or sell against USDC) is signed in the person\'s own wallet.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false },
    run: async (a) => ({ url: `${siteUrl()}/token/${addr(a.address)}`, note: 'Market swap on the token page; nothing is sent from here.' }),
  },
  {
    name: 'elysium_deals_link',
    description: `Link to the discount swap for a token: its sell-side LP-fee tokens, sold for USDC at ${FEES.deskDiscountPct}% under the pool price.`,
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false },
    run: async (a) => ({ url: `${siteUrl()}/deals?token=${addr(a.address)}`, note: 'Separate from the market swap; signed in the person\'s own wallet.' }),
  },
];
