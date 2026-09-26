'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import type { Launch, TokenStats } from '@/lib/data';
import { CONFIG } from '@/lib/config';
import { fmtUsd, fmtPct } from '@/lib/format';
import { loadMeta } from '@/lib/metadata';
import { TokenIcon } from './TokenIcon';

const DAY = 86_400;
const SLOTS = 5;

type Tone = 'live' | 'new';
const PILL: Record<Tone, string> = {
  live: 'bg-up/15 text-up border-up/40',
  new: 'bg-brand/20 text-brand-hi border-brand-hi/40',
};

function Card(p: {
  avatar: ReactNode; name: string; featured?: boolean; pill: { text: string; tone: Tone };
  mcap?: number; change?: number; action: ReactNode;
}) {
  const pct = Math.min(100, ((p.mcap ?? 0) / CONFIG.milestoneUsd) * 100);
  return (
    <div className="panel flex flex-col p-4 transition hover:border-brand-hi/60">
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full border-2 border-brand-hi/60 bg-panel2">{p.avatar}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-brand-hi shadow-[0_0_8px_rgba(212,242,26,.7)]" title={CONFIG.chainName} />
            {p.featured && <span className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-bold text-white">Featured</span>}
          </div>
          <div className="mt-0.5 truncate font-display text-lg font-bold uppercase text-white">{p.name}</div>
          <span className={clsx('mt-0.5 inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', PILL[p.pill.tone])}>{p.pill.text}</span>
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between gap-2">
        <div>
          <div className="font-display text-2xl font-bold text-white">{fmtUsd(p.mcap, { compact: true })}</div>
          <div className="text-xs text-muted">Market Cap</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted">24h</div>
          <div className={clsx('text-sm font-bold', p.change === undefined ? 'text-muted' : p.change >= 0 ? 'text-up' : 'text-down')}>{fmtPct(p.change)}</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line" title={`Progress to a ${fmtUsd(CONFIG.milestoneUsd, { compact: true })} market cap`}>
        <div className="h-full rounded-full bg-robin-grad" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-4">{p.action}</div>
    </div>
  );
}

function LaunchCard({ launch, stats }: { launch: Launch; stats?: TokenStats }) {
  const meta = useQuery({ queryKey: ['meta', launch.token], queryFn: () => loadMeta(launch.token), staleTime: 300_000 });
  const fresh = Date.now() / 1000 - launch.createdAt < DAY;
  return (
    <Card
      avatar={meta.data?.image
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={meta.data.image} alt="" className="h-full w-full object-cover" />
        : <TokenIcon seed={launch.token} symbol={launch.symbol} className="h-full w-full" />}
      name={launch.symbol} pill={fresh ? { text: 'New', tone: 'new' } : { text: 'Live', tone: 'live' }}
      mcap={stats?.marketCapUsd} change={stats?.change24hPct}
      action={<Link href={`/token/${launch.token}`} className="btn-brand w-full py-2.5">Buy Now</Link>}
    />
  );
}

function OpenSlot() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl3 border-2 border-dashed border-line2 bg-panel/40 p-6 text-center">
      <span className="icon-badge h-12 w-12"><Plus className="h-6 w-6" /></span>
      <div className="font-display text-lg font-bold uppercase text-white">Your launch here</div>
      <p className="text-xs text-muted">Launch a token in one transaction. Liquidity is locked from block one.</p>
      <Link href="/create" className="btn-ghost w-full py-2.5">Create a Launch</Link>
    </div>
  );
}

export function FeaturedLaunches({ launches, stats }: { launches: Launch[]; stats: Record<string, TokenStats | undefined> }) {
  const shown = launches.slice(0, SLOTS);
  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <h2 className="section-title">Featured launches</h2>
        <Link href="/explore" className="btn-ghost px-3 py-1.5 text-xs">View All <ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {shown.map((l) => <LaunchCard key={l.token} launch={l} stats={stats[l.token]} />)}
        {Array.from({ length: SLOTS - shown.length }, (_, i) => <OpenSlot key={i} />)}
      </div>
    </section>
  );
}
