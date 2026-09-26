'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, type Address, type Hash } from 'viem';
import { clsx } from 'clsx';
import { erc20Abi, permit2Abi, universalRouterAbi } from '@/lib/abi';
import { CONFIG, explorerTx } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import type { PoolKey } from '@/lib/pool';
import { buildExactInSwap, quoteExactIn } from '@/lib/swap';
import { fmtCompact, parseUnitsSafe } from '@/lib/format';
import { explainTxError } from '@/lib/txError';
import { useEnsureChain } from '@/lib/ensureChain';

type Props = {
  token: Address; symbol: string; poolKey: PoolKey; tokenIsToken0: boolean;
  lpFeeBps: number; buyTaxBps?: number; sellTaxBps?: number;
};

// Approvals are for the exact amount of each trade, never unlimited: an
// open-ended approval is the main thing wallet security scanners (Blockaid in
// MetaMask, GoPlus in Trust, OKX and others) flag. The router's Permit2
// allowance also expires after a day instead of lingering.
const PERMIT2_EXPIRY_SEC = 60 * 60 * 24;
const SLIPPAGES = [0.5, 1, 3, 5];
// Gas on Robinhood Chain is ETH, not USDG, so a buy can spend the whole USDG
// balance. (On Arc, where USDC is the gas coin, the original kept $0.10 back.)
const GAS_RESERVE_USDG = 0n;

