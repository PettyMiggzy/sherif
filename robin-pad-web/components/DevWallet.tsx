'use client';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { formatUnits, isAddress, type Address } from 'viem';
import { ExternalLink, Landmark, Wallet } from 'lucide-react';
import { CONFIG, explorerAddr } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import { erc20Abi, portalAbi } from '@/lib/abi';
import { shortAddr } from '@/lib/format';

type Balances = { devUsdg: bigint; devEth: bigint; treasury: Address; treasuryUsdg: bigint };

/**
 * Out in the open: what the dev wallet (the wallet that deployed and runs
 * the pad) holds, and what the pad's treasury has collected from the
 * platform's 10%. Read live from the chain.
 */
export function DevWallet() {
  const pc = usePublicClient({ chainId: robinhood.id });
  const dev = CONFIG.padAdmin as Address;
  const enabled = !!pc && isAddress(dev);

  const bal = useQuery({
    queryKey: ['dev-wallet', dev, CONFIG.portal],
    enabled,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Balances> => {
      const treasury = await pc!.readContract({ address: CONFIG.portal, abi: portalAbi, functionName: 'treasury' });
      const [devUsdg, devEth, treasuryUsdg] = await Promise.all([
        pc!.readContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [dev] }),
        pc!.getBalance({ address: dev }),
        pc!.readContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] }),
      ]);
      return { devUsdg, devEth, treasury, treasuryUsdg };
    },
  });

  if (!enabled) return null;
  const d = bal.data;
  const usd = (raw: bigint, dec: number) => Number(formatUnits(raw, dec));

  return (
    <section className="panel p-6">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-white">Where the money sits</h2>
      <p className="mt-1 text-sm text-muted">Live from the chain. Anyone can check these wallets on the explorer.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Holder
          icon={<Wallet className="h-5 w-5" />}
          title="Dev wallet"
          note="Deployed the pad and owns its treasury."
          address={dev}
          rows={[
            ['USDG', d ? `$${usd(d.devUsdg, CONFIG.quoteDecimals).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '…'],
            ['ETH (gas)', d ? `${usd(d.devEth, 18).toLocaleString('en-US', { maximumFractionDigits: 5 })}` : '…'],
          ]}
        />
        <Holder
          icon={<Landmark className="h-5 w-5" />}
          title="Pad treasury"
          note="The platform's 10% of every launch's fees lands here."
          address={d?.treasury}
          rows={[['USDG', d ? `$${usd(d.treasuryUsdg, CONFIG.quoteDecimals).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '…']]}
        />
      </div>
      {bal.isError && <p className="mt-3 text-xs text-down">Couldn&apos;t read balances right now. They&apos;ll refresh on their own.</p>}
    </section>
  );
}

function Holder({ icon, title, note, address, rows }: { icon: ReactNode; title: string; note: string; address?: Address; rows: [string, string][] }) {
  const href = address ? explorerAddr(address) : '';
  return (
    <div className="rounded-xl border border-line bg-panel2/60 p-5">
      <div className="flex items-center gap-3">
        <span className="icon-badge h-10 w-10">{icon}</span>
        <div className="min-w-0">
          <div className="font-display text-lg font-bold uppercase text-white">{title}</div>
          <div className="text-xs text-dim">{note}</div>
        </div>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className="font-bold text-white">{v}</dd>
          </div>
        ))}
      </dl>
      {address && (
        href
          ? <a href={href} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 font-mono text-xs text-brand-hi hover:underline">{shortAddr(address)}<ExternalLink className="h-3.5 w-3.5" /></a>
          : <span className="mt-4 inline-block font-mono text-xs text-muted">{shortAddr(address)}</span>
      )}
    </div>
  );
}
