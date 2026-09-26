'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { notFound } from 'next/navigation';
import { useReadContract } from 'wagmi';
import { clsx } from 'clsx';
import { isAddress, type Address } from 'viem';
import { Crown, Flame, Globe, Send, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { fetchLaunch, fetchLaunches, fetchSpot, getStats, getTrades, getHolders, getCandles, publicClient, type TokenStats } from '@/lib/data';
import { loadMeta } from '@/lib/metadata';
import { normalizeLink } from '@/lib/metaAuth';
import { hookAbi } from '@/lib/abi';
import { CONFIG } from '@/lib/config';
import { poolKeyFor } from '@/lib/pool';
import { fmtUsd, fmtPct, timeAgo } from '@/lib/format';
import { CandleChart } from '@/components/CandleChart';
import { TradePanel } from '@/components/TradePanel';
import { TradesTable } from '@/components/TradesTable';
import { HoldersTable } from '@/components/HoldersTable';
import { TokenIcon } from '@/components/TokenIcon';
import { StatCards } from '@/components/StatCards';
import { FeatureStrip } from '@/components/FeatureStrip';
import { CreatorCard, InfoTab, AddrLink } from '@/components/TokenExtras';
import { GoPlusPanel } from '@/components/GoPlusPanel';
import { askExplorerForSource } from '@/lib/explorerSource';

type Tab = 'chart' | 'trades' | 'holders' | 'info';
const TFS = [['1h', 60, 60], ['4h', 240, 72], ['1d', 900, 96], ['1w', 3600, 168], ['1M', 14400, 180]] as const; // label, interval(s), candle count
const LP_FEE_BPS = CONFIG.poolFee / 100;
const fmtP = (p?: number) => (p === undefined ? '—' : p >= 1 ? p.toFixed(2) : p.toFixed(6));
const HOT_TXNS_24H = 50; // arbitrary, honest threshold — not a mockup fabrication, just a round number

export default function TokenPage({ params }: { params: { address: string } }) {
  const valid = isAddress(params.address);
  const token = (valid ? params.address : '0x0000000000000000000000000000000000000000') as Address;
  const [tab, setTab] = useState<Tab>('chart');
  const [tf, setTf] = useState<(typeof TFS)[number]>(TFS[2]);

  const launch = useQuery({ queryKey: ['launch', token], enabled: valid, queryFn: () => fetchLaunch(token) });
  const meta = useQuery({ queryKey: ['meta', token], enabled: valid, queryFn: () => loadMeta(token) });
  // So the explorer (and the scanners that read it) have this token's source.
  useEffect(() => { if (launch.data) askExplorerForSource(token); }, [launch.data, token]);
  const { key: poolKey, tokenIsToken0 } = useMemo(() => poolKeyFor(token), [token]);

  // Price reads wait for the launch record so they can clamp to its liquidity
  // range (see fetchSpot) — an out-of-range slot0 is free to push and not a price.
  const range = launch.data && launch.data.tickLower !== undefined && launch.data.tickUpper !== undefined
    ? { tickLower: launch.data.tickLower, tickUpper: launch.data.tickUpper } : undefined;
  const spot = useQuery({ queryKey: ['spot', token, range?.tickLower, range?.tickUpper], enabled: valid && launch.isFetched, queryFn: () => fetchSpot(token, range), refetchInterval: 12_000 });
  const stats = useQuery({ queryKey: ['stats', token, !!launch.data], enabled: valid && launch.isFetched, queryFn: () => getStats(token, launch.data, { liquidity: true }), refetchInterval: 20_000 });
  const trades = useQuery({ queryKey: ['trades', token], enabled: valid, queryFn: () => getTrades(token), refetchInterval: 20_000 });
  const holders = useQuery({ queryKey: ['holders', token], enabled: valid && launch.isFetched, queryFn: () => getHolders(token, launch.data) });
  const candles = useQuery({ queryKey: ['candles', token, tf[0]], enabled: valid, queryFn: () => getCandles(token, tf[2], tf[1]), refetchInterval: 60_000 });

  const taxes = useQuery({
    queryKey: ['tax', token, spot.data?.poolId],
    enabled: !!spot.data?.poolId,
    queryFn: () => publicClient.readContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'poolConfigs', args: [spot.data!.poolId] }),
  });

  // Real ranking by 24h volume across every launch. Only with an indexer:
  // without one every volume is unknown, and sorting a list of unknowns would
  // hand out an arbitrary "Trending #1".
  const rank = useQuery({
    queryKey: ['rank', token],
    enabled: valid && !!CONFIG.indexerUrl,
    refetchInterval: 60_000,
    queryFn: async () => {
      const all = await fetchLaunches();
      const withVol = await Promise.all(
        all.map(async (l) => [l.token.toLowerCase(), (await getStats(l.token, l).catch(() => undefined as TokenStats | undefined))?.volume24hUsd ?? 0] as const),
      );
      const sorted = withVol.sort((a, b) => b[1] - a[1]);
      const idx = sorted.findIndex(([t]) => t === token.toLowerCase());
      return idx === -1 ? null : idx + 1;
    },
  });

  if (!valid) return <div className="panel p-8 text-center text-down">That doesn&apos;t look like a token address.</div>;
  // A failed lookup (index or RPC down) is not proof the token doesn't exist —
  // only a successful lookup that comes back empty is a 404.
  if (launch.isError) {
    return (
      <div className="panel space-y-3 p-8 text-center">
        <div className="font-bold text-down">This token didn&apos;t load. Check your connection, then retry.</div>
        <button className="btn-ghost" onClick={() => launch.refetch()}>Retry</button>
      </div>
    );
  }
  if (launch.isSuccess && launch.data === null) return notFound();

  const name = launch.data?.name ?? 'Loading…';
  const symbol = launch.data?.symbol ?? '···';
  const priceUsd = spot.data?.priceUsd ?? 0;
  const up = (stats.data?.change24hPct ?? 0) >= 0;
  const buyTaxBps = taxes.data ? Number(taxes.data[3]) : launch.data?.buyTaxBps ?? 0;
  const sellTaxBps = taxes.data ? Number(taxes.data[4]) : launch.data?.sellTaxBps ?? 0;
  const active = taxes.data ? Boolean(taxes.data[5]) : false;
  const hot = (stats.data?.txns24h ?? 0) >= HOT_TXNS_24H;
  const trendingTop10 = !!rank.data && rank.data <= 10;
  const c = candles.data ?? [];
  const first = c[0], last = c[c.length - 1];

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <div className="panel relative flex flex-col gap-4 overflow-hidden p-5 sm:flex-row sm:flex-wrap sm:items-start sm:gap-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/token-glow.jpg" alt="" className="pointer-events-none absolute inset-y-0 right-0 h-full w-2/3 object-cover opacity-35" />
            <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-panel to-transparent" />
            {/* Icon + name stay paired here (side by side even on mobile,
                narrow as that is) — `sm:contents` unwraps this at sm+ so
                the two become independent flex items of the desktop row
                (icon, name-block, price). */}
            <div className="relative flex items-start gap-4 sm:contents">
              {meta.data?.image
                ? <img src={meta.data.image} alt="" className="relative h-16 w-16 shrink-0 rounded-xl2 object-cover sm:h-28 sm:w-28" />
                : <TokenIcon seed={token} symbol={symbol} className="relative h-16 w-16 shrink-0 rounded-xl2 bg-panel2 sm:h-28 sm:w-28" />}
              <div className="relative min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-black sm:text-2xl">{name}</h1>
                  {trendingTop10 && <span className="chip bg-brand/15 text-brand-hi"><Crown className="mr-1 h-3.5 w-3.5" />Trending #{rank.data}</span>}
                  {hot && <span className="chip bg-gold/10 text-gold"><Flame className="mr-1 h-3.5 w-3.5" />Hot</span>}
                  {active && <span className="chip">tax {buyTaxBps / 100}% / {sellTaxBps / 100}%</span>}
                </div>
                <div className="text-lg text-muted">${symbol}</div>
                {meta.data?.description && <div className="mt-2 text-sm font-semibold text-text/80">{meta.data.description}</div>}
                {launch.data && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span>Created by <AddrLink a={launch.data.creator} /></span><span>·</span><span>{timeAgo(launch.data.createdAt)} ago</span>
                    {safeLink('x', meta.data?.links?.x) && <a href={safeLink('x', meta.data?.links?.x)} target="_blank" rel="noreferrer" className="hover:text-brand-hi"><XIcon /></a>}
                    {safeLink('website', meta.data?.links?.website) && <a href={safeLink('website', meta.data?.links?.website)} target="_blank" rel="noreferrer" className="hover:text-brand-hi"><Globe className="h-4 w-4" /></a>}
                    {safeLink('telegram', meta.data?.links?.telegram) && <a href={safeLink('telegram', meta.data?.links?.telegram)} target="_blank" rel="noreferrer" className="hover:text-brand-hi"><Send className="h-4 w-4" /></a>}
                  </div>
                )}
              </div>
            </div>
            <div className="relative text-left sm:text-right">
              <div className="text-2xl font-black">{fmtUsd(priceUsd)}</div>
              <div className={clsx('flex items-center gap-1 font-bold sm:justify-end', up ? 'text-up' : 'text-down')}>
                {up ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}{fmtPct(stats.data?.change24hPct)}
              </div>
            </div>
          </div>

          <StatCards stats={stats.data} marketCapUsd={spot.data?.marketCapUsd} />

          <div className="flex flex-wrap items-center gap-2">
            {(['chart', 'trades', 'holders', 'info'] as Tab[]).map((t) => (
              <button key={t} className={clsx('rounded-xl px-4 py-2 text-sm font-bold capitalize', tab === t ? 'bg-robin-grad text-ink shadow-btn' : 'bg-panel text-muted hover:text-text')} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
            {tab === 'chart' && (
              <div className="ml-auto flex gap-1">
                {TFS.map((x) => (
                  <button key={x[0]} className={clsx('rounded-lg px-3 py-1.5 text-sm font-semibold', tf[0] === x[0] ? 'bg-brand text-white' : 'text-muted hover:text-text')} onClick={() => setTf(x)}>
                    {x[0]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab === 'chart' && (
            <section className="rounded-xl3 border border-line bg-bg p-4 shadow-card">
              <div className="flex flex-wrap items-center gap-3 px-1 pb-2 text-xs font-semibold text-text/90">
                <span>{symbol}/USD · {tf[0].toUpperCase()} · {CONFIG.brand.toUpperCase()}</span>
                {last && (
                  <>
                    <span className="text-muted">O <span className="text-up">{fmtP(last.o)}</span></span>
                    <span className="text-muted">H <span className="text-up">{fmtP(last.h)}</span></span>
                    <span className="text-muted">L <span className="text-up">{fmtP(last.l)}</span></span>
                    <span className="text-muted">C <span className="text-up">{fmtP(last.c)}</span></span>
                    {first && <span className={last.c >= first.o ? 'text-up' : 'text-down'}>{fmtPct(((last.c - first.o) / first.o) * 100)}</span>}
                  </>
                )}
              </div>
              <CandleChart candles={c} />
            </section>
          )}
          {tab === 'trades' && <section className="panel"><TradesTable trades={trades.data ?? []} symbol={symbol} /></section>}
          {tab === 'holders' && <section className="panel"><HoldersTable holders={holders.data ?? []} /></section>}
          {tab === 'info' && launch.data && (
            <section className="panel">
              <InfoTab launch={launch.data} tokenIsToken0={tokenIsToken0} buyTaxBps={buyTaxBps} sellTaxBps={sellTaxBps} tick={spot.data?.tick} />
            </section>
          )}
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <TradePanel
            token={token} symbol={symbol} poolKey={poolKey} tokenIsToken0={tokenIsToken0}
            lpFeeBps={LP_FEE_BPS} buyTaxBps={buyTaxBps} sellTaxBps={sellTaxBps}
          />
          {launch.data && <CreatorCard launch={launch.data} />}
          {launch.data && <GoPlusPanel token={token} />}
        </aside>
      </div>

      <FeatureStrip />
    </div>
  );
}

// Links are validated server-side on write; checked again here so no stored
// row or local copy can ever render a javascript:/data: href.
function safeLink(kind: 'x' | 'website' | 'telegram', url?: string): string | undefined {
  try { return normalizeLink(kind, url) || undefined; } catch { return undefined; }
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M18.9 2H22l-7.6 8.7L23.3 22h-7l-5.5-7.2L4.5 22H1.4l8.1-9.3L.7 2h7.2l5 6.6L18.9 2zm-1.2 18h1.9L7.1 3.9H5.1L17.7 20z" />
    </svg>
  );
}
