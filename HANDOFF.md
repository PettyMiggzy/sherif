# Robin Labs — Handoff Brief

Read this first. It's the full context for anyone (or any new session) picking up
Robin Labs. Everything you need to continue is here.

## What Robin Labs is

A creator-first **memecoin launchpad on Robinhood Chain** (Arbitrum Orbit L2,
EVM, chainId **4663**). One-transaction launches into a real Uniswap v3 pool, a
bonding curve, a ceiling-only graduation, and a permanently-locked
protocol-owned floor — **the Bond**. Neon lime (`#dce905`) on black brand.

## Repo layout (the parts that matter)

```
launchpad/     Solidity contracts + Hardhat tests (the protocol)
  contracts/   CurvePadFactory, PadRouter, CurvePool, Bond, libraries
  AUDIT.md     audit findings + resolutions (KEEP PRIVATE — details attack surface)
pad/           the static frontend (no backend needed to run)
  index.html   home / browse feed (matches the brand mockup)
  create.html  launch a coin
  token.html   trade + graduation + dev controls
  promo.html   FOMO landing
  docs.html    branded dev docs
  admin.html   platform ownership (acceptOwnership)
  assets/      config.js (addresses/ABIs), wallet.js (signing), ethers.min.js, logo/favicons
indexer/       optional Node indexer + JSON API (SQLite, Docker, Caddy) — makes the feed fast
docs/          GitBook- + Mintlify-ready docs generated from docs/src/*.md
```

## Live on Robinhood Chain (mainnet)

| Contract | Address |
|----------|---------|
| CurvePadFactory | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` |
| PadRouter | `0xA6BaAB820809C7fC8350311776627298f91F07eC` |
| FeeConfig | `0x064D977B66FCC29256510dBCD8cC0C51bBb2De14` |
| FloorCoopFactory | `0x564EDF561Bed46C972d5D44D84f5FAc9C5118668` |
| PlatformFeeSplitter | `0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |

- RPC (public): `https://robinhoodchain.blockscout.com/api/eth-rpc`
- Explorer: `https://robinhoodchain.blockscout.com`
- Factory deploy block (for the indexer `START_BLOCK`): **17752965**
- Contract owner (all): cold wallet `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf`
  (two-step transfer — pending accept via `pad/admin.html`; may already be done)

## Economics (already implemented in the contracts)

- Total supply per coin: 1,000,000,000. Base fee: 1% per side (100 bps) — the Uniswap v3 pool's own fee tier.
- **LP fee (the in-protocol 1%)** splits **platform 90% / creator 10%** by default, via `FeeConfig.lpCreatorBps`
  (owner-tunable, creator cap 50%). Swept by `CurvePool.collectFees()`; principal never touched.
- **Swap-desk fee (router)** splits **platform 45% / creator 45% / floor 10%** by default, via
  `FeeConfig.swapSplit()` (owner-tunable, must sum to 100%).
- **Graduation reward: 0.5 ETH → creator + 0.5 ETH → platform** (each capped at raise/4; rest funds the floor).
  Sherwood LP fees compound back into the Bond via `poke()`.
- **Graduation is ceiling-only at 4.2 ETH raised** (~$34k FDV). No dev-settable target, no timeout, no
  "let it ride" — a coin graduates at exactly one price, the top of the curve.
- **Rewards program disabled** — no `RewardVault` deployed; no reward legs on any trade.
- Fees are all owner-tunable live via `FeeConfig` (`pad/admin.html` → Fee dials) — no redeploy.

## Status

- ✅ Contracts deployed + audited (3 internal passes + live mainnet lifecycle test).
- ✅ Frontend built + rebranded to Robin Labs art (logo/favicons from the real mark).
- ✅ Indexer + API (reorg-safe, precomputed snapshots, scales behind a CDN).
- ✅ Docs (branded page + GitBook/Mintlify sources).
- ⏳ Native token **$ROBIN** + staking/real-yield rewards — DESIGN IN PROGRESS
  (see "Native token" below).
- ⏳ Go-live: host `pad/`, run the indexer on a DigitalOcean droplet (Docker
  compose + Caddy), point the domain, set `API_BASE` in `pad/assets/config.js`.

## Native token plan ($ROBIN) — in progress

- Fair-launch **on Robin Labs itself** (dogfood; graduates into its own floor).
- **Reward holders with real ETH** (a cut of platform fees → a staking
  distributor; stakers claim ETH). Optional buyback&burn + hold-to-perks.
- Key: rewards are ETH, so no big token treasury is required — fair launch works.
- No router redeploy needed: route already-collected platform ETH into a
  `RobinStaking` distributor.

## How to run / verify

- Frontend: `cd pad && python3 -m http.server 8080` → open a page. Works on the
  public RPC with zero backend (the indexer only speeds up the feed).
- Indexer: `cd indexer && cp .env.example .env` (set `START_BLOCK=17752965`,
  `RPC_URL`, `SITE_DOMAIN`) → `docker compose up -d`.
- Docs: edit `docs/src/*.md`, run `node docs/build.mjs`, connect the output
  folder to GitBook or Mintlify.

## Hard constraints (do not break)

- **Never commit secrets.** Real `.env` files are gitignored; only `.env.example`
  placeholders are tracked. Never commit an RPC key or private key.
- **No AI fingerprints** in any public artifact (contracts, docs, frontend). The
  audit write-ups were scrubbed of tooling references — keep it that way.
- Keep `AUDIT.md` and `pad/overview.html` **private** (they detail attack
  surface) — share directly with an auditor, don't host them.
- Brand: logo mark is `pad/assets/logo-mark.png`; brand color `#dce905`.
