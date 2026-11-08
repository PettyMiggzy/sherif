# Elysium Pad (Elysium testnet) — https://elysiumpad.world

The Elysium Pad launchpad on Kinetiq's Elysium (testnet, chain 99801), built
from the same Next.js 14 site as `robin-pad-web` (the Robinhood Chain pad) and
the same contracts (`usdg-pad/src`, deployed by
`usdg-pad/script/DeployElysium.s.sol`).

- **Chain and quote asset:** Elysium testnet (99801) and USDC bridged from
  HyperEVM (6 decimals). Gas is HYPE.
- **Launches:** the creator picks the opening market cap, $100 to $1M, and
  the whole 1B supply goes into a single-sided Uniswap v4 position, so
  liquidity starts equal to the market cap. No bonding curve, no graduation.
- **Uniswap v4:** Elysium has no official deployment, so the stack brings its
  own: Uniswap's v4-core PoolManager (unmodified, owned by the pad admin, whose
  only power is naming a protocol-fee controller) and `PadRouter`, a router
  that speaks UniversalRouter's `execute(bytes,bytes[],uint256)` for v4 swaps
  (command 0x10 only) and is paid through the chain's canonical Permit2. The
  site's swap and quote code (`lib/swap.ts`) is unchanged from robin-pad-web.
- **Fees:** each launch's tax (0 to 10% each way) goes 80% to its creator
  and 20% to the platform; the pool's 1% LP fee goes to the platform, the USDC
  side to the treasury and the token side to the fee desk, which sells it at
  10% under the pool price on `/deals`. `/admin` collects everything and
  withdraws it to the admin wallet.
- **Verification:** new launch tokens are verified on Conduit's hosted
  Sourcify (`contracts.conduit.xyz`), which the Elysium explorer
  (Conduit Explorer) reads. GoPlus doesn't cover Elysium, so there's no
  GoPlus panel here.
- **Art:** `public/brand/` (hero, scenes, emblem, social card) was generated
  for this site with Meshy (and upscaled with Venice); prompts and settings
  are kept outside the repo.

## Deploy

**Vyre box (current host).** `Dockerfile` builds a self-contained Node server
(Next.js standalone output) listening on port 3000. Deploy it with the Vyre
connector: repo `PettyMiggzy/sherif`, branch
`claude/robinhood-chain-website-8loxcm`, root `elysium-pad-web`, domain
`elysiumpad.world`. Set `DATABASE_URL` (a Postgres database; Neon `elysium-pad`
in the King Petty org) on the app, then redeploy. The A records for
`elysiumpad.world` and `www` point at the box, and `www` redirects to the
apex (next.config.mjs).

**Vercel (alternative).** Project with root directory `elysium-pad-web`;
`scripts/vercel-ignore.sh` skips builds when nothing under this folder
changed. A private Vercel Blob store (`BLOB_READ_WRITE_TOKEN`) takes the place
of `DATABASE_URL`.

Either way the store (`lib/store.ts`) holds token pictures, descriptions and
the launch-list snapshot.

No env is needed: `lib/config.ts` defaults to the Elysium testnet
deployment. For mainnet, once Kinetiq publishes its chain id and USDC
address, deploy with `EXPECTED_CHAIN_ID` and `QUOTE_TOKEN` set and point the
site at it with the `NEXT_PUBLIC_*` variables in `.env.example`.

## Test

```
npm ci && npx tsc --noEmit && npx next build
```

`scripts/e2e-fork.cjs` drives the whole flow in a browser against an anvil
fork of Elysium (launch, buy, sell, fee desk, admin collect and withdraw);
see the comment at its top.
