# Robin Disperse — auto ETH distributor (Robinhood Chain, 4663)

Send Robinhood ETH to one wallet; a watcher on your droplet detects it and pays
**a fixed `$0.0000814` to each of your 1000 wallets** — in **one transaction**
whenever the wallets already exist, gas pinned to baseFee. Anything you don't
distribute stays in your wallet; it's yours to collect anytime.

Two things are proven by `npm test` against the real 1000-address list:
- **1000 wallets in a single tx = ~10.05M gas (~10k/wallet)** — under the chain's
  16,777,216 per-tx cap, and roughly half the gas of individual sends.
- Every recipient receives exactly `$0.0000814`; overpayment is refunded; the
  contract never holds funds.

---

## Recommended path: `Disperse` + watcher

`Disperse` is a stateless one-tx multisend (holds no funds). The watcher funds
as many wallets as your balance affords, in the fewest txs that fit the gas cap
(one tx once the wallets exist), and repeats automatically on every deposit.

```bash
npm install
npm run build:recipients      # recipients.txt -> recipients.json (validated, checksummed)
npm run compile
npm test                      # proves the multisend against all 1000 addresses

cp .env.example .env && nano .env      # set PRIVATE_KEY (your funding wallet)
npm run deploy:disperse                # deploy Disperse; prints DISPERSE_ADDRESS
# add DISPERSE_ADDRESS=0x... to .env
npm run address                        # the wallet to send Robinhood ETH to

# send ETH to that wallet, then either:
npm run disperse:once                  # one pass now
npm run watch                          # stay running; auto-disperse on every deposit
```

Run the watcher 24/7 on your droplet with systemd or pm2:

```bash
sudo cp deploy/robin-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now robin-watcher
journalctl -u robin-watcher -f
#  or:  npm i -g pm2 && pm2 start deploy/ecosystem.watch.cjs && pm2 logs robin-watcher
```

### Gas reality (measured live, ~0.067 gwei, ETH≈$1,878)

| | gas/wallet | 1000 wallets | ≈ USD |
|---|---|---|---|
| individual sends (first-ever payment) | 21,000 | 21M | ~$2.6 |
| **Disperse, wallets already exist** | **~10,000** | **~10M (ONE tx)** | **~$1.3** |

The value moved is only `$0.0814` total — gas is larger only because `$0.0000814`
is tiny — but the whole job is a couple dollars, and each individual tx is
sub-cent. The **first** round (creating fresh wallets) costs the ~25k/wallet
account-creation either way; every round after is cheapest here.

### Collecting funds back

Nothing is locked. The funding wallet is **yours** (you hold the key) — sweep any
leftover ETH anywhere, anytime. `Disperse` itself never holds a balance (it
refunds overpayment in the same tx).

---

## Alternative path: the `RobinDistributor` contract

A stateful contract that stores the recipients on-chain and does the split
itself (`fixed` = one `$0.0000814` each, or `even` = drain the whole balance
evenly). Costs more gas (stores the list; ~39k/wallet fresh) but is fully
on-chain and self-contained. See `contracts/RobinDistributor.sol`.

```bash
npm run deploy      # deploy RobinDistributor
npm run load        # push recipients on-chain
npm run plan        # preview (DISTRIBUTE_MODE=fixed|even)
npm run distribute  # startRound + batched payouts
npm run estimate    # local gas estimate priced live
```

---

## Commands

| Command | What |
|---|---|
| `npm run build:recipients` | Validate + checksum recipients.txt → recipients.json |
| `npm run compile` / `npm test` | Compile / run the full proof suite |
| `npm run deploy:disperse` | Deploy the stateless multisend |
| `npm run address` | Print the funding address + balance |
| `npm run disperse:once` | One distribution pass now |
| `npm run watch` | Auto-disperse on every deposit (daemon) |
| `npm run estimate` | Local gas estimate for RobinDistributor, priced live |

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `PRIVATE_KEY` | — (required) | Funding wallet; send ETH here, it sends from it. |
| `ROBINHOOD_RPC` | public Blockscout RPC | Chain 4663 RPC. |
| `DISPERSE_ADDRESS` | — | Set after `deploy:disperse`. |
| `INCREMENT_USD` | `0.0000814` | Per-wallet amount. |
| `ETH_USD` | live (CoinGecko) | Pin the price offline/deterministic. |
| `INCREMENT_WEI` | — | Pin the per-wallet amount in wei (skips pricing). |
| `POLL_MS` / `MIN_DEPOSIT_WEI` | `15000` / `0` | Watcher poll interval / minimum deposit. |
| `SAFE_GAS` | `14000000` | Per-tx gas ceiling for batching. |
| `GAS_BUFFER` | `1.25` | gasPrice = baseFee × this. |

## Safety

- **Not third-party audited.** The tests prove the distribution logic, not
  economic safety. Get an audit before large value flows through it.
- `disperseEqual` is atomic — if any single recipient were a contract that
  rejects ETH, that batch reverts (nothing lost). Your list is EOAs, so this
  won't happen in practice; remove any bad address if it ever does.
- `.env`, `artifacts/`, `cache/` are gitignored. Keep your key off the network.
