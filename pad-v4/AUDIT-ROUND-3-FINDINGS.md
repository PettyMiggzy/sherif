# Round-3 independent audit — Arrow launcher + fee-model round 2 (commit 954faf8)

Independent adversarial re-audit of the NEW surface introduced since the round-2 remediation: the Arrow
migration launcher (`ArrowLauncher`, `ArrowDistributor`), `RobinTokenTreasury`, and the fee-model round-2
token-leak wiring (`RobinFloorVault.tokenSink`, `LockVault` M-11). Read this alongside `ARROW.md`,
`AUDITOR-HANDOFF.md §0c/§0d`, and `ROBIN-V4-CURVE-ECON.md §5`.

**Method.** Four adversarial finder→skeptic passes over this branch, on top of the builder's own 25-agent Arrow
audit (which fixed Arrow-M1 over-extraction and Arrow-L3 tail-brick). Baseline: `npx hardhat test` → **225
passing / 6 pending** (6 = fork tests needing `FORK_RPC`). Compile clean (27 files).

**Bottom line.** The Arrow contracts themselves are clean — no theft, loss, brick, or strand found across five
independent audits. What is NOT clean is the **consistency of the fee-model round-2 "platform is ETH-only"
model** with the deployed config and the curve path. Three findings, all verified, none a fund-theft / brick /
permanent-strand. The headline invariant the hand-off advertises as *"tested, highest-value"* does not hold as
deployed.

> **REMEDIATION STATUS (build session) — all three addressed.**
> - **F1 — fixed + docs corrected.** `deploy.js` `STAKING_CLAIM_FEE_BPS` default `500 → 0` (platform forgoes the
>   token-denominated staking claim fee, so no pad token reaches the platform key). The invariant claim in
>   `AUDIT-ROUND-3-BRIEF.md`, `AUDITOR-HANDOFF.md §0c`, and `ECON §5` is corrected to **config/wiring-enforced, not
>   fully contract-enforced** (an owner setting a nonzero token claim fee re-opens it — governance caveat). A
>   structural fix (route the token claim fee to treasury/burn) is flagged back to you. Your R3F1 demo was converted
>   into an end-to-end regression proving 0 under the shipped config + the nonzero-fee caveat. Tests:
>   `R3F1.platform-token-invariant.demo.test.js`, `DualStaking.adversarial.test.js [F1]`.
> - **F3 — fixed.** `launch.js` now wires `curve.setStaking = the pool` (it was never wired → reservoir would park);
>   `setStaking` reverts `StakingAssetMismatch` on a non-pool, so the reservoir is 100% staking. `ECON` corrected: the
>   70/30 treasury split applies to **post-graduation** token LP fees; curve-phase fees ride the reservoir to staking.
> - **F2 — fixed.** `RobinFloorVault.setTokenSink` now carries the `code.length` + self guards its peers have.
>
> An independent exhaustive platform-token sweep (build session) is running to confirm no *further* token→platform
> path beyond F1 before the invariant is re-declared. Fixes on branch, tests green.

---

## F1 · MEDIUM (audit-integrity) / LOW (fund-safety) · "the platform never holds a pad token" is FALSE as deployed

**Claim under test.** `AUDIT-ROUND-3-BRIEF.md:61` and `AUDITOR-HANDOFF.md §0c:267`:
*"the platform wallet's pad-token balance is always exactly zero … the treasury key never receives a pad token
(currency1). Tested; the highest-value invariant."*

**Reality.** The staking claim fee routes pad tokens to the platform key.
- `deploy.js:35` — `FeeWalletRegistry(platform, …)` ⇒ `platformFeeWallet = platform`.
- `deploy.js:52` — `StakingFactory(platform, deployer, 500)` ⇒ every pad staking pool gets
  `platformTreasury = platform` (**the same key**) and `platformClaimFeeBps = 500` (5%).
- `RobinTokenTreasury.distribute()` forwards 70% of token-side LP fees into the DualStaking pool as a pad-token
  reward; the keeper books it via `fundTokenPushed`.
- `DualStaking.claim` (`:392`) skims `fee = amount*500/BPS` of the **pad-token** reward into
  `platformFeesOwed[padToken]`; `claimPlatformFees → _payout` (`:423`) transfers those pad tokens to
  `platformTreasury == platform`.

So ≈ 5% of the 70% staking stream (≈ 3.5% of token-side LP fees), plus 5% of any pad-token grad-leftover reward
claimed, lands on the platform key. The cited test (`RobinFloorVault.test.js [fee-model]`) only covers the
*floor* leak, not this staking-claim-fee path — the stated system-wide invariant is untested and false.

**Proof.** `test/regression/R3F1.platform-token-invariant.demo.test.js` reproduces the exact deploy wiring and
asserts the platform balance goes `0 → 3.5` pad tokens. Runs green today (the break exists).

**Fix (pick one).** (a) create pad staking pools with `platformClaimFeeBps = 0`; (b) point the staking
`platformTreasury` at a token-accepting sink distinct from the ETH-only platform key; or (c) correct the brief /
hand-off to scope the invariant to **LP-fee routing** and disclose the staking claim fee as a bounded (≤10%,
owner-zeroable) token cut. Conservation itself holds (the cut is accounted and disclosed via M-16) — this is an
invariant/marketing-vs-reality gap, not a leak.

---

## F3 · MEDIUM (model/spec) / LOW (fund-safety) · the documented round-2 token model is unachievable on the curve path

**Model (`ROBIN-V4-CURVE-ECON §53`).** *"`LockVault`'s token leg … recipient = treasury"* (sell-leg LP fee →
treasury, 70/30) **and** *"The graduation leftover-reserve dump stays 100% staking."* Two different targets.

