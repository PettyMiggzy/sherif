'use client';
import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { formatUnits } from 'viem';
import { Tag } from 'lucide-react';
import { fetchLaunches, fetchSpot, publicClient, type Launch } from '@/lib/data';
import { feeDeskAbi, lockerAbi } from '@/lib/abi';
import { CONFIG, generationOf } from '@/lib/config';
import { FEES } from '@/lib/fees';
import { fmtCompact, fmtUsd } from '@/lib/format';
import { TokenIcon } from '@/components/TokenIcon';
import { FeeDeskCard } from '@/components/FeeDeskCard';

type Deal = { launch: Launch; tokens: bigint; cost: bigint; worthUsd?: number; feesWaiting: boolean };

/**
 * The discount swap: every new coin's fee-desk tokens (its sell-side LP fees)
 * at 10% under the pool price. Separate from the market swap on each token
 * page. Pick a coin on the left, buy it on the right; ?token= preselects one.
 */
export default function DealsPage() {
  return <Suspense><Deals /></Suspense>;
}

function Deals() {
  const router = useRouter();
  const pathname = usePathname();
  const picked = useSearchParams().get('token')?.toLowerCase();

  const launches = useQuery({ queryKey: ['launches'], queryFn: () => fetchLaunches(), refetchInterval: 20_000 });
  const deskLaunches = useMemo(() => (launches.data ?? []).filter((l) => !!generationOf(l.portal).feeDesk), [launches.data]);
  const deals = useQuery({
    queryKey: ['deals', deskLaunches.map((l) => l.token)],
    enabled: launches.isSuccess,
    refetchInterval: 20_000,
    queryFn: async (): Promise<Deal[]> => {
      const rows = await Promise.all(deskLaunches.map(async (l): Promise<Deal> => {
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

  const list = deals.data ?? [];
  // The coin in the swap: the one asked for (even with nothing for sale yet), else the top deal.
  const selected = deskLaunches.find((l) => l.token.toLowerCase() === picked) ?? list[0]?.launch;
  const pick = (l: Launch) => router.replace(`${pathname}?token=${l.token}`, { scroll: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-black"><Tag className="h-7 w-7 text-brand-hi" />Deals: the discount swap</h1>
        <p className="mt-1 max-w-3xl text-muted">
          Every sell pays a 1% LP fee in the coin being sold. Those coins are sold here for USDG at {FEES.deskDiscountPct}% under the
          pool price, never dumped into the pool. This is separate from the market swap on each coin&apos;s page.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <section className="space-y-3">
          {(launches.isLoading || deals.isLoading) && <div className="panel p-8 text-center text-muted">Checking every coin&apos;s discount swap…</div>}
          {(launches.isError || deals.isError) && <div className="panel p-8 text-center text-down">The deals didn&apos;t load. Give it a moment and refresh.</div>}
          {deals.data && !list.length && (
            <div className="panel p-8 text-center text-muted">Nothing for sale right now. Each sell on a coin adds to its discount swap, so check back soon.</div>
          )}
          {!!list.length && (
            <div className="panel divide-y divide-line">
              {list.map(({ launch: l, tokens, cost, worthUsd, feesWaiting }) => {
                const on = selected?.token === l.token;
                return (
                  <button key={l.token} onClick={() => pick(l)} aria-pressed={on} data-token={l.token}
                    className={clsx('flex w-full flex-wrap items-center gap-4 px-5 py-4 text-left hover:bg-panel2/60', on && 'bg-panel2/80 shadow-[inset_3px_0_0_#D4F21A]')}>
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
                    ) : feesWaiting ? <span className="chip">New fees waiting to be brought in</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          {selected ? (
            <>
              <FeeDeskCard key={selected.token} launch={selected} symbol={selected.symbol} />
              <Link href={`/token/${selected.token}`} className="block text-center text-sm text-muted hover:text-text">
                Market swap and chart for ${selected.symbol} →
              </Link>
            </>
          ) : deals.data && (
            <div className="panel p-5 text-sm text-muted">Pick a coin to buy it here at {FEES.deskDiscountPct}% under market.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
