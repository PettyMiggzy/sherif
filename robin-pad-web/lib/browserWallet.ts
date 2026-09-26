'use client';
import { numberToHex } from 'viem';
import { robinhood } from './chain';
import { CONFIG } from './config';

// The wallet built into the browser in use: an extension on a computer, or
// the wallet app's own browser on a phone (window.ethereum, EIP-1193).

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isOkxWallet?: boolean;
  isPhantom?: boolean;
  isBraveWallet?: boolean;
};

export function browserProvider(): Eip1193Provider | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}

export function isPhone(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** The wallet's own name when it says which one it is. */
export function browserWalletName(p = browserProvider()): string {
  if (!p) return 'Browser Wallet';
  if (p.isRabby) return 'Rabby';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet';
  if (p.isOkxWallet) return 'OKX Wallet';
  if (p.isPhantom) return 'Phantom';
  if (p.isBraveWallet) return 'Brave Wallet';
  // Several other wallets also set isMetaMask, so it is checked last.
  if (p.isMetaMask) return 'MetaMask';
  return 'Browser Wallet';
}

const codeOf = (e: unknown): number | undefined => {
  const x = e as { code?: number; data?: { originalError?: { code?: number } } };
  return x?.code ?? x?.data?.originalError?.code;
};

/** Switches the wallet to Robinhood Chain, adding the network first if the wallet doesn't know it. */
export async function switchWalletToChain(p: Eip1193Provider): Promise<void> {
  const want = numberToHex(robinhood.id);
  const current = String(await p.request({ method: 'eth_chainId' })).toLowerCase();
  if (current === want) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  } catch (e) {
    if (codeOf(e) !== 4902) throw e;
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: want,
        chainName: robinhood.name,
        nativeCurrency: robinhood.nativeCurrency,
        rpcUrls: [CONFIG.rpcUrl],
        ...(CONFIG.explorerUrl ? { blockExplorerUrls: [CONFIG.explorerUrl] } : {}),
      }],
    });
  }
}

/** A wallet error in plain words, keeping the wallet's own message and code. */
export function walletErrorText(e: unknown): string {
  const code = codeOf(e);
  if (code === 4001) return 'Declined in the wallet, so nothing was sent.';
  if (code === -32002) return 'Your wallet already has a request waiting. Open the wallet, finish or reject it, then try again.';
  const msg = (e as { message?: string })?.message ?? String(e);
  return code !== undefined ? `${msg} (code ${code})` : msg;
}

/**
 * Links that reopen `url` inside a wallet app's own browser, where the wallet
 * is built in and connects directly. For phone browsers that have no wallet
 * (plain Safari or Chrome), which can't connect any other way unless
 * WalletConnect is set up.
 */
export function walletAppLinks(url: string): { name: string; href: string }[] {
  const u = encodeURIComponent(url);
  return [
    { name: 'MetaMask', href: `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, '')}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${u}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${u}` },
    { name: 'OKX Wallet', href: `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${u}`)}` },
  ];
}
