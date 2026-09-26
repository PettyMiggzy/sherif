'use client';
import { useState, type ReactNode } from 'react';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import type { Launch } from '@/lib/data';
import { splitterAbi, lockerAbi, hookAbi } from '@/lib/abi';
import { robinhood } from '@/lib/chain';
import { poolKeyFor } from '@/lib/pool';
import { CONFIG, explorerAddr, explorerTx } from '@/lib/config';
import { shortAddr, bpsToPct } from '@/lib/format';
import { explainTxError } from '@/lib/txError';
import { useEnsureChain } from '@/lib/ensureChain';

export function AddrLink({ a }: { a: string }) {
  const href = explorerAddr(a);
  return href
    ? <a className="text-brand-hi hover:underline" href={href} target="_blank" rel="noreferrer">{shortAddr(a)}</a>
    : <span>{shortAddr(a)}</span>;
}

export function InfoTab({ launch, tokenIsToken0, buyTaxBps, sellTaxBps, tick }: { launch: Launch; tokenIsToken0: boolean; buyTaxBps: number; sellTaxBps: number; tick?: number }) {
  const rows: [string, ReactNode][] = [
    ['Token', <AddrLink key="token" a={launch.token} />],
    ['Creator', <AddrLink key="creator" a={launch.creator} />],
    ['Locker (holds the LP)', <AddrLink key="locker" a={launch.locker} />],
    ['Splitter', <AddrLink key="splitter" a={launch.splitter} />],
    ['Hook', <AddrLink key="hook" a={CONFIG.hook} />],
    ['Pool ID', <span key="poolid" className="font-mono text-xs">{launch.poolId}</span>],
    ['Currency order', tokenIsToken0 ? `currency0 = ${launch.symbol}, currency1 = USDG` : `currency0 = USDG, currency1 = ${launch.symbol}`],
    ['Current tick', tick === undefined ? '—' : String(tick)],
    ['LP fee', '1% on every swap'],
    ['Buy tax', bpsToPct(buyTaxBps)],
    ['Sell tax', bpsToPct(sellTaxBps)],
    ['Supply', '1,000,000,000, all of it in the locked pool position'],
    ['Creator cut', '90% of the tax and USDG LP fees, credited by the splitter'],
    ['Launch transaction', <a key="txhash" className="font-mono text-xs text-brand-hi hover:underline" href={explorerTx(launch.txHash) || undefined} target="_blank" rel="noreferrer">{shortAddr(launch.txHash, 8)}</a>],
  ];
  return (
    <div className="divide-y divide-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
          <dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd>
        </div>
      ))}
    </div>
  );
}

/**
 * Creator revenue. Swap tax is always taken in USDG and waits in the hook
 * (pendingTax) until someone calls the permissionless hook.flush(key), which
 * moves it into the splitter. Quote-side LP fees reach the splitter through
 * the locker's permissionless harvestFees() (token-side LP fees are burned).
 * The splitter then credits the creator 90% (main pad) or 85% (white-label
 * pad); only USDG is ever credited.
 */
