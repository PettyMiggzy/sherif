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

### Docker

```bash
docker build -t robinlabs-indexer .
docker run -p 8787:8787 -v $PWD/data:/app/data --env-file .env robinlabs-indexer
```

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
| `GET /api/coin/:token` | one coin, fully enriched |
| `GET /api/trades/:token?limit=` | recent trades (exact wei) |

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
