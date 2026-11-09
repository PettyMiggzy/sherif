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

/** A profile value that must be filled in before this network can run. */
function need(v: string, label: string): string {
  if (!v) throw new Error(`The ${NETWORK} profile in lib/config.ts has no ${label} yet. Fill it in (or set its NEXT_PUBLIC_ variable).`);
  return v;
}

/** Like addr(), but empty means "not deployed" and gives ''. */
function optAddr(value: string | undefined, label: string, fallback = ''): Address | '' {
  const v = value ?? fallback;
  return v === '' ? '' : addr(v, label);
}

// Network profiles. The site runs on mainnet unless NEXT_PUBLIC_NETWORK=testnet,
// and every value can still be overridden by its own NEXT_PUBLIC_* variable.
// A profile with a blank value stops the build with a clear message instead
// of pointing at a wrong address.
type Profile = {
  chainId: number; chainName: string; rpcUrl: string; explorerUrl: string; usdc: string;
  portal: string; hook: string; treasury: string; feeDesk: string; factory: string; poolManager: string; router: string;
  genesisBlock: number; backupRpc: string;
};
const PROFILES: Record<'testnet' | 'mainnet', Profile> = {
  testnet: {
    chainId: 99801, chainName: 'Elysium Testnet',
    rpcUrl: 'https://testnet-rpc.elysium.kinetiq.xyz', explorerUrl: 'https://test-explorer.elysium.kinetiq.xyz',
    usdc: '0x7D29d8047B905000459c0E80c34a26CeedcB47b2',
    portal: '0x788A959628C49b7eB92e6FCe9154dF775B4d709c', hook: '0x4eB7CD0299021045A92B67a8EE48DE8aA4CA68Cc',
    treasury: '0x256772d87147C91749646F8365A2D760336F9E92', feeDesk: '0xBfBBa2Db88caf8ae43Db5f066F340229967965e9',
    factory: '0xc7891BB84805D2919573499e0D11149C8972F06D', poolManager: '0xD1a514C574E60aAfCBf9fd822eF64fe963D3B4FA',
    router: '0x4ff52c870735200162A971396a6E599536E67254', genesisBlock: 26320181,
    backupRpc: 'https://elysium-testnet-rpc.hypedexer.com',
  },
  mainnet: {
    chainId: 99901, chainName: 'Elysium',
    // Elyscan (independent explorer and public RPC) until Kinetiq publishes its own endpoints.
    rpcUrl: 'https://rpc.elyscan.live', explorerUrl: 'https://elyscan.live',
    // USDC bridged from HyperEVM's native USDC (l1Address() checked, and HyperEVM's gateway computes this same address).
    usdc: '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65',
    // usdg-pad/script/DeployElysium.s.sol as the deployer 0xDaF4…5fBD0 at nonce 0; rehearsed on a mainnet fork.
    portal: '0x788A959628C49b7eB92e6FCe9154dF775B4d709c', hook: '0x4eB7CD0299021045A92B67a8EE48DE8aA4CA68Cc',
    treasury: '0x256772d87147C91749646F8365A2D760336F9E92', feeDesk: '0xBfBBa2Db88caf8ae43Db5f066F340229967965e9',
    factory: '0xc7891BB84805D2919573499e0D11149C8972F06D', poolManager: '0xD1a514C574E60aAfCBf9fd822eF64fe963D3B4FA',
    router: '0x4ff52c870735200162A971396a6E599536E67254',
    genesisBlock: 3035000, // deployed Nov 9 2026 at blocks 3,035,141 to 3,035,644; no launch can predate it
    backupRpc: 'https://rpc-live.elysp.com', // a second, independent provider; agrees with the primary on block hashes
  },
};
export const NETWORK: 'testnet' | 'mainnet' = process.env.NEXT_PUBLIC_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const P = PROFILES[NETWORK];
export const BACKUP_RPC_DEFAULT = P.backupRpc;

