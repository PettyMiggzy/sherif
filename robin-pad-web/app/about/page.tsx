import { Coins, Lock, Percent, Eye } from 'lucide-react';
import { CONFIG } from '@/lib/config';

export default function About() {
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-4xl font-black">
          <span className="text-cream">ABOUT</span> <span className="grad-text">{CONFIG.brand.toUpperCase()}</span>
        </h1>
        <p className="mt-2 text-lg text-muted">{CONFIG.tagline}</p>
      </div>

      <section className="panel space-y-3 p-6">
        <h2 className="font-bold">The short version</h2>
        <p className="text-text/85">
          {CONFIG.brand} is Robin Labs&apos; launchpad on {CONFIG.chainName}, open to anyone. A new token
          gets its own Uniswap v4 pool, paired with USDG, and can be traded in the same block it was created.
          There is no curve to fill and nothing to graduate to later: the pool a token starts in is the pool
          it keeps.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Fact icon={Coins} title="Same start for every token" body="Each launch mints exactly 1,000,000,000 tokens and all of them go into the pool. No team bag, no presale. The creator buys from the pool like everyone else." />
        <Fact icon={Lock} title="Liquidity that stays put" body="The pool position belongs to a locker contract with no owner and no withdraw function. Nobody can pull it out, us included." />
        <Fact icon={Percent} title="A split set in code" body="A launch's revenue (its tax plus the LP fees it earns in USDG) goes 90% to the creator and 10% to the platform. That ratio is a constant in the contract, not a setting." />
        <Fact icon={Eye} title="Real numbers or a dash" body="Numbers here are read from the chain, or from the indexer. When there is no real figure to show, you get a “—”, not a guess." />
      </section>

      <section className="panel space-y-2 p-6 text-sm text-muted">
        <h2 className="font-bold text-text">Before you buy</h2>
        <p>
          Have fun, but please be careful: this is experimental software that handles real USDG on {CONFIG.chainName}.
          The contracts have been reviewed, though not by an outside audit firm. Prices move only with trading,
          locked liquidity doesn&apos;t stop a token from falling to zero, and nothing on this site is financial
          advice. Look into any token before buying it, even one you launched.
        </p>
      </section>
    </div>
  );
}

function Fact({ icon: Icon, title, body }: { icon: typeof Coins; title: string; body: string }) {
  return (
    <div className="panel p-5">
      <Icon className="h-5 w-5 text-brand-hi" />
      <h3 className="mt-3 font-bold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}
