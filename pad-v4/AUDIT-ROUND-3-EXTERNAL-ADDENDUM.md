# External auditor — H-5 addendum & corrections (after the build team's rebuttal)

The build team rebutted my `AUDIT-ROUND-3-EXTERNAL-RESPONSE.md` with committed PoCs and shipped a new interim fix
(`COMMIT_COOLDOWN 65m > MAX_OBSERVED_GAP 60m`, commit `d2d02e0`) plus the OTG-2 closure spec. I re-audited the
rebuttal the same way I audited the code — independent PoCs on the **real shipped vault** at tip `843d9b0`, finder→
challenge. Several of their corrections are right and I concede them. The core finding stands and is **worse** than I
first reported, and the review turned up **two new items** — one against their shipped fix, one against their proposed
closure.

## Corrections to my own report (conceded — I verified each myself)

1. **My `COMMIT_COOLDOWN > MIN_DWELL` recommendation is INERT.** I ran their regression: pre-fix `+8.7340 ETH`,
   my-recommendation (cooldown 30m) `+8.7340 ETH` — bit-identical. It contradicted my *own* mechanism ("token-flat
   between commits… cost is ~2× pool fee, NOT arbitrage"): if the attacker holds no position, waiting is free. **Bad
   recommendation. Withdrawn.** The inequality that bites is against `MAX_OBSERVED_GAP`, not `MIN_DWELL`.

2. **"A fast keeper fully neutralizes it" is FALSE.** It closes only the *round-trip* variant (attacker restores
   spot≥band between pokes, so a keeper poke hits `tick≥floorTickLower` and zeroes `belowSince`, `RobinFloorVault.sol`
   `:194-195`). Against a **sustained hold** (attacker pushes the tick below the band and keeps it there), every poke
   sees `tick<band`, so it *advances/keeps* `belowSince` (`:212`) — the keeper becomes the attacker's accomplice and
   **commits the slices itself** (measured: keeper does 4 commits, `+7.5 ETH`). This voided two things in my report:
   the keeper compensating control (**withdrawn**) and the "keeper" leg of my HIGH-not-CRITICAL rationale.

3. **My ~5–6% break-even was measured on the wrong configuration.** My three PoCs set `hooks: ZERO` (LP fee only);
   every shipped pad runs `buyTaxBps=sellTaxBps=100` and `0/0` is contract-forbidden (`RobinFeeHook.sol:144`). But the
   correction goes *against* me, not for me: the live residual is the **sustained-hold** variant, whose break-even
   **with** the 1%+1% tax is **~3.3%** (lower than my 5–6%), because the sustained attacker pays *one* ~1.11 ETH
   round-trip and then extracts the carve over many free pokes (holding is free per unit time — see T1). So the hook
   tax does **not** reduce severity; my number was for a variant that the shipped fix closes.

4. **My blessed TWAP direction (§2) was incomplete at best.** Both underlying facts the build team cite are
   confirmed by PoC: **T1** — a push→hold→sell round trip costs the same at 0s and at 6h of hold (`0.209 ETH` LP-only,
   `1.111 ETH` hooked), so *any* time-window dial (`MIN_DWELL`, `TWAP_WINDOW`, a bigger cooldown) is inert as a
   security control; **T2** — a TWAP is a decaying memory that reads "below band" for a bounded interval after a
   genuine crash (measured ~55s to ~122min), reopening the atomic force-fill inside that window. A plain TWAP gate is
   therefore not "the smallest correct change"; the gate needs an **economic (hold-cost-vs-carve) bound**, which is my
   own correction (b) and is exactly what OTG-2's episode allowance implements. My correction (a) — retain a live
   spot-below-band check as a settlement precondition — **is** necessary and correct (carried into OTG-2 as P3).

## The core finding stands — and is worse

The H-5 residual is **HIGH and blocks mainnet**, reinforced. On the **real shipped vault** (tip `843d9b0`), the
**sustained-hold** variant, attacker self-poking, **no keeper**:

| scenario | commits | carve drained | attacker net |
|---|---|---|---|
| 16-window hold, LP-fee pad | 12 | **93.1%** (18.63 / 20 ETH) | **+11.67 ETH** |
| same, **1%+1% hook tax** (real pad) | 12 | **93.1%** | **+10.65 ETH** |
| no-carve control | — | 0 | −0.21 ETH (proves extraction) |

Gas across the whole drain: ~0.003 ETH. This is confirmed extraction of ~all of the floor carve, it survives the
real hook tax, and it needs no keeper.

## New item N-A — the shipped interim fix is INSUFFICIENT (do not rely on it)

`COMMIT_COOLDOWN 65m > MAX_OBSERVED_GAP 60m` (`d2d02e0`) closes **only** the artificially-slow round-trip — the one
where the attacker is *forced* to poke >60m apart so the `:212` re-arm fires. It does **not** touch the sustained
hold: the attacker self-pokes every ~30m (< 60m), so `belowSince` is armed once and never re-armed, and the vault
commits on schedule (measured above: +10–11 ETH, 93% of carve, on the shipped constants). The regression
`H5.floor-forced-fill.test.js` case 3 passes (`-0.209 / 0 carve`) **only because it hard-codes a >60m poke gap** —
the attacker chooses the cadence, so that green is false confidence. The contract comment "closes the demonstrated
once-per-cooldown loop" (`RobinFloorVault.sol:114`) overstates what shipped. **Consequence: there is no valid
"ship interim behind the fix + a keeper" posture. Mainnet stays blocked until a real structural closure lands.**
(Keep the shipped constants — they still kill the atomic whole-carve fill and the slow round-trip — just don't
represent them as closing H-5.)

## New item N-B — OTG-2's design has a shallow-dump gap (must-fix before it is a closure)

I did the external design review OTG-2 asks for. **P1 (the swap-witnessed `aboveLowerTs` watermark) is airtight and
should ship**: in `v4-core@1.0.2`, `slot0.tick` is written only by `initialize` and `swap` (`Pool.sol:106,439`;
`modifyLiquidity`/`donate`/`setProtocolFee`/`setLPFee` preserve it), so every above→below transition is a swap whose
pre-swap tick is above the band — the attacker's own push stamps the watermark and closes the gate in the same tx.

**But P2 (the episode allowance) does not fully close H-5.** The episode resets only when a swap's pre-swap tick
`>= floorTickUpper` (`aboveUpperTs`, spec `:294/:239`, reset at `:113-118`). A dump that stalls **anywhere in
`[floorTickLower, floorTickUpper)`** never advances `aboveUpperTs`, so `episodeStartQuote` stays at its constructor
default `0` (spec `:387`) and `_episodeAllowance` returns `cap + (amt − 0)` — **uncapped** (spec `:189-192`).
Measured on the current geometry (band `[60,1260]`, midpoint ~660): force-fill PnL crosses **positive at ~tick 700**
and the whole `(≈660, 1260)` window is net-profitable *and* below the episode-reset pivot — so under OTG-2 that regime
still drains the carve, net-positive even under the hook tax. The spec's "**3,700× unprofitable at any hold duration /
full closure**" (spec `:58`) is true only for **deep** dumps (tick past `floorTickUpper`); it must not be stated as a
general closure. The regime is narrower and slower than unmitigated H-5, but it is still net-profitable extraction.
**Must-fix:** make the episode reset (or the allowance anchor) trigger on a sustained run below `floorTickLower`, not
only on crossing `floorTickUpper` — e.g. anchor `episodeStartQuote` at arming / at the first below-band observation so
a shallow dump cannot inherit the unbounded first-episode allowance.

## Updated bottom line

- **F1 / F2 / F3 / the two contract-enforced invariants / Arrow (for FCFS):** unchanged — cleared.
- **Floor H-5:** **HIGH, blocks mainnet.** Worse than first reported (sustained hold: 93% of carve, no keeper,
  survives the hook tax and the shipped interim fix). No keeper mitigation exists; no valid ship-interim posture.
- **Fix:** OTG-2 is the right shape — ship P1 and P3 — **but close the P2 shallow-dump gap (N-B) first**, or the
  "closure" leaves a narrower but real extraction surface. I'll re-audit the implementation when it lands.
- The launch decision is unchanged from my prior response in kind, only firmer: either land a *complete* structural
  closure, or descope the floor's "un-ruggable" promise (the build team already corrected the v4 README in `9ed6ae7`)
  and ship the rest of v4, which is clean.

*(Corrections above were verified against the real shipped `RobinFloorVault` at tip `843d9b0`; PoCs are under
`test/scratch/` — untracked, not part of the audited tree.)*