export const CONFIG = {
  // Kinetiq's own Elysium RPC: CORS-open and write-capable (wallets are handed
  // it when they add the network, so it must accept eth_sendRawTransaction).
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? need(P.rpcUrl, 'rpcUrl'),
  // An env var rather than a constant: the default, 99801, is Elysium
  // testnet. Mainnet gets its id from Kinetiq's own docs, set here by env.
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? P.chainId),
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME ?? P.chainName,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? P.explorerUrl,
  brand: process.env.NEXT_PUBLIC_BRAND ?? 'Elysium Pad',
  tagline: process.env.NEXT_PUBLIC_TAGLINE ?? 'Pick your market cap. Launch in one transaction.',
  // The site's public URL, for absolute social-preview links.
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://elysiumpad.world',
  // WalletConnect (Reown) project id. Public by design and not origin-restricted.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '89d7a1882c0fa9a5bbe0a58accafc100',
  // Optional: a separate main site, linked as "Home" in the nav.
  homeUrl: process.env.NEXT_PUBLIC_HOME_URL ?? '',
  // The pad admin wallet (owns the treasury, the factory and the PoolManager), shown on the /admin page.
  padAdmin: process.env.NEXT_PUBLIC_PAD_ADMIN ?? '0x5899a0576A94327a6316E01190f951edf7645914',
  milestoneUsd: Number(process.env.NEXT_PUBLIC_MILESTONE_USD ?? 30000),
  // Elysium Pad on Elysium testnet (usdg-pad/script/DeployElysium.s.sol):
  // the main portal (opening market cap $100 to $1M) and its shared hook.
  // The platform takes 20% of the tax and every LP fee (fee desk below).
  portal: addr(process.env.NEXT_PUBLIC_PORTAL, 'NEXT_PUBLIC_PORTAL', need(P.portal, 'portal')),
  hook: addr(process.env.NEXT_PUBLIC_HOOK, 'NEXT_PUBLIC_HOOK', need(P.hook, 'hook')),
  treasury: addr(process.env.NEXT_PUBLIC_TREASURY, 'NEXT_PUBLIC_TREASURY', need(P.treasury, 'treasury')),
  // RobinFeeDesk: the platform takes every LP fee (the USDC side to the
  // treasury, the token side to this desk, which sells it at 10% off) and
  // 20% of the tax. See lib/fees.ts.
  feeDesk: optAddr(process.env.NEXT_PUBLIC_FEE_DESK, 'NEXT_PUBLIC_FEE_DESK', P.feeDesk),
  // White-label pad factory: its pads (the house pad included) also pay the treasury.
  factory: addr(process.env.NEXT_PUBLIC_FACTORY, 'NEXT_PUBLIC_FACTORY', need(P.factory, 'factory')),
  // Elysium has no Uniswap deployment of its own, so the pad brings both:
  // a v4 PoolManager (Uniswap's v4-core, owned by the pad admin) and
  // PadRouter, which speaks UniversalRouter's execute() for v4 swaps and is
  // paid through the chain's canonical Permit2.
  poolManager: addr(process.env.NEXT_PUBLIC_POOL_MANAGER, 'NEXT_PUBLIC_POOL_MANAGER', need(P.poolManager, 'poolManager')),
  router: addr(process.env.NEXT_PUBLIC_ROUTER, 'NEXT_PUBLIC_ROUTER', need(P.router, 'router')),
  permit2: addr(process.env.NEXT_PUBLIC_PERMIT2, 'NEXT_PUBLIC_PERMIT2', '0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  // USDC bridged from HyperEVM, 6 decimals: every pool's quote asset. Gas is HYPE.
  usdc: addr(process.env.NEXT_PUBLIC_USDC, 'NEXT_PUBLIC_USDC', need(P.usdc, 'usdc')),
  // FALSE, not true: RobinHook/RobinPortal explicitly revert on
  // quoteAsset == address(0) (NativeQuoteUnsupported / ZeroAddress). There
  // is no native-currency code path in these contracts at all; the quote
  // leg is always a real ERC-20 transfer, never msg.value.
  quoteIsNative: (process.env.NEXT_PUBLIC_QUOTE_IS_NATIVE ?? 'false') === 'true',
  quoteDecimals: Number(process.env.NEXT_PUBLIC_QUOTE_DECIMALS ?? 6),
  // Optional. When set, lib/data.ts reads stats/trades/holders/candles from
  // pad-indexer's HTTP API instead of returning honest empty/unknown values for
  // the fields that need real trade history — no other code changes needed.
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? '',
  // The block CONFIG.portal was deployed at (or any block before it). No
  // LaunchCreated log can exist before this, so it's a safe, permanent floor
  // for the launch scan in lib/launches.ts, which avoids an unbounded
  // fromBlock:0 eth_getLogs call.
  portalGenesisBlock: BigInt(process.env.NEXT_PUBLIC_PORTAL_GENESIS_BLOCK || P.genesisBlock),
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
];

/** The current deployment first, then older ones (each once). */
export const GENERATIONS: PadGeneration[] = ALL_GENERATIONS.filter(
  (g, i) => ALL_GENERATIONS.findIndex((x) => x.portal.toLowerCase() === g.portal.toLowerCase()) === i,
);

export function generationOf(portal?: string): PadGeneration {
  return GENERATIONS.find((g) => g.portal.toLowerCase() === portal?.toLowerCase()) ?? GENERATIONS[0];
}