export function TradePanel(p: Props) {
  const { address, isConnected } = useAccount();
  const pc = usePublicClient({ chainId: robinhood.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [debounced, setDebounced] = useState('');
  const [slippagePct, setSlippagePct] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(amount), 350); return () => clearTimeout(t); }, [amount]);

  const isBuy = side === 'buy';
  const inToken = isBuy ? CONFIG.usdg : p.token;
  const outToken = isBuy ? p.token : CONFIG.usdg;
  const inDecimals = isBuy ? CONFIG.quoteDecimals : 18;
  const outDecimals = isBuy ? 18 : CONFIG.quoteDecimals;
  const taxBps = isBuy ? p.buyTaxBps : p.sellTaxBps;
  const zeroForOne = isBuy ? !p.tokenIsToken0 : p.tokenIsToken0;

  // Both are real ERC-20 reads — never the wallet's native balance (ETH,
  // which only pays gas). The contracts only ever move USDG via ERC-20
  // transferFrom, so the balance shown must come
  // from the same asset the swap actually spends.
  const usdgBal = useReadContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [address!], chainId: robinhood.id, query: { enabled: !!address, refetchInterval: 15_000 } });
  const tokenBal = useReadContract({ address: p.token, abi: erc20Abi, functionName: 'balanceOf', args: [address!], chainId: robinhood.id, query: { enabled: !!address, refetchInterval: 15_000 } });
  const inBal = isBuy ? usdgBal.data : tokenBal.data;

  const amountIn = useMemo(() => parseUnitsSafe(amount, inDecimals) ?? 0n, [amount, inDecimals]);
  const quotedAmountIn = useMemo(() => parseUnitsSafe(debounced, inDecimals) ?? 0n, [debounced, inDecimals]);

  // Real output from the live pool (tax, LP fee, opening gap and price impact
  // included), plus a 1/1000-size reference quote to show price impact.
  const quote = useQuery({
    queryKey: ['quote', p.token, side, quotedAmountIn.toString()],
    enabled: !!pc && quotedAmountIn > 0n,
    staleTime: 5_000,
    refetchInterval: 12_000,
    retry: 1,
    queryFn: async () => {
      const base = { key: p.poolKey, zeroForOne, currencyIn: inToken, currencyOut: outToken };
      const refIn = quotedAmountIn / 1000n > 0n ? quotedAmountIn / 1000n : 1n;
      const [out, refOut] = await Promise.all([
        quoteExactIn(pc!, { ...base, amountIn: quotedAmountIn }),
        quoteExactIn(pc!, { ...base, amountIn: refIn }).catch(() => 0n),
      ]);
      const impactPct = out > 0n && refOut > 0n
        ? Math.max(0, (1 - (Number(out) / Number(quotedAmountIn)) / (Number(refOut) / Number(refIn))) * 100)
        : undefined;
      return { out, impactPct };
    },
  });

  const quoteReady = amountIn > 0n && amountIn === quotedAmountIn && quote.isSuccess && !!quote.data;
  const out = quoteReady ? quote.data!.out : undefined;
  const amountOutMin = out !== undefined ? (out * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n : undefined;
  const noLiquidity = out === 0n;
  const spendable = inBal === undefined ? undefined : isBuy ? (inBal > GAS_RESERVE_USDG ? inBal - GAS_RESERVE_USDG : 0n) : inBal;
  const insufficient = spendable !== undefined && amountIn > 0n && amountIn > spendable;
  const needsGasRoom = insufficient && isBuy && inBal !== undefined && amountIn <= inBal;
  const canTrade = quoteReady && !!amountOutMin && amountOutMin > 0n && !insufficient && !busy;

  async function waitOk(hash: Hash, what: string) {
    const r = await pc!.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${what} failed on-chain`);
  }

  async function ensureAllowance() {
    if (!address || !pc) return;
    const erc20Allow = await pc.readContract({ address: inToken, abi: erc20Abi, functionName: 'allowance', args: [address, CONFIG.permit2] });
    if (erc20Allow < amountIn) {
      setBusy('Approving this amount…');
      await waitOk(await writeContractAsync({ chainId: robinhood.id, address: inToken, abi: erc20Abi, functionName: 'approve', args: [CONFIG.permit2, amountIn] }), 'Token approval');
    }
    const [permit2Allow, expiration] = await pc.readContract({ address: CONFIG.permit2, abi: permit2Abi, functionName: 'allowance', args: [address, inToken, CONFIG.router] });
    const nowSec = Math.floor(Date.now() / 1000);
    if (permit2Allow < amountIn || expiration <= nowSec + 60) {
      setBusy('Letting the router use this amount…');
      await waitOk(await writeContractAsync({ chainId: robinhood.id, address: CONFIG.permit2, abi: permit2Abi, functionName: 'approve', args: [inToken, CONFIG.router, amountIn, nowSec + PERMIT2_EXPIRY_SEC] }), 'Router approval');
    }
  }

  async function submit() {
    if (!pc || !address || !canTrade || amountOutMin === undefined) return;
    setErr(null); setTx(null);
    try {
      setBusy(`Checking your wallet is on ${CONFIG.chainName}…`);
      await ensureChain();
      // Approval runs for BOTH sides — a buy spends USDG via ERC-20
      // transferFrom just as a sell spends the launch token.
      await ensureAllowance();
      const { args } = buildExactInSwap({ key: p.poolKey, zeroForOne, amountIn, amountOutMin, currencyIn: inToken, currencyOut: outToken });
      // Run the exact swap against the chain first: if it would fail (price moved
      // past the slippage, balance changed), say why here instead of sending
      // the wallet a transaction it would warn is likely to fail.
      setBusy('Checking the swap…');
      await pc.simulateContract({ address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args, account: address });
      setBusy('Swap waiting on your wallet…');
      const h = await writeContractAsync({ chainId: robinhood.id, address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args });
      setTx(h); setBusy(`Waiting for ${CONFIG.chainName}…`);
      await waitOk(h, 'Swap');
      setAmount(''); usdgBal.refetch(); tokenBal.refetch();
    } catch (e: unknown) {
      setErr(explainTxError(e));
    } finally {
      setBusy(null);
    }
  }

  const balLabel = inBal === undefined ? '—' : isBuy
    ? `${Number(formatUnits(inBal, CONFIG.quoteDecimals)).toFixed(2)} USDG`
    : `${fmtCompact(Number(formatUnits(inBal, 18)))} ${p.symbol}`;

  function fillPct(pct: number) {
    if (spendable === undefined) return;
    setAmount(formatUnits((spendable * BigInt(pct)) / 100n, inDecimals));
  }

  const outSymbol = isBuy ? p.symbol : 'USDG';
  const fmtOut = (v: bigint) => `${Number(formatUnits(v, outDecimals)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${outSymbol}`;
  const impact = quoteReady ? quote.data!.impactPct : undefined;
  const buttonLabel = busy
    ?? (needsGasRoom ? 'Balance too low'
      : insufficient ? 'Balance too low'
      : amountIn === 0n ? (isBuy ? `Buy ${p.symbol}` : `Sell ${p.symbol}`)
        : quote.isError ? 'Try the quote again'
          : !quoteReady ? 'Fetching a quote…'
            : noLiquidity ? "The pool can't fill this"
              : isBuy ? `Buy ${p.symbol}` : `Sell ${p.symbol}`);

  return (
    <div className="panel p-5">
      <div className="grid grid-cols-2 rounded-xl2 bg-panel2 p-1">
        <button className={clsx('rounded-xl py-2.5 text-sm font-bold', isBuy ? 'bg-robin-grad text-ink shadow-btn' : 'text-muted')} onClick={() => setSide('buy')}>Buy</button>
        <button className={clsx('rounded-xl py-2.5 text-sm font-bold', !isBuy ? 'bg-robin-grad text-ink shadow-btn' : 'text-muted')} onClick={() => setSide('sell')}>Sell</button>
      </div>

      <div className="mt-5 flex items-center justify-between text-sm">
        <span className="font-semibold">{isBuy ? 'Amount in USDG' : `Amount in ${p.symbol}`}</span>
        <button className="text-muted hover:text-text" onClick={() => fillPct(100)}>Wallet: {balLabel}</button>
      </div>
      <input
        className="mt-2 w-full rounded-xl2 border border-line2 bg-bg px-4 py-4 text-xl font-semibold text-text placeholder:text-dim outline-none focus:border-brand-hi focus:shadow-glow"
        inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)}
      />
      <div className="mt-3 grid grid-cols-4 gap-2">
        {isBuy
          ? [1, 5, 10, 25].map((v) => <button key={v} className="rounded-xl border border-line2 bg-panel py-2 text-sm font-bold hover:bg-panel2" onClick={() => setAmount(String(v))}>${v}</button>)
          : [25, 50, 75, 100].map((pct) => <button key={pct} className="rounded-xl border border-line2 bg-panel py-2 text-sm font-bold hover:bg-panel2" onClick={() => fillPct(pct)}>{pct}%</button>)}
      </div>

      <dl className="mt-5 space-y-2.5 text-sm">
        <Row k="You get" v={out !== undefined ? fmtOut(out) : amountIn > 0n ? '…' : '—'} />
        <Row k="At least" v={amountOutMin ? fmtOut(amountOutMin) : '—'} />
        <Row k="Price impact" v={impact === undefined ? '—' : `${impact < 0.01 ? '<0.01' : impact.toFixed(2)}%`} warn={impact !== undefined && impact > 5} />
        <Row k="LP fee" v={`${p.lpFeeBps / 100}%`} />
        <Row k={isBuy ? 'Buy tax' : 'Sell tax'} v={taxBps === undefined ? '…' : `${taxBps / 100}%`} />
        <div className="flex items-center justify-between">
          <dt className="text-muted">Slippage</dt>
          <dd className="flex gap-1">{SLIPPAGES.map((s) => <button key={s} className={clsx('rounded-lg px-2 py-0.5 font-semibold', slippagePct === s ? 'bg-panel2 text-brand-hi' : 'text-dim')} onClick={() => setSlippagePct(s)}>{s}%</button>)}</dd>
        </div>
      </dl>
      {noLiquidity && amountIn > 0n && (
        <div className="mt-3 rounded-xl border border-line2 bg-panel2 p-2 text-xs text-muted">
          {isBuy ? 'Nothing left in the pool to buy at the moment.' : `No USDG in the pool yet. Once someone buys ${p.symbol}, selling opens up.`}
        </div>
      )}

      {!isConnected ? (
        <div className="btn-brand mt-5 w-full py-3.5 text-base opacity-90">Connect a wallet first</div>
      ) : (
        <button className="btn-brand mt-5 w-full py-3.5 text-base" disabled={!canTrade && !quote.isError} onClick={quote.isError ? () => quote.refetch() : submit}>
          {buttonLabel}
        </button>
      )}
      {tx && <a className="mt-2 block truncate text-xs text-brand-hi" href={explorerTx(tx) || undefined} target="_blank" rel="noreferrer">tx {tx}</a>}
      {err && <div className="mt-2 rounded-xl border border-down/40 bg-down/5 p-2 text-xs text-down">{err}</div>}
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return <div className="flex justify-between"><dt className="text-muted">{k}</dt><dd className={clsx('font-bold', warn && 'text-down')}>{v}</dd></div>;
}
