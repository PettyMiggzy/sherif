import type { ReactNode } from 'react';
import { CONFIG } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { UsdcNotice } from '@/components/UsdcNotice';

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-bg border border-line2 p-4 text-xs leading-relaxed text-text">
      <code>{children}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="panel space-y-4 p-6">
      <h2 className="text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

function AddrRow({ label, value }: { label: string; value: string }) {
  const isPlaceholder = value === '0x0000000000000000000000000000000000000000';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className={isPlaceholder ? 'font-mono text-xs text-dim' : 'font-mono text-xs'}>
        {isPlaceholder ? 'not set on this site' : value}
      </span>
    </div>
  );
}

export const metadata = { title: `${CONFIG.brand} docs` };

export default function Docs() {
  const indexerBase = CONFIG.indexerUrl || 'https://your-indexer.example.com';
  // Kinetiq's public Elysium endpoint (CONFIG.rpcUrl), never a paid provider URL.
  const PUBLIC_RPC = CONFIG.rpcUrl;
  const siteBase = CONFIG.siteUrl || 'https://elysiumpad.world';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="panel space-y-3 p-8">
        <h1 className="text-3xl font-bold">Docs &amp; API</h1>
        <p className="text-muted">
          Build whatever you like on top: scripts, bots, dashboards, trading tools. You don&apos;t need a key or an
          allowlist, because your code calls the same contracts this site calls, and the only limits are your own RPC
          provider&apos;s. Each launch puts its entire supply into a Uniswap v4 pool paired with USDC, and that
          position stays locked.
        </p>
        <p className="rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm text-text">
          Bots and snipers are welcome. There&apos;s no anti-snipe window, max buy, max wallet, cooldown or blacklist in
          any launch or in the hook, and the first block of every launch is open to everyone.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {[['#network', 'Contracts'], ['#api', 'JSON API'], ['#mcp', 'MCP & agents'], ['#reading', 'Read'], ['#trading', 'Trade'], ['#creating', 'Launch'], ['#fees', 'Fees'], ['#events', 'Events']].map(([href, label]) => (
            <a key={href} href={href} className="chip border border-transparent hover:border-brand-hi/60">{label}</a>
          ))}
        </div>
      </div>

      <Section id="network" title={`Contracts on ${CONFIG.chainName}`}>
        <UsdcNotice full />
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-dim">Addresses this site uses (chain id {CONFIG.chainId})</div>
          <div className="rounded-lg border border-line2 px-3">
            <AddrRow label="RPC (public)" value={PUBLIC_RPC} />
            <AddrRow label="Portal" value={CONFIG.portal} />
            <AddrRow label="Hook" value={CONFIG.hook} />
            {CONFIG.feeDesk && <AddrRow label="Fee desk" value={CONFIG.feeDesk} />}
            <AddrRow label="PoolManager" value={CONFIG.poolManager} />
            <AddrRow label="Router (PadRouter)" value={CONFIG.router} />
            <AddrRow label="Permit2" value={CONFIG.permit2} />
            <AddrRow label="USDC (every pool's pair)" value={CONFIG.usdc} />
          </div>
        </div>
        <p className="text-xs text-dim">
          Decimals: USDC has 6, launch tokens have 18. Supply is always 1,000,000,000. Gas is paid in HYPE;
          trades are in USDC, so a wallet needs a little of both.
        </p>
        <p className="text-xs text-dim">
          Elysium has no official Uniswap v4 deployment yet, so {CONFIG.brand} runs on its own copy of Uniswap&apos;s
          v4-core PoolManager, compiled unmodified from Uniswap&apos;s code. As on every v4 deployment, its owner can do
          one thing: name a protocol-fee controller. Nothing else about a pool can be changed by anyone.
        </p>
      </Section>

      <Section id="api" title="Public JSON API">
        <p className="text-sm text-muted">
          This site serves the pad&apos;s data as JSON. No key, no sign-up, and any website or bot can call it (CORS is
          open). Responses are cached for a few seconds at the edge, so poll as often as you like.
        </p>
        <Code>{`GET ${siteBase}/api/v1/config            # chain, RPC, every contract address, pool settings, live or not
GET ${siteBase}/api/v1/launches?limit=50  # newest first; &before=<block> pages back
GET ${siteBase}/api/v1/market?limit=30    # live price, market cap, change since launch
GET ${siteBase}/api/v1/tokens/0xToken     # one launch: pool key, price, tax waiting to flush, details`}</Code>
        <Code>{`curl ${siteBase}/api/v1/market?limit=1
# { "live": true, "updatedAt": 1790400000, "tokens": [ { "address": "0x…", "symbol": "ROBIN",
#   "priceUsd": 0.0000021, "marketCapUsd": 2100, "changeSinceLaunchPct": 84.2,
#   "buyTaxBps": 200, "sellTaxBps": 400, "createdAt": 1790399000, "image": null } ] }`}</Code>
      </Section>

      <Section id="reading" title="Reading launches and prices">
        <p className="text-sm text-muted">Pick a source:</p>
        <div>
          <h3 className="mb-1 font-semibold">Option A: straight from the chain</h3>
          <p className="mb-2 text-sm text-muted">Each launch is one <code className="font-mono">LaunchCreated</code> log on the portal. For a live price, read the pool&apos;s slot0 with a single <code className="font-mono">extsload</code> call on PoolManager. There&apos;s nothing else to run.</p>
        </div>
        <div>
          <h3 className="mb-1 font-semibold">Option B: the pad-indexer HTTP API</h3>
          <p className="mb-2 text-sm text-muted">pad-indexer stores launches, trades, holders and candles in its own database, so you can skip scanning logs yourself. The base URL below is this site&apos;s indexer when one is set.</p>
          <Code>{`GET ${indexerBase}/launches
GET ${indexerBase}/stats/:token
GET ${indexerBase}/trades/:token?n=30
GET ${indexerBase}/holders/:token?n=20
GET ${indexerBase}/candles/:token?n=96&interval=900   # OHLCV; interval in seconds, 900 by default`}</Code>
          <Code>{`curl ${indexerBase}/stats/0xTokenAddress
# { "priceUsd": 0.000042, "marketCapUsd": 42000, "volume24hUsd": 3150.5,
#   "change24hPct": -2.7, "holders": 88, "txns24h": 19, "liquidityUsd": 7400 }`}</Code>
        </div>
      </Section>

      <Section id="mcp" title="MCP server and agent files">
        <p className="text-sm text-muted">
          AI agents can use {CONFIG.brand} through an MCP server: <code className="font-mono">{siteBase}/mcp</code>.
          No key and no sign-up. It reads the same live chain data as the JSON API. To launch or trade, an agent calls
          a prepare tool and signs the returned transactions with its own wallet; people get links instead. The server
          holds no keys, signs nothing and sends no transactions.
        </p>
        <div className="overflow-x-auto rounded-lg border border-line2">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-dim"><tr><th className="p-3">Tool</th><th className="p-3">What it does</th></tr></thead>
            <tbody className="divide-y divide-line">
              {[
                ['elysium_config', 'Chain, RPC, every contract, the fee model, and whether launching is live'],
                ['elysium_list_launches', 'Launches, newest first (limit, before)'],
                ['elysium_market', 'Live price, market cap and change since launch'],
                ['elysium_get_token', 'One launch: pool key, price, pending tax, creator details'],
                ['elysium_prepare_launch', 'The launch transaction, ready for your wallet to sign (name, symbol, market cap $100 to $1M, taxes 0 to 10%). Pass from to dry-run it'],
                ['elysium_prepare_trade', 'Approvals plus the router swap to buy with USDC or sell a token, with a live quote and a minimum-out guard'],
                ['elysium_details_message', 'The message the launching wallet signs to set a token\'s description, image and links'],
                ['elysium_launch_link', 'A pre-filled create page link (name, symbol, market cap $100 to $1M, taxes 0 to 10%)'],
                ['elysium_trade_link', 'The token page, for the market swap'],
                ['elysium_deals_link', `The discount swap for a token (${FEES.deskDiscountPct}% under the pool)`],
              ].map(([t, d]) => (
                <tr key={t}><td className="whitespace-nowrap p-3 font-mono text-xs text-brand-hi">{t}</td><td className="p-3 text-muted">{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs uppercase tracking-wider text-dim">Add it to a client</p>
        <Code>{`# Claude Code
claude mcp add --transport http elysium-pad ${siteBase}/mcp

# Any client that takes a JSON config (Streamable HTTP)
{ "mcpServers": { "elysium-pad": { "type": "http", "url": "${siteBase}/mcp" } } }

# Or call it directly
curl -s ${siteBase}/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elysium_market","arguments":{"limit":5}}}'

# Plain REST for the same transactions (GET, no key)
${siteBase}/api/v1/tx/launch?name=Gladius&symbol=GLAD&market_cap_usd=30000&from=0xYourWallet
${siteBase}/api/v1/tx/trade?token=0xToken&side=buy&amount=25&from=0xYourWallet`}</Code>
        <p className="text-sm text-muted">
          For code generators there is an OpenAPI 3.1 description of the JSON API at{' '}
          <a className="text-brand-hi underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>, and a plain-text
          map of the site for agents at <a className="text-brand-hi underline" href="/llms.txt">/llms.txt</a>, with a
          fuller guide at <a className="text-brand-hi underline" href="/llms-full.txt">/llms-full.txt</a> and the MCP server card at{' '}
          <a className="text-brand-hi underline" href="/.well-known/mcp/server-card.json">/.well-known/mcp/server-card.json</a>. The create page
          also accepts <code className="font-mono">?name=&amp;symbol=&amp;mc=&amp;buyTax=&amp;sellTax=</code> to pre-fill the form.
        </p>
      </Section>

      <Section id="trading" title="Buying and selling">
        <p className="text-sm text-muted">
          A trade is one v4 exact-input swap on the launch&apos;s pool, sent through PadRouter, the pad&apos;s swap
          router. It speaks Uniswap UniversalRouter&apos;s <code className="font-mono">execute</code> for v4 swaps
          (command 0x10, V4_SWAP, and nothing else), so UniversalRouter v4 swap code works against it unchanged.
          Whatever you spend (USDC on a buy, the token on a sell) needs two approvals first: the ERC-20 approves
          Permit2, then Permit2 approves the router. Each one lasts until it is used up, expires or is revoked.
          This site approves exactly the amount of each trade, never an unlimited amount, and the router&apos;s
          allowance expires after a day.
        </p>
        <Code>{`// Step 1: let Permit2 move the amount you're spending
erc20.approve(PERMIT2, amount)

// Step 2: let the router spend it through Permit2 (this site sets a 1-day expiry)
permit2.approve(token, ROUTER, amount, expiration)

// Step 3: the swap
router.execute(commands, inputs, deadline)
// commands = 0x10 (V4_SWAP)
// actions  = SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)
// PadRouter, like UniversalRouter v2.1.1, expects SIX fields in SWAP_EXACT_IN_SINGLE:
//   (PoolKey poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum,
//    uint256 minHopPriceX36 /* 0 turns it off */, bytes hookData)
// Encode only five and the call reverts without any error data.

// Getting a quote costs nothing and needs no balance. eth_call execute with two actions,
// SWAP_EXACT_IN_SINGLE then TAKE_ALL(currencyOut, type(uint256).max). That minimum can never
// be met, so the call reverts with V4TooLittleReceived(minAmountOutReceived, amountReceived):
// read the quote from amountReceived.`}</Code>
        <p className="text-xs text-dim">
          Pool order: whichever of the two addresses is smaller, compared as a number, is currency0. On a buy you pay
          USDC, so <code className="font-mono">zeroForOne</code> is true exactly when USDC is currency0; on a sell,
          when the launch token is.
        </p>
      </Section>

      <Section id="creating" title="Launching from code">
        <p className="text-sm text-muted">A single transaction mints the token, opens its USDC pool and locks all 1B tokens in the pool position:</p>
        <Code>{`portal.createLaunch({
  name: "Laurel Coin",
  symbol: "LAUREL",
  startingMarketCapQuote: 10_000_000000n, // $10,000 in USDC's 6 decimals ($100 to $1T on-chain; the site offers up to $1M)
  buyTaxBps: 200,  // 2%, up to 1000 (10%)
  sellTaxBps: 400, // 4%
})
// emits LaunchCreated(token, creator, locker, splitter, poolId, quoteAsset,
//                     tokenIsToken0, buyTaxBps, sellTaxBps, tickLower, tickUpper,
//                     initSqrtPriceX96, name, symbol)`}</Code>
        <p className="text-xs text-dim">Every launch gets a splitter contract of its own, and the creator can claim from it whenever they like (see Fees).</p>
      </Section>

      <Section id="fees" title="Fees and claims">
        <p className="text-sm text-muted">
          A trade pays two things: the pool&apos;s 1% LP fee, and the creator&apos;s tax for that side, anywhere from 0 to
          10%, picked at launch and fixed from then on. The tax is always collected in USDC.{' '}
          {FEES.lpToPlatform ? (
            <>The tax is shared <span className="font-semibold text-text">{FEES.creatorPct}% to the creator and {FEES.platformPct}% to the platform</span>.
            The LP fee goes to the platform: the USDC side to the treasury, and the token side (sells pay it in the token)
            to the fee desk, which sells those tokens for USDC at {FEES.deskDiscountPct}% under the pool price instead of selling them into the pool.</>
          ) : (
            <>The tax, plus whatever LP fees are earned in USDC, is shared <span className="font-semibold text-text">{FEES.creatorPct}% to the creator and {FEES.platformPct}% to the platform</span>.</>
          )}
        </p>
        <Code>{FEES.lpToPlatform ? `hook.flush(poolKey)            // anyone: pushes a pool's waiting tax into its splitter
locker.harvestFees()           // anyone: collects LP fees; USDC to the treasury, tokens to the fee desk
feeDesk.buy(token, usdcIn, minOut, to)  // anyone: buys the desk's tokens at ${FEES.deskDiscountPct}% off, USDC to the treasury
splitter.claim(to, USDC)       // creator only: pays out the creator's ${FEES.creatorPct}%
splitter.claimPlatform(USDC)   // anyone: pays the platform's ${FEES.platformPct}% to the treasury` : `hook.flush(poolKey)            // anyone: pushes a pool's waiting tax into its splitter
locker.harvestFees()           // anyone: collects LP fees; USDC fees go to the splitter, token fees are burned
splitter.claim(to, USDC)       // creator only: pays out the creator's ${FEES.creatorPct}%
splitter.claimPlatform(USDC)   // anyone: pays the platform's ${FEES.platformPct}% to the treasury`}</Code>
        <p className="text-xs text-dim">
          Swaps never pay anyone out directly, so if a payout address gets stuck or blocklisted, only its own claim
          fails and trading carries on. A creator can pass the role to another wallet in two steps:{' '}
          <code className="font-mono">transferCreator</code>, then <code className="font-mono">acceptCreator</code> from the new wallet.
        </p>
      </Section>

      <Section id="events" title="Events">
        <Code>{`event LaunchCreated(
  address indexed token, address indexed creator, address locker, address splitter,
  bytes32 poolId, address quoteAsset, bool tokenIsToken0,
  uint16 buyTaxBps, uint16 sellTaxBps, int24 tickLower, int24 tickUpper,
  uint160 initSqrtPriceX96, string name, string symbol
);

event Swap( // emitted by PoolManager for every pool: filter on id
  bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1,
  uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee
);

event TaxCollected(bytes32 indexed poolId, address indexed quoteAsset, bool isBuy, uint256 amount);`}</Code>
      </Section>
    </div>
  );
}
