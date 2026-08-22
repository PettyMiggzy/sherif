# Every pad, every flow, every fee — verified

Written so we agree on what the product *is*. Every number here is read from the code or from **live chain
state**, not from a comment or a slide. Where your description and the code disagree, that is called out.

---

## 1. Which pads exist, and which one ships

| pad | where | status |
|---|---|---|
| **Curve pad (v1)** | `launchpad/` | **LIVE.** ROBIN launched here. Shallow farmable wall, anti-snipe on, fixed 1B supply. |
| **Curve pad (v2)** | `launchpad/` (same source, new deploy) | **SHIPS NEXT.** Deep wall, no guard, creator-chosen supply. |
| Curve pad v4 | `pad-v4/` | Built, audited 3 rounds, **not deployed.** The eventual rewrite. |
| Seed-LP pad | `pad-v4/` | v4 only, not deployed. |
| Stock pad | `pad-v4/` | v4 only, **disabled / fail-closed** (no live stock registry). |
| Presale vault | `pad-v4/` | v4 only, not deployed. |
| **Turbo / Arrow** | `pad-v4/` | v4 only, **not deployed.** |

> **"As long as they don't do turbo launch."** There is no turbo in what ships. Turbo (Arrow) is a v4 launcher
> and nothing in `launchpad/` references it. On v2 the graduation reward has **no turbo condition** — see §3.

## 2. The v2 launch flow, end to end

1. **Launch (one tx).** `launchWithSupply(params, supply, startTickMag)` — or `launch(params)` for the defaults.
   Deploys the token, creates a **real Uniswap v3 pool**, seeds the single-sided curve, registers the coin's fee
   with the router, and turns trading on. 75% of supply goes on the curve, 25% is held back as the Ambush.
2. **Optional dev buy, atomic.** Any ETH sent is the creator's own first buy, executed inside the launch tx
   before anyone else can trade. **Uncapped** — it can climb the whole curve to the ceiling; excess is refunded.
3. **Trading.** Buys walk the price up the curve. No wallet caps, no cooldowns, no dead window (v2). Sells are
   never restricted — there is no transfer tax, so the token stays clean and does not read as a honeypot.
4. **Graduation — ceiling only.** No early path, no timeout. `graduate()` is permissionless and only succeeds at
   the full ceiling (~4.1 ETH raised at the default geometry). It pays the rewards, then posts the Bond.
5. **The Bond, permanent.** Three positions, no withdraw path anywhere:
   - **Sherwood** — 60% of the raise as full-range locked LP. Fees compound back into it forever.
   - **Bounty** — the other 40%, a WETH buy wall. **v2 places it 9,000–15,600 ticks below spot (~59%–79% down).**
   - **Ambush** — the 25% supply reserve as sell orders 3x–25x above, feeding the Bounty when a pump fills them.

## 3. The money map — live values, read from chain

**Swap fee.** Every coin pays **1% per side minimum**, and a creator may set up to **4% per side**
(`MAX_TAX_BPS = 400`). Whatever the rate, the fee splits:

> **Platform 45% · Creator 45% · That coin's Bond floor 10%**
> — live from `FeeConfig.swapSplit()` at `0x064D…De14`, on **both** buy and sell.

⚠️ **The contract comments describe a different, dead model** (base 1% to platform on buys / creator on sells,
25-75 above that). That legacy branch only runs when `feeConfig` is **unset**, and it is set on the live router.
`docs.html:441` already states the live 45/45/10 correctly. See FLOW-1.

So raising your fee raises **both** sides' take: at 1% the creator earns 0.45% per trade, at 4% they earn 1.8%.

**LP fees** (the pool's own 1% tier): **creator 10% / platform 90%** (`lpCreatorBps = 1000`, live).

**Graduation:** **0.5 ETH to the creator and 0.5 ETH to the platform** — but capped:
`reward = min(0.5 ETH, raise / 4)` each, so the two payouts can never exceed half the raise. At the default
geometry (~4.1 ETH raised) the cap is not reached and the creator gets the full 0.5.

⚠️ **This couples to creator-chosen valuation.** A full 0.5 ETH needs a raise of **≥ 2 ETH**. Launch at a low
valuation and the raise shrinks with it — at the v2 band floor the raise is ~0.13 ETH and the reward is ~0.03
ETH, about **6% of the headline number**. See FLOW-2.

**Platform income, total:** 45% of every swap fee + 90% of LP fees + 0.5 ETH per graduation + the deferred
0.1% legacy bucket where it applies.

## 4. What a creator actually controls

| knob | range | where |
|---|---|---|
| Name / symbol / dev wallet | free | `LaunchParams` |
| **Supply** | any (bounded only by the FDV band) | `launchWithSupply` — **built, not reachable, see FLOW-3** |
| **Launch valuation** | inside the governed FDV band | `startTickMag` — same gap |
| **Fee rate** | 1%–4% per side | `TaxParams.buyBps/sellBps` |
| Project-share allocation | wallet / floor / burn, summing to 100% | `TaxParams` — **legacy path only**, see FLOW-1 |
| Opening buy | any size, uncapped | ETH sent with `launch` |
| Project wallet | any address | `TaxParams.projectWallet` |

Creators do **not** control: the curve geometry, the graduation ceiling, the Bond's shape or depth, the 45/45/10
split, or anything about the floor. Those are protocol-wide.

## 5. Findings from writing this down

**FLOW-1 — the fee comments describe a model that no longer runs.** `PadRouter`'s header and `_distribute`'s
docstring both describe the legacy base/excess split. Live, `feeConfig` is set, so every fee goes 45/45/10 and
the `walletBps`/`floorBps`/`burnBps` allocation a creator supplies is **accepted, validated, and then ignored**.
The site is right; the contract comments are stale and will mislead the next auditor. Low severity, real.

**FLOW-2 — creator-chosen valuation quietly shrinks the graduation reward.** Nothing warns anyone. The band
floor permits launches paying ~6% of the advertised 0.5 ETH. Two options: raise the v2 FDV band floor so the
minimum raise still clears 2 ETH and the full reward is always earned, or show the creator their actual reward
next to their chosen valuation. The first is one number; the second is honest either way.

**FLOW-3 — the two knobs you most want are unreachable.** Supply and valuation are built and fork-tested but the
UI calls the old `launch()` and still advertises fixed 1B supply. Tracked as REQ-2 in `AUDIT-FINAL.md`.

**FLOW-4 — the router owner is not the address in `deploy.json`.** Live `PadRouter.owner()` is
`0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8`; `deploy.json` records the owner as `0xCDD5…fabf`. The v2 deploy
**must be signed by the router owner** or `setFactory` fails and every v2 launch reverts at `register`.
`deploy-v2.js` checks this before deploying anything, so it fails safe — but know which key you need, and it
must not be a key that has ever been exposed.

## 6. Not in the code at all — operational promises

**"We pay their DexScreener update and 10× boost."** No contract, no automation, nothing on chain. It is a
manual commitment, currently advertised as automatic ("every coin that graduates gets a DexScreener 10× Boost,
funded by Robin Labs, instant promotion"). No coin has graduated yet, so it has never been tested. Either build
it into the graduation runbook or soften the copy — "instant" and "every" are strong words to leave unbacked.