**Reality.** On the curve path both are driven by the single `curve.staking` variable at graduation:
- `RobinCurveV4.sol:417` — `onGraduated(…, staking)` ⇒ `LockVault.registerLaunch` sets the locked-LP sell-leg
  recipient = `curve.staking`.
- `RobinCurveV4.sol:454` — `_fundStaking` sends the graduation reservoir to `curve.staking`.

One knob, two sinks the model wants pointed differently:
- `setStaking(pool)` → reservoir 100% to stakers ✓, but the lock sell-leg goes 100% to the pool, **skipping the
  treasury's 70/30 burn** ✗ (and `RobinTokenTreasury`'s own docstring, which lists *"LockVault sell-leg"* as a
  source, is false on this path).
- `setStaking(treasury)` → lock sell-leg 70/30 ✓, but the reservoir now runs through the treasury and **30% of
  the graduation reservoir is burned** ✗.

Neither wiring satisfies both halves of the model, and it is unrepairable after graduation
(`LockVault.setStakingRecipient` reverts `AlreadySet`). The PadFactory path is unaffected (it has no reservoir
and wires `setStakingRecipient(treasury)` directly).

Related hardening: `RobinCurveV4.setStaking`'s `_probeStakeAsset` accepts `RobinTokenTreasury` (its `token()`
returns the pad token), so it cannot distinguish the pool from the treasury — a `setStaking(treasury)` mis-wire
passes all guards and silently burns 30% of the reservoir.

**Fund-safety.** LOW — funds reach stakers either way; no theft or strand. This is a model/spec/architecture
inconsistency, not a loss.

**Fix.** Give the curve two independent sinks (a distinct locked-LP-fee recipient vs the reservoir sink), or
amend `ECON §53` + the treasury docstring to state that on the curve path the lock sell-leg goes 100% to
stakers (no 70/30) and the treasury's LockVault-sell-leg source applies to the PadFactory path only.

---

## F2 · LOW (defense-in-depth) · `RobinFloorVault.setTokenSink` omits the guards its peers carry

`setTokenSink` (`:222-228`) validates only `sink == address(0)`. Its four peers require the target be a
contract and (for the hook) reject self: `RobinCurveV4.setStaking` `:535` (`code.length` `[LOW-3]`),
`setFloor`/`setAmbush`, `RobinFeeHook.setFloorRecipient` (`[M-4]` code + `[M-24]` self). `setTokenSink` is a
one-shot with no rescue and `sweepTokenFees` is the only outward token path, so a mis-wire is permanent — and
`sink == address(this)` makes `sweepTokenFees` a self-transfer no-op that emits `TokenFeesSwept` while freezing
the token forever (the exact `[M-24]` case). `LockVault.setStakingRecipient` (`:98-106`) shares the gap.

**Fix.** Add `if (sink.code.length == 0) revert ZeroAddress();` and `if (sink == address(this)) revert …;` to
`setTokenSink` (and, for consistency, `LockVault.setStakingRecipient`).

---

## Verified clean / positive properties

- **Arrow sidesteps C-2.** The buyout is price-limited at `gradSqrt` and lands `curSqrt == gradSqrt`, so
  `_graduatePull`'s anti-grief nudge (gated `if (curSqrt < gradSqrt)`) is **skipped** — the expensive dust-tick
  tick-walk that bricks a normal sellout-then-graduate never runs.
- **`ArrowLauncher`** — the M1 `preBal` refund isolation, the `_absorbableIn`+1% margin sizing (price limit
  prevents overshoot; margin guarantees arrival), the three sequential (never nested) unlock legs, and the
  zero-residue refund all hold.
- **`ArrowDistributor`** — no-withdraw shape, the L3 balance-clamp, the double-hashed merkle leaf, claim-once
  bitmap; funds only ever reach the leaf `account`.
- **`RobinTokenTreasury`** — `distribute()` idempotency and 70/30 dust conservation; no withdraw path.
- **Token conservation** — the DualStaking claim fee is accounted (not a leak); every currency1 stream is
  accounted. The issues above are invariant/model consistency, not lost funds.

## Pass ledger

| pass | scope | result |
|---|---|---|
| builder (25 agents) | Arrow launcher + distributor | Arrow-M1 + Arrow-L3 fixed; 10 candidates refuted |
| 1 (5 finders) | Arrow + treasury + floor-leak + token-flow | F2 (LOW) confirmed; F1 raised but **wrongly refuted** (false "distinct key" premise) |
| 2 (4 lenses) | arithmetic, composition, re-read, conservation | clean |
| 3 (assume-a-bug) | theft/loss, grief/DoS, seams | **F1 re-confirmed** with the deploy-config evidence |
| 4 (final sweep) | credit accounting, ambush/grad routing | **F3** surfaced (the two facets → the curve `staking` coupling) |

## Sims

Full sim suite green: **33 sim tests pass** (Arrow migration end-to-end, curve economics/graduation/slippage,
presale, lock-staking graduation) plus the F1 demonstrator. No new adversarial sim was needed for F2/F3 — F3 is
proven by reading against `ECON §53`; F2 is a static guard omission.

## Note on the round-3 readiness claim

`AUDIT-ROUND-3-BRIEF.md` states v4 is *"audit-ready now"* with the platform-ETH-only invariant *"tested,
highest-value."* F1 shows that invariant is false as deployed and F3 shows the documented token model is
unachievable on the flagship path. These should be reconciled (code or docs) before the package goes to the
external auditor, or the auditor will find the same gaps against `deploy.js` and lose trust in the brief.
