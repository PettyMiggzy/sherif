'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { formatUnits, parseAbi, parseUnits, type Address, type Hash } from 'viem';
import { Landmark } from 'lucide-react';
import { CONFIG, explorerAddr, explorerTx } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import { erc20Abi, hookAbi, portalAbi, splitterAbi } from '@/lib/abi';
import { poolId, poolKeyFor } from '@/lib/pool';
import { explainTxError } from '@/lib/txError';
import { shortAddr } from '@/lib/format';
import { useEnsureChain } from '@/lib/ensureChain';
import { ConnectButton } from './ConnectButton';

const treasuryAbi = parseAbi([
  'function owner() view returns (address)',
  'function withdraw(address token, address to, uint256 amount)',
]);

const usd = (raw: bigint) => `$${Number(formatUnits(raw, CONFIG.quoteDecimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Launch = { token: Address; key: ReturnType<typeof poolKeyFor>['key']; pending: bigint; splitter: Address; credit: bigint };

/**
 * The platform's 10%. Swap tax waits in the hook until someone flushes the
 * pool to its splitter; the splitter then holds the platform's share until
 * claimPlatform sends it to the treasury, which only its owner can withdraw.
 * "Collect & withdraw" does all three for every launch on this site's portal.
 * (White-label pads and the house pad are handled on robinlab.io/admin.html.)
 */
export function TreasuryPanel() {
  const { address, isConnected: connectedNow } = useAccount();
  // Wallet state only after mount: the server renders from the wallet cookie
  // while the browser is still reconnecting, and the two must match.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isConnected = mounted && connectedNow;
  const pc = usePublicClient({ chainId: robinhood.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; tx?: Hash } | null>(null);
  const [amount, setAmount] = useState('');

  const data = useQuery({
    queryKey: ['treasury', CONFIG.treasury, CONFIG.portal],
    enabled: !!pc,
    refetchInterval: 20_000,
    queryFn: async () => {
      const [balance, owner, count] = await Promise.all([
        pc!.readContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [CONFIG.treasury] }),
        pc!.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName: 'owner' }),
        pc!.readContract({ address: CONFIG.portal, abi: portalAbi, functionName: 'launchCount' }),
      ]);
      const tokens = await Promise.all(Array.from({ length: Number(count) }, (_, i) =>
        pc!.readContract({ address: CONFIG.portal, abi: portalAbi, functionName: 'allLaunches', args: [BigInt(i)] })));
      const launches: Launch[] = await Promise.all(tokens.map(async (token) => {
        const { key } = poolKeyFor(token);
        const id = poolId(key);
        const [pending, cfg] = await Promise.all([
          pc!.readContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'pendingTax', args: [id] }),
          pc!.readContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'poolConfigs', args: [id] }),
        ]);
        const splitter = cfg[0];
        const credit = await pc!.readContract({ address: splitter, abi: splitterAbi, functionName: 'creditedToPlatform', args: [CONFIG.usdg] });
        return { token, key, pending, splitter, credit };
      }));
      const ready = launches.reduce((a, l) => a + l.credit, 0n);
      const unflushed = launches.reduce((a, l) => a + l.pending, 0n);
      return { balance, owner, launches, ready, unflushedShare: unflushed / 10n };
    },
  });

  const d = data.data;
  const isOwner = isConnected && !!address && !!d && address.toLowerCase() === d.owner.toLowerCase();

  async function send(label: string, call: Parameters<typeof writeContractAsync>[0]) {
    setBusy(`${label}: approve in your wallet…`);
    const hash = await writeContractAsync(call);
    setBusy(`${label}: waiting for ${CONFIG.chainName}…`);
    const r = await pc!.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${label} failed on-chain`);
    return hash;
  }

  async function collect() {
    const fresh = (await data.refetch()).data;
    if (!fresh) throw new Error("Couldn't read the launches. Try again.");
    const toFlush = fresh.launches.filter((l) => l.pending > 0n);
    for (const [i, l] of toFlush.entries()) {
      await send(`Flushing ${i + 1}/${toFlush.length}`, { address: CONFIG.hook, abi: hookAbi, functionName: 'flush', args: [[l.key.currency0, l.key.currency1, l.key.fee, l.key.tickSpacing, l.key.hooks]], chainId: robinhood.id });
    }
    // Flushing is what credits the splitters, so read the credits again.
    const after = toFlush.length ? (await data.refetch()).data! : fresh;
    const toClaim = after.launches.filter((l) => l.credit > 0n);
    for (const [i, l] of toClaim.entries()) {
      await send(`Claiming ${i + 1}/${toClaim.length}`, { address: l.splitter, abi: splitterAbi, functionName: 'claimPlatform', args: [CONFIG.usdg], chainId: robinhood.id });
    }
    return { flushed: toFlush.length, claimed: toClaim.length };
  }

  async function run(kind: 'collect' | 'all' | 'withdraw') {
    if (!pc || !address) return;
    setErr(null); setDone(null);
    try {
      await ensureChain();
      if (kind !== 'collect' && !isOwner) throw new Error(`Only the treasury owner (${d ? shortAddr(d.owner) : '…'}) can withdraw. Connect that wallet.`);
      let c = { flushed: 0, claimed: 0 };
      if (kind !== 'withdraw') c = await collect();
      if (kind === 'collect') {
        setDone({ text: c.flushed || c.claimed ? `Collected: ${c.flushed} pool(s) flushed, ${c.claimed} claim(s).` : 'Nothing to collect right now.' });
        return;
      }
      const bal = await pc.readContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [CONFIG.treasury] });
      const want = kind === 'withdraw' && amount.trim() ? parseUnits(amount.trim().replace(/[$,]/g, ''), CONFIG.quoteDecimals) : bal;
      if (want === 0n) { setDone({ text: 'The treasury holds no USDG yet.' }); return; }
      if (want > bal) throw new Error(`The treasury only holds ${usd(bal)}.`);
      const tx = await send('Withdrawing', { address: CONFIG.treasury, abi: treasuryAbi, functionName: 'withdraw', args: [CONFIG.usdg, address, want], chainId: robinhood.id });
      setAmount('');
      setDone({ text: `Withdrew ${usd(want)} USDG to ${shortAddr(address)}.`, tx });
    } catch (e: unknown) {
      setErr(explainTxError(e));
    } finally {
      setBusy(null);
      data.refetch();
    }
  }

  return (
    <div className="panel space-y-5 p-6">
      <div className="flex items-center gap-3">
        <span className="icon-badge h-11 w-11"><Landmark className="h-5 w-5" /></span>
        <div>
          <h2 className="font-display text-2xl font-extrabold uppercase text-white">Treasury</h2>
          <p className="text-sm text-muted">The platform&apos;s 10% of every launch, paid in USDG.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="In treasury" value={d ? usd(d.balance) : '…'} note="withdraw now" />
        <Stat label="Ready to collect" value={d ? usd(d.ready) : '…'} note="sitting in splitters" />
        <Stat label="Not yet flushed" value={d ? usd(d.unflushedShare) : '…'} note="your share, in the hook" />
      </div>

      {!isConnected ? <ConnectButton /> : (
        <div className="space-y-3">
          <button className="btn-brand w-full py-3 text-base" disabled={!!busy} onClick={() => run('all')}>
            {busy ?? 'Collect & withdraw everything to my wallet'}
          </button>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost flex-1" disabled={!!busy} onClick={() => run('collect')}>Collect to treasury</button>
            <input className="input w-36 flex-none" placeholder="amount (all)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            <button className="btn-ghost" disabled={!!busy} onClick={() => run('withdraw')}>Withdraw</button>
          </div>
          {d && !isOwner && <p className="text-xs text-gold">This wallet isn&apos;t the treasury owner ({shortAddr(d.owner)}). It can collect, but not withdraw.</p>}
        </div>
      )}
      {done && (
        <div className="rounded-lg border border-up/40 bg-up/10 p-3 text-sm text-up">
          {done.text}{done.tx && explorerTx(done.tx) && <> <a className="underline" href={explorerTx(done.tx)} target="_blank" rel="noreferrer">View tx</a></>}
        </div>
      )}
      {err && <div className="rounded-lg border border-down/40 bg-down/10 p-3 text-sm text-down">{err}</div>}
      <p className="text-xs text-dim">
        {d ? `${d.launches.length} launch${d.launches.length === 1 ? '' : 'es'} on this portal · ` : ''}treasury{' '}
        <a className="font-mono text-brand-hi hover:underline" href={explorerAddr(CONFIG.treasury) || undefined} target="_blank" rel="noreferrer">{shortAddr(CONFIG.treasury)}</a>
      </p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel2/60 p-4">
      <div className="text-[11px] font-bold uppercase tracking-wider text-brand-hi">{label}</div>
      <div className="mt-1 font-display text-3xl font-bold text-white">{value}</div>
      <div className="text-xs text-dim">{note}</div>
    </div>
  );
}
