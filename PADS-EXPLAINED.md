# Every pad, explained

One section per pad. Each says what it is, the flow step by step, where every fee goes, and staking.
All numbers verified against code or read live from chain.

**Only PAD 1 ships next.** Pads 2–6 are `pad-v4/`, built and audited but NOT deployed.

---

# PAD 1 — The Curve Pad (v2) · SHIPPING NEXT

The main product. Free launch, no ETH seed needed, real Uniswap v3 pool from block one.

## Flow

**1. Creator launches (one tx)**
Picks name, symbol, fee rate (1–4% per side), and optionally supply + valuation.
The contract deploys the token, creates a real Uniswap v3 pool, seeds the curve, registers the fee, turns
trading on. **Supply splits 75% onto the curve / 25% held back as the Ambush reserve.**

**2. Optional dev buy — same transaction**
Any ETH the creator sends is their own first buy, executed inside the launch tx before anyone else can trade.
**Uncapped** — it can climb the entire curve to the ceiling. Unspent ETH refunded.

**3. Trading**
Buys walk the price up the curve. No wallet caps, no cooldowns, no dead window. Sells are never restricted —
there is no transfer tax, so the token doesn't read as a honeypot.

**4. Graduation — only at the full ceiling**
No early exit, no timeout. `graduate()` is permissionless. At the default geometry that's **~4.1 ETH raised**.

**5. The Bond is posted — permanent, no withdraw path**
- **Sherwood** — 60% of the raise as full-range locked LP. Trade fees compound back into it forever.
- **Bounty** — the other 40% as a WETH buy wall, placed **9,000–15,600 ticks below spot (~59–79% down)**.
- **Ambush** — the 25% supply reserve as sell orders 3×–25× above. Fills into pumps, feeds the Bounty.

**6. Forever after**
`poke()` is permissionless and recenters the walls, compounding Sherwood fees back into locked LP.

## Where the money goes

**Swap fee — 1% per side minimum, creator may set up to 4%**
> **45% platform · 45% creator · 10% that coin's Bond floor** — both sides.

Raising the rate lifts both takes: at 1% the creator earns 0.45%/trade, at 4% they earn 1.8%.

