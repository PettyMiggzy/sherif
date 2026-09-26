'use client';
import Link from 'next/link';
import type { Launch } from '@/lib/data';
import { fmtUsd, fmtPct } from '@/lib/format';
import { clsx } from 'clsx';

export function Ticker({ items }: { items: Array<Launch & { priceUsd?: number; change24hPct?: number }> }) {
  if (!items.length) return null;
  const row = [...items, ...items];
  return (
    <div className="panel overflow-hidden">
      <div className="ticker-track flex w-max gap-6 px-4 py-2 text-xs">
        {row.map((t, i) => (
          <Link key={`${t.token}-${i}`} href={`/token/${t.token}`} className="flex items-center gap-2 whitespace-nowrap">
            <span className="font-semibold">${t.symbol}</span>
            <span className="text-muted">{fmtUsd(t.priceUsd)}</span>
            <span className={clsx((t.change24hPct ?? 0) >= 0 ? 'text-up' : 'text-down')}>{fmtPct(t.change24hPct)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
