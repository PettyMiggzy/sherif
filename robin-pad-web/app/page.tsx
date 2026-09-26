'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchLaunches, getStats, type Launch, type TokenStats } from '@/lib/data';
import { priceFromTick } from '@/lib/pool';
import { CONFIG } from '@/lib/config';
import { fmtUsd } from '@/lib/format';
import { Hero, StatsBar, STAT_ICONS, LaunchPromo, WhyPanel, HowItWorks, CtaBanner, type Stat } from '@/components/HomeSections';
import { FeaturedLaunches } from '@/components/FeaturedLaunches';
import { DevWallet } from '@/components/DevWallet';
import { askExplorerForSources } from '@/lib/explorerSource';

const DAY = 86_400;

/** The price a launch opened at: the pool opens exactly at its position's edge. */
function openingPrice(l: Launch): number | undefined {
  if (l.tokenIsToken0 === undefined || l.tickLower === undefined || l.tickUpper === undefined) return undefined;
  return priceFromTick(l.tokenIsToken0 ? l.tickLower : l.tickUpper, l.tokenIsToken0, CONFIG.quoteDecimals);
}

const sumOf = (xs: (number | undefined)[]) => (xs.some((x) => x !== undefined) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : undefined);

export default function Home() {
  const launches = useQuery({ queryKey: ['launches'], queryFn: () => fetchLaunches(), refetchInterval: 20_000 });
  const all = launches.data ?? [];
  const tokens = all.map((l) => l.token);
  // Newest first; once per visit (see lib/explorerSource.ts).
  useEffect(() => { askExplorerForSources(tokens.slice(0, 30)); }, [tokens.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useQuery({
    queryKey: ['stats', tokens],
    enabled: tokens.length > 0,
    refetchInterval: 20_000,
    queryFn: async () =>
      Object.fromEntries(await Promise.all(all.map(async (l) => [l.token, await getStats(l.token, l).catch(() => undefined)] as const))) as Record<string, TokenStats | undefined>,
  });
  const st = stats.data ?? {};

  // Every number below is real: counted from the launch index, read from the
  // pools, or summed from the indexer. Without an indexer, volume and holders
  // show "—" instead of a made-up figure.
  const now = Date.now() / 1000;
  const newToday = all.filter((l) => now - l.createdAt < DAY).length;
  const volume = sumOf(all.map((l) => st[l.token]?.volume24hUsd));
  const holders = sumOf(all.map((l) => st[l.token]?.holders));
  const priced = all.filter((l) => st[l.token] && openingPrice(l) !== undefined);
  const above = priced.filter((l) => st[l.token]!.priceUsd > openingPrice(l)! * 1.000001).length;
  const successRate = priced.length ? Math.round((100 * above) / priced.length) : undefined;

  const items: Stat[] = [
    { icon: STAT_ICONS.Rocket, label: 'Total launches', value: launches.data ? all.length.toLocaleString() : '—', delta: newToday ? `+${newToday} 24h` : undefined },
    { icon: STAT_ICONS.BarChart3, label: '24h volume', value: volume === undefined ? '—' : fmtUsd(volume, { compact: true }) },
    { icon: STAT_ICONS.Trophy, label: 'Success rate', value: successRate === undefined ? '—' : `${successRate}%`, hint: 'Share of launches trading above their launch price' },
    { icon: STAT_ICONS.Users, label: 'Holders', value: holders === undefined ? '—' : holders.toLocaleString() },
  ];

  const featured = [...all].sort((a, b) => (st[b.token]?.marketCapUsd ?? 0) - (st[a.token]?.marketCapUsd ?? 0) || b.createdAt - a.createdAt);

  return (
    <div className="space-y-12">
      <div>
        <Hero />
        <StatsBar items={items} />
      </div>
      <section className="grid gap-5 lg:grid-cols-[1.75fr_1fr]">
        <LaunchPromo />
        <WhyPanel />
      </section>
      {launches.isError && <div className="panel p-5 text-center text-sm text-down">The launch list didn&apos;t load. Give it a moment and refresh.</div>}
      <FeaturedLaunches launches={featured} stats={st} />
      <DevWallet />
      <HowItWorks />
      <CtaBanner />
    </div>
  );
}
