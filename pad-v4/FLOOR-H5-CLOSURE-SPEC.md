# H-5 closure — design specification (P1/P2/P3 NOW IMPLEMENTED)

> **STATUS: IMPLEMENTED AND MEASURED.** P1 (the swap-witnessed gate), P2 (episode allowance, with the [R3 N-B]
> correction) and P3 (retained live-spot precondition) are on the branch. **P4 (the TWAP conjunct) is DEFERRED** —
> by this spec's own §0 table it "kills nothing new — it is provably implied by P1", yet it needs a 128-slot
> oracle ring, a new `FeeHookDeployer`, and ctor changes to all three factories. On a surface that has refuted
> five designs, that much novel machinery for zero incremental security is the likeliest way to add a new
> critical. Flagged for the auditor rather than shipped.
>
> **Measured closure** (`test/regression/H5.floor-forced-fill.test.js` cases 5-6), same pad, same 1% hook tax,
> same 12-hour sustained-hold run, only the gate differing:
>
> | | attacker PnL | commits | carve drained |
> |---|---|---|---|
> | control — pre-gate vault | **+9.4754 ETH** | 8 | 16.64 / 20 (83%) |
> | **armed gate** | **-1.1106 ETH** | **0** | **0.00 / 20** |
>
> The honest path still deploys (case 6): after a genuine 196-minute recovery the keeper commits normally.
>
> **[R3 N-B] correction applied.** The episode anchors on the ABOVE-LOWER watermark, not an above-upper one, so a
> shallow dump that stalls inside the band can no longer hold one episode open forever.
>
> ### OPEN — P2 sizing is a liveness/security tradeoff the auditor must set
> The spec's `EPISODE_BASE_WEI = seedQuoteWei / 10_000` (1 bp) was measured to **starve the honest path**: the
> allowance counts only ETH arriving AFTER the episode opens, so a carve accrued BEFORE a dump is effectively
> undeployable for that episode — the floor stops being a floor exactly when it is needed. This is a real
> M-15-class liveness regression the spec understated. Since P1 closes the measured attack ON ITS OWN, the
> runbook currently ships a generous-but-bounded `episodeBaseWei` (`seedEth`) and P2 stands as the secondary
> bound on an attacker who genuinely sustains `MIN_BELOW_DURATION`. Tightening it is an economic call for the
> external auditor, with the liveness cost above on the table.

> **Status: DESIGN, red-teamed, awaiting implementation + external review.**
> The shipped interim hardening (`COMMIT_COOLDOWN` 65m > `MAX_OBSERVED_GAP` 60m, see `RobinFloorVault` `[R3-H5]`
> and `test/regression/H5.floor-forced-fill.test.js`) closes the demonstrated once-per-cooldown loop but only
> *paces* the sustained-hold variant. This document is the structural closure.

## READ THIS FIRST — the external auditor's blessed direction was MEASURED WORSE THAN DOING NOTHING

`AUDIT-ROUND-3-EXTERNAL-RESPONSE.md` §2 blessed "gate today's fixed band on a TWAP" (FLOOR-REDESIGN Q3) as
"close to the smallest correct change". A 4-design × red-team panel built and attacked it. **All four candidate
designs were broken**, and the plain TWAP conjunct was measured to make the attack *strictly better for the
attacker*: peak extraction **+23.84 → +31.92 ETH**, break-even carve/pool-depth **~30% → 4.0%**. Two measured
economic facts explain why every "wait longer" gate fails:

- **T1 — holding costs nothing per unit time.** A push→hold→sell-back round trip measured **1.110618 ETH at 0s
  of hold and 1.110618 ETH at 3h**. Attacker cost is per ROUND TRIP, never per second. So any gate whose only
  price is "wait W" is inert — and a gate that lets ONE round trip fund MANY commits is *cheaper* than shipped.
- **T2 — a TWAP is a decaying memory.** After any genuine crash it keeps reading "below band" for a bounded
  interval, and inside that interval the attack is **fully atomic again**. All four designs fell to this.

Corollary that governs the whole design: `extraction ≈ G × (rate at which the vault commits new ETH)`. No window
length changes that. The fix must bound **ETH committed per unit of attacker cost**, and prove duration
**exactly rather than by averaging**. Hence the two new primitives below (`aboveLowerTs` watermark +
episode-scoped, non-refilling allowance) — with the TWAP retained only as defence-in-depth.

**Do not implement the auditor's §2 prescription as written.** Their correction (a) — keep a live-spot-below-band
check alongside any TWAP gate — IS correct and is carried forward as P3 (independently confirmed: without it the
wall silently mints itself out of parked token fees rather than reverting).

## MUST-FIX BEFORE IMPLEMENTING — [R3 N-B] P2's episode never resets on a SHALLOW dump

The external auditor design-reviewed this spec and confirmed **P1 (the swap-witnessed `aboveLowerTs` watermark)
is airtight — ship it.** But they found a real hole in **P2**: the episode allowance only resets when the tick
crosses **`floorTickUpper`**. A dump that stalls anywhere inside the band, `[floorTickLower, floorTickUpper)`,
never crosses that pivot, so the episode never rolls and the allowance stays effectively uncapped. They measured
the force-fill going **net-positive at the band midpoint (~tick 700)** — and that entire profitable window sits
below the reset pivot.

Consequence: this spec's headline ("≈3,700× unprofitable at any hold duration", "full closure") is **true only
for deep dumps**. Anchor the episode at **arming / first below-band observation** rather than only on crossing
the upper tick, then re-derive the bound across the shallow-dump range before this is called a closure.

---

# FINAL SPECIFICATION — H‑5 closure: **Swap‑Witnessed Below‑Band Gate + Episode‑Scoped Commit Allowance (OTG‑2)**

Target: `/home/user/sherif/pad-v4` · solc 0.8.26, viaIR, runs=1, cancun · Uniswap v4 (`@uniswap/v4-core@1.0.2`, `@uniswap/v4-periphery@1.0.3`)

---

## 0 · Executive summary — what changed relative to the four refuted designs

All four candidate designs were broken by red‑team, and they were broken by **two economic facts**, both independently measured in this repo's own harness:

* **T1 — Holding is free per unit time.** `test/scratch/s2b-hold-cost.test.js` measured a push→hold→sell‑back round trip at **1.110618 ETH at 0 s of hold and 1.110618 ETH at 3 h**. Attacker cost is per **round trip**, never per second. ⇒ **Any gate whose only cost is "wait W" is inert, and any gate that lets one round trip fund many commits is *cheaper* than the shipped code** (measured: design 1 raised peak extraction from +23.84 → +31.92 ETH and lowered break‑even carve/depth from ~30 % → 4.0 %).
* **T2 — A time‑weighted average is a *decaying memory*, so it reads "below band" for a bounded interval after every genuine crash.** In that interval a TWAP gate is already satisfied and the attack is **fully atomic again** (designs 2, 3 and 4 all fell to this: "poisoned window", "post‑crash lag", "stale‑low TWAP", break‑even collapsing from 8–10 h to 1–2.5 h).

Corollary that governs everything below: **`extraction rate = G × (rate at which the vault commits new ETH)`.** No window length changes this. The fix therefore has to bound **how much ETH the vault will commit per unit of attacker cost**, and the duration proof has to be **exact rather than averaged**.

The final design has one new primitive and one new economic bound:

| # | Control | Kills |
|---|---|---|
| **P1** | **`aboveLowerTs` watermark** — the hook stamps, on **every** swap, the timestamp whenever the **pre‑swap** tick is `>= floorTickLower`. Commit requires `now >= aboveLowerTs + MIN_BELOW_DURATION`. | T2 completely. A transition from above‑band to below‑band **is necessarily a swap whose pre‑swap tick is above the band**, so the attacker's own push stamps the watermark and closes the gate in the same transaction. Exact, O(1), swap‑clocked, no averaging, no poke. |
| **P2** | **Episode‑scoped commit allowance** — an "episode" is the run since the tick was last observed `>= floorTickUpper`; within one episode the vault may commit at most `EPISODE_BASE_WEI + 0.5 % × bandQuoteWei₀ + (ETH that arrived during the episode)`. **No time refill.** | T1 completely. One round trip funds one episode allowance, priced strictly below the round trip's own fee. Holding longer buys nothing. |
| P3 | Retained live‑spot‑below‑band check, demoted to **settlement precondition** (auditor correction (a)), plus a **re‑check inside `unlockCallback`**. | `CurrencyNotSettled` revert **and** the silent unclean add; plus the `_collect` re‑entrancy the red team found. |
| P4 | TWAP over `W = 3 × COMMIT_COOLDOWN` as a **required‑when‑available** conjunct. | Nothing new — it is provably implied by P1 — but it is the auditor's blessed control and defence‑in‑depth against a P1 implementation bug. |
| P5 | `belowSince` / `MIN_DWELL` / `lastObserved` / `MAX_OBSERVED_GAP` / `MAX_COMMIT_BPS` / `COMMIT_COOLDOWN` **retained byte‑for‑byte at shipped values**. | Every red‑team finding of the form "the fix weakened an existing control". |

**Result on the auditor's own measured scenario** (120 ETH carve, dumped pad, `test/helpers/h5-lab.js` geometry): the attacker's first commit requires **3 h 15 min of continuous, zero‑excursion price support** and then yields an allowance of **`EPISODE_BASE_WEI` ≈ 1 bp of the seed ETH ≈ 0.0001 ETH**, against a push round‑trip fee of ~0.33 ETH. **≈ 3,700× unprofitable, at any hold duration.** The 120 ETH stock is structurally unreachable because it arrived in a *previous* episode.

---

## 1 · What is discarded, and why

