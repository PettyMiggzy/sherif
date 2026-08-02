# Robin Labs — Telegram Launch Bot

Create and trade tokens on **Robin Labs / Robinhood Chain** straight from Telegram.
It's a pure **command bot** (not a Mini App): users DM it, it manages a custodial
wallet per user, and it signs launches/buys/sells on their behalf against the live
factory and router.

```
/start     → makes your wallet, shows the deposit address + risk disclaimer
/launch    → name → ticker → image → optional dev-buy → live coin + chart link
/balance   → your ETH + coins
/deposit   → your deposit address (Robinhood Chain only)
/withdraw <address>  → sweep your ETH out
/buy <token> <eth>   → buy a coin
/sell <token> <pct>  → sell part of a holding
/mycoins   → coins you launched
/forget    → erase all your data (withdraw first!)
/disclaimer /help /paysupport /cancel
```

No contract changes were needed — the bot wraps the already-live, source-verified
deployment. `launch()` is a single call, and the SDK's legacy-tx handling is baked
in (Robinhood Chain has no EIP-1559).

---

## Setup

1. **Create the bot** with [@BotFather](https://t.me/BotFather) → get the token.
2. **Config:**
   ```bash
   cp .env.example .env
   # fill in TELEGRAM_BOT_TOKEN, RPC_URL (a broadcast-capable premium RPC),
   # and MASTER_SECRET:
   openssl rand -hex 32     # paste into MASTER_SECRET
   ```
3. **Run** (Docker, next to the indexer):
   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```
   or with pm2:
   ```bash
   npm install && pm2 start ecosystem.config.cjs
   ```
4. DM your bot `/start`.

### Config reference (`.env`)
| Var | What |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather (secret) |
| `RPC_URL` | premium Robinhood RPC that accepts `eth_sendRawTransaction` (secret) — **not** the indexer `/rpc` read proxy |
| `MASTER_SECRET` | 32-byte hex; encrypts every custodial key at rest (secret) |
| `API_BASE` / `SITE_BASE` | indexer + site, for pfp upload and chart links |
| `SLIPPAGE_PCT` | slippage for `/buy` and `/sell` (default 12) |
| `LAUNCH_FEE_ETH` / `FEE_WALLET` | optional on-chain bot fee per launch (0 = off) |
| `DATA_DIR` | where the encrypted wallet store persists (mount a volume) |

---

## Custody & security

This bot holds funds. Treat it like a hot wallet service.

- **Keys are encrypted at rest** with AES-256-GCM under a key derived (scrypt) from
  `MASTER_SECRET` + a per-user salt. Plaintext keys exist only in memory for the
  instant a tx is signed, and are **never logged**.
- **`MASTER_SECRET` is the crown jewel.** If it leaks, every wallet is exposed. If
  it's lost, every wallet is unrecoverable. Keep it out of the repo, in the
  environment only, and backed up somewhere safe.
- The wallet store (`data/wallets.json`) is written `0600` and atomically. **Back up
  the volume** — losing it loses every user's funds.

### Rotating `MASTER_SECRET`

If `MASTER_SECRET` is ever exposed, rotate it. **You cannot just edit `.env` and
restart** — the keystore is encrypted under the old secret, so a new secret makes
every GCM auth tag fail and locks every user out of their own wallet. Use the
re-encryption tool, which decrypts under the old secret and re-encrypts under the
new one (the private keys themselves don't change), all-or-nothing, with a backup:

```bash
cd launchbot
node rotate-secret.js --gen            # generate a strong new secret (32-byte hex)
node rotate-secret.js --check          # sanity: keystore opens under the CURRENT secret

# dry run, then the real rotation (keep both secrets in env, not shell history):
OLD_MASTER_SECRET=<current> NEW_MASTER_SECRET=<new> node rotate-secret.js --dry-run
OLD_MASTER_SECRET=<current> NEW_MASTER_SECRET=<new> node rotate-secret.js

# then set MASTER_SECRET=<new> in .env, restart, and verify:
MASTER_SECRET=<new> node rotate-secret.js --check
```

`OLD_MASTER_SECRET` defaults to `MASTER_SECRET` if unset. A pre-rotation backup is
saved as `wallets.json.bak-<ts>` — it still opens under the OLD secret, so delete
it once the bot is healthy on the new secret.

> Re-encryption re-protects the **same** keys. If the keystore file *also* leaked
> alongside the secret, the plaintext keys are already exposed — rotation won't
> un-leak them; you'd have to generate fresh wallets and move funds. Rotation fully
> restores safety only when `data/wallets.json` never left the host.
- Tell users to keep only what they'll use and `/withdraw` the rest. The `/start`
  and `/disclaimer` copy says exactly this.

---

## Telegram ToS compliance

Built to the [Bot Developer Terms](https://telegram.org/tos/bot-developers). The
design choices below are deliberate — don't undo them without re-checking the ToS.

- **Command bot, not a Mini App.** §7 restricts *Mini Apps* that generate crypto
  tokens to TON + TON Connect. This is a plain chat-command bot — it embeds no
  web app and uses no TON Connect — so §7 doesn't apply. **Do not add a Mini App
  / WebApp launch flow** on a non-TON chain; that's the line that gets bots pulled.
- **No Telegram Stars / no Telegram-native payments.** §6.2 requires digital-goods
  payments *inside Telegram* to use Stars. This bot takes **no** Telegram payments —
  all value moves on-chain in the user's own custodial wallet. Any optional bot fee
  is charged **on-chain in ETH** (`LAUNCH_FEE_ETH`), never through Telegram.
- **Opt-in only, no spam/broadcast** (§5.2b). The bot replies only to users who DM
  it first, and ignores group chats. There is no mass-message feature.
- **No misrepresentation; never asks for secrets** (§5.2d). Honest custody + risk
  disclaimer up front; the bot never asks for a Telegram password or login code.
- **Data minimization + erasure** (§4.2/§4.3). Stores only the Telegram id, the
  encrypted wallet, and launch history. `/forget` deletes a user's record on
  request. No scraping, no dataset building.
- **`/paysupport`** is handled in good faith (§6.2.1).

None of this makes a crypto bot bulletproof — Telegram can still act at its
discretion — but staying a command bot with no Mini App, no Stars, opt-in only, and
honest disclosures is the posture that keeps trading/launch bots online.

---

## Files
| File | Role |
|---|---|
| `bot.js` | Telegram long-poll loop, commands, the launch wizard |
| `chain.js` | launch / buy / sell / withdraw, legacy-tx overrides |
| `store.js` | custodial wallet store (encrypted keys, sessions, `/forget`) |
| `profile.js` | creator-signed pfp upload to the indexer |
| `config.js` | addresses, ABIs, tunables (mirrors `sdk/robinlabs.mjs`) |
