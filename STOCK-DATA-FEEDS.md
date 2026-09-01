# Stock price feeds — research notes

Researched 2026-09-01. **Not verified by us** — free-tier limits and endpoints move, so re-check
before building against any of this. Recorded so nobody re-runs the same search.

## Robinhood does not offer what you'd assume

- The public **Crypto** Trading API (`docs.robinhood.com`) is REST-only, Ed25519-signed requests.
  **No streaming endpoint.**
- There is **no public equities API at all.**
- The `wss://` feed the Robinhood web/mobile app uses is internal and undocumented. Consuming it —
  or unofficial-auth libraries in the `robin_stocks` family — **violates their ToS** and breaks
  whenever they rotate anything. Not a foundation to build a product on.

So: "Robinhood Chain hosts tokenized equities" does **not** imply we can get Robinhood's own prices.

## Usable `wss://` for equities

| | endpoint | free tier |
|---|---|---|
| **Alpaca** (best free option) | `wss://stream.data.alpaca.markets/v2/iex` | real-time IEX trades/quotes/bars, 1 concurrent connection, 30 symbols; paper account, no funding needed |
| Finnhub | `wss://ws.finnhub.io?token=KEY` | US trades, ~50 symbols |
| Twelve Data | has a free WSS tier | credit limits make it near-useless for anything continuous |

Note Alpaca free is **IEX only**, not the consolidated tape — it is a slice of national volume, so
prices can differ from a full-market quote. Fine for a display number, not for anything settling money.

## Usable `wss://` for crypto (no key)

- Binance `wss://stream.binance.com:9443/ws/btcusdt@trade`
- Coinbase `wss://ws-feed.exchange.coinbase.com`
- Kraken `wss://ws.kraken.com/v2`

## The shape that works

Market data from Alpaca/Finnhub; Robinhood's REST API only for our own account/orders, if we ever
need that at all.

## BEFORE building this, read the stance we already took

`pad/assets/config.js` (UNI_STOCK_TOKENS) says, in our own words:

> Tokenized stocks are swappable through the same page and pay us NOTHING. Not a promotion — taking a
> cut of a trade in a tokenized security is what turns a front end into a fee-taking venue for
> securities, and the pad is not one.

Showing a live **real-equity** price next to a tradeable token is a step toward quoting a security,
which is closer to that line than the current setup — today the swap tab prices these tokens off
DexScreener, i.e. off their own on-chain market, not off the underlying. That is a deliberate
difference, not an oversight. If we add an underlying-price feed, decide on purpose whether it is
labelled as reference information about the company or presented as the token's price, because those
are not the same claim. Worth a lawyer's eye before it ships, not after.
