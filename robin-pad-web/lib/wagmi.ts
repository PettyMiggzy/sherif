import { createConfig, cookieStorage, createStorage, type CreateConnectorFn } from 'wagmi';
import { robinhood } from './chain';
import { chainTransport } from './rpc';

// Server-safe on purpose: app/layout.tsx (a server component) builds this with
// no connectors just to read the wallet cookie via cookieToInitialState, which
// only needs the storage key. The real connectors come from RainbowKit, whose
// modules are "use client" and can't run in a server component — see
// lib/wallets.ts.
export function makeWagmiConfig(connectors: CreateConnectorFn[] = []) {
  return createConfig({
    chains: [robinhood],
    connectors,
    transports: { [robinhood.id]: chainTransport({ batch: true }) },
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
  });
}
