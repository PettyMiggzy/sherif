# What the other pads do — and what we should take

Researched Aug 2026. Robinhood Chain first, then the best mechanics from other chains worth stealing.
Sources at the bottom. Where a number is quoted it came from that platform's own docs or coverage.

---

## 1. The field on Robinhood Chain

### Pons — the volume leader (300k+ tokens minted in under a month)

| | |
|---|---|
| Launch fee | **0.0005 ETH** |
| Trading fee | **1%** (Uniswap V3 1% tier) |
| Split | **70% creator / 30% protocol** — legacy launches were **90/10** |
| Supply | Fixed 1,000,000,000 |
| Graduation | **4.2 ETH** — *the same threshold we use* |
| After graduation | **Nothing migrates.** Same pool, LP locked at launch by a locker contract |
| Creator income | Fees accrue in the locked position; creator claims **any time, forever** |
| Protocol income | **80% → automated TWAP buyback/burn · 20% → team** |
| Anti-snipe | First **2 blocks**: launch block is creator-only, then **5% supply wallet cap / 5.5% buy cap**. Sells never restricted |
| Next | V2 on Uniswap V4 + hooks, creators paid in **ETH** not the token |

### hood.dev / hood.fun

Supply **1 → 1e15**, FDV band **1.11–5,556 ETH**, launch fee **0.001 ETH**, **custom CA ending up to 6 hex**,
creator **70%**, anti-sniper **toggle**, **fee-policy modules** (burn · vest · stake · buyback · floor) with
vesting rates **5/10/25/50%**. LP locked forever at graduation.

### Flap — the stock angle

Two modules on Robinhood Chain: **Tax Token V3** and the **Stocks Vault**.
- A creator can set a **tokenized stock as the quote asset** — the meme trades against AAPL instead of ETH.
- A creator can set a stock as the **dividend asset** — holders receive stock tokens while they hold.
- Live assets: **AAPL, GOOGL, NVDA, PLTR, SPY, SPCX**, plus multi-stock baskets.
- Creator fee sharing across **up to 10 wallets**, transferable ownership, revocable update authority.

### Flaunch (Base, Uniswap v4) — not our chain, but the most inventive

- **Progressive Bid Wall:** every **0.1 ETH** of accrued fees places a **0.1 ETH limit order just below spot**.
- **30-minute fixed-price fair launch**, max **0.25% of supply per wallet**, **no selling** during the window.
  Afterwards the raised ETH becomes a **Post-Purchase Pool below spot**, so fair-launch buyers can exit at
  roughly their entry price minus fees.
- Creator fee allocation **0–100%**, splittable across **up to 100 wallets/socials**.
- **Memestream NFT** — the creator's revenue stream is itself an NFT: tradable, fractionalisable, borrowable.
- Platform monetises through **yield** (ETH wrapped to flETH via AAVE, ~2%), **zero platform fee**.
- **$30** to launch; captcha anti-snipe.

### Elsewhere
**Bags** — creators earn **1% of trading volume**, shareable across **up to 100** creators/apps/wallets,
claimed after verifying a linked social. **Zora** — **1%** on creator/content coins, **0.01%** on trend coins.

---

## 2. Where we stand

### We are behind on ONE thing that matters more than the rest

**Creator economics.** Pons pays **70% of every trade, forever, wherever it trades**. hood pays **70%**. Bags
pays **1% of volume**. We pay **45% of the router fee — and only when the trade goes through our own site.**
After graduation a Robin creator earns close to nothing unless they drive traffic back to us.

That is the gap that loses launches. A creator comparing pads sees 70% vs 45%, and ours has a catch.

### Also missing

| feature | who has it | cost to us |
|---|---|---|
| Custom CA ending | hood | small — already scoped |
| Creator picks where fees go | hood, Flaunch | medium — and our UI already asks for it |
| Fee split across many wallets | Flap (10), Bags/Flaunch (100) | small |
| Creator earns after graduation | Pons | **the real one** |
| Stock-quoted memes + stock dividends | Flap | **we built it and switched it off** |
| Revenue stream as a tradable NFT | Flaunch | medium, and nobody here has it |

### Where we are genuinely ahead

**Nobody on Robinhood Chain has a protocol-owned floor.** Pons and hood lock LP — that stops a rug, it does
not bid for your coin. Our Bond posts a real buy wall, plus an Ambush that sells into pumps and recycles the
proceeds into that wall. That is the differentiator, and the research says it is still unclaimed on this chain.

---

## 3. The finding that changes our floor design

**Flaunch's Progressive Bid Wall is a SHALLOW wall — 0.1 ETH just below spot — and it is not farmable.**

