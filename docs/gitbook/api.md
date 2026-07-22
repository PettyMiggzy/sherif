# Indexer API

An optional read API reads the on-chain events into a database and serves a fast browse feed, trending/top sorting, search, per-coin trades and volume — so you don't fan out dozens of RPC calls per page. It's read-only and signs nothing; the pad falls back to direct-RPC when it isn't configured.

| Route | Returns |
|-------|---------|
| `GET /health` | `{ ok, head, cursor, coins, trades }` |
| `GET /api/stats` | Totals: coins, graduated, 24h volume & trades |
| `GET /api/coins` | Browse feed — params below |
| `GET /api/coin/:token` | One coin, fully enriched (progress, mcap, volume) — includes the profile |
| `GET /api/trades/:token` | Recent trades (exact wei) |
| `GET /api/coin/:token/meta` | The coin's creator-set [profile](#coin-profiles) (image/banner URLs + socials) |
| `POST /api/coin/:token/meta` | Set the profile — **creator-signed** (only the coin's `dev`) |
| `GET /media/:token/:kind` | The coin's image bytes (`kind` = `pfp` \| `banner`) |
| `GET /api/rewards/:addr` | A wallet's claimable (with proofs) + pending [rewards](rewards.md) |
| `GET /api/rewards/claim/:epoch/:coin/:side/:addr` | One claim's exact on-chain args + proof |
| `GET /api/rewards/epoch/:n` | The full leaf set + root for an epoch — the transparency artifact |
| `GET /api/rewards/stats` | Protocol-wide reward totals |

```http
# sort: new | trending | top | graduated   filter: all | live | graduated
GET /api/coins?sort=trending&filter=live&q=wood&limit=60

# each coin includes:
{ token, curve, pool, dev, name, symbol, launchTs, devBought,
  graduated, raisedWeth, bond,
  progress, mcapEth, lastPriceEth,           # live snapshot — no chain read needed
  tradesAll, trades24h, volAllEth, vol24hEth,
  startTick, minGradTick, gradTick, gradTarget }
```

> **Built for scale.** The feed is served from precomputed snapshots (progress/mcap refreshed whenever a coin trades), so a page that lists thousands of live coins costs **one** request and **zero** per-coin RPC. Responses are cacheable (`max-age=5`) — put a CDN in front and a launch-day crowd hits cache, not the database.

## Coin profiles

Names and symbols live on-chain, but a coin's **image, banner, description and socials** are off-chain, held here. A profile is **creator-signed**: only the wallet that launched the coin (its `dev`) can set it — no login, no funds move.

```http
# Read a coin's profile (null until one is set). image/banner are absolute URLs.
GET /api/coin/:token/meta
{ token, profile: { description, telegram, twitter, website, image, banner, updatedTs } }

# Set it — the coin's dev signs, anyone else is rejected (403).
POST /api/coin/:token/meta      Content-Type: application/json
{ description, telegram, twitter, website,
  pfp,      # base64 data: URL (png/jpeg/webp/gif, ≤ 800 KB) — omit to keep the current image
  banner,   # base64 data: URL, same rules
  ts,       # unix seconds; must be within ~10 min of now and newer than the last update
  signature # personal_sign of the profile message below, by the coin's dev
}
```

The signed message binds the token and every field (images by keccak digest) so a signature can't be replayed to another coin or an altered payload:

```
Robin Labs — set coin profile
token: <token, lowercased>
ts: <ts>
digest: keccak256( JSON.stringify({description,telegram,twitter,website,pfp,banner,ts}) )
```

The pad does all of this for you — the create page uploads the profile with one extra free signature right after launch (`Pad.setCoinProfile(token, {...})` in `assets/wallet.js`; the same `profileMessage` is exported from the [SDK's](sdk.md) source). Images are downscaled client-side to fit the cap and served back from `GET /media/:token/:kind` (cacheable). Everything here is **cosmetic** — a missing profile never affects trading, and the whole layer is optional (no indexer ⇒ coins simply show name + symbol).

## Rewards

The indexer is also the off-chain half of the [reward system](rewards.md): it computes each epoch's allocation, builds the Merkle tree, and serves the proofs the on-chain `claim()` needs.

```http
# A wallet's rewards — claimable (root already on-chain, includes proofs) + pending (this open epoch, no proof yet)
GET /api/rewards/0xWallet…
{ epoch, epochEndsIn, claimWindowH,
  claimable: [{ epoch, coin, side, sideName, amount, eth, proof, name, sym }],
  pending:   [{ epoch, coin, side, sideName, amount, eth, name, sym }],
  totals: { claimableEth, pendingEth } }

# One claim's exact args + proof (side: 0=Traders, 1=Holders) — re-fetch a single leaf
GET /api/rewards/claim/:epoch/:coin/:side/:addr
{ epoch, coin, side, user, amount, proof, root, algoHash, uri, posted, postedTx }

# The transparency artifact: the full leaf set + root for an epoch (what the on-chain `uri` pins)
GET /api/rewards/epoch/:n
{ epoch, root, algoHash, uri, posted, postedTx, nLeaves, perCoin,
  leaves: [{ coin, side, user, amount, proof }] }

# Protocol-wide reward totals
GET /api/rewards/stats
{ accruedEth, coinsWithRewards, epochsPosted, allocatedEth, leaves, epoch, epochLen }
```

> Reward indexing + posting only run when the indexer is pointed at a live `RewardVault` (`REWARD_VAULT` set). The `epoch/:n` leaf set lets anyone independently recompute the allocation and verify the posted root against the frozen `algoHash`.

## Self-hosting

The indexer is a small Node service (reorg-safe log poller + JSON API over SQLite). It ships with a Dockerfile and a Compose file that also serves the static pad on the same domain with automatic HTTPS. For a launch-day crowd: point it at a private RPC (Alchemy / QuickNode) and put Cloudflare in front.
