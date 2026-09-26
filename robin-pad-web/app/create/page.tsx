'use client';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, useWriteContract, usePublicClient, useSignMessage } from 'wagmi';
import { decodeEventLog, type Address } from 'viem';
import { FileText, Rocket, PieChart, Eye, ImageUp, ShieldCheck, Check } from 'lucide-react';
import { portalAbi } from '@/lib/abi';
import { CONFIG, explorerTx } from '@/lib/config';
import { fmtUsd } from '@/lib/format';
import { saveMeta, readImageFile } from '@/lib/metadata';
import { robinhood } from '@/lib/chain';
import { ensureGasFunds, explainTxError, knownErrorsAbi } from '@/lib/txError';
import { useEnsureChain } from '@/lib/ensureChain';
import { askExplorerForSource } from '@/lib/explorerSource';
import { TokenIcon } from '@/components/TokenIcon';

// The opening market cap is also the pool's starting liquidity: the whole
// supply goes into the pool, so what DexScreener shows as liquidity starts at
// this number. The contract accepts $100 to $1T; this site offers up to $1M.
const PRESETS = [5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
const MIN_MC_USD = 100;
const presetLabel = (v: number) => (v >= 1_000_000 ? `$${v / 1_000_000}M` : `$${v / 1_000}K`);
const MAX_MC_USD = 1_000_000;
const TOTAL_SUPPLY = 1_000_000_000;

export default function Create() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const pc = usePublicClient({ chainId: robinhood.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();
  const { signMessageAsync } = useSignMessage();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [mcUsd, setMcUsd] = useState(10_000);
  const [buyTax, setBuyTax] = useState(3);
  const [sellTax, setSellTax] = useState(3);
  // Off-chain display info only: RobinRevenueSplitter is a flat 90/10 and
  // splits nothing further. Saved with the token's other details.
  const [split, setSplit] = useState({ creator: 80, buyback: 10, dividends: 5, liquidity: 5 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  // Set once createLaunch has confirmed: the token exists from here on, and
  // only the off-chain info (signed separately) may still need saving.
  const [launched, setLaunched] = useState<Address | null>(null);

  const startingMcRaw = useMemo(() => BigInt(Math.round(mcUsd * 10 ** CONFIG.quoteDecimals)), [mcUsd]);
  const openingPrice = mcUsd / 1e9;
  const splitTotal = Object.values(split).reduce((a, b) => a + b, 0);
  // The split is an off-chain display preference, never enforced on-chain,
  // so it must not be able to block a real launch.
  const valid = name.trim().length >= 2 && /^[A-Z0-9]{2,10}$/.test(symbol) && mcUsd >= MIN_MC_USD && mcUsd <= MAX_MC_USD && buyTax <= 10 && sellTax <= 10;

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    readImageFile(file).then(
      (url) => { setErr(null); setImageFile(file); setImgPreview(url); },
      (e: Error) => { setErr(e.message); setImageFile(null); setImgPreview(null); },
    );
  }

  // Image/description/split are saved off-chain, signed by the creator's
  // wallet so nobody else can rewrite this token's page. A rejected signature
  // or a failed save never loses the launch — the user can retry or skip.
  async function saveInfo(token: Address) {
    setErr(null); setBusy('One signature to save the details…');
    try {
      const { imageSaved } = await saveMeta(
        // A split that doesn't add up to 100 is saved as "not stated" (all zero).
        { token, name: name.trim(), symbol, description, image: imgPreview, split: splitTotal === 100 ? split : { creator: 0, buyback: 0, dividends: 0, liquidity: 0 }, createdAt: Date.now() },
        imageFile, signMessageAsync,
      );
      if (!imageSaved) console.warn('details saved, but the server kept no image');
      router.push(`/token/${token}`);
    } catch (e: unknown) {
      setErr(`The token launched, but saving its details failed: ${explainTxError(e)}`);
      setBusy(null);
    }
  }

  async function submit() {
    if (!pc || !address) return;
    setErr(null); setBusy('Doing a test run…');
    try {
      const call = {
        address: CONFIG.portal,
        abi: [...portalAbi, ...knownErrorsAbi],
        functionName: 'createLaunch',
        // CreateLaunchParams has no quoteAsset: RobinPortal fixes its quote
        // asset (USDG) at construction. portalAbi in lib/abi.ts matches the
        // struct exactly.
        args: [{
          name: name.trim(),
          symbol,
          startingMarketCapQuote: startingMcRaw,
          buyTaxBps: buyTax * 100,
          sellTaxBps: sellTax * 100,
        }],
      } as const;
      // Dry-run on the site's own RPC before the wallet opens. A contract
      // problem comes back with its real reason, and the explicit gas limit
      // means a wallet whose own estimate misfires can't block a launch that
      // would succeed. About 2.3M gas; +20% headroom.
      await pc.simulateContract({ ...call, account: address });
      const gas = ((await pc.estimateContractGas({ ...call, account: address })) * 12n) / 10n;
      await ensureGasFunds(pc, address, gas);
      setBusy(`Checking your wallet is on ${CONFIG.chainName}…`);
      await ensureChain();
      setBusy('Waiting for your wallet approval…');
      const hash = await writeContractAsync({ ...call, chainId: robinhood.id, gas });
      setTx(hash); setBusy(`Waiting for ${CONFIG.chainName}…`);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The launch transaction failed on-chain');

      let token: Address | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== CONFIG.portal.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: portalAbi, data: log.data, topics: log.topics });
          if (ev.eventName === 'LaunchCreated') { token = ev.args.token; break; }
        } catch { /* not ours */ }
      }
      if (!token) throw new Error('The launch went through, but its token address is missing from the receipt');
      setLaunched(token);
      askExplorerForSource(token);
      await saveInfo(token);
    } catch (e: unknown) {
      setErr(explainTxError(e));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-4xl font-black md:text-5xl">
          <span className="text-cream">LAUNCH</span><br />
          <span className="grad-text">YOUR TOKEN</span>
        </h1>
        <p className="mt-2 font-semibold uppercase tracking-wide text-muted">One transaction. Your price. Its own USDG pool.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div className="panel space-y-5 p-6">
            <SectionTitle icon={FileText} n={1} title="Name and look" subtitle="Pick a name and a ticker, and add a picture if you like." />
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
              <div>
                <label className="label">Name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sherwood Coin" maxLength={32} />
              </div>
              <div>
                <label className="label">Ticker</label>
                <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="SHWD" maxLength={10} />
              </div>
              <div>
                <label className="label">Picture</label>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-[42px] w-[42px] items-center justify-center rounded-full border-2 border-dashed border-line2 text-dim hover:border-brand hover:text-brand-hi"
                  title="Shown on this site only. The token contract never sees it."
                >
                  <ImageUp className="h-4 w-4" />
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" className="hidden" onChange={onPickImage} />
              </div>
            </div>
            <div>
              <label className="label">About it (optional)</label>
              <textarea className="input min-h-[72px] rounded-2xl" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 200))} placeholder="What's the story? A line or two is plenty." />
              <p className="mt-1 text-right text-xs text-dim">{description.length}/200</p>
              <p className="mt-1 text-xs text-dim">The picture and text are kept by this site and signed by your wallet. The launch contract has no field for them and never reads them.</p>
            </div>
          </div>

          <div className="panel space-y-5 p-6">
            <SectionTitle icon={Rocket} n={2} title="Price and tax" subtitle="Where trading starts and what each side pays. Both are locked in at launch." />
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className="label">Starting market cap and liquidity (USDG)</label>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button key={p} className={`tab border border-line2 ${mcUsd === p ? 'tab-active' : ''}`} onClick={() => setMcUsd(p)}>{presetLabel(p)}</button>
                  ))}
                  <input className="input w-32" type="number" min={MIN_MC_USD} max={MAX_MC_USD} value={mcUsd} onChange={(e) => setMcUsd(Math.min(MAX_MC_USD, Math.max(0, Number(e.target.value))))} />
                </div>
                <p className="mt-1.5 text-xs text-dim">
                  Opens at about {fmtUsd(openingPrice)} per token, with {fmtUsd(mcUsd)} of starting liquidity: the whole
                  supply goes into the pool, so the liquidity DexScreener shows starts at your market cap. From $100 up to $1M.
                </p>
              </div>
              <div>
                <label className="label">Supply</label>
                <div className="input flex items-center bg-panel2 text-muted">{TOTAL_SUPPLY.toLocaleString()}</div>
                <p className="mt-1.5 text-xs text-dim">Always 1,000,000,000. Every launch here gets the same supply.</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Slider label="Buy tax" value={buyTax} onChange={setBuyTax} />
              <Slider label="Sell tax" value={sellTax} onChange={setSellTax} />
            </div>
          </div>

          <div className="panel space-y-4 p-6">
            <div className="flex items-center justify-between">
              <SectionTitle icon={PieChart} n={3} title="Your share plan" subtitle="Tell holders what you plan to do with your 90%." />
              <span className={`chip shrink-0 ${splitTotal === 100 ? '' : 'border border-down text-down'}`}>{splitTotal}%</span>
            </div>
            <p className="text-xs text-dim">
              The contract always pays 90% of a launch&apos;s revenue to its creator and 10% to the platform.
              These numbers are only a note on your token page about how you plan to use your share. Nothing enforces them.
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              {(Object.keys(split) as (keyof typeof split)[]).map((k) => (
                <div key={k}>
                  <label className="label capitalize">{k}</label>
                  <div className="relative">
                    <input className="input pr-7" type="number" min={0} max={100} value={split[k]} onChange={(e) => setSplit({ ...split, [k]: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
                    <span className="pointer-events-none absolute right-3 top-2.5 text-sm text-dim">%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="panel p-5">
            <h3 className="flex items-center gap-2 font-bold"><Eye className="h-4 w-4 text-brand-hi" />Preview</h3>
            <p className="mt-0.5 text-xs text-muted">This is how it will show up around {CONFIG.brand}.</p>
            <div className="mt-4 flex items-center gap-3">
              {imgPreview
                ? <img src={imgPreview} alt="" className="h-14 w-14 rounded-xl object-cover" />
                : <TokenIcon seed={symbol || 'preview'} className="h-14 w-14 rounded-xl bg-panel2" />}
              <div>
                <div className="font-bold">{name || 'Your token'}</div>
                <div className="text-sm text-muted">${symbol || 'TICKER'}</div>
              </div>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <Row k="Starting market cap" v={fmtUsd(mcUsd)} />
              <Row k="Supply" v={TOTAL_SUPPLY.toLocaleString()} />
              <Row k="Buy tax" v={`${buyTax}%`} />
              <Row k="Sell tax" v={`${sellTax}%`} />
              <Row k="Your cut" v="90%, set in the contract" />
              <Row k="Starting liquidity" v={`${fmtUsd(mcUsd)} (full supply, locked)`} />
            </dl>
            {launched && !busy ? (
              <div className="mt-5 grid gap-2">
                <button className="btn-brand w-full py-3" onClick={() => saveInfo(launched)}>Sign and save details</button>
                <button className="btn-ghost w-full py-3" onClick={() => router.push(`/token/${launched}`)}>Skip for now</button>
              </div>
            ) : !isConnected ? (
              <div className="mt-5 panel2 p-3 text-center text-sm text-muted">Plug in a wallet to launch.</div>
            ) : (
              <button className="btn-brand mt-5 w-full py-3.5 text-base" disabled={!valid || !!busy || !!launched} onClick={submit}>
                <Rocket className="h-4 w-4" />{busy ?? 'Launch token'}
              </button>
            )}
            {tx && <a className="mt-2 block truncate text-xs text-brand-hi" href={explorerTx(tx) || undefined} target="_blank" rel="noreferrer">tx {tx}</a>}
            {err && <div className="mt-2 panel border-down/50 p-3 text-xs text-down">{err}</div>}
          </div>

          <div className="panel p-5">
            <h3 className="flex items-center gap-2 font-bold"><ShieldCheck className="h-4 w-4 text-brand-hi" />Same rules for every launch</h3>
            <ul className="mt-3 space-y-2 text-sm text-text/85">
              {['No team tokens, no presale', 'Rules you can read on-chain', 'Each pool trades against USDG'].map((t) => (
                <li key={t} className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-up" />{t}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <div className="panel grid grid-cols-2 gap-4 p-6 sm:grid-cols-4">
        {[['1', 'Name it', 'Ticker, picture, a short story'], ['2', 'Launch it', 'Its USDG pool opens at once'], ['3', 'Share it', 'Rally your holders'], ['4', 'Build it', 'Keep showing up for holders']].map(([n, t, d]) => (
          <div key={n} className="flex items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-robin-grad font-display text-sm font-bold text-white">{n}</div>
            <div><div className="text-sm font-bold">{t}</div><div className="text-xs text-muted">{d}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, n, title, subtitle }: { icon: typeof FileText; n: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-hi" />
      <div>
        <h2 className="font-bold">{n}. {title}</h2>
        <p className="text-xs text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="label">{label} <span className="float-right text-text">{value}%</span></label>
      <input type="range" min={0} max={10} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-brand" />
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>;
}
