'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { fetchLaunches, getStats, publicClient, type Launch, type TokenStats } from '@/lib/data';
import { hookAbi } from '@/lib/abi';
import { CONFIG } from '@/lib/config';
import { askExplorerForSources } from '@/lib/explorerSource';
import { Ticker } from '@/components/Ticker';
import { MilestoneBar } from '@/components/MilestoneBar';
import { TokenCard } from '@/components/TokenCard';

type Sort = 'new' | 'mcap' | 'vol' | 'gainers';

export default function Explore() {
  const [sort, setSort] = useState<Sort>('new');
  const [q, setQ] = useState('');

  const launches = useQuery({ queryKey: ['launches'], queryFn: () => fetchLaunches(), refetchInterval: 20_000 });
  // Once per visit (see lib/explorerSource.ts).
  useEffect(() => { askExplorerForSources((launches.data ?? []).slice(0, 60).map((l) => l.token)); }, [launches.data]);

  const stats = useQuery({
    queryKey: ['stats', launches.data?.map((l) => l.token)],
    enabled: !!launches.data?.length,
    queryFn: async () => {
      const entries = await Promise.all(launches.data!.map(async (l) => [l.token, await getStats(l.token, l).catch(() => undefined)] as const));
      return Object.fromEntries(entries) as Record<string, TokenStats | undefined>;
    },
    refetchInterval: 20_000,
  });

  const taxes = useQuery({
    queryKey: ['taxes', launches.data?.map((l) => l.poolId)],
    enabled: !!launches.data?.length,
    queryFn: async () => {
      const res = await publicClient.multicall({
        contracts: launches.data!.map((l) => ({ address: CONFIG.hook, abi: hookAbi, functionName: 'poolConfigs' as const, args: [l.poolId] })),
      });
      return Object.fromEntries(launches.data!.map((l, i) => {
        const r = res[i];
        return [l.token, r.status === 'success' ? { buy: Number(r.result[3]), sell: Number(r.result[4]) } : undefined];
      }));
    },
  });

  const list = useMemo(() => {
    let arr: Launch[] = launches.data ?? [];
    const s = q.trim().toLowerCase();
    if (s) {
      arr = arr.filter((l) => l.name.toLowerCase().includes(s) || l.symbol.toLowerCase().includes(s) || l.token.toLowerCase() === s);
    }
    const st = stats.data ?? {};
    const by = (f: (s?: TokenStats) => number) => [...arr].sort((a, b) => f(st[b.token]) - f(st[a.token]));
    if (sort === 'mcap') return by((s) => s?.marketCapUsd ?? 0);
    if (sort === 'vol') return by((s) => s?.volume24hUsd ?? 0);
    if (sort === 'gainers') return by((s) => s?.change24hPct ?? -1e9);
    return arr;
  }, [launches.data, stats.data, sort, q]);

  const totalVol = Object.values(stats.data ?? {}).reduce((a, s) => a + (s?.volume24hUsd ?? 0), 0);
  const tickerItems = (launches.data ?? []).map((l) => ({ ...l, priceUsd: stats.data?.[l.token]?.priceUsd, change24hPct: stats.data?.[l.token]?.change24hPct }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black">Browse launches</h1>
          <p className="mt-1 text-muted">Every token launched on {CONFIG.brand}, each trading in its own USDG pool with locked liquidity.</p>
        </div>
        <Link href="/create" className="btn-brand">Create a Launch</Link>
      </div>

      <Ticker items={tickerItems} />
      <MilestoneBar raisedUsd={totalVol} launches={launches.data?.length ?? 0} />

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {([['new', 'New'], ['mcap', 'Market cap'], ['vol', '24h volume'], ['gainers', 'Gainers']] as [Sort, string][]).map(([k, label]) => (
            <button key={k} className={clsx('tab', sort === k && 'tab-active')} onClick={() => setSort(k)}>{label}</button>
          ))}
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-dim" />
            <input className="input pl-9" placeholder="Search name, ticker or address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search launches" />
          </div>
          <span className="text-xs text-dim">{list.length} tokens</span>
        </div>

        {launches.isLoading && <div className="panel p-8 text-center text-muted">Fetching launches…</div>}
        {launches.isError && <div className="panel p-8 text-center text-down">The launch list didn&apos;t load. Give it a moment and refresh.</div>}
        {launches.data && !list.length && <div className="panel p-8 text-center text-muted">{q.trim() ? 'No launch matches that search.' : 'Such empty. Nobody has launched yet, so the first one could be yours.'}</div>}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((l) => <TokenCard key={l.token} launch={l} stats={stats.data?.[l.token]} taxBps={taxes.data?.[l.token]} />)}
        </div>
      </section>
    </div>
  );
}
