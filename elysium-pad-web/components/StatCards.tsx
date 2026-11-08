import { BarChart3, Droplets, Users, TrendingUp } from 'lucide-react';
import type { TokenStats } from '@/lib/data';
import { fmtUsd } from '@/lib/format';

export function StatCards({ stats, marketCapUsd }: { stats?: TokenStats; marketCapUsd?: number }) {
  const items = [
    ['Market Cap', fmtUsd(marketCapUsd ?? stats?.marketCapUsd, { compact: true }), TrendingUp],
    ['24h Volume', fmtUsd(stats?.volume24hUsd, { compact: true }), BarChart3],
    ['Liquidity', fmtUsd(stats?.liquidityUsd, { compact: true }), Droplets],
    ['Holders', stats?.holders !== undefined ? String(stats.holders) : '—', Users],
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map(([label, value, Icon]) => (
        <div key={label} className="panel flex items-center justify-between px-5 py-4">
          <div><div className="text-sm text-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div></div>
          <Icon className="h-8 w-8 text-brand-hi/70" />
        </div>
      ))}
    </div>
  );
}
