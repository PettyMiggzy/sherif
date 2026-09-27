'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, type Hash } from 'viem';
import { Tag } from 'lucide-react';
import type { Launch } from '@/lib/data';
import { erc20Abi, feeDeskAbi, lockerAbi } from '@/lib/abi';
import { CONFIG, explorerTx, generationOf } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import { feeModel } from '@/lib/fees';
import { fmtCompact, parseUnitsSafe } from '@/lib/format';
import { explainTxError } from '@/lib/txError';
import { useEnsureChain } from '@/lib/ensureChain';

// The desk's price can only rise between the quote and the transaction (it
// never goes below the block's opening price), so leave a little room.
const DESK_SLIPPAGE_BPS = 100n;

/**
 * The discount swap (the fee desk): every sell pays its 1% LP fee in this
 * token, and on the current portal those tokens are sold here for USDG at
 * 10% under the pool price instead of being sold into the pool. The USDG
 * goes to the platform. It lives on /deals, apart from the token page's
 * market swap, so the two are never confused.
 */
export function FeeDeskCard({ launch, symbol }: { launch: Launch; symbol: string }) {
  const desk = generationOf(launch.portal).feeDesk;
  const fees = feeModel(launch.portal);
  const { address, isConnected } = useAccount();
  const pc = usePublicClient({ chainId: robinhood.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();
  const [amount, setAmount] = useState('');
  const [debounced, setDebounced] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(amount), 300); return () => clearTimeout(t); }, [amount]);

  const enabled = !!desk && !!pc;
  const all = useReadContract({ address: desk || undefined, abi: feeDeskAbi, functionName: 'quoteAll', args: [launch.token], chainId: robinhood.id, query: { enabled, refetchInterval: 15_000 } });
  // harvestFees reverts NothingToHarvest when the pool has earned nothing new.
  const canCollect = useQuery({
    queryKey: ['canHarvest', launch.locker],
    enabled,
    refetchInterval: 30_000,
    queryFn: () => pc!.simulateContract({ address: launch.locker, abi: lockerAbi, functionName: 'harvestFees', account: address ?? launch.creator }).then(() => true, () => false),
  });
  const usdgBal = useReadContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [address!], chainId: robinhood.id, query: { enabled: !!address, refetchInterval: 15_000 } });

  const quoteIn = useMemo(() => parseUnitsSafe(debounced, CONFIG.quoteDecimals) ?? 0n, [debounced]);
  const quote = useQuery({
    queryKey: ['deskQuote', launch.token, quoteIn.toString()],
    enabled: enabled && quoteIn > 0n,
    refetchInterval: 12_000,
    queryFn: () => pc!.readContract({ address: desk as `0x${string}`, abi: feeDeskAbi, functionName: 'quote', args: [launch.token, quoteIn] }),
  });

  if (!desk) return null;
  const [stock, cost] = all.data ?? [undefined, undefined];
  const typed = parseUnitsSafe(amount, CONFIG.quoteDecimals) ?? 0n;
  const ready = typed > 0n && typed === quoteIn && !!quote.data;
  const [tokensOut, quotePaid] = ready ? quote.data! : [0n, 0n];
  const short = usdgBal.data !== undefined && ready && quotePaid > usdgBal.data;
  const fmtTok = (v: bigint) => `${fmtCompact(Number(formatUnits(v, 18)))} ${symbol}`;
  const fmtUsd = (v: bigint) => `$${Number(formatUnits(v, CONFIG.quoteDecimals)).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

  async function waitOk(hash: Hash, what: string) {
    const r = await pc!.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${what} failed on-chain`);
  }

  async function collect() {
    if (!pc || !address) return;
    setErr(null); setTx(null);
    try {
      setBusy(`Checking your wallet is on ${CONFIG.chainName}…`);
      await ensureChain();
      await pc.simulateContract({ address: launch.locker, abi: lockerAbi, functionName: 'harvestFees', account: address });
      setBusy('Waiting on your wallet…');
      const h = await writeContractAsync({ chainId: robinhood.id, address: launch.locker, abi: lockerAbi, functionName: 'harvestFees' });
      setTx(h); setBusy(`Waiting for ${CONFIG.chainName}…`);
      await waitOk(h, 'Collecting fees');
      all.refetch(); canCollect.refetch();
    } catch (e: unknown) {
      setErr(explainTxError(e));
    } finally {
      setBusy(null);
    }
  }

  async function buy() {
    if (!pc || !address || !ready || tokensOut === 0n) return;
    setErr(null); setTx(null);
    const minOut = (tokensOut * (10_000n - DESK_SLIPPAGE_BPS)) / 10_000n;
    try {
      setBusy(`Checking your wallet is on ${CONFIG.chainName}…`);
      await ensureChain();
      // Exact-amount approval, like every trade on this site.
      const allowance = await pc.readContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'allowance', args: [address, desk as `0x${string}`] });
      if (allowance < quoteIn) {
        setBusy('Approving this amount…');
        await waitOk(await writeContractAsync({ chainId: robinhood.id, address: CONFIG.usdg, abi: erc20Abi, functionName: 'approve', args: [desk as `0x${string}`, quoteIn] }), 'Approval');
      }
      setBusy('Checking the purchase…');
      await pc.simulateContract({ address: desk as `0x${string}`, abi: feeDeskAbi, functionName: 'buy', args: [launch.token, quoteIn, minOut, address], account: address });
      setBusy('Waiting on your wallet…');
      const h = await writeContractAsync({ chainId: robinhood.id, address: desk as `0x${string}`, abi: feeDeskAbi, functionName: 'buy', args: [launch.token, quoteIn, minOut, address] });
      setTx(h); setBusy(`Waiting for ${CONFIG.chainName}…`);
      await waitOk(h, 'Purchase');
      setAmount(''); all.refetch(); usdgBal.refetch(); quote.refetch();
    } catch (e: unknown) {
      setErr(explainTxError(e));
    } finally {
      setBusy(null);
    }
  }

  const empty = stock === 0n;
  return (
    <div className="panel space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold"><Tag className="h-4 w-4 text-brand-hi" />Discount swap: {symbol}</h3>
        <span className="chip bg-brand/15 text-brand-hi">{fees.deskDiscountPct}% under the pool</span>
      </div>
      <p className="text-xs text-muted">
        Not the market swap. Every sell pays its 1% LP fee in {symbol}; those tokens are sold here at {fees.deskDiscountPct}% under the pool price, never into the pool.
      </p>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-muted">For sale</dt><dd className="font-bold">{stock === undefined ? '…' : fmtTok(stock)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Buy it all for</dt><dd className="font-bold">{cost === undefined ? '…' : empty ? '—' : fmtUsd(cost)}</dd></div>
      </dl>

      {!empty && stock !== undefined && (
        <>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-xl border border-line2 bg-bg px-3 py-2.5 font-semibold text-text placeholder:text-dim outline-none focus:border-brand-hi"
              inputMode="decimal" placeholder="USDG" value={amount} onChange={(e) => setAmount(e.target.value)}
            />
            <button className="rounded-xl border border-line2 bg-panel px-3 text-sm font-bold hover:bg-panel2"
              onClick={() => cost !== undefined && setAmount(formatUnits(cost, CONFIG.quoteDecimals))}>All</button>
          </div>
          {ready && (
            <div className="text-sm text-muted">
              You get <span className="font-bold text-text">{fmtTok(tokensOut)}</span>
              {quoteIn - quotePaid >= 10_000n && <> for <span className="font-bold text-text">{fmtUsd(quotePaid)}</span> (all that&apos;s left)</>}
            </div>
          )}
          {!isConnected ? (
            <div className="btn-brand w-full opacity-90">Connect a wallet first</div>
          ) : (
            <button className="btn-brand w-full" disabled={!ready || tokensOut === 0n || short || !!busy} onClick={buy}>
              {busy ?? (short ? 'Not enough USDG' : typed === 0n ? `Buy ${symbol} at ${fees.deskDiscountPct}% off` : !ready ? 'Getting a price…' : `Buy ${fmtTok(tokensOut)}`)}
            </button>
          )}
        </>
      )}

      {canCollect.data && (
        <button className="btn-ghost w-full" disabled={!!busy || !address} onClick={collect}
          title="Pulls the LP fees this pool has earned since the last collection: USDG to the platform, tokens onto this desk">
          {empty ? busy ?? 'Bring in new fees to buy' : 'Bring in new fees'}
        </button>
      )}
      {empty && !canCollect.data && <p className="text-xs text-dim">Nothing for sale yet. The next sells will stock it.</p>}
      {tx && <a className="block truncate text-xs text-brand-hi" href={explorerTx(tx) || undefined} target="_blank" rel="noreferrer">tx {tx}</a>}
      {err && <div className="rounded-xl border border-down/40 bg-down/5 p-2 text-xs text-down">{err}</div>}
    </div>
  );
}