| Discarded | From | Why |
|---|---|---|
| **"TWAP conjunct only", nothing else changed** | design 1 | Broken: consolidates N round trips into 1. Measured strictly better for the attacker in 7/7 configs. |
| **Lengthening `W` / `COMMIT_COOLDOWN` as the hardening dial** | designs 1, 2 | Measured **inert to the wei** (sets A/B/C all yielded +31.1194 ETH). W and CC buy calendar time; calendar time is free. |
| **Lowering `MIN_DWELL` (10 → 5 min) to satisfy `CC > MIN_DWELL`** | designs 1, 4 | Satisfies the letter, inverts the intent. `MIN_DWELL` stays **10 minutes**; `COMMIT_COOLDOWN` stays **65 minutes**. |
| **Deleting `belowSince` / `lastObserved` / `MAX_OBSERVED_GAP`** | designs 2, 4 | The auditor wrote "**Keep it.**" Deleting `MAX_OBSERVED_GAP` makes `belowSince` unboundedly stale. All retained unchanged. |
| **Raising `COMMIT_COOLDOWN` (→ 35 min / → 30 min)** | designs 2, 3 | Under a fraction‑of‑stock slice, `slice = accrual × CC`, so raising CC *enlarges* the prize. Also `COMMIT_COOLDOWN` must stay **> `MAX_OBSERVED_GAP` (1 h)** — the repo measured that inequality, not the one against `MIN_DWELL`, as the one that bites (65 m ⇒ attacker −0.209 ETH). Unchanged at 65 min. |
| **`commitMarginTicks = ω` (gate at `tL − ω`)** | design 3 | Structurally disables curve pads forever (`floorTickLower = alignUp(gradTick+1)` sits one spacing above post‑graduation spot). **Margin = 0.** Safe because `G ≤ 0` for any dump shallower than the band midpoint, so a cliff at the band edge is worth nothing. |
| **Depth‑bonus slice multiplier `(1 + (Δ)/20000)`** | design 3 | Its safety proof identified `extra` with the *push depth*; `extra` is actually a time‑average and on a pumped‑then‑crashed pad delivers a free 1.78× multiplier. No magnitude‑based sizing survives. |
| **Depth‑anchored, time‑refilling budget (leaky bucket)** | designs 3, 4 | Profit grows linearly in hold duration; break‑even ~2 days. Replaced by the **non‑refilling, episode‑scoped, flow‑anchored** allowance. |
| **`depthRefLiquidity` from `stateView.getLiquidity(id)` in the runbook** | design 4 | Measured 335× inflatable by a one‑spacing JIT straddle across the non‑atomic launch→vault‑deploy gap (`scripts/launch.js` step 2 vs step 3), for ~0.03 ETH. **No live liquidity read appears anywhere in this spec.** |
| **Covered‑time clock / `MAX_SEGMENT` / crediting the stored `lastTick` / tight per‑second clamp (20 ticks/s)** | design 4 + the research brief | Crediting `s.lastTick` is directly exploitable at zero holding cost (push → 1‑wei swap to latch → sell back → idle). A tight clamp is *actively harmful*: it suppresses a genuine crash and lengthens the stale‑low‑TWAP window. |
| **`MAX_OBSERVATION_AGE` / `MAX_OBS_AGE` freshness gate** | designs 1, 2, 3, 4 | Asymmetric: the attacker's own push always refreshes it; the honest keeper cannot produce an observation at all. It taxes only the defender. Removed — and unnecessary, because **only `swap` moves `slot0`**, so a frozen endpoint is *correct*, and the retained live‑spot read covers the tail exactly. |
| **A `pokeObservation()` liveness aid** | designs 1, 2 | Re‑imports poke dependence. Not shipped. |
| **A hard-reverting constructor assertion on the hook** | designs 2, 3 | Bricks every hookless unit/fork pool. Replaced by a **loud, platform‑only `armFloorGate(poolId)` runbook step** that reverts on mismatch, plus `check-wiring.js`. |

**Kept and carried forward** (all four red teams confirmed these): the V3 `Oracle.transform` crediting convention; the infallible bounded hook write via a pinned `extsload(bytes32)` staticcall (`0x1e2eaeaf`, verified); placement after the corporate‑action curb block and **before** the `:210` early return; seeding in `registerPool` so `REQUIRED_FLAGS` stays `0x00CC`; compile‑time ring cardinality (no `grow()`); flat single‑word returns to dodge `abi.decode` cleanliness reverts; the corrected ring‑sizing rule `(N−1)·B − (B−1) ≥ W`; the `FeeHookDeployer` EIP‑170 offload; and the `_collect` re‑entrancy re‑check.

---

## 2 · The final gate logic

### 2.1 `RobinFloorVault.addFloor()` — replaces the current `:187–224`

```solidity
uint8 constant R_ORACLE   = 1;  // hook unreadable / unarmed / armed for a different band
uint8 constant R_SPOT     = 2;  // live spot inside/above the band  (settlement precondition)
uint8 constant R_WARMUP   = 3;  // gate armed less than MIN_BELOW_DURATION ago
uint8 constant R_BELOW    = 4;  // price was observed at/above the band too recently  <-- THE GATE
uint8 constant R_TWAP     = 5;  // TWAP over W is not below the band
uint8 constant R_DWELL    = 6;  // legacy poke dwell (retained, subordinate)
uint8 constant R_COOLDOWN = 7;  // legacy pace limiter (retained, unchanged)
uint8 constant R_BUDGET   = 8;  // episode allowance exhausted

function addFloor() external nonReentrant returns (uint128 added) {
    uint256 amt = currency0.balanceOfSelf();
    if (amt == 0) return 0;
    PoolId id = _poolId();

    // ── L1 · READ THE HOOK GATE STATE. [H-3]-safe: low-level staticcall + length check + flat
    //         single-word decode. address(0) / EOA / pre-oracle hook / short return / dirty word
    //         / hook armed for a DIFFERENT band  ==> PARK. Never a revert, never a brick.
    (bool gOk, uint64 armedAt, uint64 aboveLowerTs, uint64 aboveUpperTs) = _gateState(id);
    if (!gOk) return _park(amt, 0, 0, R_ORACLE);

    // ── L2 · EPISODE BOOKKEEPING. An "episode" is the run of time since the tick was last observed
    //         at or above floorTickUpper. Ending an episode requires sweeping the WHOLE band and
    //         buying it back — i.e. a full, fee-paying round trip. Done BEFORE any early return so
    //         the snapshot is always taken at the earliest poke of the episode.
    if (aboveUpperTs != episodeAnchor) {
        episodeAnchor     = aboveUpperTs;
        episodeStartQuote = amt;            // ETH parked when this episode began
        episodeStartBand  = bandQuoteWei;   // ETH already committed when this episode began
        emit FloorEpisodeReset(aboveUpperTs, amt, bandQuoteWei);
    }

    // ── L3 · LIVE SPOT — DEMOTED from "the gate" to a SETTLEMENT PRECONDITION [auditor (a)].
    //         This is the ONLY guarantee the band is pure-currency0 at current spot, which
    //         _add's getLiquidityForAmount0 (:279) + _resolve(currency1,…) (:296) depend on.
    //         It is monotone-conservative: it can only turn a commit into a PARK, never force one.
    //         The legacy poke-dwell bookkeeping is preserved here EXACTLY as shipped.
    (, int24 spot,,) = stateView.getSlot0(id);
    uint64 nowTs = uint64(block.timestamp);
    uint64 prevObserved = lastObserved;
    lastObserved = nowTs;
    if (spot >= floorTickLower) {
        belowSince = 0;
        return _park(amt, spot, 0, R_SPOT);
    }
    if (belowSince == 0 || nowTs > prevObserved + MAX_OBSERVED_GAP) belowSince = nowTs;

    // ── L4 · THE GATE. Swap-witnessed, exact, unaveraged proof of CONTINUOUS below-band price.
    //         `aboveLowerTs` is stamped by the hook on EVERY swap whose PRE-swap tick is >= the
    //         band. Coverage is total: the tick cannot move without a swap, every swap's pre-swap
    //         tick is inspected (including same-second swaps), and the tail [last swap, now] is
    //         covered by the L3 live read. So passing L4 PROVES the tick was < floorTickLower at
    //         every instant of [now - MIN_BELOW_DURATION, now].
    if (nowTs < armedAt + MIN_BELOW_DURATION)       return _park(amt, spot, 0, R_WARMUP);
    if (nowTs < aboveLowerTs + MIN_BELOW_DURATION)  return _park(amt, spot, 0, R_BELOW);

    // ── L5 · TWAP conjunct — the auditor's blessed control (§2 of the external response).
    //         Provably implied by L4 (a window with no above-band instant has an average below the
    //         band), so it costs zero liveness; retained as defence-in-depth. Unavailable (cold
    //         ring / span > MAX_SPAN_MULT × W) => L4 alone governs; an attacker cannot force
    //         unavailability, because the ring only grows and a sparse pad's span only widens.
    int256 tw = _twap(id, TWAP_WINDOW);
    if (tw != TWAP_UNAVAILABLE && tw >= int256(floorTickLower)) return _park(amt, spot, int24(tw), R_TWAP);

    // ── L6 · LEGACY PACE — retained UNCHANGED, values UNCHANGED. Subordinate AND-terms.
    if (block.timestamp < uint256(belowSince)   + MIN_DWELL)       return _park(amt, spot, int24(tw), R_DWELL);
    if (block.timestamp < uint256(lastCommitAt) + COMMIT_COOLDOWN) return _park(amt, spot, int24(tw), R_COOLDOWN);

    // ── L7 · SIZE — the episode allowance. Every term is a CEILING; the composed policy is never
    //         more permissive than today's MAX_COMMIT_BPS.
    uint256 allow = _episodeAllowance(amt);
    uint256 slice = (amt * MAX_COMMIT_BPS) / BPS;
    // [was :220] a balance too small to slice goes in whole — but NEVER above the allowance.
    if (slice == 0 && amt <= allow) slice = amt;
    if (slice > allow) slice = allow;
    if (slice > amt)   slice = amt;
    if (slice == 0)    return _park(amt, spot, int24(tw), R_BUDGET);

    added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, slice)), (uint128));
    if (added > 0) lastCommitAt = nowTs;      // never burn a cooldown on a no-op mint
    parkedQuote = currency0.balanceOfSelf();
    emit FloorCommitted(slice, added, allow, bandQuoteWei);
}

function _park(uint256 amt, int24 spot, int24 tw, uint8 reason) private returns (uint128) {
    parkedQuote = amt;
    emit FloorSkipped(spot, amt);                       // signature UNCHANGED (6 test assertions)
    emit FloorParked(reason, spot, tw, amt);            // new: which layer said no
    return 0;
}
```

### 2.2 The episode allowance — the economic bound (auditor correction (b))

```solidity
/// Cumulative ETH inflow is DERIVABLE, never tracked: outflows from the vault's currency0 balance
/// are ONLY commits into the band (currency0 LP fees go straight to the platform via
/// poolManager.take inside _collect and never enter this balance; currency1 is an ERC20).
/// So  cumInflow == currency0.balanceOfSelf() + bandQuoteWei  and it is monotone non-decreasing.
/// Inflow during this episode therefore collapses to  (amt - episodeStartQuote).
function _episodeAllowance(uint256 amt) internal view returns (uint256) {
    uint256 cap = EPISODE_BASE_WEI + (episodeStartBand * EPISODE_BAND_BPS) / BPS;
    if (amt >= episodeStartQuote) return cap + (amt - episodeStartQuote);   // + episode inflow
    uint256 spent = episodeStartQuote - amt;                                // cap already consumed
    return spent >= cap ? 0 : cap - spent;
}
```

