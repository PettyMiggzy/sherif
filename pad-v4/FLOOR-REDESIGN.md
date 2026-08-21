# Floor redesign — closing H-5 / M-15 / L-33 structurally

**Status: H-5 IS STILL OPEN.** This file is the reasoning trail for SIX designs proposed and refuted on this one
surface: M-7's mid-curve build, M-15's naive live-`slot0` gate, H-5's dwell, the "place below spot" redesign
below, the external auditor's blessed TWAP-gated commit, and now the swap-witnessed gate that was briefly
believed to close it. **Do not implement anything in this document.**

The recurring reason they fail is worth stating once: an honest keeper commits when the price has genuinely been
below the band, and an attacker reproduces that by *holding* the price there — which costs him nothing per unit
of time. On-chain the two are the same observation. No gate built on *duration* can separate them, which is why
the sixth design fell the same way as the first five. Closing this needs a different discriminator (deploy only
fees that arrived during the episode; or add liquidity atomically inside the sell that funds it), or the floor's
guarantee needs descoping. See `AUDIT-ROUND-3-EXTERNAL-ADDENDUM-2.md`.

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

## ⛔ NOT RESOLVED — the swap-witnessed gate is the SIXTH refuted design (see ADDENDUM-2)

**The table below is REAL but was read wrongly.** It was measured at `episodeBaseWei = 0`, i.e. with the commit
allowance pinned at zero — a floor that can never deploy anything. The gate was not what stopped the attacker.
At an allowance large enough for the floor to function, the same armed gate is drained for **+8.34 ETH (74%)**
(H5 case 7). Duration is free for an attacker, so a gate that proves duration cannot separate him from an honest
crash. Kept for the record:

| | attacker PnL | commits | carve drained |
|---|---|---|---|
| pre-gate vault | **+9.4754 ETH** | 8 | 16.64 / 20 (83%) |
| **armed gate** | **-1.1106 ETH** | **0** | **0.00 / 20** |

The watermark itself is sound and worth keeping: `RobinFeeHook` stamps every swap whose PRE-swap tick sits at or
above the band, so `now >= aboveLowerTs + MIN_BELOW_DURATION` really is an exact proof that the price was never
above the band for that span. The error was believing that proof is worth anything. It establishes only that the
price *was* below the band — never *why* — and an attacker who simply holds it there satisfies it for the price
of one round trip. Measured: the first attacker commit lands at minute 210 at every nonzero allowance.

## ⚠️ The TWAP-gated commit below was ALSO refuted; see `FLOOR-H5-CLOSURE-SPEC.md`

The section below was written before the external round-3 review and before this surface was measured. It is
kept for the reasoning trail, but **a plain TWAP-gated commit is now REFUTED too** — the fifth design to fall
here. A 4-design × red-team panel measured the naive TWAP conjunct making the attack **strictly better for the
attacker** (peak extraction +23.84 → +31.92 ETH; break-even carve/pool-depth ~30% → 4.0%), because:

- **holding costs nothing per unit time** (measured: identical 1.110618 ETH round-trip cost at 0s and at 3h of
  hold), so a gate priced in "wait W" is inert, and one that lets a single round trip fund several commits is
  cheaper than what ships today; and
- **a TWAP is a decaying memory** — after a genuine crash it keeps reading below-band for a bounded interval,
  inside which the attack is fully atomic again.

The surviving direction replaces *averaging* with an **exact, swap-witnessed duration proof** (`aboveLowerTs`
watermark) plus an **episode-scoped, non-refilling commit allowance** that bounds ETH committed per unit of
attacker cost. See **`FLOOR-H5-CLOSURE-SPEC.md`**. What DOES carry forward from the auditor's §2 is correction
(a): any gate must retain a live-spot-below-band check, or the wall silently mints itself out of parked token
fees instead of reverting (independently measured).

## The (refuted) direction as originally proposed: a TWAP-gated commit

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
