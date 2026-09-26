import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus_Jakarta_Sans, Barlow_Condensed } from 'next/font/google';
import { headers } from 'next/headers';
import { cookieToInitialState } from 'wagmi';
import './globals.css';
import { Providers } from './providers';
import { Nav } from '@/components/Nav';
import { makeWagmiConfig } from '@/lib/wagmi';
import { CONFIG } from '@/lib/config';

// A heavy condensed display face (the Robin Labs banners' poster type) for
// headings, and Plus Jakarta Sans (robinlab.io's body face) for text.
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-body' });
const barlow = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700', '800'], variable: '--font-display' });

export const metadata: Metadata = {
  ...(CONFIG.siteUrl ? { metadataBase: new URL(CONFIG.siteUrl) } : {}),
  title: CONFIG.brand,
  description: CONFIG.tagline,
  openGraph: { title: CONFIG.brand, description: CONFIG.tagline, images: ['/brand/social-share.jpg'] },
  twitter: { card: 'summary_large_image', title: CONFIG.brand, description: CONFIG.tagline, images: ['/brand/social-share.jpg'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(makeWagmiConfig(), headers().get('cookie'));
  return (
    <html lang="en">
      <body className={`${jakarta.variable} ${barlow.variable} min-h-screen font-sans antialiased`}>
        <Providers initialState={initialState}>
          <Nav />
          <main className="mx-auto max-w-[1440px] px-6 pb-20 pt-6">{children}</main>
          <footer className="border-t border-line px-6 py-8 text-center text-xs text-dim">
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-muted">
              <Link href="/explore" className="hover:text-brand-hi">Explore</Link>
              <Link href="/docs" className="hover:text-brand-hi">Docs &amp; API</Link>
              <Link href="/about" className="hover:text-brand-hi">About</Link>
              <a href="https://robinlab.io" target="_blank" rel="noreferrer" className="hover:text-brand-hi">robinlab.io</a>
              <a href="https://github.com/Robinlabz/Labs" target="_blank" rel="noreferrer" className="hover:text-brand-hi">GitHub</a>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span>{CONFIG.brand} · every launch trades against USDG on {CONFIG.chainName} · not affiliated with Robinhood</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