**Uniswap LP fee (the pool's own 1% tier)**
> **10% creator · 90% platform**

**At graduation**
> **0.5 ETH creator · 0.5 ETH platform** — but it's `min(0.5 ETH, raise ÷ 4)` each.
> Needs a raise ≥2 ETH for the full amount.

**Platform total:** 45% of swap fees + 90% of LP fees + 0.5 ETH per graduation.

## Staking on this pad
**None.** Staking contracts are not deployed (`stakingFactory`, `robinStaking` unset). The UI hides it.

---

# PAD 2 — Curve Pad v4 · NOT DEPLOYED

The rewrite, on Uniswap v4 with hooks. Same idea, different money model — and it adds staking and a floor.

## Flow

**1. Launch** — token minted to the factory, fee hook mined and deployed, pool initialized at the curve top
(100% token, zero ETH), curve seeded. **No dev mint at all**: supply = curve + reserve exactly, creator gets
zero tokens and buys from the curve like everyone else.

**2. Curve phase** — buyers walk the price down from `startTick` toward `gradTick`. Default split is
**73% curve / 27% reserve**.

**3. Graduation** — permissionless, at the ceiling. Anyone can trigger it and gets paid to.

**4. After** — permanent locked LP, plus a price floor, an ambush band, and staking all live.

## Where the money goes

**Buy tax 1%** — taken from the ETH going in, before the swap:
- 0.2% → curve buffer → **platform** at graduation
- 0.2% → **referrer** (only if a ref link was used — carved out of the platform's cut, never the trader's)
- remainder → **platform** (0.8%, or 0.6% when a referral applies)

**Sell tax 1%** — of the ETH coming out:
- 0.2% → **the floor**
- 0.8% → **creator**

**Pool LP fee 1%**
- ETH side → **100% platform**
- Token side → **treasury: 70% staking / 30% creator-burn** (creator burns it to dead when they choose)

**Graduation waterfall** (of the raise)
- Keeper bounty off the top: `min(0.2% of raise, 0.02 ETH)` → whoever triggers it
- **10% platform · 10% creator · 5% ambush · ~75% into permanent locked LP**

**Key rule:** the platform is **ETH-only** and never holds a pad token. Contract-enforced.

## Staking on this pad
**Yes.** 30-day lock, rewards drip over 30 days, 10% early-exit penalty recycled back into the reward pool.
Funded by leftover reserve tokens at graduation + 70% of token-side LP fees.

---

# PAD 3 — Presale → Curve v4 · NOT DEPLOYED

An optional trustless, refundable presale in front of a curve launch.

## Flow

**1. Creator opens a presale** — sets target, deadline, per-wallet cap, minimum contribution. The launch config
is committed up front; the salts are commit-reveal so the future pool address can't be front-run.

**2. Anyone deposits ETH** — deposits are trimmed to the remaining gap, surplus refunded same tx.

**3a. Target met → `finalize()`** — in ONE transaction it launches the curve AND does the first buy. Presalers
then claim tokens **pro-rata at the resulting curve price**, plus a pro-rata refund of any ETH the buy didn't
spend.

**3b. Target missed → 100% refunds.** Also refunds if the launch gets sniped, or via a grace-period escape hatch.

## Where the money goes
**ETH never touches the creator.** It leaves the vault only as (a) the pooled curve buy, (b) a refund/claim to
the person who deposited it, or (c) Robin Labs' 10% of a raise that hit its target. A presale that misses its
target pays no fee at all — every refund is the whole deposit. After that it's a normal Pad 2 curve — same
taxes, same waterfall.

## Staking
Same as Pad 2 once launched.

---

# PAD 4 — Turbo / Arrow · NOT DEPLOYED

A one-tx migration launcher. For a dev bringing holders from an existing token.

## Flow

**1. 0.5 ETH off the top → platform.** A flat launch fee.
**2. Launch the pad** — normal curve launch.
**3. Buy out the ENTIRE curve** — one swap, price-limited exactly at the graduation ceiling.
**4. Graduate immediately** — permanent LP minted and locked in the same tx.
**5. Airdrop** — the whole bought supply goes to a no-withdraw distributor; holders self-claim against a
committed merkle root.
**6. Refund** — all unspent ETH back to the dev.

**The dev ends holding zero tokens.** The pitch is "no dev wallet holds the bag, clean bubble map."

## Where the money goes
0.5 ETH platform fee, then the normal graduation waterfall (Pad 2) since it graduates through the real curve.

## Note
This is the "turbo launch" you mentioned. It **does not exist on the shipping pad** — v4 only. So on v2 there is
no turbo condition on the 0.5 ETH graduation reward.

---

# PAD 5 — Seed-LP Pad · NOT DEPLOYED

The simple pad: creator supplies ETH + tokens directly, no curve, no graduation. Launch straight into a locked
2-sided LP.

**Flow:** creator sets price and seeds both sides → LP locked forever → trading live immediately.

**Money:** buy LP fee → platform; sell LP fee → staking. 1% trade tax: buys → platform; sells → creator 0.8% +
floor 0.2%.

**Staking:** yes, plus an add-only price floor.

---

# PAD 6 — Stock Pad · DISABLED

Would quote a coin against a tokenized stock instead of ETH. **Fail-closed and unusable** — there is no live
Robinhood stock registry, and the contract refuses any stock the platform's registry doesn't attest.

---

# STAKING — the whole picture

| where | what | status |
|---|---|---|
| $ROBIN staking | stake the platform token, earn a basket | **not deployed** |
| Per-coin staking (v3) | via StakingFactory | **not deployed** |
| Lock staking (v4) | 30-day lock, drip, 10% early-exit penalty | v4 only |
| Dual staking (v4) | stake the coin, earn ETH + the coin | v4 only |

**Today there is no live staking anywhere.** The UI gates itself off so nothing is falsely advertised.

---

# FEE CHEAT SHEET

| | **v2 (shipping)** | **v4 (later)** |
|---|---|---|
| Buy tax | part of the 1–4% swap fee | 1% → platform (0.2% of it to a referrer) |
| Sell tax | same swap fee | 1% → 0.8% creator / 0.2% floor |
| Swap fee split | 45% platform / 45% creator / 10% floor | n/a — taxes are separate |
| LP fee | 10% creator / 90% platform | ETH side 100% platform; token side 70% staking / 30% burn |
| At graduation | 0.5 ETH each to creator + platform | 10% platform / 10% creator / 5% ambush / 75% LP |
| Keeper paid? | no | yes — `min(0.2%, 0.02 ETH)` |
| Floor funded by | 10% of every swap fee | 0.2% sell tax + ambush LP fees |
