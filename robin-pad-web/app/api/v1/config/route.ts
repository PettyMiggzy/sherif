import { CONFIG, GENERATIONS } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { apiJson, apiOptions, padIsLive } from '@/lib/publicApi';
import { chainClient } from '@/lib/launches';
import { portalAbi } from '@/lib/abi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Everything a bot needs to configure itself: chain, contracts, pool settings.
export async function GET() {
  const [live, treasury] = await Promise.all([
    padIsLive().catch(() => false),
    chainClient.readContract({ address: CONFIG.portal, abi: portalAbi, functionName: 'treasury' }).catch(() => null),
  ]);
  return apiJson({
    chainId: CONFIG.chainId,
    rpcUrl: CONFIG.rpcUrl,
    explorerUrl: CONFIG.explorerUrl,
    live,
    contracts: {
      portal: CONFIG.portal, hook: CONFIG.hook, treasury, poolManager: CONFIG.poolManager,
      universalRouter: CONFIG.router, permit2: CONFIG.permit2, usdg: CONFIG.usdg,
      feeDesk: CONFIG.feeDesk || null,
    },
    // New launches: the creator's share of the tax, and who gets the LP fee.
    fees: { creatorTaxPct: FEES.creatorPct, platformTaxPct: FEES.platformPct, lpFeeToPlatform: FEES.lpToPlatform, feeDeskDiscountPct: FEES.deskDiscountPct },
    // Earlier deployments whose launches still trade (each launch names its own hook in /api/launches).
    olderPortals: GENERATIONS.slice(1).map((g) => ({ portal: g.portal, hook: g.hook, factory: g.factory })),
    poolFee: CONFIG.poolFee,
    tickSpacing: CONFIG.tickSpacing,
    totalSupply: CONFIG.totalSupply.toString(),
    quoteDecimals: CONFIG.quoteDecimals,
    maxTaxBps: CONFIG.maxTaxBps,
    portalGenesisBlock: CONFIG.portalGenesisBlock.toString(),
  }, { maxAge: 30 });
}

export const OPTIONS = apiOptions;
