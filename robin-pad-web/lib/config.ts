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

/** Like addr(), but empty means "not deployed" and gives ''. */
function optAddr(value: string | undefined, label: string, fallback = ''): Address | '' {
  const v = value ?? fallback;
  return v === '' ? '' : addr(v, label);
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
  // main portal (opening market cap $100 and up) and its shared hook.
  // Relaunched 2026-09-27 (20% of tax, every LP fee, fee desk); the
  // 2026-09-26 portal is listed in GENERATIONS below.
  portal: addr(process.env.NEXT_PUBLIC_PORTAL, 'NEXT_PUBLIC_PORTAL', '0xC7006415A6633f87edbbF0feb091c9C460D7D0eC'),
  hook: addr(process.env.NEXT_PUBLIC_HOOK, 'NEXT_PUBLIC_HOOK', '0xcd7098a79B4D5EC5105EE11120f09A93AF81e8cc'),
  treasury: addr(process.env.NEXT_PUBLIC_TREASURY, 'NEXT_PUBLIC_TREASURY', '0x2F59476D23dE13e1Cd171d69Efe1227dE8349D3f'),
  // RobinFeeDesk: on a portal that has one, the platform takes every LP fee
  // (the USDG side to the treasury, the token side to this desk, which sells
  // it at 10% off) and 20% of the tax. Empty: the 2026-09-26 portal, where
  // LP fees and tax both split 90% creator / 10% platform. See lib/fees.ts.
  feeDesk: optAddr(process.env.NEXT_PUBLIC_FEE_DESK, 'NEXT_PUBLIC_FEE_DESK', '0x7151193a74EFBA9026596a09Ac4C43584c3E316D'),
  // White-label pad factory: its pads (the house pad included) also pay the treasury.
  factory: addr(process.env.NEXT_PUBLIC_FACTORY, 'NEXT_PUBLIC_FACTORY', '0x42dfB0740Ee799494F15b791e348A7488bc76970'),
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
  portalGenesisBlock: BigInt(process.env.NEXT_PUBLIC_PORTAL_GENESIS_BLOCK || 73877789),
  poolFee: 10_000,
  tickSpacing: 200,
  totalSupply: 1_000_000_000n * 10n ** 18n,
  maxTaxBps: 1000,
} as const;

export const explorerTx = (h: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/tx/${h}` : '');
export const explorerAddr = (a: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/address/${a}` : '');

/**
 * One deployment of the pad: a portal, the hook its pools use, and its
 * white-label factory. Launches live forever, so after a redeploy the older
 * portals stay listed and tradeable next to the current one.
 */
export type PadGeneration = {
  portal: Address; hook: Address; factory: Address; genesisBlock: bigint;
  /** The fee desk its launches send token-side LP fees to; '' if none. */
  feeDesk: Address | '';
};

const ALL_GENERATIONS: PadGeneration[] = [
  { portal: CONFIG.portal, hook: CONFIG.hook, factory: CONFIG.factory, genesisBlock: CONFIG.portalGenesisBlock, feeDesk: CONFIG.feeDesk },
  // 2026-09-26: 10% platform on tax and USDG LP fees, token-side LP fees burned.
  { portal: '0x7e2f5dEe1A846fF21eE946d2e450F64133d0fD6F', hook: '0x04abDE4e77036178E0DF13d435B7b7f87265e8cc', factory: '0xD637De9DA24007D11e60BDf0B8358b060953D4E8', genesisBlock: 73073570n, feeDesk: '' },
];

/** The current deployment first, then older ones (each once). */
export const GENERATIONS: PadGeneration[] = ALL_GENERATIONS.filter(
  (g, i) => ALL_GENERATIONS.findIndex((x) => x.portal.toLowerCase() === g.portal.toLowerCase()) === i,
);

export function generationOf(portal?: string): PadGeneration {
  return GENERATIONS.find((g) => g.portal.toLowerCase() === portal?.toLowerCase()) ?? GENERATIONS[0];
}
