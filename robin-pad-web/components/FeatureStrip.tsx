import { Rocket, Lock, CircleDollarSign, Users } from 'lucide-react';
import { CONFIG } from '@/lib/config';

export function FeatureStrip() {
  const items = [
    [Rocket, 'Fair start', 'Whole supply goes into the pool'],
    [Lock, 'Locked liquidity', 'No withdraw function exists'],
    [CircleDollarSign, 'Priced in USDG', `A dollar pool on ${CONFIG.chainName}`],
    [Users, 'Creator-first', '90% of the fees go to the creator'],
  ] as const;
  return (
    <div className="panel grid grid-cols-2 divide-y divide-line md:grid-cols-4 md:divide-x md:divide-y-0">
      {items.map(([Icon, t, s]) => (
        <div key={t} className="flex items-center gap-4 px-6 py-5">
          <Icon className="h-8 w-8 shrink-0 text-brand-hi" />
          <div><div className="font-bold">{t}</div><div className="text-sm text-muted">{s}</div></div>
        </div>
      ))}
    </div>
  );
}