We proved a shallow wall is drainable (+0.2299 ETH per round trip on the live band) and went deep (~59% down)
to fix it. Flaunch reaches the same safety from the opposite direction: **bound the wall's SIZE, not its
depth.** A 0.1 ETH order cannot yield more than a fraction of 0.1 ETH to an attacker, while the round-trip cost
of manipulating into it is roughly fixed. Below a certain size, farming stops paying.

That means our deep wall is not the only answer, and it may not be the best one — deep catches crashes but
misses every ordinary dip, which is worse product.

**Proposed hybrid, to model before v4:** many small shallow walls fed continuously by fees (catches dips, size-
bounded so farming never pays) **plus** the deep wall as the crash catcher. Each is safe for a different
reason. This needs measuring on the fork the same way the deep wall was — do not ship it on this reasoning
alone.

---

## 4. Presale — what a good one looks like

The pattern worth copying is **Flaunch's**, not a classic presale:

1. **Fixed price, fixed window** (30 min), everyone pays the same.
2. **Per-wallet cap** (0.25% of supply) so one buyer cannot take the raise.
3. **No selling during the window** — kills the flip-and-dump.
4. **On close, the raise becomes a pool below spot** so participants can exit near their entry. Downside
   protection *by construction*, which is what makes people willing to enter early.

Classic presale ingredients to fold in: **soft cap** (refund everyone if unmet), **hard cap** (stop accepting),
and a **refund window** before claiming.

**Our `PresaleVault` already does the hard parts** — target, deadline, per-wallet cap, minimum contribution,
commit-reveal salts, 100% refunds on miss, and one atomic transaction that launches AND makes the pooled buy so
presalers claim pro-rata at the resulting price. What it lacks versus Flaunch: the **no-sell window** and the
**exit-at-entry pool**. It is v4-only today.

---

## 5. What I would do

**For v2, now (cheap, closes real gaps):**
1. **Raise the creator's share.** 45% is not competitive against 70%. This is the single highest-impact change.
2. **Give the creator post-graduation income** — a share of the locked position's fees, the way Pons does.
   We just built the plumbing to route the ETH side to the platform; the same code can pay the creator a cut.
3. **Custom CA ending** (`XY1ab5`) — already scoped, small.
4. **Fee-destination menu** — burn / marketing / sell wall / pay me. Fixes a live bug at the same time.
5. **Flat launch fee** — everyone charges one (0.0005–0.001 ETH). Ours is free. It monetises the dud tail.
6. **Fee splitting across wallets** — cheap, and every serious pad now has it.

**Revisit immediately: the stock pad.** Flap is shipping stock-quoted memes and stock dividends on our chain,
using assets that are demonstrably live (AAPL, GOOGL, NVDA, PLTR, SPY, SPCX). We built `StockPadFactory`,
`StockQuoteAdapter` and a `DualStaking` that already pays ETH + stock rewards — all disabled on H-2 ("no live
Robinhood stock registry"). **That premise looks stale.** If a registry exists now, we have a shipped
competitor's flagship feature sitting finished in the repo.

**For v4, later:**
- Creator revenue as a tradable NFT (Flaunch's Memestream) — nobody here has it.
- The hybrid bid wall, once measured.
- Presale with a no-sell window and an exit-at-entry pool.

**Skip:** yield-bearing ETH (needs an AAVE-class lender here), captcha (we have no mempool to snipe from),
tiered/lottery allocation (wrong culture for this chain).

---

## Sources

- [Pons docs](https://docs.ponsfamily.com/) · [Pons V2 / Uniswap V4](https://crypto.news/robinhood-chain-launchpad-pons-announces-v2-with-uniswap-v4-upgrade/) · [Pons overview](https://www.kucoin.com/blog/pons-token-robinhood-chain-pump-fun-rival)
- [hood.fun](https://hood.fun/)
- [Flap — stocks to meme holders](https://airdropalert.com/blogs/what-is-flap-launchpad/) · [Flap on DefiLlama](https://defillama.com/protocol/flap-sh)
- [Flaunch mechanics](https://www.blocmates.com/articles/flaunch-redefining-launchpads-with-fixed-price-fair-launch)
- [Creator fees explained](https://crypto.news/what-are-creator-fees-memecoin-launchpads-explained/) · [Best memecoin launchpads 2026](https://coinbureau.com/analysis/best-memecoin-launchpads)
- [Fair launches, presales, bonding curves](https://crypto.news/what-is-a-crypto-launchpad-fair-launch-presale-explained/)
- [Robinhood Chain launchpad landscape](https://www.bitrue.com/blog/best-robinhood-launchpads-2026) · [15 launchpads compete](https://bbx.com/article/545282)
