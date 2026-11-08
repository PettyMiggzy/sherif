'use client';
import '@rainbow-me/rainbowkit/styles.css';
import { WagmiProvider, type State } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { useState, type ReactNode } from 'react';
import { wagmiConfig } from '@/lib/wallets';
import { padChain } from '@/lib/chain';

// Matches tailwind.config.ts (mint brand on ink-teal panels) so the
// wallet modal reads as part of the site rather than a third-party popup.
const theme = darkTheme({ accentColor: '#5EEAC6', accentColorForeground: '#03100D', borderRadius: 'large', fontStack: 'system' });
theme.fonts.body = 'var(--font-body), system-ui, sans-serif';
theme.colors.modalBackground = '#0A1A17';
theme.colors.modalBorder = '#16302B';
theme.colors.modalText = '#EEF3EE';

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={qc}>
        <RainbowKitProvider theme={theme} initialChain={padChain} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
