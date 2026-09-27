'use client';
import Link from 'next/link';
import { usePublicClient, useReadContract } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { Tag } from 'lucide-react';
import type { Launch } from '@/lib/data';
import { feeDeskAbi, lockerAbi } from '@/lib/abi';
import { generationOf } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import { feeModel } from '@/lib/fees';
import { fmtCompact } from '@/lib/format';

/**
 * On the token page, under the market swap: a pointer to this coin's
 * discount swap on /deals, when its fee desk has tokens for sale or new
 * sell-side fees are waiting in the pool to be brought onto it. The
 * discount swap itself lives on /deals so the two swaps stay separate.
 */
export function DiscountLink({ launch, symbol }: { launch: Launch; symbol: string }) {
  const desk = generationOf(launch.portal).feeDesk;
  const stock = useReadContract({ address: desk || undefined, abi: feeDeskAbi, functionName: 'inventory', args: [launch.token], chainId: robinhood.id, query: { enabled: !!desk, refetchInterval: 20_000 } });
  const pc = usePublicClient({ chainId: robinhood.id });
  // harvestFees reverts NothingToHarvest when the pool has earned nothing new.
  const waiting = useQuery({
    queryKey: ['canHarvest', launch.locker],
    enabled: !!desk && !!pc,
    refetchInterval: 30_000,
    queryFn: () => pc!.simulateContract({ address: launch.locker, abi: lockerAbi, functionName: 'harvestFees', account: launch.creator }).then(() => true, () => false),
  });
  if (!desk || (!stock.data && !waiting.data)) return null;
  return (
    <Link href={`/deals?token=${launch.token}`} className="panel flex items-center gap-3 p-4 hover:border-brand-hi/60">
      <Tag className="h-5 w-5 shrink-0 text-brand-hi" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold">
          {stock.data ? `${fmtCompact(Number(formatUnits(stock.data, 18)))} ${symbol}` : symbol} at {feeModel(launch.portal).deskDiscountPct}% under market
        </div>
        <div className="text-muted">A separate discount swap, on Deals</div>
      </div>
      <span className="text-sm font-bold text-brand-hi">Open →</span>
    </Link>
  );
}