export function CreatorCard({ launch }: { launch: Launch }) {
  const { address } = useAccount();
  const pc = usePublicClient({ chainId: robinhood.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const poolKey = poolKeyFor(launch.token).key;
  const keyTuple = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks] as const;

  const creator = useReadContract({ address: launch.splitter, abi: splitterAbi, functionName: 'creator', chainId: robinhood.id });
  // A creator can hand the role to another wallet in two steps; the new
  // wallet accepts here.
  const pendingCreator = useReadContract({ address: launch.splitter, abi: splitterAbi, functionName: 'pendingCreator', chainId: robinhood.id });
  const mainPad = useReadContract({ address: launch.splitter, abi: splitterAbi, functionName: 'isMainPad', chainId: robinhood.id });
  const credUsdg = useReadContract({ address: launch.splitter, abi: splitterAbi, functionName: 'creditedToCreator', args: [CONFIG.usdg], chainId: robinhood.id, query: { refetchInterval: 15_000 } });
  const pending = useReadContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'pendingTax', args: [launch.poolId], chainId: robinhood.id, query: { refetchInterval: 15_000 } });
  // harvestFees reverts NothingToHarvest when no LP fees have accrued — ask
  // the chain first instead of offering a button that sends a doomed tx.
  const canHarvest = useQuery({
    queryKey: ['canHarvest', launch.locker],
    enabled: !!pc,
    refetchInterval: 30_000,
    queryFn: () => pc!.simulateContract({ address: launch.locker, abi: lockerAbi, functionName: 'harvestFees', account: address ?? launch.creator }).then(() => true, () => false),
  });

  const isCreator = !!address && !!creator.data && address.toLowerCase() === creator.data.toLowerCase();
  const isPendingCreator = !!address && !!pendingCreator.data && address.toLowerCase() === pendingCreator.data.toLowerCase();
  const usdg = credUsdg.data ?? 0n;
  const pendingTax = pending.data ?? 0n;
  const sharePct = mainPad.data === undefined ? undefined : mainPad.data ? 90 : 85;
  const fmt = (v: bigint) => Number(formatUnits(v, CONFIG.quoteDecimals)).toFixed(4);

  // Each action is first run against the chain as a simulation, so a call that
  // would fail never reaches the wallet (and its "likely to fail" warning).
  async function run(label: string, check: () => Promise<unknown>, send: () => Promise<`0x${string}`>) {
    if (!pc) return;
    setMsg(null); setBusy(label);
    try {
      await ensureChain();
      await check();
      const h = await send();
      const r = await pc.waitForTransactionReceipt({ hash: h });
      setMsg(r.status === 'success' ? `${label} went through.` : `${label} failed on-chain.`);
      credUsdg.refetch(); pending.refetch(); canHarvest.refetch(); creator.refetch(); pendingCreator.refetch();
    } catch (e: unknown) {
      setMsg(explainTxError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Creator earnings</h3>
        <span className="chip">{sharePct === undefined ? '…' : `Creator gets ${sharePct}%`}</span>
      </div>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-muted">Ready to claim (USDG)</dt><dd className="font-bold">{fmt(usdg)}</dd></div>
        <div className="flex justify-between" title="Tax the hook is holding for this pool. A flush moves it into the splitter, which credits the creator's share.">
          <dt className="text-muted">Tax held in the hook</dt><dd className="font-bold">{fmt(pendingTax)}</dd>
        </div>
        <div className="flex justify-between"><dt className="text-muted">Creator</dt><dd><AddrLink a={creator.data ?? launch.creator} /></dd></div>
      </dl>

      <div className="grid grid-cols-2 gap-2">
        <button className="btn-ghost" disabled={pendingTax === 0n || !!busy || !address}
          onClick={() => run('Flush tax',
            () => pc!.simulateContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'flush', args: [keyTuple], account: address! }),
            () => writeContractAsync({ address: CONFIG.hook, abi: hookAbi, functionName: 'flush', args: [keyTuple], chainId: robinhood.id }))}>
          Flush tax
        </button>
        <button className="btn-ghost" disabled={!canHarvest.data || !!busy || !address}
          title={canHarvest.data ? 'Sends the fees this pool has earned to the splitter' : 'Nothing earned since the last harvest'}
          onClick={() => run('Harvest LP fees',
            () => pc!.simulateContract({ address: launch.locker, abi: lockerAbi, functionName: 'harvestFees', account: address! }),
            () => writeContractAsync({ address: launch.locker, abi: lockerAbi, functionName: 'harvestFees', chainId: robinhood.id }))}>
          Harvest LP fees
        </button>
      </div>
      {isPendingCreator && (
        <button className="btn-brand w-full" disabled={!!busy}
          onClick={() => run('Accept creator role',
            () => pc!.simulateContract({ address: launch.splitter, abi: splitterAbi, functionName: 'acceptCreator', account: address! }),
            () => writeContractAsync({ address: launch.splitter, abi: splitterAbi, functionName: 'acceptCreator', chainId: robinhood.id }))}>
          {busy ?? 'Accept the creator role'}
        </button>
      )}
      {isCreator && (
        <button className="btn-brand w-full" disabled={usdg === 0n || !!busy}
          onClick={() => run('Claim USDG',
            () => pc!.simulateContract({ address: launch.splitter, abi: splitterAbi, functionName: 'claim', args: [address!, CONFIG.usdg], account: address! }),
            () => writeContractAsync({ address: launch.splitter, abi: splitterAbi, functionName: 'claim', args: [address!, CONFIG.usdg], chainId: robinhood.id }))}>
          {busy ?? `Claim ${fmt(usdg)} USDG`}
        </button>
      )}
      <p className="text-xs text-dim">Anyone can flush or harvest; both just move money into the splitter. Claiming is creator-only.</p>
      {msg && <div className="text-xs text-muted">{msg}</div>}
    </div>
  );
}
