export const shortAddr = (a?: string, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : '—');

export function fmtUsd(v: number | undefined, opts: { compact?: boolean; digits?: number } = {}) {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (opts.compact) return '$' + fmtCompact(v);
  if (Math.abs(v) < 0.01 && v !== 0) return '$' + v.toPrecision(3);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: opts.digits ?? 2 });
}

export function fmtCompact(v: number) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(a < 1 ? 4 : 2);
}

export const fmtPct = (p?: number) => (p === undefined ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
export const bpsToPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;

export function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function parseUnitsSafe(v: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') return null;
  const [i = '0', f = ''] = v.split('.');
  return BigInt(i + f.slice(0, decimals).padEnd(decimals, '0'));
}
