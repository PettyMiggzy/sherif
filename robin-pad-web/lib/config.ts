import type { Address } from 'viem';

// Next.js only inlines NEXT_PUBLIC_* vars into the client bundle when they're
// referenced as a literal `process.env.NEXT_PUBLIC_X` (static dot access) —
// its compiler pattern-matches that exact syntax at build time. A helper
// that does `process.env[name]` with a dynamic `name` can NEVER be inlined:
// the browser has no real process.env, so that lookup silently returns
// undefined for every visitor, no matter what's set in Vercel. This is why
// each addr() call below passes the already-resolved `process.env.NEXT_PUBLIC_X`
// value in, rather than the var's name — the CONFIG object is what needs the
// static references, not this function.
function addr(value: string | undefined, label: string, fallback?: string): Address {
  const v = value ?? fallback;
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${label} is unset or isn't a 0x address`);
  return v as Address;
}

export const CONFIG = {
  // Robinhood Chain's own RPC: CORS-open and write-capable (wallets are handed
  // it when they add the network, so it must accept eth_sendRawTransaction).
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
  // An env var rather than a constant; the default, 4663, is Robinhood Chain
  // mainnet, where Robin Labs Pad is deployed.
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663),
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Robinhood Chain',
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://robinhoodchain.blockscout.com',
  brand: process.env.NEXT_PUBLIC_BRAND ?? 'Robin Labs Pad',
  tagline: process.env.NEXT_PUBLIC_TAGLINE ?? 'Pick your price. Launch in one transaction.',
  // The site's public URL, for absolute social-preview links. robinlab.io
  // (the apex) redirects to www at the domain level.
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.robinlab.io',
  // WalletConnect (Reown) project id: the same one robinlab.io uses
  // (pad/assets/config.js). Public by design and not origin-restricted.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '89d7a1882c0fa9a5bbe0a58accafc100',
  // Optional: a separate main site, linked as "Home" in the nav. Empty since
  // this site is robinlab.io itself.
  homeUrl: process.env.NEXT_PUBLIC_HOME_URL ?? '',
  // The pad admin wallet (deployer; owns the treasury and factory), shown on the /admin page.
  padAdmin: process.env.NEXT_PUBLIC_PAD_ADMIN ?? '0x5899a0576A94327a6316E01190f951edf7645914',
  milestoneUsd: Number(process.env.NEXT_PUBLIC_MILESTONE_USD ?? 30000),
  // Robin Labs Pad on Robinhood Chain (usdg-pad/docs/ROBINHOOD-DEPLOY.md): the
  // main portal (10% platform / 90% creator, opening market cap $100 and up) and
  // the one shared hook. Deployed 2026-09-26.
  portal: addr(process.env.NEXT_PUBLIC_PORTAL, 'NEXT_PUBLIC_PORTAL', '0x7e2f5dEe1A846fF21eE946d2e450F64133d0fD6F'),
  hook: addr(process.env.NEXT_PUBLIC_HOOK, 'NEXT_PUBLIC_HOOK', '0x04abDE4e77036178E0DF13d435B7b7f87265e8cc'),
  treasury: addr(process.env.NEXT_PUBLIC_TREASURY, 'NEXT_PUBLIC_TREASURY', '0x2F59476D23dE13e1Cd171d69Efe1227dE8349D3f'),
  // White-label pad factory: its pads (the house pad included) also pay the treasury.
  factory: addr(process.env.NEXT_PUBLIC_FACTORY, 'NEXT_PUBLIC_FACTORY', '0xD637De9DA24007D11e60BDf0B8358b060953D4E8'),
  // Uniswap v4's PoolManager and UniversalRouter (v2.1.1) on Robinhood Chain.
  poolManager: addr(process.env.NEXT_PUBLIC_POOL_MANAGER, 'NEXT_PUBLIC_POOL_MANAGER', '0x8366a39CC670B4001A1121B8F6A443A643e40951'),
  router: addr(process.env.NEXT_PUBLIC_ROUTER, 'NEXT_PUBLIC_ROUTER', '0x8876789976decbfcbbbe364623c63652db8c0904'),
  permit2: addr(process.env.NEXT_PUBLIC_PERMIT2, 'NEXT_PUBLIC_PERMIT2', '0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  // USDG (Global Dollar, Paxos), 6 decimals: every pool's quote asset. Gas is ETH.
  usdg: addr(process.env.NEXT_PUBLIC_USDG, 'NEXT_PUBLIC_USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  // FALSE, not true (see the comment in .env.example):
  // RobinHook/RobinPortal explicitly revert on quoteAsset == address(0)
  // (NativeQuoteUnsupported / ZeroAddress). There is no native-currency
  // code path in these contracts at all — confirmed directly against
  // RobinLocker's unconditional IERC20.safeTransfer usage on both pool
  // currencies. The quote leg is always a real ERC-20 transfer, never
  // msg.value.
  quoteIsNative: (process.env.NEXT_PUBLIC_QUOTE_IS_NATIVE ?? 'false') === 'true',
  quoteDecimals: Number(process.env.NEXT_PUBLIC_QUOTE_DECIMALS ?? 6),
  // Optional. When set, lib/data.ts reads stats/trades/holders/candles from
  // pad-indexer's HTTP API instead of returning honest empty/unknown values for
  // the fields that need real trade history — no other code changes needed.
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? '',
  // The block CONFIG.portal was deployed at. No LaunchCreated log can exist
  // before this, so it's a safe, permanent floor for the launch scan in
  // lib/launches.ts — it avoids an unbounded fromBlock:0 eth_getLogs call,
  // which public RPC providers (Alchemy included) reject past a ~10k block
  // range on any chain with real age.
  portalGenesisBlock: BigInt(process.env.NEXT_PUBLIC_PORTAL_GENESIS_BLOCK || 73073570),
  poolFee: 10_000,
  tickSpacing: 200,
  totalSupply: 1_000_000_000n * 10n ** 18n,
  maxTaxBps: 1000,
} as const;

export const explorerTx = (h: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/tx/${h}` : '');
export const explorerAddr = (a: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/address/${a}` : '');
