# Floor redesign — closing H-5 / M-15 / L-33 structurally

**Status: DESIGN PROPOSAL for the external auditor to react to. Not yet implemented.**
The shipped `RobinFloorVault` has interim hardening (see the contract header + `AUDIT-SCOPE.md` §5) that closes the
*atomic whole-carve* force-fill and the *>1h-stale* replay, but a bounded slice can still be force-committed off a
≤1h-stale `belowSince`. This document proposes the structural fix. Because three prior attempts on this exact surface
were refuted (M-7's mid-curve build, M-15's naive live-`slot0` gate, H-5's dwell), **please validate the approach
below before it is implemented.**

## The three findings, restated

- **H-5** — the park→commit dwell is poke-observed, not duration-enforced, so the carve can be force-committed into
  a stale/manipulated band.
- **M-15** — a *single fixed* band deepens only while the token trades above it; in a drawdown the carve idles.
- **L-33** — letting the band build mid-curve widens the H-5/M-4 surface.

Root cause common to all three: **a single fixed band + a spot-based gate deciding *whether* to commit the carve into
that fixed band.** The gate is the manipulable primitive, and the fixed band is what makes a manipulated commit
*profitable* (liquidity minted at a price the attacker chose, not the market's).

## The proposal: add-only ETH bands placed relative to *current* spot, never a whole-carve gate

Replace "commit the whole carve into one fixed band when a spot gate passes" with "**on each poke, place a small,
capped ETH band immediately below the current token price (a strictly-`currency0` range just above the current
tick), then stop.**" Concretely:

1. **No fixed anchor, no park/commit gate.** `addFloor()` reads the current tick and adds a single-sided
   `currency0` (ETH) band `[alignUp(tick+1), alignUp(tick+1) + width]` — always in the pure-ETH region just below
   the current token price. There is no "is spot below the band?" branch and no `belowSince`/dwell state.
2. **Capped + rate-limited per poke** (kept from today): at most `MAX_COMMIT_BPS` of the on-hand carve per
   `COMMIT_COOLDOWN`, so a single poke can only ever place a bounded slice.
3. **Add-only, forever** (kept): no `decreaseLiquidity`/withdraw path exists, so every band is permanent — the
   "can't rug to zero" guarantee is unchanged, and now *every* poke deploys capital instead of parking (closes
   M-15's idling).

## Why this "place below spot" approach DOES NOT WORK — REFUTED

**An adversarial review of this proposal found it BROKEN (a profitable atomic sandwich). Do not implement it.**
It is recorded here because it is the natural next idea, and knowing *why* it fails points at the only approach
that survives (a TWAP, below).

The flaw: "placement never buys token at placement time" is true but **irrelevant** — the theft happens at
*conversion* time, moments later in the *same* transaction. Concretely (currency0 = ETH, currency1 = token, so
price `p = token/ETH`; **buying token lowers the tick**):

1. Flash-buy token to push the tick DOWN (token momentarily "expensive"). e.g. `√p 1.0 → 0.8`: pay 250 ETH, get 200 token.
2. Poke `addFloor()` (permissionless, no dwell in this design): it reads the manipulated tick and places the ETH
   slice as a single-sided band just above the *current* (pushed-down) tick — i.e. **below** the true price. Say a
   25 ETH slice becomes band `[0.8, 0.9]`.
3. Sell the 200 token back. The recovery swap sweeps UP through the fresh band, **converting its 25 ETH into ~18
   token at the band's above-market prices** — and the attacker (the seller) captures that ETH. Net ≈ **+5 ETH** on
   a 25 ETH slice, token-flat, after fees. Repeat once per `COMMIT_COOLDOWN` to drain the carve.

The band went from 25 ETH → 18 token (≈18 ETH of value) — it overpaid ~39%, and the attacker pocketed the spread.
This is exactly the H-5 force-fill, made *fully atomic* (worse than the shipped interim hardening, which at least
forces a dwell observation). `MAX_COMMIT_BPS` only rate-limits; each slice is independently profitable, so bounded
≠ unprofitable. **Any design where the placement tick is attacker-controllable via flash-manipulated spot is
exploitable, because the freshly-placed single-sided ETH is converted at that manipulated price in the same tx.**

The lesson: the commit/placement price must come from a source the attacker CANNOT move within a transaction —
i.e. a manipulation-resistant TWAP, not live `slot0`. There is no spot-based scheme (gate OR placement) that is safe.

## The only surviving direction: a TWAP-gated commit

Since every spot-based scheme is exploitable (above), the commit/placement price must come from a
manipulation-resistant **time-weighted average price** the attacker cannot move within a transaction:

- **Source of the TWAP.** The pool's own hook (`RobinFeeHook`) records truncated observations (à la Uniswap V3/V4
  oracle), or a separate observer the keeper feeds. The floor commits/places using the TWAP tick, NOT live `slot0`.
- **Why it holds.** A flash-manipulated spot moves `slot0` for zero blocks of *average* — the TWAP barely moves, so
  the freshly-placed liquidity is priced at the real market, and the recovery swap has no stale band to sweep.
- **Cost.** This is a larger change (hook records observations + the floor reads a windowed average), and it must be
  designed so a *sustained* (multi-block) manipulation — which a TWAP cannot fully resist — is bounded by
  `MAX_COMMIT_BPS`/`COMMIT_COOLDOWN` and made unprofitable by the cost of holding the price for the TWAP window.

## Open questions for the auditor

1. **TWAP window vs. griefing.** What window makes a sustained push to move the TWAP more expensive than
   `MAX_COMMIT_BPS` of the carve is worth? Interaction of the window with `COMMIT_COOLDOWN`.
2. **Oracle plumbing.** Should `RobinFeeHook` record observations (it already runs on every swap via
   `beforeSwap`/`afterSwap`), or is a standalone cardinality-managed observer cleaner? Gas on the hot swap path.
3. **Fixed band vs. TWAP-placed band.** With a trustworthy TWAP, is the *fixed* anchored band (today's design)
   simply safe again (its only flaw was the manipulable commit gate), so the fix is "gate the existing commit on the
   TWAP" rather than a full dynamic-placement rewrite? This is likely the smallest correct change.
4. **Interaction with `RobinAmbushVault`** (forwards ETH fees to the floor) and `collectFees`.

## Recommendation

Ship the interim hardening (done). The "place below spot" idea in the refuted section above **must not be built**.
The TWAP-gated commit (likely just gating today's fixed-band commit on a TWAP tick — Q3) is the direction to pursue,
but it needs the auditor's design review first: this surface has now refuted M-7's mid-curve build, M-15's naive
live-`slot0` gate, H-5's dwell, AND this "place below spot" proposal. A novel mechanism shipped here without that
review is the most likely way to introduce a new critical.
