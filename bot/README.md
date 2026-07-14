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

## How buy detection works
An ERC-20 `Transfer` where `from == PAIR_ADDRESS` means tokens left the pool → a
**buy**. The base token that flowed into the pool in the same tx is the amount
spent, used for price and market cap. Works with UniswapV2-style pairs
(`token0`/`token1`/`getReserves`). If price data can't be resolved it still posts
the token amount, buyer, and tx link.

## Commands
- `/ping`, `/status` — anyone
- `/testbuy` — admin only (posts a sample alert to check formatting)

## Security
- **Never commit `.env`.** It's gitignored. Only `.env.example` (placeholders) is
  tracked.
- If a bot token was ever shared in plaintext, rotate it in @BotFather.

## Running 24/7
Use a process manager or a small host:
```bash
# pm2
npm i -g pm2 && pm2 start buybot.js --name sheriff-buybot
# or systemd / a Railway/Fly/VPS worker
```

## Notes on the current token address
At the time this was set up, `TOKEN_ADDRESS` had **no contract code** on Robinhood
Chain mainnet (chainId 4663) — i.e. it wasn't a live ERC-20 there yet (pre-deploy
or launchpad/bonding-curve). The bot's `--check`/startup will detect this and wait
(retry every 60s) until the token goes live, then resolve the pair and start
alerting. Set `PAIR_ADDRESS` once liquidity exists for reliable detection.
