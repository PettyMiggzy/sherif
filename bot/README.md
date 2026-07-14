# $SHERIFF Buy Bot

A Telegram buy bot for **$SHERIFF** on **Robinhood Chain**. It watches the token's
liquidity pair for buys and posts alerts (amount, USD/price, market cap, buyer, tx
link) to your Telegram group.

> Community meme utility. It only **reads** the chain and **posts** alerts — it
> holds no keys, moves no funds, and has no token/airdrop mechanic.

## Setup

```bash
cd bot
cp .env.example .env      # then edit .env with your real values
npm install
npm run check             # validates RPC + token + resolves the LP pair (no posting)
npm start                 # runs the bot
```

### Required `.env` values
- `TELEGRAM_BOT_TOKEN` — from @BotFather (**secret**)
- `TELEGRAM_CHAT_ID` — the group/channel id (e.g. `-1003503389902`)
- `TOKEN_ADDRESS` — the $SHERIFF contract
- `PAIR_ADDRESS` — the LP pair (recommended). Leave blank to auto-detect.

See `.env.example` for the full list (price, thresholds, links, media).

## Detection modes
- **Premium RPC (instant)** — set `RPC_URL` to your Robinhood Chain RPC and the bot
  watches the curve/pair (`0x37F84F3A…`) on-chain, firing alerts the moment a buy
  lands (checks new blocks every `RPC_POLL_MS`, default 4s). ape.store is still used
  to enrich each alert with price / MC / curve %. **Recommended.**
- **ape.store polling (default)** — no RPC needed; polls the ape.store `/trades`
  API every `POLL_MS`.

An RPC url with an API key in it is a **secret** — keep it in `.env` (gitignored).

## How buy detection works
An ERC-20 `Transfer` where `from == PAIR_ADDRESS` means tokens left the pool → a
**buy**. The base token that flowed into the pool in the same tx is the amount
spent, used for price and market cap. Works with UniswapV2-style pairs
(`token0`/`token1`/`getReserves`). If price data can't be resolved it still posts
the token amount, buyer, and tx link.

## Buy alert media
Each buy alert attaches the **animated Sheriff** (`media/buy.mp4`) — uploaded to
Telegram once, then reused via its `file_id` (fast, no re-upload). Override with
`MEDIA_PATH` (local file) or `MEDIA_URL` (public url), or set `MEDIA_PATH=` empty
for text-only alerts.

## Commands
Every reply has inline **Chart / Buy / 𝕏 / TG** buttons and pulls live ape.store data.

**Market:** `/price` · `/mc` · `/stats` · `/curve` · `/king` · `/vol` · `/supply` · `/holders`
**Community:** `/top` (top buyers) · `/recent` · `/info` · `/ca` · `/chart` · `/buy` · `/links` · `/quote` · `/shill` · `/gm`
**General:** `/help` · `/ping`

**Admin only** (your `ADMIN_ID`):
- `/testbuy` — post a sample buy alert (with media)
- `/mute` / `/unmute` — pause / resume buy alerts
- `/setmin <usd>` — only alert buys above this USD
- `/setemoji <emoji>` — change the buy emoji
- `/say <message>` — broadcast to the group

Admin overrides (`mute`, `min`, `emoji`) persist across restarts. Test any command
without posting: `node buybot.js --cmd stats`

## Security
- **Never commit `.env`.** It's gitignored. Only `.env.example` (placeholders) is
  tracked.
- If a bot token was ever shared in plaintext, rotate it in @BotFather.

## Running 24/7
Deploy configs are included — pick one:

```bash
# pm2 (loads bot/.env automatically)
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save

# Docker (pass secrets as env, not baked in)
docker build -t sheriff-buybot .
docker run -d --restart=always --env-file .env --name sheriff-buybot sheriff-buybot

# systemd (edit paths/user in sheriff-buybot.service first)
sudo cp sheriff-buybot.service /etc/systemd/system/ && sudo systemctl enable --now sheriff-buybot

# Railway / Render / Fly / Heroku-style: uses the Procfile (worker: node buybot.js)
```
Set the env vars (`.env` values) in your host's dashboard for hosted platforms.

## Notes on the current token address
At the time this was set up, `TOKEN_ADDRESS` had **no contract code** on Robinhood
Chain mainnet (chainId 4663) — i.e. it wasn't a live ERC-20 there yet (pre-deploy
or launchpad/bonding-curve). The bot's `--check`/startup will detect this and wait
(retry every 60s) until the token goes live, then resolve the pair and start
alerting. Set `PAIR_ADDRESS` once liquidity exists for reliable detection.
