import type { Metadata } from 'next';
import { CONFIG } from '@/lib/config';
import { UsdcNotice } from '@/components/UsdcNotice';

export const metadata: Metadata = { title: `Get USDC on ${CONFIG.chainName} · ${CONFIG.brand}`, description: `Bridge USDC to ${CONFIG.chainName} with Relay, then launch or trade.` };

const RELAY = 'https://relay.link/bridge/elysium';

export default function Bridge() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-4xl font-black"><span className="text-cream">GET</span> <span className="grad-text">USDC</span></h1>
        <p className="mt-2 text-lg text-muted">Every pool on {CONFIG.brand} trades against USDC on {CONFIG.chainName}. Here is how to get some.</p>
      </div>

      <UsdcNotice full />

      <section className="panel space-y-3 p-6 text-sm text-muted">
        <h2 className="font-bold text-text">Bridge it with Relay</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>Open <a className="text-brand-hi underline" href={RELAY} target="_blank" rel="noreferrer">Relay&apos;s {CONFIG.chainName} bridge</a> and connect the wallet you will use here.</li>
          <li>Pick the chain your USDC is on, and set <b className="text-text">{CONFIG.chainName}</b> as the destination with <b className="text-text">USDC</b> as the token.</li>
          <li>Check that the quote shows the fee and the amount you will receive, then confirm. Relay shows the exact cost before you sign.</li>
          <li>Come back here. The USDC lands in the same wallet, at the address above.</li>
        </ol>
        <p>
          <a className="inline-block rounded-xl bg-ely-grad px-4 py-2 font-bold text-ink shadow-btn" href={RELAY} target="_blank" rel="noreferrer">Open the Relay bridge</a>
        </p>
      </section>

      <section className="panel space-y-2 p-6 text-sm text-muted">
        <h2 className="font-bold text-text">Good to know</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li><b className="text-text">Gas is HYPE.</b> You need a small amount of HYPE on {CONFIG.chainName} for every transaction, about a cent each. Relay bridges USDC here; it does not bridge HYPE for gas.</li>
          <li>Only the USDC at the address above works. USDC on other chains, or other tokens named USDC, will not trade against these pools.</li>
          <li>Relay is a separate service run by a third party. This site does not control it, so check the details it shows before you confirm.</li>
        </ul>
      </section>
    </div>
  );
}
