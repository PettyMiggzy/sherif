# Robin Labs — Buyback & Burn Bot

Buys **$ROBIN** through the live PadRouter and sends it to the dead address —
**no contract deploy, no pad change.** It uses the same router every trade goes
through, so it works while ROBIN is on the curve *and* after it graduates.

Two ways it burns, every cycle:
- **Send it $ROBIN** → it burns that ROBIN directly (transfer to `0x…dEaD`).
- **Send it ETH** → it buys ROBIN and burns it — but only **on dips** (price below
  its rolling average by `DIP_PCT`).

Announcements post a row of 🦊 that grows with the burn size, and every burn is
tracked (totals, history).

---

## Quick start

```bash
cd burnbot
cp .env.example .env
```

1. **Make the burn wallet** and fund it:
   ```bash
   node -e "const{ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log('address',w.address);console.log('key    ',w.privateKey)"
   ```
   Put the `key` in `BURN_PRIVATE_KEY` in `.env`, then **send Robinhood ETH to the
   `address`** (that's the money it burns with). You can also send it **$ROBIN**
   directly anytime — it'll burn that too.
2. **Set `RPC_URL`** to a broadcast-capable Robinhood RPC (the same one the pad uses).
3. **Check it:**
   ```bash
   npm run status
   ```
   Shows the wallet address, ETH balance, dip state, and totals burned.
4. **One test burn** (spends `BUYBACK_ETH` if it's a dip):
   ```bash
   npm run once
   ```
5. **Run it hourly:**
   ```bash
   docker compose up -d --build      # or: pm2 start index.js --name burnbot
   docker compose logs -f
   ```

### Burn announcements (optional)
Set `TG_BOT_TOKEN` + `TG_CHAT_ID` to post each burn to a channel. For the custom
🦊 emoji: DM the emoji to the bot, run `node getEmojiId.js`, and paste the printed
id into `CUSTOM_EMOJI_ID`. (Custom emoji animate for Telegram Premium viewers;
everyone else sees the plain 🦊.)

---

## Config (`.env`)
| Var | Default | What |
|---|---|---|
| `RPC_URL` | — | broadcast-capable Robinhood RPC (secret if keyed) |
| `BURN_PRIVATE_KEY` | — | the burn wallet's key (secret, .env only) |
| `TOKEN` | $ROBIN | token to buy & burn |
| `BUYBACK_ETH` | `0.05` | ETH per dip-buy (or `max`) |
| `INTERVAL_MIN` | `60` | cycle cadence (hourly) |
| `DIP_PCT` | `4` | buy when ≥ this % below the rolling avg (`0` = every cycle) |
| `DIP_WINDOW_HRS` | `48` | rolling window the dip is measured against |
| `GAS_RESERVE_ETH` | `0.003` | always kept for gas |
| `MIN_BALANCE_ETH` | `0.01` | don't buy below this |
| `SLIPPAGE_PCT` | `15` | buyback slippage tolerance |
| `BURN_EMOJI` / `CUSTOM_EMOJI_ID` | 🦊 | announcement emoji (+ custom id) |
| `EMOJI_STEP_ETH` / `EMOJI_MAX` | `0.01` / `50` | one emoji per this much ETH, capped |

**Runway math:** at `0.05` ETH/dip-buy, hourly, sending ~**2.4 ETH** funds ~**48h**
of dip-buys (longer, since it only buys on dips). It stops buying when the balance
drops below `MIN_BALANCE_ETH` — top it up to keep going.

---

## Safety
- `router.buy` is **quoted first** (staticCall); a revert or ~0 quote aborts the
  cycle instead of sending an unprotected buy. Slippage floor applied.
- Every write is a **legacy type-0 tx** with an explicit gasPrice (Robinhood Chain
  has no EIP-1559); tx waits are bounded (3 min).
- The burn wallet is a **hot wallet** — keep only what you intend to burn in it,
  and never commit `.env`. `BURN_PRIVATE_KEY` is the only thing at risk.
- Offline-simulated end to end: `RPC_URL=x BURN_PRIVATE_KEY=0x… node test/sim.mjs`
  (27 checks — legacy txs, buy→burn-to-DEAD, held-burn, dip math, quote-abort).

## Files
| File | Role |
|---|---|
| `index.js` | CLI (`--status` / `--once` / scheduled), cycle logic, announce, ledger |
| `burn.js` | buy→burn, held-burn, price probe, dip math, legacy tx |
| `config.js` | addresses, ABIs, tunables |
| `getEmojiId.js` | prints a custom emoji's id for `CUSTOM_EMOJI_ID` |
