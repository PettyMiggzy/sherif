import { fmtUsd } from '@/lib/format';
import { CONFIG } from '@/lib/config';

export function MilestoneBar({ raisedUsd, launches }: { raisedUsd: number; launches: number }) {
  const pct = Math.min(100, (raisedUsd / CONFIG.milestoneUsd) * 100);
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-muted">24h volume goal, all launches</span>
        <span className="font-medium">{fmtUsd(raisedUsd, { compact: true })} <span className="text-dim">/ {fmtUsd(CONFIG.milestoneUsd, { compact: true })}</span></span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-gradient-to-r from-brand to-gold transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-dim">
        <span>{launches} launches</span>
        <span>{pct.toFixed(1)}%</span>
      </div>
    </div>
  );
}