Read as one invariant, which is the whole security argument in one line:

> **Within one episode, cumulative `bandQuoteWei` growth never exceeds `EPISODE_BASE_WEI + 0.5 % of the band's size at episode start + every wei of ETH that arrived at the vault during that episode.**

Three exhaustive ways an attacker can enlarge that allowance, each priced:

| Lever | Attacker pays | Allowance gained | Extraction ≤ | Margin |
|---|---|---|---|---|
| End the episode (cross `floorTickUpper` and re‑enter) | `β·N_push ≥ β·N_bandCross = 0.008 × 0.0582·D` | `EPISODE_BASE_WEI = 1e‑4·D` | `G·1e‑4·D ≤ 1e‑4·D` | **4.66×** |
| Push down through a token‑heavy band (forces a refill of `bq`, recovered on the sweep) | `2β·bq = 0.016·bq` | `0.005·bq` | `0.005·bq` | **3.2×** |
| Generate carve inflow `I` (wash trading) | `≥ (β_net/φ)·I = (0.008/0.002)·I = 4·I` | `I` | `G·I ≤ I` | **4×** |
| Donate `I` ETH to the vault directly | `I`, plus `β·I` in sweep fees | `I` | `G·I < I` strictly (`G = 1 − P_band/P_true < 1`) | strict, `≥ β·I` |
| Absorb honest counter‑flow `V` (they must, or the watermark resets) | `V·G` in inventory loss | `0.002·V` | `0.002·G·V` | **500×** |

Note the pre‑existing band contributes **zero** profit and **positive** cost: on a dumped pad the band already holds token, so pushing down refills it with `bq` ETH at band prices and sweeping recovers exactly `bq` — a wash, minus `β` on `2·bq` of notional. **A bigger floor makes the attack strictly more expensive.**

---

## 3 · `RobinFeeHook` — the observation, the watermarks, the read

### 3.1 Storage (two packed slots per pool + the ring)

```solidity
uint16 internal constant OBS_N       = 128;      // compile-time cardinality — no grow(), nothing to under-size
uint40 internal constant OBS_BUCKET  = 180;      // seconds per ring slot
int256 internal constant MAX_TICK_MOVE_PER_SEC = 9116;   // Uniswap MAX_ABS_TICK_MOVE, per SECOND — INSANITY BOUND ONLY
int256 internal constant MIN_TICK    = -887272;
int256 internal constant MAX_TICK    =  887272;
int256 public  constant TWAP_UNAVAILABLE = type(int256).max;
uint256 internal constant MAX_SPAN_MULT  = 4;    // reported span may not exceed 4×window
bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));                  // StateLibrary.sol:11
bytes4  internal constant EXTSLOAD_SEL = 0x1e2eaeaf;                         // extsload(bytes32) — OVERLOADED, pin it

/// write-once at arming; read-only thereafter.  24+24+40 = 88 bits -> ONE slot
struct FloorGateCfg { int24 gateLower; int24 gateUpper; uint40 armedAt; }

/// THE HOT RECORD — read+written on every swap.  40+24+88+16+40+40 = 248 bits -> ONE slot
struct OracleState {
    uint40 ts;              // wall clock of the newest accumulator advance
    int24  lastTick;        // clamped tick at ts — CLAMP REFERENCE ONLY, never credited
    int88  tickCumulative;  // Σ tick_i · Δt_i   (int88 ⇒ overflow provably unreachable)
    uint16 index;           // newest ring slot
    uint40 aboveLowerTs;    // last second a swap saw a PRE-swap tick >= gateLower   <-- THE GATE
    uint40 aboveUpperTs;    // last second a swap saw a PRE-swap tick >= gateUpper   <-- EPISODE ID
}

/// COLD snapshots, appended at most once per OBS_BUCKET.  40+88 = 128 bits -> ONE slot
struct Obs { uint40 ts; int88 tickCumulative; }

mapping(PoolId => FloorGateCfg) public floorGate;
mapping(PoolId => OracleState)  public oracleState;
mapping(PoolId => Obs[128])     internal obsRing;
```

### 3.2 The infallible pre‑swap tick read

`PoolManager.swap` calls `pool.checkPoolInitialized()` (`PoolManager.sol:196`, reads `slot0`) **before** `key.hooks.beforeSwap(...)` (`:202`) and `_swap` only afterwards (`:206`); `slot0` is the first member of `Pool.State` (`Pool.sol:83-91`). So in `beforeSwap` the slot holds the **pre‑swap** tick and is already **warm**.

```solidity
function _preSwapTick(PoolId id) private view returns (bool ok, int24 tick) {
    bytes32 slot = keccak256(abi.encodePacked(PoolId.unwrap(id), POOLS_SLOT));   // StateLibrary:324-326
    (bool s, bytes memory d) = address(poolManager).staticcall(abi.encodeWithSelector(EXTSLOAD_SEL, slot));
    if (!s || d.length < 32) return (false, 0);                                  // never revert
    assembly ("memory-safe") { tick := signextend(2, shr(160, mload(add(d, 32)))) }  // StateLibrary:53-62
    ok = true;
}
```

Never `StateLibrary.getSlot0` — its `abi.decode` runs in **our** frame after the call returns, outside any `try/catch`; that is the exact `[H-3]` trap `_scheduledEffectiveAt` (`RobinFeeHook.sol:273-277`) was rewritten to dodge. `Extsload.extsload(bytes32)` is bare assembly (`Extsload.sol:10-15`) and cannot revert, so the guard is belt‑and‑braces.

### 3.3 The write

Inserted in `beforeSwap` as **exactly one line**, after the corporate‑action curb block closes (`:206`) and **before** the early return at `:210`:

```solidity
        }                                     // <- end of curb block, :206
        if (c.registered) _observe(id);       // NEW
        // BUY tax = fee on the money-side INPUT ...
        if (!c.registered || sender == address(this) || !params.zeroForOne || c.buyTaxBps == 0) { ... }  // :210
```

*After the curb* because a curbed swap reverts the whole tx anyway. *Before `:210`* because that early return fires on **sells**, on `buyTaxBps == 0`, and on the curve controller's own swaps — all of which move the tick and **must** be observed; recording only taxed buys would hand an attacker a free unobserved direction.

```solidity
function _observe(PoolId id) private {
    FloorGateCfg memory g = floorGate[id];
    OracleState  memory s = oracleState[id];
    if (s.ts == 0 && g.armedAt == 0) return;              // neither seeded nor armed
    (bool ok, int24 raw) = _preSwapTick(id);
    uint40 nowTs = uint40(block.timestamp);
    bool dirty;
    unchecked {
        // ── WATERMARKS. Stamped on EVERY swap, INCLUDING same-second swaps (no dt guard), on the
        //    RAW (unclamped) tick, and FAIL-CLOSED on an unreadable slot. This is what makes an
        //    above-band -> below-band transition impossible to hide: the transition is a swap, and
        //    that swap's pre-swap tick is the above-band one.
        if (g.armedAt != 0) {
            if ((!ok || raw >= g.gateLower) && s.aboveLowerTs != nowTs) { s.aboveLowerTs = nowTs; dirty = true; }
            if ((!ok || raw >= g.gateUpper) && s.aboveUpperTs != nowTs) { s.aboveUpperTs = nowTs; dirty = true; }
        }
        // ── ACCUMULATOR — Uniswap V3 `Oracle.transform` semantics.
        if (ok && s.ts != 0) {
            uint40 dt = nowTs - s.ts;                     // monotone clock -> cannot underflow
            if (dt != 0) {                                // same second: zero weight, no clamp step
                int256 t   = int256(raw);
                int256 cap = MAX_TICK_MOVE_PER_SEC * int256(uint256(dt));
                int256 lo  = int256(s.lastTick) - cap;
                int256 hi  = int256(s.lastTick) + cap;
                if (t < lo) t = lo; else if (t > hi) t = hi;
                if (t < MIN_TICK) t = MIN_TICK; else if (t > MAX_TICK) t = MAX_TICK;

                // *** LOAD-BEARING. Credit [s.ts, now] at THIS swap's clamped PRE-swap tick — the
                // *** tick that genuinely prevailed over that interval, because only `swap` moves
                // *** slot0. Crediting the STORED s.lastTick instead (as the research brief's
                // *** snippet does) REOPENS H-5 AT ZERO HOLDING COST: push, 1-wei swap to latch,
                // *** sell back, idle W, one swap -> the whole window credited at the pushed tick.
                // *** DO NOT "SIMPLIFY" THIS LINE.
                s.tickCumulative += int88(t * int256(uint256(dt)));
                s.lastTick = int24(t);                    // provably in [MIN_TICK, MAX_TICK]

                if (nowTs / OBS_BUCKET != s.ts / OBS_BUCKET) {
                    s.index = (s.index + 1) % OBS_N;
                    obsRing[id][s.index] = Obs({ts: nowTs, tickCumulative: s.tickCumulative});
                }
                s.ts = nowTs;
                dirty = true;
            }
        }
    }
    if (dirty) oracleState[id] = s;
}
```

**Complete revert‑vector closure:** external call → low‑level staticcall + length check (and `extsload` cannot revert); checked math → everything `unchecked` **and** sized so overflow is unreachable (`|Σ| ≤ 887272 × 3.15e9 ≈ 2.8e15` over a century vs `int88.max ≈ 1.55e26`; per‑write `|t·dt| ≤ 9.75e17`); division → none on the write path; casts → no `SafeCast`, clamp in `int256` then a provably in‑range narrowing; array OOB → `% OBS_N` on a compile‑time constant; reentrancy → `beforeSwap` is already `nonReentrant`; caller influence → **zero** input from `sender`, `params`, `hookData`; OOG → ≤ 3 storage slots, one staticcall, no loops. `uint40` timestamps run past year 36000, so V3's `lte()` phantom‑overflow surface does not exist.

**Ring stuffing is structurally impossible:** appends are gated on bucket rollover, not swap count, so no swap rate can force more than one append per 180 s; and `consultTick` requires `o.ts <= s.ts − window`, so the span is `≥ W` by construction.

**Measured gas budget** (EIP‑2929/3529): steady state ≈ 2 cold SLOADs (4,200) + 1 warm SSTORE (5,000) + staticcall (~600) + arithmetic (~400) ≈ **10.2k**; on a dumped pad the watermark write is folded into the same slot so the marginal cost is 0; bucket rollover adds +5,000, or +22,100 on a ring slot's first‑ever write (128 such per pad, ever) → worst case ≈ **32k**. At the pinned `30_180_000 wei` gas price that is ~3.1e‑7 ETH per swap. `beforeSwap` already does `poolManager.mint` + `_bookBuy`.

### 3.4 The seed (no new hook flag)

`PadFactory.launch` calls `poolManager.initialize(...)` and then `registerPool(...)` **in the same transaction** (same for `CurvePadFactoryV4` and `StockPadFactory`), so `slot0` already holds the launch tick. Appended at the end of `registerPool`, after the `config[id] = …` write (`:154-170`):

```solidity
        (bool ok0, int24 t0) = _preSwapTick(id);
        uint40 n0 = uint40(block.timestamp);
        oracleState[id] = OracleState({
            ts: n0, lastTick: ok0 ? t0 : int24(0), tickCumulative: 0, index: 0,
            aboveLowerTs: 0, aboveUpperTs: 0
        });
        obsRing[id][0] = Obs({ts: n0, tickCumulative: 0});      // the anchor snapshot
