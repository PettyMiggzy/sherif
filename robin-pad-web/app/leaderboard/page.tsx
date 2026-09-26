'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Crown } from 'lucide-react';
import { fetchLaunches, getStats, type TokenStats } from '@/lib/data';
import { CONFIG } from '@/lib/config';
import { fmtUsd, fmtPct, shortAddr } from '@/lib/format';
import { TokenIcon } from '@/components/TokenIcon';

export default function Leaderboard() {
  const launches = useQuery({ queryKey: ['launches'], queryFn: () => fetchLaunches(), refetchInterval: 20_000 });

  const stats = useQuery({
    queryKey: ['stats', launches.data?.map((l) => l.token)],
    enabled: !!launches.data?.length,
    queryFn: async () => {
      const entries = await Promise.all(launches.data!.map(async (l) => [l.token, await getStats(l.token, l).catch(() => undefined)] as const));
      return Object.fromEntries(entries) as Record<string, TokenStats | undefined>;
    },
    refetchInterval: 20_000,
  });

  // Same ranking every token's own page shows ("Trending #N") — 24h volume
  // across every real launch, nothing curated or hand-picked.
  const ranked = useMemo(() => {
    const arr = launches.data ?? [];
    const st = stats.data ?? {};
    return [...arr].sort((a, b) => (st[b.token]?.volume24hUsd ?? 0) - (st[a.token]?.volume24hUsd ?? 0));
  }, [launches.data, stats.data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black">Leaderboard</h1>
        <p className="mt-1 text-muted">Top launches on {CONFIG.brand}, sorted by how much USDG changed hands in the last 24 hours.</p>
      </div>

      {launches.isLoading && <div className="panel p-8 text-center text-muted">Fetching launches…</div>}
      {launches.isError && <div className="panel p-8 text-center text-down">The launch list didn&apos;t load. Give it a moment and refresh.</div>}
      {launches.data && !ranked.length && <div className="panel p-8 text-center text-muted">Such empty. Nobody has launched yet, so the first one could be yours.</div>}

      {!!ranked.length && (
        <div className="panel divide-y divide-line overflow-hidden">
          {ranked.map((l, i) => {
            const s = stats.data?.[l.token];
            const up = (s?.change24hPct ?? 0) >= 0;
            return (
              <Link key={l.token} href={`/token/${l.token}`} className="flex items-center gap-4 p-4 transition hover:bg-panel2">
                <span className={clsx('flex w-7 shrink-0 items-center justify-center font-black', i < 3 ? 'text-brand-hi' : 'text-dim')}>
                  {i < 3 ? <Crown className="h-5 w-5" /> : i + 1}
                </span>
                <TokenIcon seed={l.token} symbol={l.symbol} className="h-10 w-10 shrink-0 rounded-lg bg-panel2" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{l.name} <span className="font-normal text-muted">${l.symbol}</span></div>
                  <div className="text-xs text-dim">by {shortAddr(l.creator)}</div>
                </div>
                <div className="hidden text-right sm:block">
                  <div className="font-semibold">{fmtUsd(s?.volume24hUsd, { compact: true })}</div>
                  <div className="text-xs text-dim">24h volume</div>
                </div>
                <div className={clsx('w-16 shrink-0 text-right text-sm font-medium', up ? 'text-up' : 'text-down')}>{fmtPct(s?.change24hPct)}</div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
