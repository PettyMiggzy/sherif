# Robin Labs Pad — Indexer + API

A small, reorg-safe indexer that reads Robin Labs Pad activity off Robinhood
Chain and serves it as a fast JSON API. The static pad can then render a live
browse feed, trending/top sorting, search, per-coin trade history and volume
**without fanning out dozens of RPC calls per page** — it just calls this API.

It is **optional and non-breaking**: the pad falls back to reading the chain
directly if no `API_BASE` is configured. Nothing here holds a private key or
signs anything — it is read-only.

## What it indexes

Four on-chain events, straight from the deployed contracts:

| Event | From | Becomes |
|-------|------|---------|
| `Launched` | `CurvePadFactory` | a new coin (token/curve/pool/dev, name, symbol) |
| `Bought` | `PadRouter` | a buy trade (ETH in, tokens out, fee) |
| `Sold` | `PadRouter` | a sell trade (tokens in, ETH out, fee) |
| `Graduated` | `CurvePool` | graduation (raised WETH, the Bond address) |

Everything else — 24h volume, trade counts, last price, trending order — is
**derived by query** from those, so it stays correct even after a reorg.

## Run it

```bash
cd indexer
cp .env.example .env          # set START_BLOCK to the factory's deploy block
npm install
npm start                     # indexer + API on :8787
```

Then point the pad at it — in `pad/assets/config.js`:

```js
export const API_BASE = "https://your-indexer-host";   // "" = direct-RPC fallback
```

### Docker (indexer only)

```bash
docker build -t robinlabs-indexer .
docker run -p 8787:8787 -v $PWD/data:/app/data --env-file .env robinlabs-indexer
```

### Docker Compose — the whole stack, one command

Serves the static pad **and** the API on one domain with automatic HTTPS
(Caddy). Same origin → no CORS, one certificate.

```bash
cd indexer
cp .env.example .env
#  → set RPC_URL (Alchemy/QuickNode), START_BLOCK, and SITE_DOMAIN=pad.robinlabs.io
docker compose up -d
```

Point your domain's A record at the box first. Then set, in
`pad/assets/config.js`:

```js
export const API_BASE = "https://pad.robinlabs.io";   // your SITE_DOMAIN
```

That's it — `https://pad.robinlabs.io` now serves the pad, and
`…/api/coins` is the live feed.

### DigitalOcean droplet — API only, pad stays on Vercel (recommended)

If you already have a droplet and the pad is on Vercel, host just the **API** on a
subdomain and point the pad at it. Real disk = coin profiles are safe; always-on =
never spins down.

```bash
# 0) DNS: add an A record  api.robinlab.io -> <droplet IP>  (wait for it to resolve)

# 1) on the droplet
git clone <this repo> && cd <repo>/indexer
cat > .env <<'ENV'
SITE_DOMAIN=api.robinlab.io
FACTORY=0x7E9E3BC24013e6f607e89c52E619B6FD77334DC2
ROUTER=0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F
REWARD_VAULT=0x0F07dC315e332084129c1D00bEbADAb05edf79Dc
START_BLOCK=15944153
CORS_ORIGIN=*
# RPC_URL=<your private Robinhood Chain RPC>   # optional; else the public RPC
ENV

# 2) one command (installs nothing else — Docker does it all)
docker compose -f docker-compose.api.yml up -d --build
```

Caddy fetches the HTTPS cert automatically. Confirm with
`curl https://api.robinlab.io/health` → `{"ok":true,...}`. Then set, in
`pad/assets/config.js`:

```js
export const API_BASE = "https://api.robinlab.io";
```

Commit + push → Vercel redeploys → the feed (images, volume, trending) is live.

### Managed (Fly.io) — API only, keep the pad on Vercel

The pad is already on Vercel, so you only need to host the **API** and point the
site at it. `fly.toml` is committed and ready:

```bash
cd indexer
fly apps create robinlabs-indexer
fly volumes create indexer_data -r iad -n 1 -s 1     # 1 GB disk for the DB (holds coin profiles)
fly secrets set RPC_URL=<your private Robinhood Chain RPC>   # optional; else the public RPC
fly deploy
```

Then set `API_BASE` in `pad/assets/config.js` to `https://robinlabs-indexer.fly.dev`,
commit + push → Vercel redeploys and the feed goes live (images, volume, trending).
CORS is already open, so cross-origin (Vercel ↔ Fly) just works.

### The live values for THIS deployment

Already baked into `fly.toml` / use in `.env` — no need to look them up:

| Key | Value |
|-----|-------|
| `FACTORY` | `0x7E9E3BC24013e6f607e89c52E619B6FD77334DC2` |
| `ROUTER` | `0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F` |
| `REWARD_VAULT` | `0x0F07dC315e332084129c1D00bEbADAb05edf79Dc` |
| `START_BLOCK` | `15944153` (the factory's deploy block — fast first sync) |

## Scaling to a launch-day crowd (10k concurrent)

The users' **launches and trades never touch this backend** — those go straight
to the factory/router on-chain via each user's own wallet RPC. This backend only
serves **reads** (the browse feed, charts data, search). Three things keep it fast:

1. **Precomputed snapshots.** Progress and market cap are refreshed whenever a
   coin trades and stored on the row, so listing thousands of live coins is
   **one query, zero per-coin RPC**. The old path did a chain read per card;
   this one doesn't.
2. **A private RPC for the indexer.** Point `RPC_URL` at Alchemy or QuickNode.
   The public Blockscout endpoint is rate-limited and will lag under a flood of
   launch-day events; a private endpoint keeps the indexer caught up and lets
   you raise `CHUNK` for faster catch-up.
3. **A CDN in front.** Every API response sends `cache-control: max-age=5`.
   Put Cloudflare (orange-cloud) on the domain and 10k readers are served from
   the edge — only ~1 request per route per 5s reaches the box. This is the
   single biggest lever; do it before launch.

Other knobs:

- **SQLite is fine here.** Writes are single-threaded from one indexer; reads are
  WAL-concurrent and CDN-cached. If you ever outgrow it, run `--no-index` API
  replicas against a read-only copy, or swap the store — the query layer is
  isolated in `src/api.js` / `src/db.js`.
- **Tune `POLL_MS`** down (e.g. 3000) during launch for faster feed freshness,
  back up afterward to spare the RPC.
- **`CONFIRMATIONS`** trades latency for reorg-safety; 3 is a good default.

### Deploy on a DigitalOcean droplet (what you have)

```bash
# on a fresh Ubuntu droplet with Docker installed:
git clone <your repo> && cd <repo>/indexer
cp .env.example .env && nano .env          # RPC_URL, START_BLOCK, SITE_DOMAIN
docker compose up -d                        # site + API live with HTTPS
docker compose logs -f indexer              # watch it catch up
```

Open firewall ports 80 + 443. Put the domain behind Cloudflare for the CDN
cache. Done — one $6–12/mo droplet comfortably serves a launch-day crowd behind
the CDN.

### Scripts

- `npm start` — indexer loop + API (the normal mode)
- `npm run index` — indexer only (writer)
- `npm run api` — API only (reader; e.g. a second replica)
- `npm run backfill` — one catch-up pass then exit (good for cron)

## API

Base URL is your host. All responses are JSON, `cache-control: max-age=5`.

| Route | What |
|-------|------|
| `GET /health` | `{ ok, head, cursor, coins, trades }` — liveness + how far indexed |
| `GET /api/stats` | totals: coins, graduated, 24h volume & trades |
| `GET /api/coins?sort=&filter=&q=&limit=&offset=` | the browse feed |
| `GET /api/coin/:token` | one coin, fully enriched (includes the profile) |
| `GET /api/trades/:token?limit=` | recent trades (exact wei) |
| `GET /api/coin/:token/meta` | the coin's creator-set profile (image/banner URLs + socials) |
| `POST /api/coin/:token/meta` | set the profile — **creator-signed** (only the coin's `dev`) |
| `GET /media/:token/:kind` | the coin's image bytes (`kind` = `pfp` \| `banner`) |
| `GET /api/rewards/user/:addr` | all of a wallet's reward claims + Merkle proofs, across epochs |
| `GET /api/rewards/claim/:epoch/:coin/:side/:addr` | one claim's exact args + proof (`side` 0=traders,1=holders) |
| `GET /api/rewards/epoch/:n` | the full leaf set + root for an epoch (transparency artifact) |

## Rewards (RewardVault merkle poster)

When `REWARD_VAULT` is set (see `.env.example`), the indexer also runs the off-chain half of the RewardVault
design. On-chain, PadRouter forwards two 0.25% legs per trade — a BUY leg (traders) and a SELL leg (holders) —
and RewardVault custodies them per `(coin, epoch, side)` and caps what can ever leave (`Σ claims ≤ pot`). It
never scores. This poster does:

1. **Index** the `Accrued` events (raw, PK'd like trades; reorg-safe) → derive each `(coin,epoch,side)` pot.
2. **Score** each finalized epoch from the coin's trades:
   - **Traders** (BUY-leg pot) ∝ `max(0, Σ buy − Σ sell tokens)` in the epoch (net accumulation).
   - **Holders** (SELL-leg pot) ∝ balance-seconds (`∫ balance dt`, balance carried in from before the epoch,
     clamped at 0).
3. **Allocate** each pot `amount = floor(pot · weight / Σweight)` so `Σ ≤ pot` (dust stays unclaimed → swept to
   floor after the claim window).
4. **Build** ONE global Merkle root over all coins' leaves for the epoch; each leaf is
   `keccak(keccak(abi.encode(epoch, coin, side, user, amount)))` — identical to the contract and OZ
   `StandardMerkleTree`, so proofs verify against `RewardVault.claim`.
5. **Persist** every leaf + proof (served by the API) and **post** the root on-chain via `POSTER_KEY`.

The scoring spec is frozen in `src/rewards.js`; its keccak is posted on-chain as `algoHash` so anyone can
recompute from `/api/rewards/epoch/:n` and challenge a mismatch. Correctness is covered by
`test/rewards.test.mjs` (`node --test test/rewards.test.mjs`): leaf parity with the contract formula, proof
verification, conservation, and both scoring rules. Omit `POSTER_KEY` to run compute-only (serves proofs, posts
nothing) for a dry run.

**`/api/coins` params**

- `sort` — `new` (default) · `trending` (24h volume) · `top` (all-time volume) · `graduated`
- `filter` — `all` (default) · `live` · `graduated`
- `q` — substring match on name / symbol / token address
- `limit` (≤200), `offset`

Each coin includes: `token, curve, pool, dev, name, symbol, launchTs, devBought,
graduated, raisedWeth, bond, tradesAll, trades24h, volAllEth, vol24hEth,
lastPriceEth, lastTradeTs`.

## How reorgs are handled

The cursor only advances to `head - CONFIRMATIONS`. Each poll re-scans a small
window back from the cursor and re-applies logs; all writes are idempotent
(`INSERT … ON CONFLICT DO NOTHING/UPDATE`, keyed by `(tx, logIndex)`), and trades
in the re-scanned window are purged first so an orphaned block can't leave stale
rows. Bump `CONFIRMATIONS` if Robinhood Chain ever shows deeper reorgs.

## Notes

- Volume/price are summed as ETH-scale floats for ranking and display; the exact
  per-trade wei are always available on `/api/trades`.
- Set `START_BLOCK` to the factory deploy block or the first backfill crawls from
  genesis (correct, just slower). Find it on the explorer: the factory address'
  first transaction.
- Use a private archive RPC in `.env` for faster backfills and higher getLogs
  range limits; the public Blockscout endpoint works but is rate-limited.