```

`REQUIRED_FLAGS` stays **`0x00CC`** — the write rides the already‑set `BEFORE_SWAP_FLAG`; taking `AFTER_INITIALIZE_FLAG` would move the target to `0x10CC` and break `BaseHook.sol:43`, `PadFactory.sol`, `CurvePadFactoryV4.sol`, `StockPadFactory.sol` and `scripts/mine.js:3`. Cardinality is `OBS_N` from block zero — the auditor's "bump `cardinalityNext` at launch" is discharged **structurally**, there is no growth mechanism to get wrong.

### 3.5 Arming — a loud, platform‑only runbook step

```solidity
error FloorGateAlreadyArmed();
error FloorGateMismatch();
event  FloorGateArmed(PoolId indexed id, address vault, int24 gateLower, int24 gateUpper);

/// @notice Bind this pool's floor band into the hook so `_observe` can stamp the watermarks.
/// Platform-only, one-shot, and HARD-REVERTS on any mismatch — a mis-wired floor vault is an
/// unrecoverable park-forever (add-only, no withdraw), so it must fail at deploy time, loudly.
/// Deliberately NOT folded into setFloorRecipient: that setter is also used by pools whose
/// recipient is not a RobinFloorVault, and it must keep working for them.
function armFloorGate(PoolId id) external {
    if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
    PoolConfig storage c = config[id];
    if (!c.registered) revert NotRegistered();
    address v = c.floorRecipient;
    if (v == address(0)) revert NoFloorRecipient();
    if (floorGate[id].armedAt != 0) revert FloorGateAlreadyArmed();

    // typed calls: a revert here IS the intended deploy-time failure (not on any swap path)
    int24 lo = IRobinFloorBand(v).floorTickLower();
    int24 hi = IRobinFloorBand(v).floorTickUpper();
    if (PoolId.unwrap(IRobinFloorBand(v).poolId()) != PoolId.unwrap(id)) revert FloorGateMismatch();
    if (lo >= hi || lo < int24(MIN_TICK) || hi > int24(MAX_TICK)) revert FloorGateMismatch();

    (bool ok, int24 t) = _preSwapTick(id);
    uint40 n = uint40(block.timestamp);
    floorGate[id] = FloorGateCfg({gateLower: lo, gateUpper: hi, armedAt: n});
    OracleState storage s = oracleState[id];
    if (!ok || t >= lo) s.aboveLowerTs = n;      // conservative: park until MIN_BELOW elapses
    if (!ok || t >= hi) s.aboveUpperTs = n;
    emit FloorGateArmed(id, v, lo, hi);
}
```

`armedAt` **is** the warm‑up anchor (`now >= armedAt + MIN_BELOW_DURATION`), which is exact and needs no separate `startedAt`. On a `PadFactory` pad at launch (tick 0 < `tL` = 60) and a curve pad at graduation (spot = `gradTick` < `tL` < `tU`), `aboveUpperTs` stays **0**, which matches the vault's constructor default `episodeAnchor = 0` — so the pad's **first episode starts with `episodeStartQuote = 0` and therefore an unbounded (inflow‑equal) allowance.** That is what preserves the honest path exactly.

### 3.6 The reads (flat single words — no `abi.decode` cleanliness reverts)

```solidity
/// Every return is a full 32-byte word (uint256/int256), so the vault's decode can never revert on a
/// dirty word — the failure mode that a (bool,int24,uint32) tuple would introduce in the CALLER's frame.
function floorGateState(PoolId id)
    external view returns (uint256 armedAt, uint256 aboveLowerTs, uint256 aboveUpperTs, int256 gateLower)
{
    FloorGateCfg memory g = floorGate[id];
    OracleState  memory s = oracleState[id];
    return (uint256(g.armedAt), uint256(s.aboveLowerTs), uint256(s.aboveUpperTs), int256(g.gateLower));
}

function consultTick(PoolId id, uint32 window) external view returns (int256) {
    OracleState memory s = oracleState[id];
    if (s.ts == 0 || window == 0 || uint256(s.ts) < uint256(window)) return TWAP_UNAVAILABLE;
    uint40 target = s.ts - uint40(window);
    for (uint256 i = 1; i <= OBS_N; ++i) {
        Obs memory o = obsRing[id][(uint256(s.index) + OBS_N - i) % OBS_N];
        if (o.ts == 0) continue;
        if (o.ts <= target) {
            uint40 span = s.ts - o.ts;                                  // >= window by construction
            if (span == 0 || uint256(span) > uint256(window) * MAX_SPAN_MULT) return TWAP_UNAVAILABLE;
            unchecked { return int256(s.tickCumulative - o.tickCumulative) / int256(uint256(span)); }
        }
    }
    return TWAP_UNAVAILABLE;
}
```

No interpolation, no binary search, no wrap‑around comparison — both endpoints are **real recorded** `(ts, cum)` pairs divided by their **true** delta. Worst case 128 cold SLOADs ≈ 269k gas, on the keeper poke path only, **never** on a swap.

### 3.7 The vault‑side reads

```solidity
function _gateState(PoolId id)
    internal view returns (bool ok, uint64 armedAt, uint64 aboveLowerTs, uint64 aboveUpperTs)
{
    (bool s, bytes memory d) = address(hooks).staticcall(
        abi.encodeWithSelector(IRobinFloorGate.floorGateState.selector, id));
    if (!s || d.length < 128) return (false, 0, 0, 0);          // address(0)/EOA returns ok + 0 bytes
    (uint256 a, uint256 lo, uint256 up, int256 gl) = abi.decode(d, (uint256, uint256, uint256, int256));
    if (a == 0) return (false, 0, 0, 0);                        // not armed
    if (gl != int256(floorTickLower)) return (false, 0, 0, 0);  // armed for a DIFFERENT band -> PARK
    if (a > type(uint64).max || lo > type(uint64).max || up > type(uint64).max) return (false, 0, 0, 0);
    return (true, uint64(a), uint64(lo), uint64(up));
}

