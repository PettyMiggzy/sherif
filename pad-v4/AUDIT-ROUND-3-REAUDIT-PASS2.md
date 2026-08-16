# Round-3 re-audit — PASS 2: verifying the remediation-of-the-re-audit at tip `ec3d7aa`

Second re-audit pass, against tip `ec3d7aa` (commits `52b8eef` + `ec3d7aa`), which closed the five items from
`AUDIT-ROUND-3-REMEDIATION-REAUDIT.md` and added two **new contract behaviors** + 12 sweep residuals. Method: an
8-agent adversarial workflow (4 residual-risk dimensions × finder→skeptic, skeptics told to REFUTE — with special
instruction to hunt a hidden false-positive brick or an Arrow reservoir burn) plus manual confirmation of every
load-bearing claim.

**Test/sim gates on `ec3d7aa`:** unit `233 passing / 6 pending / 0 failing` (+1 vs the prior 232 = the new
`[R3-N2]` regression case); sims `32 passing / 0 failing` (Arrow 6/6, curve graduation, lock-staking graduation).
Compile clean. No fix-induced regression.

> **Bottom line:** everything fund-relevant is **closed and verified**. The two new contract behaviors are correct —
> no false-positive brick, no reservoir burn, no regression. **One residual remains: a doc-precision inconsistency at
> 2 of 7 sites (NONE fund-safety).** Fix those two lines and the external-auditor package can honestly state all
> round-3 findings closed at `233 / 32` green.

---

## Verified CLOSED (adversarially + manually)

| Item | Verdict | Key evidence |
|---|---|---|
| **F2** — `LockVault.setStakingRecipient` guard | ✅ closed | `LockVault.sol:107` now `zero ‖ code.length==0 ‖ self`; M25 pins EOA/self rejection; `registerLaunch` writes the recipient directly (bypasses the setter), so the curve-path pool registration is unaffected |
| **F3 code path** — reservoir → 100% staking | ✅ closed | `_fundStaking:788-790` parks at `staking==0`, else 100% to pool; ETH-only waterfall elsewhere |
| **N1** — `launch.js` de-graft | ✅ closed | no runtime `curve` ref remains (comment-only); curve wiring correctly relocated to the curve runbook |
| **N2** — `setStaking` splitter rejection | ✅ **closed structurally, no false-positive** | `RobinCurveV4.sol:552-553` rejects only `splitter && sd.length==32`; `DualStaking`/`RobinLockStaking` expose neither `TO_STAKING_BPS` nor a fallback, so the staticcall reverts → `splitter=false` → **real pool accepted**. Selector check: `token()=0xfc0c546a`, `tokenAsset()=0x28da4472`, `TO_STAKING_BPS()=0xe45b09ec` — no collision. `TO_STAKING_BPS` is defined only in the treasury. M25 `[R3-N2]` asserts treasury rejected **and** the real pool still passes. |
| **N2 upgrade / self-guards — burn & brick risk** | ✅ **fund-safe** | Arrow graduates with `staking==0` → `_fundStaking` parks (no `address(0)`/dead transfer); `flushStaking:463` needs `staking!=0`; post-hoc `setStaking(pool)` recovers 100% and the splitter guard blocks a post-hoc `setStaking(treasury)` fat-finger. Self-guards (`setStaking/setFloor/setAmbush/setStakingRecipient` reject self) break no legitimate flow. |
| **Arrow "model gap"** (build-session self-reported MED) | ✅ closed & accurate | `ArrowLauncher` never calls `setStaking` (platform-gated; it can't) → `staking==0` at graduate → lock registers `0` → sell-leg wirable post-hoc to the treasury (70/30) via `setStakingRecipient`. `ARROW.md` rewrite matches the code. |
| Sweep residuals (stale-5% purge, comment truth) | ✅ closed | no residual `default 5%/500` for DualStaking; the `deploy.js:55` F1 comment now states the structural truth |

The N2 move is the same upgrade pattern as F1: my re-audit said the "probe rejects the treasury" *rationale* was
false; the build session made it **true in the contract** (a splitter-shape probe) rather than merely rewording it —
so the 30%-reservoir-burn mis-wire is now contract-blocked on every path, including the Arrow post-graduation wiring.

## The one surviving residual — doc-precision inconsistency (NONE fund-safety)

Two of seven doc sites retained a blanket "curve-path `LockVault` sell-leg → 100% staking, **permanently**" claim
*without* the Arrow sub-path carve-out that the other five sites (`ARROW.md`, `ECON §2`+`§5`, `START-HERE`,
`AUDIT-ROUND-3-BRIEF`) correctly carry:

1. **`RobinTokenTreasury.sol:13-16`** — *"Curve pads … The curve-path `LockVault` sell-leg does NOT come here: at
   graduation `registerLaunch` hard-wires it to `curve.staking` (the pool) — 100% staking, permanently."*
2. **`AUDITOR-HANDOFF.md §0c`** (~L271) — *"the curve-path `LockVault` sell-leg and the graduation reservoir are
   hard-wired 100% to the staking pool."*

Both are true for the **standard curve runbook (path B)** but false for the **Arrow curve sub-path (path C)**, where
the curve graduates with `staking` unset, the lock registers recipient `0`, and the sell-leg is then wired **to the
treasury** (70/30) post-hoc — exactly as `ARROW.md` step 2 and `ECON` (which calls Arrow a "curve sub-path") describe.
Read in isolation, each of these two sites tells an operator the Arrow curve sell-leg can never reach the treasury,
directly contradicting `ARROW.md`. The word "permanently" is the specific over-statement.

*(Also noted: the `ec3d7aa` commit message states `AUDITOR-HANDOFF §0c` was updated to "carry the matching Arrow
nuance," but the diff to that file only touched the unrelated ambush-recipient line — the §0c sell-leg clause was not
in fact given the Arrow carve-out. A commit-message over-claim, not a code issue.)*

**Hand-off (for the build session — this auditor modified no code):** add the Arrow sub-path carve-out to those two
sites — e.g. *"… 100% to the pool on the standard curve runbook (path B); on the Arrow sub-path (path C) the curve
graduates with `staking` unset, so the lock registers `0` and the sell-leg is wired post-hoc to the treasury (70/30)."*
Once both read consistently with `ARROW.md`, all seven sites agree and the external package is clean.

## Positive properties re-confirmed at `ec3d7aa`

- N2 splitter probe: read-only `staticcall`, no `abi.decode` of its return (length-checked), no reentrancy/grief; only
  the platform-chosen one-shot sink is probed.
- Arrow reservoir is **never burned** — parked-then-recovered is the only failure mode, and it is
  operator-liveness-dependent, not a loss.
- All one-shot setters survive a rejected self/EOA/treasury attempt unspent (still wirable to the correct target).
- F1 (structural pad-token exemption) remains intact and unbypassable.
