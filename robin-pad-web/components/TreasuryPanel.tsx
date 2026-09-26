'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { formatUnits, parseAbi, parseUnits, type Address, type Hash } from 'viem';
import { Landmark } from 'lucide-react';
import { CONFIG, explorerAddr, explorerTx } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import { erc20Abi, hookAbi, splitterAbi } from '@/lib/abi';
import { poolId, poolKeyFor } from '@/lib/pool';
import { explainTxError } from '@/lib/txError';
import { shortAddr } from '@/lib/format';
import { useEnsureChain } from '@/lib/ensureChain';
import { ConnectButton } from './ConnectButton';

const treasuryAbi = parseAbi([
  'function owner() view returns (address)',
  'function withdraw(address token, address to, uint256 amount)',
]);
const factoryAbi = parseAbi(['function padCount() view returns (uint256)', 'function allPads(uint256) view returns (address)']);
const padAbi = parseAbi([
  'function launchCount() view returns (uint256)',
  'function allLaunches(uint256) view returns (address)',
  'function platformShareBps() view returns (uint16)',
  'function claimPlatformFees(uint256 from, uint256 to) returns (uint256)',
]);
const MAIN_SHARE_BPS = 1000n; // RobinRevenueSplitter.MAIN_PAD_PLATFORM_SHARE_BPS

const usd = (raw: bigint) => `$${Number(formatUnits(raw, CONFIG.quoteDecimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Launch = { pad: Address; token: Address; key: ReturnType<typeof poolKeyFor>['key']; pending: bigint; splitter: Address; credit: bigint; shareBps: bigint };
type Pad = { pad: Address; main: boolean; count: bigint };

/**
 * The platform's 10%. Swap tax waits in the hook until someone flushes the
 * pool to its splitter; the splitter then holds the platform's share until
 * claimPlatform sends it to the treasury, which only its owner can withdraw.
 * "Collect & withdraw" does all three for every launch: this site's main
 * portal and every pad the factory deployed (the house pad and white-label
 * pads, which claim per pad with claimPlatformFees).
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
      const [balance, owner, padCount] = await Promise.all([
        pc!.readContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [CONFIG.treasury] }),
        pc!.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName: 'owner' }),
        pc!.readContract({ address: CONFIG.factory, abi: factoryAbi, functionName: 'padCount' }),
      ]);
      const padAddrs = await Promise.all(Array.from({ length: Number(padCount) }, (_, i) =>
        pc!.readContract({ address: CONFIG.factory, abi: factoryAbi, functionName: 'allPads', args: [BigInt(i)] })));
      const pads: Pad[] = [];
      const launches: Launch[] = [];
      for (const [pad, main] of [[CONFIG.portal, true] as const, ...padAddrs.map((a) => [a, false] as const)]) {
        const [count, shareBps] = await Promise.all([
          pc!.readContract({ address: pad, abi: padAbi, functionName: 'launchCount' }),
          main ? Promise.resolve(MAIN_SHARE_BPS) : pc!.readContract({ address: pad, abi: padAbi, functionName: 'platformShareBps' }).then(BigInt),
        ]);
        pads.push({ pad, main, count });
        const tokens = await Promise.all(Array.from({ length: Number(count) }, (_, i) =>
          pc!.readContract({ address: pad, abi: padAbi, functionName: 'allLaunches', args: [BigInt(i)] })));
        launches.push(...await Promise.all(tokens.map(async (token) => {
          const { key } = poolKeyFor(token);
          const id = poolId(key);
          const [pending, cfg] = await Promise.all([
            pc!.readContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'pendingTax', args: [id] }),
            pc!.readContract({ address: CONFIG.hook, abi: hookAbi, functionName: 'poolConfigs', args: [id] }),
          ]);
          const splitter = cfg[0];
          const credit = await pc!.readContract({ address: splitter, abi: splitterAbi, functionName: 'creditedToPlatform', args: [CONFIG.usdg] });
          return { pad, token, key, pending, splitter, credit, shareBps };
        })));
      }
      const ready = launches.reduce((a, l) => a + l.credit, 0n);
      const unflushedShare = launches.reduce((a, l) => a + (l.pending * l.shareBps) / 10_000n, 0n);
      return { balance, owner, pads, launches, ready, unflushedShare };
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
    // Main-portal launches claim one splitter at a time; every other pad
    // claims all of its launches in one claimPlatformFees call.
    const mainClaims = after.launches.filter((l) => l.pad === CONFIG.portal && l.credit > 0n);
    const padClaims = after.pads.filter((p) => !p.main && after.launches.some((l) => l.pad === p.pad && l.credit > 0n));
    const total = mainClaims.length + padClaims.length;
    let n = 0;
    for (const l of mainClaims) {
      await send(`Claiming ${++n}/${total}`, { address: l.splitter, abi: splitterAbi, functionName: 'claimPlatform', args: [CONFIG.usdg], chainId: robinhood.id });
    }
    for (const p of padClaims) {
      await send(`Claiming ${++n}/${total}`, { address: p.pad, abi: padAbi, functionName: 'claimPlatformFees', args: [0n, p.count], chainId: robinhood.id });
    }
    return { flushed: toFlush.length, claimed: total };
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
        {d ? `${d.launches.length} launch${d.launches.length === 1 ? '' : 'es'} across ${d.pads.length} pad${d.pads.length === 1 ? '' : 's'} · ` : ''}treasury{' '}
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
