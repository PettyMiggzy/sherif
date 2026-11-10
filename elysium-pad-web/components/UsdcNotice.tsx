'use client';
import { useState } from 'react';
import { CONFIG, explorerAddr } from '@/lib/config';

// The one USDC this pad uses. Said plainly wherever people are about to spend
// it, because USDC on other chains (or lookalike tokens) will not work here.
export function UsdcNotice({ full = false, className = '' }: { full?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const href = explorerAddr(CONFIG.usdc);
  async function copy() {
    try { await navigator.clipboard.writeText(CONFIG.usdc); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the address is selectable below */ }
  }
  return (
    <div className={`rounded-xl border border-line2 bg-panel2 p-3 text-xs text-muted ${className}`}>
      <p>
        <span className="font-semibold text-text">Which USDC?</span> This pad uses the USDC on {CONFIG.chainName}, not USDC on other chains.
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <code className="select-all break-all font-mono text-[11px] text-brand-hi">{CONFIG.usdc}</code>
        <button type="button" onClick={copy} className="rounded-md border border-line2 px-2 py-0.5 text-[11px] hover:border-brand">{copied ? 'Copied' : 'Copy'}</button>
        {href && <a className="text-[11px] text-brand-hi underline" href={href} target="_blank" rel="noreferrer">View on explorer</a>}
      </div>
      <p className="mt-1.5"><a className="text-brand-hi underline" href="/bridge">How to get this USDC</a></p>
      {full && (
        <p className="mt-1.5">
          It has {CONFIG.quoteDecimals} decimals and is bridged in from HyperEVM&apos;s native USDC. Check this address before you buy or
          import it, because other tokens can be named &quot;USDC&quot;. Gas on {CONFIG.chainName} is paid in HYPE, so keep a little HYPE in the same wallet.
        </p>
      )}
    </div>
  );
}
