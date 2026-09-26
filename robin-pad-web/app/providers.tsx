'use client';
import '@rainbow-me/rainbowkit/styles.css';
import { WagmiProvider, type State } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { useState, type ReactNode } from 'react';
import { wagmiConfig } from '@/lib/wallets';
import { robinhood } from '@/lib/chain';

// Matches tailwind.config.ts (lime brand on forest-black panels) so the
// wallet modal reads as part of the site rather than a third-party popup.
const theme = darkTheme({ accentColor: '#A3E635', accentColorForeground: '#0A1004', borderRadius: 'large', fontStack: 'system' });
theme.fonts.body = 'var(--font-body), system-ui, sans-serif';
theme.colors.modalBackground = '#0B1107';
theme.colors.modalBorder = '#1E2B12';
theme.colors.modalText = '#EEF5E3';

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={qc}>
        <RainbowKitProvider theme={theme} initialChain={robinhood} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
