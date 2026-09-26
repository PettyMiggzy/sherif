# Robin Labs Pad (site)

The Next.js site for Robin Labs Pad on Robinhood Chain: launch a token at the
starting market cap you pick, explore launches, and trade them through
Uniswap's UniversalRouter. Every launch gets a real Uniswap v4 pool against
USDG from its first block. It reads the chain directly and talks to the
contracts in `../usdg-pad` (the main portal and the shared hook, deployed
2026-09-26; addresses in `../usdg-pad/docs/ROBINHOOD-DEPLOY.md`).

Ported from the SDOGE Launchpad site (`PettyMiggzy/Sdoge-`, `pad-web/`), which
runs the same contracts on Arc against USDC, and reskinned for Robin Labs.
What changed besides the look:

- **Chain and quote asset:** Robinhood Chain (4663) and USDG. Gas is ETH, not
  the quote coin, so buys no longer hold $0.10 back and gas errors talk ETH.
- **RPC fallback:** a reverting call (every swap quote is one) is returned
  as-is instead of being retried on the backup, and the browser only uses the
  `/api/rpc` relay when a backup is configured. Before, an unconfigured backup
  turned every quote into "Try the quote again".
- **Launch list:** a token looked up right after launching no longer comes
  back "not found" when a scan was already running. Scans step 500k blocks
  (Robinhood Chain makes ~10 blocks a second).
- **/admin:** a Treasury panel collects the platform's 10% from every launch
  and withdraws it to the owner wallet. (robinlab.io/admin.html does the same
  across white-label pads and the house pad too.)
- **Removed:** the pinned $SDOGE card, the SDOGE dev-wallet holdings, and the
  Arc SDK section of the docs.

## Run locally

```bash
cd robin-pad-web
npm ci
npm run dev                  # http://localhost:3000
```

No env is needed: `lib/config.ts` defaults to the live Robinhood deployment
(see `.env.example` for what can be overridden). Without
`BLOB_READ_WRITE_TOKEN` everything works except saving token details
(picture, description, links).

## Checks

- `npx next build` type-checks and lints.
- `scripts/e2e-fork.cjs` drives the real site in a browser against an anvil
  fork of Robinhood Chain mainnet: launch at a typed-in $25,000 starting
  market cap (checked against the pool's price on-chain), buy $50 and sell
  half through the real UniversalRouter, then collect and withdraw the
  platform fees on /admin as the treasury owner. See the top of the file.

## Go live

Create a Vercel project with this folder as its root directory. Optionally
connect a private Vercel Blob store (sets `BLOB_READ_WRITE_TOKEN`), set
`NEXT_PUBLIC_SITE_URL` to the site's domain, and a WalletConnect project id
for phone wallets.
