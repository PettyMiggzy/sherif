'use client';
import { useState } from 'react';
import { ConnectButton as RKConnectButton } from '@rainbow-me/rainbowkit';
import { useBalance, useReadContract } from 'wagmi';
import { formatEther, formatUnits, type Address } from 'viem';
import { ExternalLink, Wallet, X } from 'lucide-react';
import { robinhood } from '@/lib/chain';
import { CONFIG } from '@/lib/config';
import { erc20Abi } from '@/lib/abi';
import { shortAddr } from '@/lib/format';
import { browserProvider, isPhone, walletAppLinks } from '@/lib/browserWallet';
import { useEnsureChain, useWalletChainId } from '@/lib/ensureChain';

// With a WalletConnect project ID, RainbowKit's own list reaches phone
// wallets (see lib/wallets.ts). Without one, a phone browser with no wallet
// built in (plain Safari or Chrome) has nothing it can connect to, so the
// button offers to reopen the page inside a wallet app instead.
const hasWalletConnect = !!CONFIG.walletConnectProjectId;

export function ConnectButton() {
  const ensureChain = useEnsureChain();
  // The wallet's own network, which can differ from wagmi's record (see
  // lib/ensureChain.ts); if either says it isn't Robinhood Chain, offer the switch.
  const walletChain = useWalletChainId();
  const [appsOpen, setAppsOpen] = useState(false);
  return (
    <>
      <RKConnectButton.Custom>
        {({ account, chain, mounted, openConnectModal, openAccountModal }) => {
          // Rendered but invisible until mounted, so SSR and the first client
          // render agree and the header doesn't shift when wallet state loads.
          if (!mounted) return <div aria-hidden className="pointer-events-none opacity-0"><button className="btn-brand px-6 py-3 text-[15px]">Connect Wallet</button></div>;
          if (!account) {
            const connect = () => (!hasWalletConnect && isPhone() && !browserProvider() ? setAppsOpen(true) : openConnectModal());
            return <button className="btn-brand px-6 py-3 text-[15px]" onClick={connect}>Connect Wallet</button>;
          }
          if (chain?.unsupported || (walletChain !== undefined && walletChain !== robinhood.id)) {
            return <button className="btn-down" onClick={() => ensureChain().catch(() => {})}>Switch to Robinhood</button>;
          }
          return <Connected address={account.address as Address} onClick={openAccountModal} />;
        }}
      </RKConnectButton.Custom>
      {appsOpen && <OpenInWalletApp onClose={() => setAppsOpen(false)} />}
    </>
  );
}

function OpenInWalletApp({ onClose }: { onClose: () => void }) {
  const links = walletAppLinks(window.location.href);
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Open in your wallet app" className="w-full max-w-md rounded-t-2xl border border-line bg-panel p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-display text-xl font-bold uppercase text-white">Open in your wallet app</h2>
          <button className="text-muted hover:text-white" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-2 text-sm text-muted">
          This browser has no wallet in it. Pick your wallet: the pad opens inside its app, and Connect Wallet works there.
        </p>
        <div className="mt-5 grid gap-2.5">
          {links.map((l) => (
            <a key={l.name} href={l.href} className="flex items-center justify-between rounded-xl border border-line bg-panel2/60 px-4 py-3 font-bold text-white hover:border-brand">
              <span className="flex items-center gap-3"><Wallet className="h-5 w-5 text-brand-hi" />{l.name}</span>
              <ExternalLink className="h-4 w-4 text-muted" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function Connected({ address, onClick }: { address: Address; onClick: () => void }) {
  const { data: bal } = useBalance({ address });
  const { data: usdg } = useReadContract({ address: CONFIG.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [address], query: { refetchInterval: 15_000 } });
  return (
    <div className="flex items-center gap-2">
      <span className="chip hidden sm:inline-flex" title="Gas">{bal ? `${Number(formatEther(bal.value)).toFixed(4)} ETH` : '…'}</span>
      <span className="chip" title="What you trade with">{usdg !== undefined ? `$${Number(formatUnits(usdg, CONFIG.quoteDecimals)).toFixed(2)} USDG` : '…'}</span>
      <button className="btn-ghost" onClick={onClick} title="Account">{shortAddr(address)}</button>
    </div>
  );
}
