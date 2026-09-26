'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { clsx } from 'clsx';
import { ConnectButton } from './ConnectButton';
import { CONFIG } from '@/lib/config';

type Item = { label: string; href: string; external?: boolean };

// The main Robin Labs site's pages sit next to the pad's own, like robinlab.io's nav does.
const home = CONFIG.homeUrl.replace(/\/+$/, '');
const ITEMS: Item[] = [
  ...(home ? [{ label: 'Home', href: home, external: true }] : []),
  { label: 'Launchpad', href: '/' },
  { label: 'Create', href: '/create' },
  { label: 'Explore', href: '/explore' },
  { label: 'How it works', href: '/#how-it-works' },
  ...(home ? [{ label: 'Stake', href: `${home}/stake.html`, external: true }] : []),
  { label: 'Leaderboard', href: '/leaderboard' },
];

export function Logo() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5 leading-none" aria-label={CONFIG.brand}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo.jpg" alt="" className="h-10 w-10 rounded-lg" />
      <span className="flex flex-col">
        <span className="font-display text-[26px] font-extrabold uppercase tracking-wide text-white">
          Robin <span className="text-brand-hi">Labs</span>
        </span>
        <span className="mt-0.5 text-[9px] font-bold tracking-[0.55em] text-muted">LAUNCHPAD</span>
      </span>
    </Link>
  );
}

/** The chain every launch lives on: a live-signal dot and the chain's name (no third-party logo). */
export function ChainBadge({ className }: { className?: string }) {
  return (
    <span className={clsx('flex items-center gap-2 font-display font-bold uppercase tracking-wide text-white', className)}>
      <span className="relative flex h-[0.45em] w-[0.45em]">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-hi/60 motion-reduce:hidden" />
        <span className="relative inline-flex h-full w-full rounded-full bg-brand-hi" />
      </span>
      {CONFIG.chainName}
    </span>
  );
}

function NavLink({ item, active, onClick, mobile }: { item: Item; active: boolean; onClick?: () => void; mobile?: boolean }) {
  const base = mobile
    ? 'rounded-lg px-2 py-2.5 text-base font-semibold'
    : 'whitespace-nowrap border-b-2 pb-1 text-[15px] font-semibold';
  const cls = clsx(base, 'text-text/85 hover:text-brand-hi', mobile ? active && 'bg-panel2 text-brand-hi' : active ? 'border-brand-hi text-brand-hi' : 'border-transparent');
  return item.external
    ? <a href={item.href} className={cls} onClick={onClick}>{item.label}</a>
    : <Link href={item.href} className={cls} onClick={onClick}>{item.label}</Link>;
}

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-line/60 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center gap-6 px-4 sm:px-6 lg:gap-10">
        <Logo />
        <nav className="hidden items-center gap-6 xl:flex 2xl:gap-7">
          {ITEMS.map((it) => <NavLink key={it.label} item={it} active={!!it.href && !it.external && path === it.href} />)}
        </nav>
        <div className="ml-auto flex items-center gap-3 sm:gap-5">
          <ChainBadge className="hidden text-lg lg:flex" />
          <ConnectButton />
          <button
            type="button"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line2 text-text xl:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav className="flex flex-col gap-1 border-t border-line2 bg-bg px-4 py-3 xl:hidden">
          {ITEMS.map((it) => <NavLink key={it.label} item={it} mobile active={!!it.href && path === it.href} onClick={() => setOpen(false)} />)}
        </nav>
      )}
    </header>
  );
}
