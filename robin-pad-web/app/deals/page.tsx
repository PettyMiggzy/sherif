'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { Tag } from 'lucide-react';
import { fetchLaunches, fetchSpot, publicClient, type Launch } from '@/lib/data';
import { feeDeskAbi, lockerAbi } from '@/lib/abi';
import { CONFIG, generationOf } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { fmtCompact, fmtUsd } from '@/lib/format';
import { TokenIcon } from '@/components/TokenIcon';

type Deal = { launch: Launch; tokens: bigint; cost: bigint; worthUsd?: number; feesWaiting: boolean };

/**
 * Every coin with LP-fee tokens on the fee desk, sold at 10% under the pool
 * price. Buying happens on each token's page (its Fee desk card).
 */
export default function Deals() {
  const deals = useQuery({
    queryKey: ['deals'],
    refetchInterval: 20_000,
    queryFn: async (): Promise<Deal[]> => {
      const launches = (await fetchLaunches()).filter((l) => !!generationOf(l.portal).feeDesk);
      const rows = await Promise.all(launches.map(async (l): Promise<Deal> => {
        const desk = generationOf(l.portal).feeDesk as `0x${string}`;
        const [[tokens, cost], feesWaiting] = await Promise.all([
          publicClient.readContract({ address: desk, abi: feeDeskAbi, functionName: 'quoteAll', args: [l.token] }),
          // harvestFees reverts NothingToHarvest when the pool has earned nothing new.
          publicClient.simulateContract({ address: l.locker, abi: lockerAbi, functionName: 'harvestFees', account: l.creator }).then(() => true, () => false),
        ]);
        const range = l.tickLower !== undefined && l.tickUpper !== undefined ? { tickLower: l.tickLower, tickUpper: l.tickUpper } : undefined;
        const worthUsd = tokens > 0n ? await fetchSpot(l.token, range, l.hook).then((s) => s.priceUsd * Number(formatUnits(tokens, 18))).catch(() => undefined) : undefined;
        return { launch: l, tokens, cost, worthUsd, feesWaiting };
      }));
      return rows
        .filter((d) => d.tokens > 0n || d.feesWaiting)
        .sort((a, b) => (b.worthUsd ?? 0) - (a.worthUsd ?? 0) || Number(b.feesWaiting) - Number(a.feesWaiting));
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-black"><Tag className="h-7 w-7 text-brand-hi" />Deals</h1>
        <p className="mt-1 max-w-2xl text-muted">
          Every sell pays a 1% LP fee in the coin being sold. Those coins are sold here for USDG at {FEES.deskDiscountPct}% under the
          pool price, never dumped into the pool. Pick one to buy it on its page.
        </p>
      </div>

      {deals.isLoading && <div className="panel p-8 text-center text-muted">Checking every coin&apos;s fee desk…</div>}
      {deals.isError && <div className="panel p-8 text-center text-down">The deals didn&apos;t load. Give it a moment and refresh.</div>}
      {deals.data && !deals.data.length && (
        <div className="panel p-8 text-center text-muted">Nothing for sale right now. Each sell on a coin adds to its desk, so check back soon.</div>
      )}

      {!!deals.data?.length && (
        <div className="panel divide-y divide-line">
          {deals.data.map(({ launch: l, tokens, cost, worthUsd, feesWaiting }) => (
            <Link key={l.token} href={`/token/${l.token}#fee-desk`} className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-panel2/60">
              <TokenIcon seed={l.token} symbol={l.symbol} className="h-11 w-11 shrink-0 rounded-xl bg-panel2" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{l.name}</div>
                <div className="text-sm text-muted">${l.symbol}</div>
              </div>
              {tokens > 0n ? (
                <dl className="grid grid-cols-3 gap-6 text-right text-sm tabular-nums">
                  <div><dt className="text-xs text-dim">For sale</dt><dd className="font-bold">{fmtCompact(Number(formatUnits(tokens, 18)))}</dd></div>
                  <div><dt className="text-xs text-dim">Worth</dt><dd className="font-bold">{fmtUsd(worthUsd)}</dd></div>
                  <div><dt className="text-xs text-dim">Yours for</dt><dd className="font-bold text-brand-hi">{fmtUsd(Number(formatUnits(cost, CONFIG.quoteDecimals)))}</dd></div>
                </dl>
              ) : feesWaiting ? (
                <span className="chip">Fees waiting: bring them in on its page</span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
