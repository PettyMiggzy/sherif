import type { Holder } from '@/lib/data';
import { explorerAddr } from '@/lib/config';
import { fmtCompact, shortAddr } from '@/lib/format';

export function HoldersTable({ holders }: { holders: Holder[] }) {
  if (!holders.length) return <div className="panel p-6 text-center text-sm text-dim">No holders to show yet.</div>;
  return (
    <div className="panel overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-dim">
            <th className="px-4 py-3 font-medium">#</th>
            <th className="px-4 py-3 font-medium">Address</th>
            <th className="px-4 py-3 font-medium">Balance</th>
            <th className="px-4 py-3 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {holders.map((h, i) => (
            <tr key={h.address} className="border-b border-line last:border-0 hover:bg-panel2">
              <td className="px-4 py-2.5 text-dim">{i + 1}</td>
              <td className="px-4 py-2.5">
                <a className="text-brand-hi hover:underline" href={explorerAddr(h.address) || undefined} target="_blank" rel="noreferrer">{shortAddr(h.address)}</a>
                {h.tag && <span className="chip ml-2">{h.tag}</span>}
              </td>
              <td className="px-4 py-2.5 text-muted">{fmtCompact(h.balance)}</td>
              <td className="px-4 py-2.5 text-right font-medium">{h.pct.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
