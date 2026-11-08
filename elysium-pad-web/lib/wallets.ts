'use client';
import { connectorsForWallets, type Wallet } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet, coinbaseWallet, rainbowWallet, trustWallet, rabbyWallet, okxWallet, phantomWallet,
  walletConnectWallet, injectedWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConnector } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { makeWagmiConfig } from './wagmi';
import { CONFIG } from './config';
import { browserWalletName, isPhone } from './browserWallet';

const wcProjectId = CONFIG.walletConnectProjectId || undefined;

// The wallet in this browser: an extension on a computer, or the wallet app's
// own browser on a phone. It carries the wallet's own name ("MetaMask") so
// phone users know it's theirs. On phones it asks for the account with
// eth_requestAccounts straight away: the stock connector first sends
// wallet_requestPermissions (an account picker for desktop extensions), which
// some wallet apps' browsers never answer, so the connect would hang.
const browserWallet = (): Wallet => ({
  ...injectedWallet(),
  name: browserWalletName(),
  createConnector: (walletDetails) =>
    createConnector((config) => ({
      ...injected({ shimDisconnect: !isPhone() })(config),
      ...walletDetails,
    })),
});

// Named wallets deep-link into their mobile apps (and use their own injected
// provider when opened inside that wallet's in-app browser); installed
// desktop extensions are also auto-detected via EIP-6963. The generic
// browser wallet is left out of that list on purpose: it has no auto-hide,
// so plain mobile Safari/Chrome would show a dead option that can never
// connect. It's the only option when no WalletConnect project ID is set,
// since every other wallet here throws at config time without one.
const connectors = connectorsForWallets(
  wcProjectId
    ? [
        { groupName: 'Popular', wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, trustWallet, phantomWallet] },
        { groupName: 'More', wallets: [rabbyWallet, okxWallet, walletConnectWallet] },
      ]
    : [{ groupName: 'Installed', wallets: [browserWallet] }],
  { appName: CONFIG.brand, projectId: wcProjectId ?? 'unset' },
);

export const wagmiConfig = makeWagmiConfig(connectors);

declare module 'wagmi' {
  interface Register { config: typeof wagmiConfig }
}
