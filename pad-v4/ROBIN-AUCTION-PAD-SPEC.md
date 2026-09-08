# Robin Auction Pad — design spec

The proposed model: creator optionally runs a **1–3 day auction**, **10% of supply per day**, raise
split **10% platform / 90% into the curve**, **4.2 ETH auto-graduation**, graduation into **two
pools** (ROBIN 40% + a creator-chosen WETH / ETH / stock leg 60%), creator-picked supply, airdrop at
creation, v4 buy/sell taxes, and **unsold supply into the coin's own staking pool**.

Competitive grounding for all of this is in [`../AUCTION-PAD-RESEARCH.md`](../AUCTION-PAD-RESEARCH.md).
This document is the design.

---

## 0. The thing worth knowing first: most of this already exists

`contracts/presale/PresaleVault.sol` is already, almost exactly, the auction's settlement engine.
It is an EIP-1167 clone per sale, factory-initialized, and it already implements:

| The auction needs | `PresaleVault` today |
|---|---|
| ETH in, per-wallet cap, deadline | `deposit()`, `perWalletCap`, `deadline` |
| **10% platform cut of the raise** | `PLATFORM_FEE_BPS = 1000`, taken once on success |
| **Proceeds into the curve** | `finalize()` launches the curve and does the pooled first buy atomically |
| **"divided based on amount u bid"** | pro-rata token claim at the resulting price + pro-rata refund of unspent ETH |
| **Minimum raise or refund** | full refunds on failure — a failed raise takes no cut at all |
| Launch-snipe protection | commit-reveal salts; a sniped launch fails safe to 100% refunds |
| No admin over contributor funds | no owner, no operator; the only external address is the timelocked fee registry |

So this is not "build an auction protocol". It is **add a release schedule and a price ladder to a
vault we have already written and audited**. That is the single biggest cost saving available here,
and it also means the money-handling paths that would otherwise be brand-new unaudited code are not.

What is genuinely new: the tranche/rung ladder, the reserve price, the unsold→staking route, and
the dual-pool graduation.

---

## 1. The auction mechanism

### 1.1 The problem with the rule as stated

Two of the stated rules cannot both be live:

> "on that day 1st buy is cheapest and grows as day goes on" **and** "if multiple bids then divided
> based on amount u bid"

If the day's 10% is divided pro-rata by ETH contributed, then every bidder that day gets the same
effective price — total ETH ÷ 100M tokens — and the intraday ladder changes nothing. If instead each
bid fills at whatever the ladder reads at the moment it lands, then it is first-come-first-served and
pro-rata never applies. Pick one.

Worse, a ladder that climbs **on the clock** re-creates the exact problem the daily batch exists to
solve: if 09:00 is cheaper than 09:01, the optimal strategy is to land in the first block of the day,
and that is a priority-fee auction won by bots. It would be an FCFS launchpad wearing an auction hat.

### 1.2 The fix — a demand-driven ladder

Take STONKZ's rule, which is the right one, and which is also how Uniswap's CCA gets "early is
cheaper" without a within-interval race:

- The day's 10% is released in **tranches** (suggest 96/day → one per 15 minutes; 1.04M tokens per
  tranche at 1B supply).
- Price sits on a **rung**. The rung advances **only when a tranche fully clears** — never on the
  clock. A tranche that does not clear is re-offered at the same rung.
- Everyone filling in a tranche pays **that tranche's rung**, whether they were first or last.
- If a tranche is oversubscribed, allocation is **pro-rata by ETH** — the owner's rule, kept — and
  surplus ETH rolls into the next tranche.

This delivers exactly the stated intent: the first buys of the auction are the cheapest, and the
price climbs through the day. But it climbs because **demand cleared supply**, not because time
passed, so there is no advantage whatsoever to being milliseconds earlier. Early conviction is still
paid: an early bidder's budget is exposed to more cheap rungs, so their average price is lower.

