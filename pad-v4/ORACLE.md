# ORACLE.md — the observation record inside `RobinFeeHook`

> **This is a park-biased, purpose-built estimator for exactly one consumer — `RobinFloorVault`'s commit gate.
> It is NOT a general price oracle and must never be reused as one.** It is deliberately cheap to read wrong in
> the *conservative* direction: every failure mode resolves to "the floor parks", which costs liveness and
> nothing else. A consumer that needs a price to *pay* against would be reading a number this contract does not
> promise.

## What it is

Three things, all keyed by `PoolId`, all written only from `beforeSwap` on a **registered** pad:

| Field | Type | Written when | What it means |
|---|---|---|---|
| `aboveLowerTs` | `uint40` | every swap whose **pre-swap** tick is `>= gateLower` | last second the price was witnessed at/into the floor band |
| `aboveUpperTs` | `uint40` | every swap whose **pre-swap** tick is `>= gateUpper` | last second the price was witnessed below the band's bottom (diagnostics only) |
| `tickCumulative` + a 128-slot ring | `int88` / `Obs[128]` | at most once per `OBS_BUCKET` (180 s) | a V3-`Oracle.transform`-shaped arithmetic tick accumulator |

**The watermarks are the security control. The accumulator is not.** `RobinFloorVault` gates a commit on
`now >= aboveLowerTs + MIN_BELOW_DURATION`; the TWAP conjunct built on the accumulator is defence-in-depth
against a bug in the watermark path, and is provably implied by it (a window containing no above-band instant
has an average below the band). If the ring is cold, short, or stretched, the read returns `TWAP_UNAVAILABLE`
and the watermark governs alone — which is why an attacker cannot gain anything by forcing unavailability.

## Why the watermark is exact rather than averaged

`slot0.tick` is written only by `initialize` and `swap` in `v4-core`. `modifyLiquidity`, `donate`,
`setProtocolFee` and `setLPFee` all preserve it. Therefore **every above-band → below-band transition is a
swap whose pre-swap tick is above the band**, and that swap stamps `aboveLowerTs` before the pool moves. An
attacker who pushes the price out of the band closes the gate in the same transaction that opens the
opportunity. The tail interval `[last swap, now]` is covered by the vault's own live `getSlot0` read, so the
gate proves the tick was below the band at *every instant* of the window — not on average.

This is what makes a time-weighted average unnecessary here, and it is why a plain TWAP gate was **measured
worse than shipping nothing**: an average is a decaying memory, so after a genuine crash it keeps reading
"below band" for a bounded interval, and inside that interval the force-fill is atomic again.

## The properties the write is built to hold

- **It cannot revert.** The pre-swap tick is read with a low-level `staticcall` to the pinned
  `extsload(bytes32)` selector (`0x1e2eaeaf`) plus a length check, then decoded in assembly — never through
  `abi.decode` in our own frame, which is the `[H-3]` trap that a `try/catch` does not cover. Everything is
  `unchecked` and sized so overflow is unreachable rather than merely unchecked. No division, no `SafeCast`,
  no array indexing that is not masked by a compile-time power-of-two, no loops.
- **It fails CLOSED.** If the slot cannot be read, both watermarks are stamped, which parks the floor. An
  attacker who could somehow make the read fail would be *strengthening* the gate, not weakening it.
- **It takes zero caller input.** Not `sender`, not `params`, not `hookData`. There is nothing to steer.
- **It cannot be stuffed.** Ring appends are gated on 180-second bucket rollover, not on swap count, so no
  swap rate can force more than one append per bucket.
- **Same-second swaps still stamp.** The watermark write has no `dt` guard — only the accumulator does. On a
  chain with ~100 ms blocks and 1-second timestamps, a `dt != 0` guard on the watermark would be a hole.

## The one line that must never be "simplified"

