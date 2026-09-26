'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, ExternalLink, ShieldCheck } from 'lucide-react';
import { CONFIG } from '@/lib/config';
import { goplusReportUrl, summarizeGoPlus, type GoPlusScan } from '@/lib/goplus';

/**
 * GoPlus Security's independent scan of a token: the same data wallets like
 * Trust and OKX use for their warnings. Shown as is, with one note: GoPlus
 * can't yet trade through Uniswap v4 hook pools, so it marks every
 * token on one as a honeypot.
 */
export function GoPlusPanel({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['goplus', token.toLowerCase()],
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<GoPlusScan> => {
      const r = await fetch(`/api/goplus/${token}`);
      if (!r.ok) throw new Error(`GoPlus lookup ${r.status}`);
      return ((await r.json()) as { scan: GoPlusScan }).scan;
    },
  });
  // A scan that fails to load shows nothing rather than a broken box.
  if (q.isLoading || q.isError) return null;

  const report = goplusReportUrl(CONFIG.chainId, token);
  const s = q.data ? summarizeGoPlus(q.data) : null;
  const passed = s ? s.checks.length - s.flagged : 0;

  return (
    <section className="panel p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-brand-hi" />
        <h3 className="font-display text-lg font-bold uppercase text-white">GoPlus scan</h3>
      </div>
      {!s ? (
        <p className="mt-2 text-sm text-muted">
          GoPlus hasn&apos;t scanned this token yet. New tokens usually show up within a day.
        </p>
      ) : (
        <>
          <button className="mt-3 flex w-full items-center justify-between text-left text-sm" onClick={() => setOpen((o) => !o)}>
            <span>
              <span className="font-bold text-up">{passed} checks passed</span>
              {s.flagged > 0 && <span className="font-bold text-gold"> · {s.flagged} flagged</span>}
            </span>
            {open ? <ChevronUp className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />}
          </button>
          {open && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {s.checks.map((c) => (
                <li key={c.label} className={c.ok ? 'text-up' : 'text-gold'}>{c.ok ? '✓' : '✗'} {c.label}</li>
              ))}
              {(s.buyTax !== undefined || s.sellTax !== undefined) && (
                <li className="pt-1 text-muted">Tax GoPlus measured: buy {pct(s.buyTax)}, sell {pct(s.sellTax)}</li>
              )}
            </ul>
          )}
          {s.honeypotFlag && (
            <p className="mt-3 rounded-lg border border-line bg-panel2/60 p-3 text-xs text-muted">
              About the honeypot flag: GoPlus&apos;s test trade can&apos;t go through Uniswap v4 hook pools yet, so it
              flags every token on one. Every {CONFIG.brand} token is a plain ERC-20 with no owner,
              no blacklist and no sell limit, and its source is verified on the explorer. Anyone can sell at any time.
            </p>
          )}
        </>
      )}
      <a href={report} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs text-brand-hi hover:underline">
        Full report on GoPlus <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </section>
  );
}

const pct = (v?: number) => (v === undefined ? '—' : `${(v * 100).toFixed(v * 100 < 1 && v > 0 ? 2 : 0)}%`);