> **Superseded in implementation, not in reasoning.** §2.2 shows the curve's own tick range already
> *is* this ladder, so none of it needs building as a separate mechanism. The argument above still
> decides the question it answers — the price must climb with demand, never with the clock — and a
> bonding curve satisfies that by construction.

*Alternative worth knowing:* STONKZ dampens whales with **per-capita** fills plus a logarithmic size
bonus — at their 10% setting, 1,000× the capital gets 2.59× the fill instead of 1,000×. It is more
"fair launch" and it is a real differentiator, but it is also more complex and easier to sybil. Plain
pro-rata is what was asked for and is simpler to audit. Flagging it as a knob, not recommending a
change.

### 1.3 The rung does not reset between days

Day 2 starts on the rung day 1 ended on. Monotone, never decreasing — the CCA rule ("once a tick is
reached it becomes the new floor"). If the ladder reset nightly, a day-3 bidder could buy cheaper
than a day-1 bidder, which punishes exactly the early conviction the design is trying to reward.

### 1.4 A reserve price is mandatory

As stated, "if only one bid they win the day's 10% allocation" is an open vault. A single 0.001 ETH
bid on a quiet day takes 100M tokens. Anyone watching for auctions with no bids can farm this, and
the creator can do it to themselves.

Every credible auction in this category has a floor — IGRA's was $0.006, pools.trade uses a $10k
minimum FDV. So: the creator declares a **floor price**, validated against the existing FDV band
(`PadValuation` / the `PoolMath.fdvWei` check), and rung 0 **is** that floor. A lone bidder pays
floor × tokens taken, and takes only what they actually paid for.

### 1.5 There is no failed auction — decided

The owner's call: *"no failed auction if no one bids that day it goes back to the curve or staking or
what ever"*. So there is **no minimum raise and no refund path**. The launch always happens.

This deliberately drops the safety property both competitors ship (pools.trade refunds below $10k
FDV; STONKZ gates on a raise threshold). Worth stating what that costs: a bidder can no longer get
their ETH back, so **the reserve price is now the only thing standing between a bidder and a bad
fill**. It has to bind hard against the FDV band, and the ladder must not be able to climb out of
that band either — see §2.

In exchange the design gets simpler and the UX gets better: nobody ever waits three days to be told
the launch is off. For a memecoin pad that is the right trade.

### 1.6 Settlement timing

All days settle **together at auction close**. If day-1 winners could claim and trade while day 3 is
still bidding, they would be selling into their own auction's remaining bidders. One settlement, one
clearing price per rung, tokens claimable at close.

---

## 2. Where unbid supply goes — and the architecture that answers it

The open question was whether unbid supply reverts to the curve or to staking. Answering it required
checking when the launch is actually configured, and that check changed the design.

### 2.1 The launch config is frozen before the auction runs

`PresaleVault.initialize()` stores the whole `LaunchConfig` (`cfg = cfg_`, `PresaleVault.sol:165`) and
commits to the salts. `supply`, **`curveSupply`**, `reserveSupply` and `startTickMag` are all fixed at
creation, and `[M-12]` additionally snapshots the governed geometry (`snapStartTickMag`) so an
in-flight `setDefaults` retune cannot move it.

So a separate auction vault **cannot** size the curve from the auction result. "Unbid supply goes back
to the curve" is not a no-op under that architecture — it needs `curveSupply` deferred out of the
committed config, which drags in the FDV band check and the commit-reveal snipe model.

Worse, it introduces a brick. If the curve is to open at the auction's final clearing rung, that tick
has to pass `PadValuation`'s FDV band at `launch()`. A clearing price that lands outside the band
reverts the launch — and with no refund path, the ETH has nowhere to go.

### 2.2 The architecture that removes the question

The curve is **not a custom AMM**. It is a real Uniswap v4 pool seeded as a single token-only range
`[gradTick, startTick]`, initialized at `startTick`; buyers swap ETH in and walk the tick down
(`RobinCurveV4.sol:65-68`). There is no `buy()` — trades go through the PoolManager, gated by the hook.

That means the auction does not need its own price ladder at all. **The curve's tick range already is
the ladder.**

Build the auction as *batched buying into the curve* rather than as a separate sale:

- The curve is deployed up front with its normal geometry and its full `curveSupply`.
- For the auction window the hook's `beforeSwap` admits **only the auction vault** — everyone else is
  locked out for 1–3 days.
- Bidders deposit ETH into the vault. At each tranche boundary the vault executes **one pooled buy**
  into the curve with that tranche's ETH, and distributes the tokens **pro-rata by contribution**.
  `PresaleVault` already does exactly this once at `finalize()`; the auction runs it N times.
- When the window closes the hook gate lifts and the curve trades normally.

Every open question collapses:

| Question | Answer under this architecture |
|---|---|
| Where does unbid supply go? | **Nowhere — it never left the curve.** Literally the owner's answer, at zero cost. |
| Reserve price? | `startTick`, already FDV-band-checked at launch. No new band logic. |
| Can the clearing price brick the launch? | No. The curve is launched before the auction, so there is nothing left to validate. |
| Does the curve open at the clearing price? | Yes, by construction — the auction *is* the curve moving. |
| Can day-1 winners dump on day-3 bidders? | No — the hook gate locks everyone but the vault out. |
| "First buy cheapest, grows through the day"? | That is just what a bonding curve does. |
| Failed auction? | Cannot happen. The window ends and normal trading begins. |
| 10% platform cut? | `PLATFORM_FEE_BPS = 1000`, already in the vault. |

The work reduces to two changes: a `beforeSwap` window gate in the hook, and a tranche schedule with
per-tranche pro-rata accounting in the vault. Neither touches graduation, the FDV band, the
commit-reveal, or the floor vault.

**Status: recommended, not yet validated.** The `beforeSwap` gate needs checking against what `sender`
actually is for a vault-initiated swap, and the tranche-buy loop needs gas modelling against this
chain's 16M clamp. Both are cheap to test and I have not tested them yet.

### 2.3 So: curve, not staking

Unbid auction supply stays in the curve. Tokens the **curve** has not sold at graduation still go to
staking, which is the existing v4 behaviour. One rule each, no special cases, no routing code.

### 2.4 Graduation still auto-fires

10% of the raise to the platform, 90% into the curve. If that clears 4.2 ETH the token graduates at
window close having never traded openly — which is fine, the auction *was* the price discovery.

## 3. Dual-pool graduation — ROBIN 40% / creator's pick 60%

This is the part of the proposal nobody else on this chain does, and it is the strongest idea in it.
Pons buys back and burns PONS out of fee *revenue* — a one-time sink. Putting ROBIN into
**permanently locked LP on every graduation** is recurring, compounds with launch volume, and the
ROBIN never comes back out.

It is also the most expensive part to build, for four reasons:

1. **It is two pools, not one.** A v4 pool is a pair; TOKEN cannot be paired with both ROBIN and WETH
   in one pool. Graduation must mint **two** locked positions. Today `graduate()` mints exactly one
   (`RobinCurveV4.sol:770-784`, one `MINT_POSITION` into the `LockVault`).
2. **Both pools must carry the hook.** If the ROBIN pool ships without the fee hook — or with a
   different fee/tickSpacing so it is a different `PoolId` — then it is an untaxed venue for the same
   token, and the buy/sell tax becomes optional again. This is precisely the sibling-pool hole closed
   in the L25 fix (`beforeInitialize` now rejects any pool not opened by the factory). Any dual-pool
   design has to be built through that gate, not around it.
3. **The ROBIN leg has to be bought.** 40% of the LP reserve must market-buy ROBIN before it can seed
   TOKEN/ROBIN. On a thin ROBIN pool that buy moves the price, and the new pool is then seeded at an
   inflated ROBIN mark — the LP is underwater the moment it exists. Needs a depth cap: if the ROBIN
   leg would exceed some share of ROBIN's own liquidity, cap it and route the remainder to the other
   leg.
4. **Splitting 40/60 halves the depth traders see.** Two pools at 40% and 60% of one reserve are
   worse to trade than one pool at 100%, and they will arbitrage against each other. The arb is not
   pure loss — both pools carry the hook, so both sides of it pay tax — but the quoted price gets
   worse and aggregators will route around the thinner leg.

Everything downstream also assumes one pool: the floor vault, the ambush vault, and the staking
wiring all key off a single `PoolId`.

**Recommendation: ship this second.** The auction reuses audited code and can go out on its own. The
dual-pool change rewrites the graduation waterfall and touches the exact surface where the
tax-avoidance hole lives. Doing both at once puts the riskiest change on the critical path of the
feature you actually want live.

---

## 4. Taxes, supply, staking

**The auction should not charge the 1.25% buy tax.** The 10% platform cut of the raise already prices
the platform's take, and charging both taxes the same money twice — it would come straight out of the
raise that seeds the curve. Post-graduation swaps pay the tax normally.

**Across two pools, a route that hops both pays the tax twice.** TOKEN/ROBIN → ROBIN/ETH is two taxed
legs. Worth deciding deliberately whether that is acceptable or whether the hook should exempt the
second hop.

**Unsold supply → the coin's staking pool** is a good rule and nobody else does it. One guard needed:
the creator can airdrop to their own wallets at creation and stake them before anyone else exists, so
a large unsold deposit landing in the staking accumulator would be captured almost entirely by the
creator. Either snapshot stake eligibility, or drip the unsold supply in over time rather than in one
deposit.

**Supply picking and unlimited airdrop** already exist and are covered by
`test/regression/FDV.creator-supply.test.js`. The airdrop needs the same batching treatment the
disperse path got — this chain's 16M gas clamp means "unlimited wallets" is unlimited *across*
transactions, not within one.

---

## 5. Build order

| | Work | Notes |
|---|---|---|
| 1 | H-5 residual — episode allowance made timing-immune | done, compiles clean |
| 2 | Validate the §2.2 architecture: `beforeSwap` window gate + tranche-buy gas | cheap; blocks everything below |
| 3 | Hook: admit only the auction vault during the window | small `beforeSwap` branch |
| 4 | Vault: tranche schedule + N pooled buys + per-tranche pro-rata | the existing `finalize()` buy, run N times |
| 5 | Per-wallet / per-tranche caps | the only whale control left once refunds are gone |
| 6 | Dual-pool graduation + ROBIN leg + depth cap | must be built through the L25 `beforeInitialize` gate |
| 7 | Stock-paired variant | 6, plus the halt/restriction handling in `../STOCK-DATA-FEEDS.md` |

Steps 2–5 are a shippable product. Nothing in them touches graduation, the FDV band, the floor vault
or the commit-reveal, which is the whole reason this shape is worth preferring.

## 6. Open decisions

Settled by the owner:

- **No failed auction, no refunds.** The launch always happens.
- **Unbid supply goes back to the curve** — and under §2.2 it never leaves it.

Still open:

- **Pro-rata or per-capita fills?** Pro-rata is what was asked for and is far simpler. STONKZ's
  per-capita with a log size bonus is more whale-resistant but more sybil-exposed. With refunds gone,
  a **per-wallet cap** is now the main whale control either way and should be set deliberately.
- **Is the ROBIN leg fixed at 40%, or a band the creator picks within?** 40% is a lot of depth to move
  off the main pair.
- **Does a route that hops both graduated pools pay the tax twice, or is the second hop exempt?**
- **Does the auction fill itself pay the 1.25% buy tax**, on top of the 10% platform cut of the raise?
  Charging both takes the same money twice, straight out of what seeds the curve.
