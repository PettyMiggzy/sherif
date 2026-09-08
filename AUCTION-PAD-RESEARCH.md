# Auction launchpads — research for the Robin Auction Pad

Research pass for the proposed v4 model: an optional 1–3 day auction, 10% of supply per day,
raise split 10% platform / 90% into the curve, 4.2 ETH auto-graduation, dual-pool graduation
(ROBIN 40% + a creator-chosen WETH / ETH / stock leg at 60%), creator-picked supply, airdrop at
creation, v4 buy/sell taxes, and unsold tokens to the coin's own staking pool.

Purpose of this document is to establish **what already exists** before we design, because two
launchpads on this same chain already ship most of the auction half of the idea.

---

## 1. The canonical design: Uniswap's Continuous Clearing Auction (CCA)

The reference implementation for "auction instead of first-come-first-served". Built by Uniswap
Labs, used for Aztec's December 2025 sale (~$59–61M from ~17,000 bidders across 191 countries)
and re-used for Igra's IGRA sale.

Mechanically:

| | |
|---|---|
| **Bid** | a MAX PRICE plus a BUDGET — not a market order |
| **Spreading** | every bid is automatically split across **all remaining intervals**, at the same max price |
| **Clearing** | each interval sets **one uniform price** — the highest price at which that interval's released supply clears |
| **Priority** | higher max-price bids fill first; at the clearing price itself, **pro-rata** |
| **Monotonicity** | price can only rise or hold, never fall — "once a tick is reached it becomes the new floor" |
| **Fill maths** | `amount_paid = bid_amount × (current_mps / total_mps)`, total MPS = 10,000,000 |
| **Withdrawal** | bids are non-withdrawable while in range; withdrawable once out of range |
| **Floor** | a reserve price (IGRA: $0.006) |
| **Failure** | a graduation threshold — **miss it and every bidder is fully refunded** |
| **Exit** | at close, proceeds automatically create a Uniswap v4 pool **at the discovered price** |

The property worth stealing: **early bidding is cheaper without a within-interval race.** A bidder
who commits early has more of their budget exposed to earlier, cheaper intervals, so their
*average* price is lower — but being milliseconds earlier inside one interval buys nothing.

Third-party research on CCA (auditless) does not find it unbreakable. Live weaknesses: residual
bid shading, whales deliberately under-bidding to suppress the clearing price, secondary markets
in bids via proxy accounts, and — most relevant to us — **post-auction sniping at the pool
transition**, where early bidders are first to sell into the freshly seeded pool at the final
clearing price while carrying almost no price risk.

## 2. What is already live on Robinhood Chain

| Launchpad | Launch mechanism | Fees | Graduation |
|---|---|---|---|
| **pools.trade** (Uniswap Labs) | **Crowd Launch**: 4-hour TWAP auction, bids are budgets filled gradually — or **Instant Launch**: plain curve | 0.25% LP fee, autocompounding; creator fee optional at 0.05% of the 25bps | **$10k min FDV or every order is refunded**; v4 pool, liquidity locked forever |
| **STONKZ** | **Ladder auction** — supply in per-block tranches, price rung advances *only when a tranche fully clears*; **per-capita fill** with a log size bonus; per-wallet cap; four duration tiers (1h / 4h / 24h / 7d) | 25% of ongoing trading fees to protocol, hard-capped at 40%, stamped immutably at launch | "LP HELTH" gate — raise ≥ creator threshold **AND** pool health ρ inside the tier band (1h: 40–50%, 24h: 50–60%) |
| **Pons** | fixed 1B supply, pool live from block one | 0.0005 ETH to launch, 1% pool fee; creators keep 70% of every trade; **80% of protocol revenue buys back and burns PONS** (29% of supply burned so far) | 4.2 ETH paired WETH |
| **long.xyz** | memecoins paired against tokenized stocks (NVDA, AAPL, MSFT, GOOGL, TSLA, MU, SPCX) | not published | 24h ticker reservations against sniping; token addresses ending `1e18` |
| **hood.fun** | fair curve, auto-migrates to locked Uniswap v3 | not published | curve completion |
| **flap.sh** | curve paying stock tokens | not published | — |

**kekfun.xyz** has no indexed documentation as of this pass — the site renders only a title
("The Most Powerful Launchpad on Robinhood") and there is no docs subdomain, no whitepaper and no
third-party writeup of its auction. Its mechanism could not be verified. The 10%-per-day shape
described to me is closest to STONKZ's ladder among anything that *is* documented.

## 3. What this means for the proposed design

Three parts of the idea are **already table stakes on this chain**, not differentiation:

- **An auction instead of FCFS.** pools.trade (Uniswap Labs itself) and STONKZ both ship one.
- **A minimum-raise refund.** Both competitors have it; the proposed design does not specify one.
- **Stock pairing.** long.xyz, flap.sh and Pons all already pair against tokenized equities.

Two parts are **genuinely not done by anyone above**:

- **A mandatory ROBIN leg in every graduating pool.** Pons buys back and burns its token out of
  fee *revenue* — a one-time sink. Putting ROBIN into *permanently locked LP* on every graduation
  is structurally different: the demand is recurring, it compounds with launch volume, and the
  ROBIN never leaves the pool. This is the strongest tokenomic in the proposal and the clearest
  moat.
- **Unsold auction supply into that coin's own staking pool.** Nobody listed does this. It turns a
  failed or partial auction into staking yield rather than overhang.

And one part is a **real edge that only holds if the code holds**: enforced buy/sell taxes on a v4
hook. Competitors charge LP fees (0.25%–1%), which are avoidable by trading a pool they don't
control. A hook-enforced tax is not — but only once the sibling-pool route is closed, which is what
the L25 fix does. That fix is what makes the "unavoidable" claim true rather than marketing.

## Sources

- [Continuous Clearing Auctions: Bootstrapping Liquidity on Uniswap v4](https://blog.uniswap.org/continuous-clearing-auctions)
- [How Aztec Raised $59M With 17,000 Bidders Using Uniswap's CCA](https://blog.uniswap.org/aztec-cca)
- [Understanding the Aztec Token Auction: A Deep Dive into Continuous Clearing Auctions](https://hackmd.io/SCfjYNHQTmuRl2adnFi2oA)
- [Igra Network Announces IGRA Public Token Sale via Continuous Clearing Auction](https://decrypt.co/362180/igra-network-announces-igra-public-token-sale-via-continuous-clearing-auction-proven-at-59m-scale)
- [My Attempt at Breaking Uniswap's New Auction Protocol](https://research.auditless.com/p/want-to-win-the-aztec-sale-study)
- [Pools.trade: A New Way to Launch on Robinhood Chain](https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain)
- [STONKZ — the fair-launch ladder auction](https://stonkz.green/)
- [Robinhood Chain Launchpads Compared (2026)](https://memecentral.fun/guides/robinhood-chain-launchpads-compared)
- [What Is Long.xyz? The Launchpad Pairing Memecoins With Stocks](https://airdropalert.com/blogs/what-is-long-xyz/)
- [Pons Explained: Robinhood Chain Launchpad & Tokenomics](https://www.datawallet.com/crypto/pons-explained)