```solidity
s.tickCumulative += int88(t * int256(uint256(dt)));   // t = THIS swap's clamped PRE-swap tick
s.lastTick        = int24(t);
```

The interval `[s.ts, now]` is credited at **this swap's pre-swap tick**, because that is the tick that
genuinely prevailed across the interval (only `swap` moves `slot0`). Crediting the **stored** `s.lastTick`
instead — which is what the obvious V3-shaped rewrite does — reopens H-5 at zero holding cost: push the tick,
latch it with a 1-wei swap, sell back, idle for the window, then one swap credits the whole window at the
pushed tick. `test/unit/RobinFeeHook.oracle.test.js` pins this.

`lastTick` exists **only** as the clamp reference. It is never itself credited.

## Sizing, and the inequalities behind each number

| Constant | Value | Why |
|---|---|---|
| `OBS_N` | 128 | Ring-span rule, corrected for two rollovers landing 1 s apart across a bucket boundary: the guaranteed span is `(N−1)·B − (B−1) = 127·180 − 179 = 22,681 s ≥ TWAP_WINDOW (11,700 s)` — 1.94×. A power of two, so `% OBS_N` is a mask. |
| `OBS_BUCKET` | 180 s | Same inequality. Bucketing costs zero accuracy (both read endpoints are real recorded pairs) and makes ring stuffing structurally impossible. |
| `MAX_TICK_MOVE_PER_SEC` | 9116 | Uniswap's `MAX_ABS_TICK_MOVE`, re-homed per **second** (this chain writes ~10 times per timestamp, so "per write" would be defeated). **Declared NOT a security control** — an insanity/overflow bound only. A *tight* clamp is actively harmful: it suppresses a genuine crash and lengthens the stale-low-average window. |
| `MAX_SPAN_MULT` | 4 | Caps a reported span at `4 × W`, so a sparse pad's stretched average cannot dilute recent history. |
| `int88` / `uint40` | — | `|Σ| ≤ 887,272 × 3.15e9 ≈ 2.8e15` over a century, against `int88.max ≈ 1.55e26` — eight orders of headroom, so overflow is *unreachable*, not merely unchecked. `uint40` runs past the year 36,000, so V3's `lte()` phantom-overflow surface does not exist here and was not ported. |

## What was deliberately deleted relative to V3's `Oracle.sol`

`grow()` / `cardinality` / `cardinalityNext` (cardinality is a compile-time constant from block zero, so it
cannot be under-sized by a forgotten bump), `binarySearch` / `getSurroundingObservations` / interpolation
(both read endpoints are real recorded pairs divided by their true delta), `lte()`'s 2106 wrap-around
comparison, and `secondsPerLiquidityCumulativeX128`. Those ~290 deleted lines are exactly where the historical
oracle bug class lives.

**There is no audited dependency to point at.** v4 removed the built-in oracle by design;
`TruncGeoOracle`/`TruncatedOracle` exist only on an unmerged, `UNLICENSED`, unaudited periphery branch (no
redistribution right into an MIT tree, and an `int48` accumulator is a downgrade); v3-core's `Oracle.sol` is
copyleft, pinned to `>=0.5.0 <0.8.0`, and relies on wrapping arithmetic that 0.8.26 reverts on — on the hot
swap path. What limits the risk here is **scope**, not provenance: the primary control is a pair of `uint40`
watermarks and two comparisons.

## Gas

Steady state ≈ 2 cold SLOADs + 1 warm SSTORE + one staticcall ≈ 10 k. On a dumped pad the watermark write folds
into the same slot, so its marginal cost is 0. A bucket rollover adds ~5 k, or ~22 k on a ring slot's
first-ever write (128 of those per pad, ever). Measured in `test/unit/RobinFeeHook.oracle.test.js`: rollover
costs **+21,790** gas over a same-bucket swap, inside the 35 k budget.

`consultTick` is worst-case 128 cold SLOADs (~269 k). It is on the **keeper poke** path only — never on a swap.
