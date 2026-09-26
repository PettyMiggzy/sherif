import { clsx } from 'clsx';
import type { Trade } from '@/lib/data';
import { explorerAddr, explorerTx } from '@/lib/config';
import { fmtUsd, shortAddr, timeAgo } from '@/lib/format';

export function TradesTable({ trades, symbol }: { trades: Trade[]; symbol: string }) {
  if (!trades.length) return <div className="panel p-6 text-center text-sm text-dim">Quiet so far: no trades on this pool yet.</div>;
  return (
    <div className="panel overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-dim">
            <th className="px-4 py-3 font-medium">Side</th>
            <th className="px-4 py-3 font-medium">USD</th>
            <th className="px-4 py-3 font-medium">{symbol}</th>
            <th className="px-4 py-3 font-medium">Trader</th>
            <th className="px-4 py-3 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.hash} className="border-b border-line last:border-0 hover:bg-panel2">
              <td className={clsx('px-4 py-2.5 font-medium', t.isBuy ? 'text-up' : 'text-down')}>{t.isBuy ? 'Buy' : 'Sell'}</td>
              <td className="px-4 py-2.5">{fmtUsd(t.usd)}</td>
              <td className="px-4 py-2.5 text-muted">{t.tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
              <td className="px-4 py-2.5">
                <a className="text-brand-hi hover:underline" href={explorerAddr(t.trader) || undefined} target="_blank" rel="noreferrer">{shortAddr(t.trader)}</a>
              </td>
              <td className="px-4 py-2.5 text-right text-dim">
                <a className="hover:underline" href={explorerTx(t.hash) || undefined} target="_blank" rel="noreferrer">{timeAgo(t.ts)} ago</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
