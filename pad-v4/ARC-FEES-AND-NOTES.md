# Arc pad — fee design & open items (working notes)

Captured from a live discussion, not yet built. This is a durable record so nothing said gets lost
between sessions — see ROBIN-V4-CURVE-ECON.md for how the CURRENT (Robinhood Chain) fee model
actually works; this file is where the proposed Arc changes get worked out before any Solidity is
touched.

## Status: NOT YET IMPLEMENTED — needs one number confirmed first (see below)

## What's clear and already matches the shipped defaults

- **1% buy tax / 1% sell tax (2% total).** This is *already* the deployed default on both Robinhood
  Chain and Arc (`buyTaxBps: 100, sellTaxBps: 100` in deploy-curve.js / deploy-curve-arc.js) — no
  change needed here.
- **Sell-side trader rebate:** take **half of the 1% sell tax (i.e. 0.5% of sell volume)** and route
  it to a pool that rewards active traders, instead of the current model where ~1.00% of the sell
  tax goes straight to the creator. This is a genuinely NEW mechanic — there's no "trader rebate"
  concept in the current `RobinFeeHook`/`RobinV4FeeConfig` struct (the closest existing thing is
  `sellFloorShareBps`, which funds the floor vault, not traders). Needs: a new bps field, a new
  accrual book (mirroring the existing `platformOwed`/`creatorOwed`/`floorOwed` pattern), and a
  claim mechanism — probably weighted by trade volume or count, TBD.

## What's NOT yet clear — needs a straight answer before I write contract code

The creator's fee share was described three different ways in the same conversation:
1. "at a certain market cap, platform takes half, gives half to the creator"
2. "give the creator one and a half percent"
3. "they're getting two percent"

These don't reconcile (2% would be the ENTIRE tax take, leaving nothing for platform/trader-rebate;
1.5% and "half" are also different numbers from each other). My best read is this was thinking-out-
loud that never landed on a final number ("I don't know man, figure it out... just make it clean").

**Before I touch any Solidity here, I need one confirmed number:** what % of the 2% total tax does
the creator get once they cross the market-cap threshold — and what is that threshold?

## Also new, not in the current contracts: market-cap-gated fee split

Current architecture note (ROBIN-V4-CURVE-ECON.md, "Immutable per-pad economics"): **every fee param
is stamped immutably at launch — nothing changes fee routing live based on price/market cap today.**
"100% to platform pre-threshold, split with creator post-threshold" is a new behavior, not a
retune of an existing governance knob. Two ways to build it:
- Cleanest: reuse the EXISTING curve-phase-vs-graduation split the contracts already have (buy tax
  today is ~100% platform-bound during the curve phase; sell tax already gives the creator ~1.00%
  today) — i.e. this might already be close to what's wanted if "certain market cap" = "graduation,"
  which is a concept that already exists. Worth checking against this reading before building
  something net-new that duplicates it.
- If it genuinely needs to check current price/market-cap live and branch fee routing mid-trade
  (not just curve-phase vs. post-graduation), that's real new logic in `RobinFeeHook`'s
  `beforeSwap`/`afterSwap` — a bigger, audit-relevant change.

## Reminders (already-existing features, no new work needed)

- **Optional 1-4 day auction before the curve launches** — this already exists (`PresaleVault` /
  the auction pages). Just needs to keep working for Arc launches too; nothing to build.
- **Creator makes a small buy at creation, split between the DEX-visibility pool and a curve sell
  buffer** — this does NOT map cleanly onto anything currently in the contracts (the existing
  `buyBufferShareBps` is funded from the BUY TAX, not from a mandatory creator purchase). Sounds
  like a new "minimum creator buy-in at launch, auto-split" mechanic. Flagging as new work, not
  confirmed-existing.

## Blocked on the user, not on engineering

- **Dual-chain badge** (cosmetic marker for a token deployed on both Robinhood Chain and Arc) —
  needs Venice API credits (the existing `/api/art` image-gen proxy, `VENICE_API_KEY` in
  indexer/.env) which the user said they'll add tomorrow. Do not start building/testing this until
  credits exist — no point burning effort on something that needs a live key to verify.
- **Pitch decks** need updating for Arc — outside this repo's scope as far as I can tell; flagging
  that it was mentioned, not something to act on without more direction.

## Next step

Ask for the one missing number (creator's post-threshold %, and the actual market-cap threshold)
before writing any RobinFeeHook/RobinV4FeeConfig changes.