function _twap(PoolId id, uint32 w) internal view returns (int256) {
    (bool s, bytes memory d) = address(hooks).staticcall(
        abi.encodeWithSelector(IRobinFloorGate.consultTick.selector, id, w));
    if (!s || d.length < 32) return TWAP_UNAVAILABLE;
    int256 t; assembly ("memory-safe") { t := mload(add(d, 32)) }
    if (t < TickMath.MIN_TICK || t > TickMath.MAX_TICK) return TWAP_UNAVAILABLE;   // sentinel OR garbage
    return t;
}
```

### 3.8 `_add` — the mint‑time re‑check and the principal counter

The red team found a real hole in "the tick cannot move between the `getSlot0` read and `modifyLiquidity`": `_add` calls `_collect()` (`:275`), which does `poolManager.take(currency0, plat, …)` (`:314`); for native ETH `Currency.transfer` is `call(gas(), to, amount, …)` — **full gas forwarded**, while the PoolManager is unlocked. A platform wallet that is a contract can swap and move the tick inside that call.

```solidity
function _add(uint256 amt) internal returns (uint128 L) {
    if (floorLiquidity > 0) _collect();          // may hand full gas to the platform wallet (native take)

    // [H-5/re-entrancy] RE-CHECK the settlement precondition AFTER _collect and immediately before the
    // mint, atomically with it. Closes both (b-i) the ERC20InsufficientBalance revert and (b-ii) the
    // SILENT UNCLEAN ADD, which is worse: the vault routinely holds currency1 (token-side LP fees park
    // in-vault by design, :317, awaiting sweepTokenFees), so if that parked balance covers `owed` the add
    // SUCCEEDS and permanently converts the token treasury's money into un-removable floor principal —
    // no revert, no distinguishing event, and no remove path to undo it. Abort cleanly (0), never revert.
    (, int24 tickNow,,) = stateView.getSlot0(_poolId());
    if (tickNow >= floorTickLower) { emit FloorMintAborted(tickNow); return 0; }

    uint160 sLower = TickMath.getSqrtPriceAtTick(floorTickLower);
    uint160 sUpper = TickMath.getSqrtPriceAtTick(floorTickUpper);
    L = LiquidityAmounts.getLiquidityForAmount0(sLower, sUpper, amt);
    if (L == 0) return 0;
    (BalanceDelta delta,) = poolManager.modifyLiquidity(_poolKey(), ModifyLiquidityParams({
        tickLower: floorTickLower, tickUpper: floorTickUpper,
        liquidityDelta: int256(uint256(L)),                // ALWAYS positive — no remove path exists
        salt: bytes32(0)
    }), "");
    int128 a0 = delta.amount0();
    // exact principal consumed (fees were realized by _collect above); `amt` rounds down in
    // getLiquidityForAmount0 and would over-count the allowance ledger.
    if (a0 < 0) bandQuoteWei += uint256(uint128(-a0));
    _resolve(currency0, a0, address(this));
    _resolve(currency1, delta.amount1(), address(this));
    floorLiquidity += L;
    emit FloorAdded(amt, L, floorLiquidity);
}
```

---

## 4 · Final constants, each with its justifying inequality

`β_net` = the attacker's **irreducible** round‑trip fee fraction, computed against the **worst realistic attacker** (the creator, who recovers 80 % of the sell tax via `creatorOwed`, and who self‑refers via the permissionless `hookData` referrer): shipped `buyTax 100 / sellTax 100 / lpFee 3000 / sellFloorShare 2000` gives arm's‑length `β = 2.6 %`, creator‑attacker `β_net = 0.2 % (net sell tax) + 0.6 % (LP, unrecoverable — the seed LP is `LockVault`‑locked and its currency0 fees route to the **platform**, not the creator) = **0.8 %**`. Every sizing below uses **`β_net = 0.008`** and **`G_max = 1`**. `φ = sellTaxBps × sellFloorShareBps = 0.002` (the floor's share of sell notional). `D` = pool ETH depth ≈ `seedQuoteWei`.

### 4.1 `RobinFloorVault`

| Constant | Value | Status | Inequality / justification |
|---|---|---|---|
| `MIN_DWELL` | **10 minutes** | **UNCHANGED** | `COMMIT_COOLDOWN (3900) > MIN_DWELL (600)` — the auditor's independent requirement, **already satisfied strictly in the shipped tree and not weakened by this change.** Subsumed by `MIN_BELOW_DURATION`; retained as a subordinate AND‑term so the requirement keeps a live referent and no getter breaks. |
| `MAX_COMMIT_BPS` | **2000** | **UNCHANGED** | The outermost ceiling; every new term is a `min()` beneath it, so the composed policy is never more permissive than today's. |
| `COMMIT_COOLDOWN` | **65 minutes** | **UNCHANGED** | Must stay `> MAX_OBSERVED_GAP (1 h)` — the repo *measured* that this inequality, not the one against `MIN_DWELL`, is what bites (10 m ⇒ attacker +8.7340 ETH; 65 m ⇒ −0.2090 ETH). Raising it further would enlarge each slice; lowering it regresses a measured control. |
| `MAX_OBSERVED_GAP` | **1 hours** | **UNCHANGED** | The auditor wrote "Keep it." Bounds `belowSince` staleness. |
| `MIN_BELOW_DURATION` | **195 minutes (11 700 s)** | **NEW** | `= TWAP_WINDOW = 3 × COMMIT_COOLDOWN` ✓ (auditor correction (b), literal). Continuous, swap‑witnessed, zero‑excursion price support required before any commit. |
| `TWAP_WINDOW` (W) | **195 minutes (11 700 s)** | **NEW** | `W ≥ 3 × COMMIT_COOLDOWN` → `11700 = 3 × 3900` ✓ (equality). |
| `EPISODE_BAND_BPS` | **50 (0.5 %)** | **NEW** | `g < 2·β_net / G_max = 0.016` → `0.005` gives **3.2×** margin. Prices the "push down through a token‑heavy band" lever: the attacker must refill `bq` and pays `β` on `2·bq` of notional. |
| `EPISODE_BASE_WEI` | **immutable ctor param; runbook value `seedQuoteWei / 10_000`** (1 bp) | **NEW** | `G_max · EPISODE_BASE_WEI < β_net · N_bandCross`, where `N_bandCross = D·(1 − e^{−(tU−tL)·5e‑5}) = 0.0582·D` for the shipped 1200‑tick band → `< 4.66e‑4·D`. At `1e‑4·D` the margin is **4.66×**. **Derived from the launch config constant `SEED_ETH`, never from a chain read** (closes the design‑4 `getLiquidity` inflation vector); asserted in `check-wiring.js`. |
| inflow multiple `k` | **1 (implicit)** | **NEW** | Two independent bounds: donation vector needs `k · G_max ≤ 1` (strict, since `G = 1 − P_band/P_true < 1` always, with a further `β·I` of sweep fees on top); fee‑flow vector needs `k · G_max < β_net/φ = 4` ✓ **4×**. `k = 1` is the unique value satisfying both while still allowing **100 % of a live pad's carve to deploy**. |
| `BPS` | 10 000 | UNCHANGED | |

### 4.2 `RobinFeeHook`

| Constant | Value | Inequality / justification |
|---|---|---|
| `OBS_N` | **128** | Ring‑span rule, **corrected**: consecutive rollovers can be 1 s apart across a bucket boundary, so the guaranteed span is `(N−1)·B − (B−1)`, not `(N−1)·B`. `127·180 − 179 = 22 681 ≥ 11 700` ✓ **1.94×**. Power of two ⇒ `% OBS_N` is a mask. |
| `OBS_BUCKET` | **180 s** | Same inequality. Bucketing costs zero accuracy (both read endpoints are real recorded pairs) and makes ring stuffing structurally impossible. |
| `MAX_TICK_MOVE_PER_SEC` | **9116 / second** | Uniswap's `MAX_ABS_TICK_MOVE`, re‑homed per **second** via the explicit `if (dt == 0) return;` (Robinhood Chain runs ~100 ms blocks with 1‑second `block.timestamp` granularity, ~9–10 blocks per timestamp, so "per write" would be defeated by 10 writes/second). **Declared NOT a security control** — it is an insanity/overflow bound only. A *tight* clamp (design 4's 20 ticks/s) is actively harmful: it suppresses a genuine crash and lengthens the stale‑low‑TWAP window that broke designs 2/3/4. |
| `MAX_SPAN_MULT` | **4** | Caps the reported span at `4·W` so a sparse pad's stretched average cannot dilute recent history (design‑3 red team finding #6). |
| `TWAP_UNAVAILABLE` | `type(int256).max` | `≥ any floorTickLower`, so cold / short / dirty / missing all fail the same compare. |
| `int88` / `uint40` sizing | — | `|Σ| ≤ 887272 × 3.15e9 = 2.8e15` vs `int88.max = 1.55e26` (**8 orders**) ⇒ overflow is *unreachable*, not merely `unchecked`. `uint40` runs past year 36000 ⇒ V3's `lte()` phantom‑overflow surface deleted, not ported. |

**Deliberately absent:** any freshness / `MAX_OBSERVATION_AGE` bound, any depth or live‑liquidity read, any margin below the band edge, any time‑based budget refill, any magnitude‑based slice multiplier.

### 4.3 Runbook parameter recommendation (no code change)

`FLOOR_ANCHOR_OFFSET_SPACINGS` — recommend passing `anchorTick + 2·TS` (≈ 1.2 %) instead of `anchorTick` to `RobinFloorVault`'s ctor for both runbooks, and `gradTick + 5·TS` (≈ 3 %) for curve pads. This is a **deploy‑anchored constant**, not a live read, so it does not touch the fixed‑band invariant. It buys honest liveness: a micro‑dip to exactly launch/graduation price no longer resets `aboveLowerTs`. Ship **offset 0 (unchanged) unless the auditor approves**; flagged, not assumed.

---

## 5 · File‑by‑file change list

### 5.1 `contracts/core/FeeHookDeployer.sol` — **NEW, DEPLOYMENT‑BLOCKING**

Measured from `artifacts/` on this tree: `StockPadFactory` deployed = **23,936 / 24,576 → 640 bytes of headroom**, and it inlines `type(RobinFeeHook).creationCode` at `StockPadFactory.sol:186`. `PadFactory` = 19,394 (`:163`), `CurvePadFactoryV4` = 20,100 (`:206`), `RobinFeeHook` = 9,348 deployed / 9,756 creation. This spec adds ~2.0–2.6 KB of hook creation code to **all three**. **`StockPadFactory` would exceed EIP‑170 and become undeployable.** Mirrors `contracts/core/CurveV4Deployer.sol:8-9`, which exists verbatim for this reason.

```solidity
contract FeeHookDeployer {
    DeterministicDeployer public immutable deployer;
    constructor(address d) { deployer = DeterministicDeployer(d); }
    /// @param ctorArgs abi.encode(poolManager, FACTORY, feeRegistry, padToken) — the factory must pass
    /// its own address(this), never this deployer, or registerPool's msg.sender==factory check breaks.
    function deploy(bytes32 salt, bytes calldata ctorArgs) external returns (address hook) {
        hook = deployer.deploy(salt, abi.encodePacked(type(RobinFeeHook).creationCode, ctorArgs));
    }
}
```

**CREATE2 addresses are provably unchanged**: `DeterministicDeployer.addressOf` hashes `(0xff, address(this), salt, keccak256(initCode))` — the *shared* deployer — and the initCode bytes are byte‑identical. `scripts/mine.js` needs **zero changes**. The mined salt value changes because the hook bytecode changes, but no salt is persisted anywhere (`launch.js` records `tokenSalt` only) and mining is a sub‑second local keccak loop.

### 5.2 `contracts/core/{PadFactory,CurvePadFactoryV4,StockPadFactory}.sol` — **MANDATORY, all three**

Add `FeeHookDeployer public immutable feeHookDeployer;` + ctor param; replace the inline `deployer.deploy(hookSalt, abi.encodePacked(type(RobinFeeHook).creationCode, abi.encode(...)))` at `PadFactory.sol:163`, `CurvePadFactoryV4.sol:206`, `StockPadFactory.sol:186` with `feeHookDeployer.deploy(hookSalt, abi.encode(poolManager, address(this), feeRegistry, token))`. Keep **both** flag cross‑checks (`uint160(hook) & 0x3FFF != HOOK_FLAGS` and `hook.REQUIRED_FLAGS() != HOOK_FLAGS`) exactly as they are. Recovers ~9.8 KB per factory. All three factories and everything pinned to them must be redeployed.

### 5.3 `contracts/interfaces/IRobinInterfaces.sol` — append

```solidity
interface IRobinFloorGate {
    function floorGateState(PoolId id) external view
        returns (uint256 armedAt, uint256 aboveLowerTs, uint256 aboveUpperTs, int256 gateLower);
    function consultTick(PoolId id, uint32 window) external view returns (int256);
}
interface IRobinFloorBand {
    function floorTickLower() external view returns (int24);
    function floorTickUpper() external view returns (int24);
    function poolId() external view returns (PoolId);
}
```

### 5.4 `contracts/hooks/RobinFeeHook.sol`

* constants block after `MAX_GUARD_WINDOW` (`:54`): `OBS_N`, `OBS_BUCKET`, `MAX_TICK_MOVE_PER_SEC`, `MIN_TICK`, `MAX_TICK`, `TWAP_UNAVAILABLE`, `MAX_SPAN_MULT`, `POOLS_SLOT`, `EXTSLOAD_SEL`.
* structs + storage beside the per‑pool books (`:81-91`), keyed identically by `PoolId id = key.toId()` (`:195`) — no new keying concept: `FloorGateCfg`, `OracleState`, `Obs`, `floorGate`, `oracleState`, `obsRing`.
* new private `_preSwapTick(PoolId)`, `_observe(PoolId)`.
* new external `floorGateState(PoolId)`, `consultTick(PoolId,uint32)`, `armFloorGate(PoolId)`.
* `registerPool` (`:139-172`): append the seed block before `emit PoolRegistered` (`:171`).
* `beforeSwap` (`:188-232`): **exactly one line** — `if (c.registered) _observe(id);` between `:206` and `:208`.
* new events `FloorGateArmed`; new errors `FloorGateAlreadyArmed`, `FloorGateMismatch`. **No event in `_observe`** — the hot path stays event‑free.
* `afterSwap`, `_bookBuy`, claims, `_payout`, `receive`: **unchanged.** Public ABI is additive only; no existing selector changes.

### 5.5 `contracts/pads/RobinFloorVault.sol`

* **ctor (`:143-179`)**: new final param `uint256 episodeBaseWei_`; `if (episodeBaseWei_ == 0) revert BadBand();`; `EPISODE_BASE_WEI = episodeBaseWei_` (immutable). No new read of any kind. `episodeAnchor`/`episodeStartQuote`/`episodeStartBand` keep their zero defaults — this is what gives the pad's **first episode** an inflow‑equal allowance.
* **constants (`:104-124`)**: `MIN_DWELL`, `MAX_COMMIT_BPS`, `COMMIT_COOLDOWN`, `MAX_OBSERVED_GAP`, `BPS` — **all unchanged in name and value**. Add `MIN_BELOW_DURATION = 195 minutes`, `TWAP_WINDOW = 195 minutes`, `EPISODE_BAND_BPS = 50`, `TWAP_UNAVAILABLE`, the `R_*` reason codes.
* **state (`:126-128`)**: `belowSince`, `lastCommitAt`, `lastObserved` — **all retained, unchanged**. Add `uint256 public bandQuoteWei; uint64 public episodeAnchor; uint256 public episodeStartQuote; uint256 public episodeStartBand;`. `parkedQuote` (`:74`) and `floorLiquidity` (`:73`) untouched.
* **`addFloor()` (`:187-224`)**: replaced by §2.1.
* **`_add` (`:267-301`)**: the mint‑time re‑check + `bandQuoteWei` accumulation (§3.8).
* **new helpers**: `_park`, `_gateState`, `_twap`, `_episodeAllowance`.
* **new views**: `poolId() external view returns (PoolId)` (required by `armFloorGate`); `gateStatus() external view returns (bool armed, bool warm, uint64 aboveLowerTs, uint64 aboveUpperTs, int256 twapTick, uint256 allowance)` — pure ops surface for the keeper, `check-wiring.js` and the indexer.
* **new events**: `FloorParked(uint8 reason, int24 spotTick, int24 twapTick, uint256 parked)`, `FloorEpisodeReset(uint64 anchor, uint256 startQuote, uint256 startBand)`, `FloorCommitted(uint256 slice, uint128 added, uint256 allowance, uint256 bandQuoteWei)`, `FloorMintAborted(int24 tick)`. `FloorSkipped` and `FloorAdded` keep their signatures.
* **untouched**: `collectFloorFees`, `setTokenSink`, `sweepTokenFees`, `unlockCallback` dispatch, `_collect`, `_resolve`, `_alignUp`, `_poolKey`, `_key`, `_poolId`, `receive()`. **No decrease/remove/withdraw selector is introduced anywhere.**
* **doc fixes**: `:78` and `:233-234` both assert "this vault is deployed **pre**-launch", contradicting both runbooks (`scripts/launch.js` step 3; `scripts/deploy-curve.js:127`) and making the new arming step look impossible to a reviewer. Rewrite the `[H-5]` header block (`:81-103`) and the in‑function residual note (`:200-211`), which currently *concede* the residual this change closes.

### 5.6 Scripts

| File | Change |
|---|---|
| `scripts/deploy.js`, `scripts/deploy-curve.js` | Deploy `FeeHookDeployer` after `DeterministicDeployer`; pass into all three factory ctors; record `feeHookDeployer` in `deploy.local.json` / `deploy.curve.json`. |
| `scripts/launch.js` step 3 (`:88-101`) | Pass `episodeBaseWei = seedEth / 10_000n` as the 11th ctor arg **computed from the local `seedEth` constant, never a chain read**. After `setFloorRecipient`, add `await legacy(hookC, "armFloorGate", [poolId]);` and assert `(await floor.gateStatus()).armed === true`. Log that the floor parks for the first `MIN_BELOW_DURATION`. |
| `scripts/deploy-curve.js` (`:127-134`) | Same two additions at the graduation‑time vault deploy; `episodeBaseWei` from the curve runbook's seed constant. |
| `scripts/check-wiring.js` | Assert `hook.floorGate(poolId).armedAt != 0`; assert `floorGate.gateLower == vault.floorTickLower()`; assert `vault.EPISODE_BASE_WEI() == seedEth/10000`; print `gateStatus()`. |
| `scripts/keeper.js` (`:64`) | No behaviour change (already `tryStep`‑wrapped; `addFloor` never reverts). Log the `FloorParked` reason code so a persistent park is diagnosable. |
| `scripts/mine.js` | **No change.** `HOOK_FLAGS = 0xcc` unaffected; CREATE2 derivation byte‑identical. |

### 5.7 Callers of `addFloor()` — re‑verified, no production caller can brick

* `RobinCurveV4._fundFloor` (`:802-814`) is `try IFloorVault(f).addFloor() {} catch {}` and **moves the ETH first** (`floorEthOwed = 0; payable(f).call{value: amt}` at `:806-810`), so even an outright revert is swallowed with the carve already in the vault. It runs at graduation step 8 (`:437`), **outside** the `poolManager.unlock` opened at step 1, so the vault's own `unlock` cannot hit `AlreadyUnlocked`.
* `RobinCurveV4.flushFloor` (`:475`) → same path. `scripts/keeper.js:64` → JS `try/catch`.
* `RobinAmbushVault._forwardFloor` (`:186-193`) does a raw `floorRecipient.call{value:e}("")` and **never calls `addFloor`** → **FLOOR‑REDESIGN Q4 ("interaction with RobinAmbushVault") resolves to: none.**

**No production caller requires a commit.** Warm‑up parking bricks nothing.

### 5.8 Docs

`FLOOR-REDESIGN.md` (record OTG‑2 as shipped, and record **T1/T2 and the four refuted TWAP variants** as refutations 5–8, so nobody re‑proposes a naive ring), `AUDIT-SCOPE.md` §5, `AUDITOR-HANDOFF.md` (H‑5 / M‑15 / L‑33), `ROBIN-V4-ARCHITECTURE.md`, `ROBIN-V4-CURVE-ECON.md` (graduation park), `DEPLOY.md` (FeeHookDeployer bootstrap + `armFloorGate` step), and a new `ORACLE.md` stating in one paragraph that this is a **park‑biased, purpose‑built estimator for one consumer** and must never be reused as a general price oracle.

---

## 6 · Test plan

Harness: `test/helpers/h5-lab.js` already builds a **real** `PoolManager`, a **real** mined `RobinFeeHook` (`hookTaxBps`), a **real** `RobinFloorVault`, dumps the pad to `dumpTick`, parks the carve, and returns a gas‑aware attacker `ledger`. It needs three edits: the vault ctor gains `episodeBaseWei`; `hook.armFloorGate(poolId)` is called after `setFloorRecipient`; and `cfg.warm` optionally advances time past `MIN_BELOW_DURATION` with keep‑alive swaps.

### 6.1 The gating regression — reproduces the auditor's attack and proves it fails

`test/regression/H5.floor-forced-fill.test.js` — **rewrite** (its `belowSince` assertions at `:134/:165/:190` describe a control that is now subordinate). Keep it as the H‑5 regression:

1. **`AUDITOR PoC — token-flat, 4 rounds`** — `buildLab({hookTaxBps:100, carve: E(120), dumpTick: 12000, baseL: 1e20n, lpRange: 60000})`, then the exact JC1 loop: push to tick 59 → `addFloor()` → sell back → `time.increase(COMMIT_COOLDOWN)` → repeat ×6. **Assert `vault.floorLiquidity() == 0`, `vault.bandQuoteWei() == 0`, carve consumed `== 0`, attacker net PnL `< 0`** (measured expectation ≈ −0.3 ETH of fees vs the shipped +23.3 ETH). Also assert **no call reverted**.
2. **`CONTROL — same run, no carve`** — `carve: 0n`. Assert PnL `< 0` **and** `|PnL_carve − PnL_control| < 1e15 wei`, i.e. the presence of a carve changes the attacker's PnL by less than a milli‑ETH. This is the decisive control: it proves the attack is no longer *extraction*.
3. **`SUSTAINED HOLD — 3h15m continuous, keep-alive swaps`** — one push to tick 59, then 1‑wei buys every 60 s (never crossing `tL`) for `MIN_BELOW_DURATION`, then `addFloor()`. Assert the commit is **exactly `min(EPISODE_BASE_WEI, 20 % of amt)`**, that attacker PnL is negative by `≥ 100×` the extraction, and that a second commit one cooldown later is **0** (allowance exhausted, no time refill).
4. **`ROUND-TRIP CONSOLIDATION (design-1 break)`** — hold below the band across **10** cooldowns, poking each time. Assert `Σ committed ≤ EPISODE_BASE_WEI + EPISODE_BAND_BPS·bq₀/BPS`, independent of the number of pokes.
5. **`POISONED WINDOW / POST-CRASH LAG (design-2/3/4 break)`** — trade healthy at tick ≈ 0 for `> W` (so both the TWAP and `aboveLowerTs` are satisfied), then crash to tick 8090 in one swap, then **in the next block** push back to tick 59 + `addFloor()` **in the same transaction** (via a helper contract). Assert **PARK with `reason == R_BELOW`**; assert `floorLiquidity` unchanged.
6. **`SAME-SECOND BACK-RUN (dt == 0 hole)`** — identical to (5) but the push lands in the **same `block.timestamp`** as the crash swap (`evm_setAutomine` off, two txs in one timestamp). Assert the watermark still stamped (`aboveLowerTs == crashTs`) and the poke **PARKS**. *This is the single most important new test.*
7. **`DONATION VECTOR`** — mid‑episode, send `X` ETH directly to the vault, then poke. Assert the increase in `bandQuoteWei` across the whole episode is `≤ X + EPISODE_BASE_WEI + 0.5 %·bq₀`.
8. **`EPISODE RESET PRICING`** — cross `floorTickUpper` and re‑enter; assert `FloorEpisodeReset` fired, a fresh `EPISODE_BASE_WEI` is granted, and the attacker's measured round‑trip cost for the crossing exceeds `EPISODE_BASE_WEI` by `≥ 3×`.
9. **`HONEST PATH (retained from :193-216)`** — healthy pad, tick 0, carve arrives; after `armedAt + MIN_BELOW_DURATION`, `addFloor()` commits `20 %` per `COMMIT_COOLDOWN` and `floorLiquidity` grows **strictly monotonically** over 12 pokes, draining the carve exactly as today.
10. **`UNCLEAN ADD (auditor correction (a))`** — force `aboveLowerTs` old and the TWAP below the band while live spot `>= floorTickLower`. Assert **PARK**, assert **no revert**, and assert the vault's **`currency1` balance is byte‑identical before and after** (the (b‑ii) silent‑unclean‑add case).

### 6.2 `test/regression/H5.gate-liveness.test.js` — **NEW**

* Unarmed hook / `hooks = address(0)` / a hook whose `floorGateState` returns 96 bytes / returns a dirty word / reverts → **all PARK with `R_ORACLE`, none revert.**
* Hook armed for a **different** band (`gateLower != floorTickLower`) → PARK.
* Warm‑up: `now < armedAt + MIN_BELOW_DURATION` → PARK `R_WARMUP`; at `armedAt + MIN_BELOW_DURATION` exactly → passes L4.
* Grief: an attacker pushing the tick to `tL` once per `MIN_BELOW_DURATION` holds the vault parked; assert `parkedQuote` is exact and nothing is lost.
* `_collect` re‑entrancy: set `platformFeeWallet` to a contract whose `receive()` swaps the tick above `floorTickLower`; call `addFloor()` with `floorLiquidity > 0`. Assert `FloorMintAborted`, `added == 0`, **no revert**, `bandQuoteWei` unchanged, vault `currency1` unchanged.
* `slice == 0` dust path never bypasses the allowance.
* `lastCommitAt` is **not** advanced when `added == 0`.

### 6.3 `test/unit/RobinFeeHook.oracle.test.js` — **NEW**

* Observation is taken off the **pre‑swap** tick (assert against a known pre/post pair).
* **Stale‑`lastTick` regression**: push → 1‑wei swap in the next second → sell back in the same second → idle `W` → one swap → assert the TWAP reads the **recovered** tick, not the pushed one. (This is the research brief's bug; it must be caught in review if anyone re‑derives `_observe` from the brief.)
* `dt == 0` writes no accumulator delta but **does** stamp the watermarks.
* An unreadable `extsload` (mocked PoolManager) stamps both watermarks **fail‑closed** and cannot revert a user's swap.
* Ring wrap past 128 rollovers; `(OBS_N−1)·OBS_BUCKET − (OBS_BUCKET−1) ≥ TWAP_WINDOW` asserted on‑chain via `consultTick` after 200 rollovers.
* Ring stuffing: 10 000 swaps in 60 s cannot append more than one snapshot per `OBS_BUCKET`.
* `MAX_SPAN_MULT`: a sparse pad whose span exceeds `4·W` returns `TWAP_UNAVAILABLE`.
* An **unregistered** pool naming this hook cannot write any state.
* `bytes4(keccak256("extsload(bytes32)")) == 0x1e2eaeaf`.
* Hot‑path gas ceiling: `beforeSwap` delta vs. an `_observe`‑disabled build `< 12 000` steady, `< 35 000` on a first‑ever ring write.

### 6.4 Existing files

| File | Change |
|---|---|
| `test/unit/RobinFloorVault.test.js` (`:49-52` ctor, `:69-90` drain loop) | Add the 11th ctor arg; arm the gate; add warm‑up. `:55-60` (band placement) and `:62-67` (**no remove/withdraw selector**) are unaffected and must keep passing. |
| `test/sim/economics.sim.test.js` (`:111-150`) | Same wiring + warm‑up; the monotonicity invariant under test survives. |
| `test/sim/curve.graduation.sim.test.js` (`:63-66`, `:101-116`), `test/unit/RobinCurveV4.graduation.test.js` (`:70-74`, `:114-116`) | Conservation assertions still pass (`_fundFloor` moves the ETH **before** the poke). **ADD** an explicit assertion that the graduation poke **PARKS and does not revert**, and that `floorEthOwed == 0` — the documented graduation regression. |
| `test/unit/RobinFeeHook.adversarial.test.js` (`:210-263`) | Add: `armFloorGate` is platform‑only, one‑shot, and reverts on a pool/band mismatch. |
| `RobinCurveV4.cappedgrad`, `RobinCurveV4.grief`, `M25.staking-sink-mismatch` | `setFloor` sink probes only — **no change**. |
| `test/fork/*` | No floor vault is deployed — no change, but these run the **real** hook against the live PoolManager and are the right place to pin the added `beforeSwap` gas. |
| **NEW** `test/unit/EIP170.test.js` | Assert `PadFactory`, `CurvePadFactoryV4`, `StockPadFactory`, `RobinFeeHook`, `RobinFloorVault`, `FeeHookDeployer` deployed bytecode all `< 24 576`. |
| **NEW** `test/unit/FloorConstants.test.js` | `COMMIT_COOLDOWN() > MIN_DWELL()`; `COMMIT_COOLDOWN() > MAX_OBSERVED_GAP()`; `TWAP_WINDOW() == 3 * COMMIT_COOLDOWN()`; `MIN_BELOW_DURATION() == TWAP_WINDOW()`; ring sizing; `EPISODE_BAND_BPS <= 160` (the `2β_net/G` bound). |

---

## 7 · Disposition of every red‑team attack

| Design | Finding | Sev | Disposition |
|---|---|---|---|
| 1 | Round‑trip consolidation (1 trip funds every commit; break‑even → 4.0 %) | HIGH | **NEUTRALIZED.** Episode allowance is non‑refilling and inflow‑scoped; the stock from a previous episode is unreachable. Consolidation now buys nothing. |
| 1 | `W`/`COMMIT_COOLDOWN` inert (A/B/C identical to the wei) | HIGH | **ACCEPTED AS TRUE, ARCHITECTURE CHANGED.** No security claim rests on W or CC. Both retained at shipped values; the economics live in the allowance. |
| 1 | Destroys the keeper compensating control | HIGH | **NEUTRALIZED.** The control is replaced by an on‑chain, swap‑witnessed watermark that needs no keeper; and an honest keeper poking during an attack now commits **at most the allowance**, not a 20 % slice. |
| 1 | `MIN_DWELL` halved | MED | **NEUTRALIZED.** `MIN_DWELL` unchanged at 10 min; `COMMIT_COOLDOWN` unchanged at 65 min; both auditor inequalities already hold strictly. |
| 1 | Constants split across contracts with no on‑chain binding | LOW | **NEUTRALIZED.** The vault cross‑checks `gateLower == floorTickLower` on every read and parks on mismatch; `armFloorGate` hard‑reverts on a pool/band mismatch; `check-wiring.js` asserts. |
| 1 | Warm‑up is `W + one bucket`, not `W` | LOW | **ACCEPTED, DOCUMENTED.** Warm‑up is now `armedAt + MIN_BELOW_DURATION` — exact, bucket‑independent. |
| 2 | Post‑crash TWAP lag restores the atomic force‑fill | HIGH | **NEUTRALIZED by P1.** The crash swap, or the attacker's own push, stamps `aboveLowerTs` on the pre‑swap tick. Test 6.1(5). |
| 2 | Amortized single‑push hold | HIGH | **NEUTRALIZED by P2.** |
| 2 | `COMMIT_COOLDOWN` 10→35 min multiplies the prize | MED | **AVOIDED.** CC unchanged; the slice is allowance‑bounded, not `accrual × CC`‑bounded. |
| 2 | `MAX_OBS_AGE` is a liveness tax on the defender only | MED | **NEUTRALIZED.** No freshness gate ships. Only `swap` moves `slot0`, so a frozen endpoint is correct and the retained live‑spot read covers the tail. |
| 2 | Deleting `MAX_OBSERVED_GAP` loses what it guarded | MED | **NEUTRALIZED.** Retained unchanged. |
| 2 | `consultTick` span unbounded above | MED | **NEUTRALIZED.** `MAX_SPAN_MULT = 4`. |
| 2 | ctor `OracleNotSeeded` assert doesn't detect an unseeded/mis‑keyed pool, and bricks tests | MED | **NEUTRALIZED.** No ctor assert. `armFloorGate` reverts on `poolId()` mismatch — a real deploy‑time failure — and a forgotten arming parks (never bricks) and is caught by `check-wiring.js`. |
| 2 | Ships undeployable (`StockPadFactory` EIP‑170) | MED | **NEUTRALIZED.** `FeeHookDeployer` mandatory for all three factories; independently re‑measured at 23,936 / 640 bytes headroom. |
| 2 | Hardcoded `extsload` selector is a silent SPOF | LOW | **MITIGATED.** Constant + a unit test asserting `0x1e2eaeaf`; and an unreadable slot now **fails closed** (stamps the watermarks) instead of silently freezing the clock. |
| 3 | Poisoned window (`tau_min = 0`), break‑even → 2.5 h | HIGH | **NEUTRALIZED by P1.** |
| 3 | Depth‑bonus safety proof invalid | HIGH | **DISCARDED.** No magnitude‑based sizing. |
| 3 | `β` not attacker‑independent (creator rebate, self‑referral) | MED | **NEUTRALIZED.** All sizing uses `β_net = 0.8 %` (the creator‑attacker figure), and the `k = 1` bound is `β`‑independent. |
| 3 | `commitMarginTicks` kills curve pads / strands funds | HIGH | **DISCARDED.** Margin = 0. |
| 3 | `consultTwo` warm‑up on the wrong clock | MED | **NEUTRALIZED.** Warm‑up is `armedAt`, not wall clock vs. `s.ts`. |
| 3 | `shortThreshold` underflow below `MIN_TICK` | LOW | **N/A.** No threshold offset exists. |
| 3 | `MIN_DWELL` dead under R1 | INFO | **ACCEPTED AND STATED.** `MIN_DWELL` is subsumed by `MIN_BELOW_DURATION`; retained unchanged, and the response says so plainly rather than claiming the 6.5× ratio is doing work. |
| 4 | `depthRefLiquidity` from live `getLiquidity` → 335× inflation | CRITICAL | **DISCARDED.** No depth read anywhere; `EPISODE_BASE_WEI` is derived from the launch config constant. |
| 4 | `MAX_SEGMENT` creates no hold cost (clamp anchored to `lastTick`) | HIGH | **DISCARDED** (covered‑time clock and tight clamp both removed). Hold cost now comes from the exact watermark + the non‑refilling allowance. |
| 4 | Post‑crash stale‑low TWAP | HIGH | **NEUTRALIZED by P1.** |
| 4 | Sustained hold profitable at ~2 days | HIGH | **NEUTRALIZED by P2** (no time refill ⇒ no linear‑in‑time term). |
| 4 | `belowSince` unbounded staleness after `MAX_OBSERVED_GAP` deletion | MED | **NEUTRALIZED.** Retained. |
| 4 | Permanent park + stranded funds | MED | **PARTIALLY ACCEPTED — residual R1 below.** |
| 4 | `_collect` re‑entrancy moves the tick between the spot check and `modifyLiquidity` | MED | **NEUTRALIZED.** Mint‑time re‑check inside `unlockCallback`, atomic with `modifyLiquidity`. |
| 4 | `_consult` validates the decode but not `wall != 0` / `wall >= cov` | LOW | **N/A + hardened.** No density term exists; the vault's `_gateState` range‑checks every word and cross‑checks `gateLower`. |
| 4 | "Reuse an audited oracle" unsatisfiable | INFO | **ACCEPTED AND STATED — residual R5 below.** |

---

## 8 · How the auditor's three explicit requirements are satisfied

**(a) "Not a one-line gate swap — the spot read is double-duty."**
The `getSlot0` read is **retained** and explicitly **demoted** from *the gate* to *a settlement precondition* (L3), documented as such in code. It is monotone in the conservative direction — it can only turn a commit into a **PARK**, never force one — so it is not an exploitable input. Two corrections to the auditor's phrasing are carried into the docs: in *this* contract the concrete failure is either **(b‑i)** an `ERC20InsufficientBalance` revert inside `_resolve` (which fires before `CurrencyNotSettled` is ever reached and would break "the honest path never reverts"), or **(b‑ii)** a **silent unclean add** — the vault routinely holds `currency1` (token‑side LP fees park in‑vault by design, `:317`, awaiting `sweepTokenFees`), so if that balance covers `owed` the add *succeeds* and permanently converts the token treasury's money into un‑removable floor principal, with no revert and no distinguishing event. **(b‑ii) is the worse hazard and it is what the retained check exists for.** The check is additionally **re‑evaluated inside `unlockCallback`, atomically with the mint**, because `_collect` hands full gas to the platform wallet while the PoolManager is unlocked.

**(b) "TWAP closes the atomic residual; a sustained hold survives unless the window is sized against a real hold-cost bound."**
Accepted in full, and answered **without** relying on a window at all, because the repo's own measurement shows there is no per‑second hold cost to size against. The hold‑cost bound is delivered structurally by the **episode allowance**: one round trip funds one episode, and the allowance is sized strictly below that round trip's own irreducible fee at the worst‑attacker fee rate (`β_net = 0.8 %`), with 3.2–4.7× margin on each of the three levers. The auditor's specific sub‑requirements are all met: `W = 3 × COMMIT_COOLDOWN` ✓ (11 700 = 3 × 3 900); harmonized with `MAX_OBSERVED_GAP` (retained, and `COMMIT_COOLDOWN > MAX_OBSERVED_GAP` preserved) ✓; **park — never revert, never commit — until the window is fully warm** ✓ (`armedAt + MIN_BELOW_DURATION`, plus three independent `TWAP_UNAVAILABLE` conditions, all parking); cardinality bumped at launch ✓ (compile‑time constant `OBS_N` from block zero — there is no `grow()` to under‑size); observations recorded **inside `RobinFeeHook`** on `beforeSwap` off the **pre‑swap** tick, with an infallible, bounded, caller‑input‑free write ✓; **no keeper‑fed observer** ✓.

**(c) "Make `COMMIT_COOLDOWN` strictly greater than `MIN_DWELL`."**
Already true in the shipped tree — `COMMIT_COOLDOWN = 65 minutes > MIN_DWELL = 10 minutes` — and **this change does not weaken either value**. The stronger inequality the repo *measured* as load‑bearing, `COMMIT_COOLDOWN (65 m) > MAX_OBSERVED_GAP (1 h)`, is also preserved. Both are asserted on‑chain in `test/unit/FloorConstants.test.js`. Honest note for the response: under this design the inequality no longer carries the load — `MIN_DWELL`/`belowSince` are strictly subsumed by `MIN_BELOW_DURATION`, which proves the same property exactly rather than by observation, and is written by swaps rather than by pokes. They are retained because the auditor asked to keep them, because they cost nothing, and because they are a monotone‑conservative AND‑term.

---

## 9 · Residuals to disclose to the auditor

| # | Residual | Sev | Why acceptable |
|---|---|---|---|
| **R1** | **Carve accrued during a *previous* episode deploys only 1:1 with new inflow.** A pad that dumped past `floorTickUpper`, accrued a large carve, and then recovered can commit only `EPISODE_BASE_WEI + 0.5 %·bandQuoteWei + new carve`. Deploying a 120 ETH backlog would need 120 ETH of new carve ≈ 60 000 ETH of new sell volume. On a dead pad it parks indefinitely. | **MED (liveness)** | This backlog **is** the +23.3 ETH prize the auditor measured; making it un‑drainable in bulk is the security property, and it is the direct consequence of `extraction rate = G × commit rate`. Nothing is lost: the vault is add‑only, `parkedQuote` is exact, the ETH can only ever leave into the band, and it deploys as the pad earns. The instruction was to prioritise never minting into a manipulated band over deploying capital. **If the auditor wants a bounded liveness valve, the single dial is a time refill of `EPISODE_BASE_WEI` per `REFILL_PERIOD`; at `REFILL_PERIOD = 7 days` the break‑even continuous hold is ≈ 33 days. Default is 0 (no refill) and it is theirs to set.** |
| **R2** | **Grief:** anyone can hold the floor parked by pushing the tick to `>= floorTickLower` once per `MIN_BELOW_DURATION`. | LOW | Costs a real round trip on a pad trading above launch price, gains the griefer nothing, and loses nothing permanently (add‑only; the carve parks and deploys later). This grief existed identically before (pushing spot above the band at poke time). |
| **R3** | A pad **hovering exactly at the band edge** (curve pads at `gradTick`, ETH pads at launch price) resets `aboveLowerTs` on every dip and rarely commits. | LOW | Correct behaviour — at the band edge `G ≤ 0`, so the wall's marginal value is ~zero. Mitigated by the **`FLOOR_ANCHOR_OFFSET_SPACINGS` runbook knob** (§4.3), a deploy‑anchored constant that does not touch the fixed‑band invariant. Flagged for the auditor's decision; default unchanged. |
| **R4** | **Graduation regression:** curve pads park for `MIN_BELOW_DURATION` after graduation (the curve walks the tick **down** from `startTick` through the whole region above `gradTick`, so the last curve swap's pre‑swap tick is above the band and stamps the watermark). | LOW | Non‑bricking: `_fundFloor` zeroes `floorEthOwed` and moves the ETH **before** the try/caught poke; `flushFloor()` and the keeper complete it. Explicitly asserted in the graduation tests. It also **strengthens L‑33** — the floor cannot build mid‑curve, structurally. |
| **R5** | **The oracle is bespoke. "Reuse an audited truncated‑geomean oracle" is not satisfiable and this spec does not pretend otherwise.** Re‑verified: zero `oracle`/`observe`/`cardinality` hits under `node_modules/@uniswap/` — v4 removed the built‑in oracle by design. `TruncGeoOracle`/`TruncatedOracle` exist only on the unmerged `v4-periphery@trunc-oracle` branch, are `SPDX: UNLICENSED` (no redistribution right into an MIT tree — this alone ends it), unaudited, unreleased, and technically a downgrade (`int48` accumulator ⇒ ~5‑year horizon in an immutable contract). v3‑core `Oracle.sol` is BUSL→GPL‑2.0‑or‑later copyleft, `pragma >=0.5.0 <0.8.0`, and **relies on wrapping arithmetic that 0.8.26 reverts on — on the hot swap path**; and a per‑distinct‑timestamp ring would need `cardinality ≈ 1800` for a 30‑minute window on this 1‑second‑granular chain. | INFO | What limits the risk is **scope**: ~130 lines that are V3 `Oracle.transform`'s accumulator semantics plus a clamp, with `grow()`/`cardinality`/`cardinalityNext`, `binarySearch`/`getSurroundingObservations`/interpolation, `lte()`'s 2106 wrap, and `secondsPerLiquidityCumulativeX128` **all deleted** — and those ~290 deleted lines are exactly where the historical oracle bug class lives. **Crucially, the security of the gate does not rest on the accumulator at all**: the primary control (P1) is a pair of `uint40` watermarks and two comparisons. Do not claim an audited dependency; the auditor will check. |
| **R6** | **`EPISODE_BASE_WEI` is a trusted launch parameter.** Set 100× too high and the base allowance is decorative. | LOW | Same trust level `anchorTick` already carries (`[audit L1]`), and for the same reason: it **cannot** be derived on‑chain without a live read, and a live read is the vector that broke design 4. It is re‑derivable from launch calldata at audit time (`SEED_ETH / 10 000`), emitted, and asserted in `check-wiring.js`. |
| **R7** | **A malicious *platform* is not defended against.** An attacker who is simultaneously the platform wallet, the creator, and the sole LP has an irreducible cost equal to the floor's own carve share, making the `k = 1` inflow bound break‑even minus sweep fees. | INFO | The platform is the protocol operator; a malicious platform can do far worse than this (it holds `setFloorRecipient`, `setTokenSink`, the fee registry). The seed LP is `LockVault`‑locked with its currency0 fees routed to the platform, so a *creator* attacker cannot recover the 60 bps of LP fee — which is what preserves the 4× margin in the realistic model. |
| **R8** | **M‑15 is untouched and slightly worsened.** The fixed anchor still idles the carve in a sustained drawdown, and R1 adds the episode scope on top. | MED (product) | Out of scope and explicitly acknowledged by the auditor as "a separate product decision". Documented, not fixed. |
| **R9** | **~130 lines of new code now sit on the hot swap path of every pad.** The revert‑vector list is enumerated and closed, overflow is unreachable by sizing rather than by argument, and the write takes **zero** caller‑controlled input — but a revert in `beforeSwap` bricks a pool for everyone. | MED | Needs its own review pass, not just a floor‑gate review. The fork tests exercise the real hook against the live PoolManager and pin the gas ceiling. |

---

## 10 · Implementation order (do not reorder)

1. `FeeHookDeployer` + the three factory ctor changes + `scripts/deploy*.js` → **recompile and confirm all three factories are under 24,576 before writing a line of oracle code.**
2. `IRobinInterfaces.sol` additions.
3. `RobinFeeHook`: storage → `_preSwapTick` → `_observe` → `registerPool` seed → the one line in `beforeSwap` → `floorGateState` / `consultTick` / `armFloorGate`. Land `test/unit/RobinFeeHook.oracle.test.js` **before** touching the vault.
4. `RobinFloorVault`: ctor param → state → `_gateState` / `_twap` / `_episodeAllowance` / `_park` → `addFloor` → `_add` re‑check + `bandQuoteWei` → `poolId()` / `gateStatus()` → doc fixes.
5. `test/helpers/h5-lab.js` edits, then `H5.floor-forced-fill.test.js` rewrite (tests 6.1(1) and 6.1(2) are the gating pair), then `H5.gate-liveness.test.js`.
6. Runbooks, `check-wiring.js`, docs.