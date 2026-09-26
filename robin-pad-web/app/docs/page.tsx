import type { ReactNode } from 'react';
import { CONFIG } from '@/lib/config';

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
  // Robin Labs Pad lives on Robinhood Chain mainnet: show its public endpoint,
  // never a paid provider URL.
  const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const siteBase = CONFIG.siteUrl || 'https://www.robinlab.io';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="panel space-y-3 p-8">
        <h1 className="text-3xl font-bold">Docs &amp; API</h1>
        <p className="text-muted">
          Build whatever you like on top: scripts, bots, dashboards, trading tools. You don&apos;t need a key or an
          allowlist, because your code calls the same contracts this site calls, and the only limits are your own RPC
          provider&apos;s. Each launch puts its entire supply into a Uniswap v4 pool paired with USDG, and that
          position stays locked.
        </p>
        <p className="rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm text-text">
          Bots and snipers are welcome. There&apos;s no anti-snipe window, max buy, max wallet, cooldown or blacklist in
          any launch or in the hook, and the first block of every launch is open to everyone.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {[['#network', 'Contracts'], ['#api', 'JSON API'], ['#reading', 'Read'], ['#trading', 'Trade'], ['#creating', 'Launch'], ['#fees', 'Fees'], ['#events', 'Events']].map(([href, label]) => (
            <a key={href} href={href} className="chip border border-transparent hover:border-brand-hi/60">{label}</a>
          ))}
        </div>
      </div>

      <Section id="network" title={`Contracts on ${CONFIG.chainName}`}>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-dim">Addresses this site uses (chain id {CONFIG.chainId})</div>
          <div className="rounded-lg border border-line2 px-3">
            <AddrRow label="RPC (public)" value={PUBLIC_RPC} />
            <AddrRow label="Portal" value={CONFIG.portal} />
            <AddrRow label="Hook" value={CONFIG.hook} />
            <AddrRow label="PoolManager" value={CONFIG.poolManager} />
            <AddrRow label="UniversalRouter" value={CONFIG.router} />
            <AddrRow label="Permit2" value={CONFIG.permit2} />
            <AddrRow label="USDG (every pool's pair)" value={CONFIG.usdg} />
          </div>
        </div>
        <p className="text-xs text-dim">
          Decimals: USDG has 6, launch tokens have 18. Supply is always 1,000,000,000. Gas is paid in ETH;
          trades are in USDG, so a wallet needs a little of both.
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

      <Section id="trading" title="Buying and selling">
        <p className="text-sm text-muted">
          A trade is one v4 exact-input swap on the launch&apos;s pool, sent through Uniswap&apos;s UniversalRouter.
          Whatever you spend (USDG on a buy, the token on a sell) needs two approvals first: the ERC-20 approves
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
// Robinhood Chain's UniversalRouter (v2.1.1) expects SIX fields in SWAP_EXACT_IN_SINGLE:
//   (PoolKey poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum,
//    uint256 minHopPriceX36 /* 0 turns it off */, bytes hookData)
// Encode only five and the call reverts without any error data.

// Getting a quote costs nothing and needs no balance. eth_call execute with two actions,
// SWAP_EXACT_IN_SINGLE then TAKE_ALL(currencyOut, type(uint256).max). That minimum can never
// be met, so the call reverts with V4TooLittleReceived(minAmountOutReceived, amountReceived):
// read the quote from amountReceived.`}</Code>
        <p className="text-xs text-dim">
          Pool order: whichever of the two addresses is smaller, compared as a number, is currency0. On a buy you pay
          USDG, so <code className="font-mono">zeroForOne</code> is true exactly when USDG is currency0; on a sell,
          when the launch token is.
        </p>
      </Section>

      <Section id="creating" title="Launching from code">
        <p className="text-sm text-muted">A single transaction mints the token, opens its USDG pool and locks all 1B tokens in the pool position:</p>
        <Code>{`portal.createLaunch({
  name: "Sherwood Coin",
  symbol: "SHWD",
  startingMarketCapQuote: 10_000_000000n, // $10,000 in USDG's 6 decimals ($100 to $1T on-chain; the site offers up to $1M)
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
          10%, picked at launch and fixed from then on. The tax is always collected in USDG. The tax, plus whatever
          LP fees are earned in USDG, is shared <span className="font-semibold text-text">90% to the creator and 10% to the platform</span>.
        </p>
        <Code>{`hook.flush(poolKey)            // anyone: pushes a pool's waiting tax into its splitter
locker.harvestFees()           // anyone: collects LP fees; USDG fees go to the splitter, token fees are burned
splitter.claim(to, USDG)       // creator only: pays out the creator's 90%
splitter.claimPlatform(USDG)   // anyone: pays the platform's 10% to the treasury`}</Code>
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
