# Autopilot — hands-off deposit → buy

Send Robinhood ETH to your distributor wallet whenever you want. The autopilot
spreads it across fresh wallets (one buy's worth each, as many as the deposit
covers) and immediately buys the token from each — no funding rounds, no
babysitting. It cycles through the wallet pool and reuses it on later deposits.

**What each buy costs, all-in (measured on-chain):**
- ~$0.0134 to make the swap (fixed chain gas — can't go lower)
- ~$0.0035 to send ETH to a **fresh** wallet the first time (account creation), or
  ~$0.0010 once that wallet already exists (reused = "warm")
- ~$0.0002 for the token itself (the floor `amountIn`)

**Fewer wallets = more total transactions**, because each wallet is reused warm
instead of paying the new-wallet tax every time:

| Pool size | Total tx per $100 | Distinct buyers |
|---|---|---|
| 8,000 | ~5,240 | 5,240 |
| 2,000 | ~5,750 | 2,000 |
| **200 (default)** | **~6,030** | 200 |
| 50 | ~6,055 | 50 |

**200 is the sweet spot** — ~99% of the max tx count, still 200 distinct buyers, and
good parallelism. Raise `WALLET_COUNT` only if you want more distinct addresses (it
costs ~15% of your tx count). ($20 ≈ ~1,180 tx at 200 wallets.)

---

## One-time setup (on the droplet)

```bash
cd /root/robin-dist/robin-distributor-contract

git pull                     # get the autopilot scripts
npm install                  # ethers etc. (if not already)
npm run compile              # builds the Disperse ABI the autopilot needs
```

### 1. Generate the wallet pool (keys stay on this server)
```bash
WALLET_COUNT=200 npm run generate
```
Writes `keys.json` (SECRET, gitignored) and `pool-addresses.json`. **Back up
`keys.json`** — it holds the private keys for every trading wallet. 200 wallets are
reused ("cycled") across every deposit, which is what maximizes total transactions.

### 2. Point `.env` at the settings
Your `.env` already has `PRIVATE_KEY` (the distributor), `ROBINHOOD_RPC` (Alchemy),
and `DISPERSE_ADDRESS`. Add / confirm the autopilot lines:
```ini
BUY_AMOUNT_IN_WEI=100000000000   # 1e-7 ETH — the floor (lowest worth going)
BUY_GAS_LIMIT=135000
FUND_BUFFER_BP=300
BUY_CONCURRENCY=8
GAS_BUFFER=1.05
POLL_MS=12000
```

### 3. Start it
```bash
# quick test in the foreground first:
npm run autopilot

# then run it for real under pm2 (survives reboots):
pm2 start deploy/ecosystem.autopilot.cjs
pm2 logs robin-autopilot
pm2 save && pm2 startup
```
(Or systemd: `sudo cp deploy/robin-autopilot.service /etc/systemd/system/ &&
sudo systemctl enable --now robin-autopilot && journalctl -u robin-autopilot -f`.)

---

## Using it

Just **send ETH to your distributor wallet** (the `PRIVATE_KEY` address the log
prints on startup). Within `POLL_MS` the autopilot funds wallets and buys. Send
more anytime — it keeps going from where the cursor left off.

`autopilot-state.json` tracks the cursor and lifetime buy count, so a restart
picks up where it stopped.

## Knobs (in `.env`, then restart)
| Want | Change |
|---|---|
| Most buys / cheapest | keep `BUY_AMOUNT_IN_WEI=100000000000` (the floor) |
| Bigger buys, fewer of them | raise `BUY_AMOUNT_IN_WEI` |
| Squeeze a few % more buys (riskier) | lower `BUY_GAS_LIMIT` toward `132000` |
| Faster rounds | raise `BUY_CONCURRENCY` (watch the RPC) |

## Notes
- `amountOutMinimum` is 0 (same as your existing working buys), so tiny buys never
  revert on size — the floor amount is safe.
- Only the wallets the autopilot just funded are touched each round, so it never
  does the slow 8,000-wallet balance scan that froze the old bot.
- The old `keys.json` wallets from the previous bot are separate; sweep any leftover
  funds from them on your own if you want — this pool is brand new.
