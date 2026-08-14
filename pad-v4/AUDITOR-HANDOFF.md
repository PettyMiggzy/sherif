# Robin V4 — auditor hand-off: what needs fixing

**This is a findings register plus a remediation ledger.** It is the output of a deep, adversarial audit pass
over `pad-v4/`. The audit itself was report-only; a remediation phase then followed on the same branch. **Every
finding below still reads exactly as it was filed** — none has been softened or deleted because it was fixed.
§0 is the ledger: what has been fixed, in which commit, with which regression test, and what has deliberately
been left alone. Read a finding for the defect and the measurement; read §0 for its current status.

For the scope map, the invariant list, the economic model and the accepted design decisions, read
[`AUDIT-SCOPE.md`](./AUDIT-SCOPE.md) first; this document assumes it. (The previous contents of this file were
a condensed restatement of `AUDIT-SCOPE.md`; it is preserved in git history.)

| | |
|---|---|
| **Scope** | `pad-v4/contracts/**` — all subsystems, including the stock pad that `AUDIT-SCOPE.md` §2 marks informational |
| **Branch** | `claude/ultra-audit-handoff-g6lxrw` |
| **Build** | solc 0.8.26, `viaIR`, optimizer runs 1, EVM cancun — compiles clean |
| **Baseline** | audit pass: `npx hardhat test` → **130 passing**, before and after. After remediation: **185 passing / 6 pending** |
| **Changed by the audit pass** | this file only |
| **Changed by the remediation phase** | 13 contracts, 3 test mocks, 12 new regression suites, 3 companion docs, the runbook + a new wiring-check script — see §0 |
| **Method** | manual review of all 5,335 lines of `contracts/`, plus an adversarial finder/skeptic gauntlet looped to consecutive clean rounds |

`PROVEN` on a finding means a runnable test or an exact numerical evaluation in this pass produced the stated
numbers. §6 has the repro recipes; §4 lists what was checked and found clean, so the next pass doesn't
re-derive it.

---

## 0. Remediation ledger

Everything in this section post-dates the audit. The findings themselves are unchanged; this is only their
status. Each fix carries a regression test that replays the original exploit against the patched contract and
asserts the measured number moved — the tests are named for the finding so the mapping is mechanical.

**Both CRITICALs, all five HIGHs and 15 MEDIUMs are fixed.** The suite is green at 185 passing / 6 pending.

The MEDIUM batch was run differently from the HIGH batch, and the difference is worth knowing when reading it:
each finding was specced against the live code by one agent, then handed to a second agent told to **refute the
proposed fix** — not the finding. Three specs survived untouched. Six came back with blocker or important
problems, and every one of those objections was real: two fixes would have re-opened a finding this document
already contains, one was defeated for 83k gas, one created a deployment DoS, and one asserted away a
behaviour change that turned out to be a genuine trade. Where the corrected fix was still mechanical it was
applied; where the correction turned it into a policy choice it was left, with the reason recorded below.

### Fixed

| id | sev | what changed | commit | regression test |
|---|---|---|---|---|
| **C-1** | CRITICAL | `RobinLockStaking`: pause guard no longer requires a non-zero rate; sub-rate tranches are carried, not scheduled; the mid-window window is floored at `MIN_DRIP_WINDOW`. Attacker's take **100.000000% → 0.000077%**. Closes **I-1(5)** (stranded remainder) and **L-19c** (missing `RewardAdded`) in the same change. | `954e24f` | `test/regression/C1.staking-capture.test.js` |
| **C-2** | CRITICAL | `RobinCurveV4.restoreCeiling` takes a caller-supplied `sqrtPriceLimitX96`, validated above spot and at/below the ceiling, so the walk back can be split across transactions. A full walk that cannot fit in one transaction is now recoverable in bounded segments. | `7b0b3a5` | `test/regression/C2.graduation-brick.test.js` |
| **H-1** | HIGH | `RobinFeeHook.afterSwap` mints the sell fee as an ERC-6909 claim instead of taking real currency, so no reachable state can make collection fail; `claimCreator`/`claimFloor` redeem. Flash-starved sell now taxed **identically to the honest baseline on the same tape**. | `fc28f7f` | `test/regression/H1.selltax-waiver.test.js` |
| **H-2** | HIGH | `StockPadFactory` pins the platform's `stockRegistry` as an immutable and **derives** the curb adapter from (stock, registry) rather than accepting one; `guardWindow` capped at 7 days in the factory **and** in `registerPool`. | `29339d6` | `test/regression/H2.stock-gate.test.js` |
| **H-3** | HIGH | `RobinFeeHook._scheduledEffectiveAt` and all six `StockQuoteAdapter` reads use length-checked low-level staticcalls; flags decode as a word, not as a `bool`. | `b405502` | `test/regression/H3.short-return.test.js` |
| **H-4** | HIGH | `StockPadFactory` refunds the unused stock seed to `msg.sender`, and only this launch's remainder (snapshot-and-delta). **99,900e18 → 0** to the creator. | `1c02825` | `test/regression/H4.stock-seed-refund.test.js` |
| **H-5** | HIGH | `RobinFloorVault.addFloor` requires the tick to have been observed below the band for `MIN_DWELL` and commits at most `MAX_COMMIT_BPS` per `COMMIT_COOLDOWN`. Atomic push→commit→sell-back now commits **nothing**; holding the push for the full dwell yields **20% instead of 100%**. | `9bf789f` | `test/regression/H5.floor-forced-fill.test.js` |
| **M-2** | MEDIUM | `CurvePadFactoryV4` constructor asserts the lock vault's position manager matches the factory's. | `032191e` | covered by the factory suite |
| **M-17** | MEDIUM | `DualStaking.boostOf` uses a length-checked staticcall; `setBoostOracle` requires code. Principal no longer freezes. | `b405502` | `test/regression/H3.short-return.test.js` |
| **M-20** | MEDIUM | `DualStaking._applyReward` floors the scheduling window and parks sub-rate tranches. Tail-staking whale's take of a creator's gift **99.00% → 0.14%**, and arrival timing now buys nothing. | `d85dfeb` | `test/regression/M20.dualstaking-jit.test.js` |
| **M-21** | MEDIUM | `setFloor`/`setAmbush` probe the target with a zero-value call before spending the one-shot. | `032191e` | covered by the curve suite |
| **M-24** | MEDIUM | `setFloorRecipient` rejects the hook itself, and `_payout` refuses a self-send. | `032191e` | covered by the hook suite |
| **M-25** | MEDIUM | `RobinLockStaking.fundTokenPushed` honours `side`/`asset`; `setStaking` probes the sink's stake asset (both `token()` and `tokenAsset()`) and refuses a foreign one. | `d85dfeb` | `test/regression/M25.staking-sink-mismatch.test.js` |
| **M-26** | MEDIUM | `RobinAmbushVault`'s constructor cross-checks its whole `PoolKey` against the curve, not just `gradTick`. | `032191e` | `test/unit/RobinAmbushVault.test.js` |
| **I-1(19)** | INFO | `CurvePadFactoryV4.launch` asserts it is the lock vault's registrar. | `032191e` | covered by the factory suite |
| **M-1** | MEDIUM | `PresaleVault.finalize` sizes the pooled buy to what the freshly-seeded curve can absorb, instead of handing it the whole raise for the hook to tax in full. Measured on a shallow curve with a 3 ETH target: buy tax **0.03 → 0.001301178445995701 ETH**, exactly 1% of what actually swapped. | `ce119fc` | `test/regression/M1.presale-overtax.test.js` |
| **M-9** | MEDIUM | `RobinCurveV4.claimCreator` pays `currentCreator()`, which follows the hook's repointable slot, so a pad's single 2-step repoint governs both creator books. Length-checked staticcall with a masked mload — this sits on a claim path. | `ce119fc` | `test/regression/M9-M27.creator-and-relaunch.test.js` |
| **M-13** | MEDIUM | `DualStaking.fundTokenPushed` and `receive()` pass `extend=FALSE`, so a stranger poking a permissionless relay can no longer re-arm the window and stall the stream. Conservation improves from up to 604,799 units lost per poke to 1. | `608599c` | `test/regression/M13.relay-poke.test.js` |
| **M-16** | MEDIUM | `donateETH`'s "WITHOUT touching the platform cut" corrected at all four sites: the exemption is the deposit only. The accumulator has no per-tranche provenance, so the payout-side promise could not be honoured in code. | `608599c` | covered by the DualStaking suite |
| **M-27** | MEDIUM | All three factories claim the token in `poolOf` at the earliest point `poolId` exists and reject a second launch with `AlreadyLaunched`, so the same salts with a different fee or tickSpacing can no longer open a second pool over a live pad. | `ce119fc` | `test/regression/M9-M27.creator-and-relaunch.test.js` |
| **M-6** | MEDIUM | `ROBIN-V4-ARCHITECTURE.md` carries a divergence table and inline SUPERSEDED / NEVER BUILT markers; the two stale code comments it named (`RobinStateView`'s `totalAssets`, `DualStaking`'s "3-way holder cut") are corrected at source. | `4fe6d2b`, `608599c` | n/a (documentation) |
| **M-7** | MEDIUM | Added `scripts/check-wiring.js` (read-only, non-zero exit if any of the five one-shots is unset), a `DEPLOY.md` §2b for the curve path, and the missing `hook.setFloorRecipient` step in `deploy-curve.js`. | `4fe6d2b` | n/a (runbook) |
| **M-18** | MEDIUM | `ROBIN-V4-CURVE-SPEC.md`'s ambush section rewritten — it described the exact mirror image of what shipped — and the money model's "ambush's pump sales" revenue line corrected. | `4fe6d2b` | n/a (documentation) |

### Deliberately not fixed — product decisions, flagged not taken

These are judgement calls about what the protocol should *be*, not defects with a mechanically correct patch.
They are left for the operator with the finding as written.

| id | why it was left | 
|---|---|
| **M-3** | What `PadFactory` is for relative to `CurvePadFactoryV4` — a scope question, not a bug. |
| **M-5** | Which owner powers to defend against, and how. Changing the trust model is the operator's call. |
| **M-10** | What `MAX_LP_FEE` should be. Any number here is a policy choice. |
| **M-12** | Whether presale terms may move after commitments. A product promise, not a code invariant. |
| **L-25** | Requires re-mined hook addresses — a launch-flow change, not a patch. |
| **H-2 (residual)** | A curated `approvedAdapter` allow-list was **not** added. Pinning the registry achieves the security result without inventing an ops process; the KYC/geo and issuer allow-list gates the contract documents remain off-chain launch gates, as it already says they are. |
| **M-4** | The proposed fix cross-checked the floor vault's anchor against live spot at deploy. Its skeptic showed that converts a benign, self-healing runtime state into a hard revert on a one-shot irreversible wiring path — a cheap, repeatable DoS on floor-vault deployment. Making the anchor verifiable without that needs a decision about what the anchor should be bound TO (the pad's launch tick? the curve's gradTick? a factory-stamped value?), which is a design choice, not a patch. |
| **M-14** | Moving the five one-shot wiring setters off `platformFeeWallet` and onto the registry's `owner()` is mechanically safe — the skeptic verified the substitution and could not break it. It is left because it relocates a **per-pad, time-critical** capability onto the root cold key. That either slows every launch to multisig cadence, or requires inventing a `padAdmin` hot role — a change to the trust model, and the operator's to make. The finding's core observation stands as written: `platformFeeWallet` is today the protocol's root admin key, not merely a payout address, and should be documented and held as such. |
| **M-15** | The proposed fix let `addFloor` choose its band from a live `getSlot0` read. That is exactly what `[audit L1]` forbids and what **H-5** was just fixed to stop, so shipping it would have re-opened a HIGH. Letting the floor deepen during a drawdown needs a second band or a moving anchor — a change to what the floor IS, and it must be designed against M-15, H-5 and L-33 together, since all three are the same guard read three ways. |
| **M-22** | The proposed `recommit` is sealed shut by the exact terminal state M-22 measures (`Failed(3)`), and an adversary holding the burned preimage can force that state for ~83k gas, winning a race the creator can only enter afterwards. The skeptic's workable alternative — gate `finalize` on `cfg.creator` — narrows the deliberate "permissionless among preimage-holders" property and must land together with **L-20**'s finalize deadline, or the perpetual option becomes *renewable and exclusive*. Both are presale-terms decisions. |

### Not yet addressed

**M-8** is largely closed as a side effect: fixing `MockPositionManagerV4`'s action-batch assumption made the
`StockPadFactory` launch path executable, and the H-2 and H-4 regression suites now execute it. What remains of
it is breadth of coverage, not reachability.

**M-19** is a process finding whose remediation is the regression suites themselves. Of the six adjacency gaps
it tabulates, four are now closed by name: the short-return case `try/catch` cannot absorb (H-3/M-17), C-2's
tick *breadth* as distinct from depth, `LockVault.setFactory`'s target as distinct from its one-shot (M-2), and
the floor guard's park→commit flip (H-5). The two that remain are the ones it ties to **M-10** and **M-12**,
both of which are on the product-decision list.

Everything else in §3 — 4 remaining MEDIUMs, the LOWs and the I-1 bundle — stands as filed and has not been
touched. Nothing in that set is a CRITICAL or HIGH.

### Notes for the next reader

Three things the remediation phase turned up that are worth knowing before you read the findings:

- **`MockPositionManagerV4` modelled only the ETH curve's 3-action batch** and indexed `params[2]`
  unconditionally. `StockPadFactory` sends two actions, so the stock launch path reverted inside the mock and
  had never been exercised by any test at all. Fixed in `1c02825`. This is the same defect class as **M-8**.
- **Several existing tests encoded the bugs as intended behaviour** and had to be corrected alongside the
  fixes, not merely re-run: `RobinLockStaking.test.js` asserted the stranded dust of **I-1(5)** was zero;
  `RobinFeeHook.skim.test.js` and `economics.sim.test.js` asserted **H-1**'s take-based collection; two floor
  tests asserted **H-5**'s immediate full commit. Each is now a stronger assertion, not a weaker one.
- **Hardhat keeps chain state across test files.** The regression suites snapshot and restore, because C-2's
  setup alone spends enough ETH to starve later files of gas money.

---

## 0b. Remediation round 2 — external-audit follow-up

After the external auditor's pass (the fixes recorded in §0 above), a second remediation round ran on
`claude/robinhood-chain-website-8loxcm`: (1) every one of the auditor's fixes was **adversarially re-verified**
(a finder specced the fix, a skeptic was told to find a bypass / incomplete patch / regression / weakened test),
and (2) the still-open LOW/MEDIUM findings were triaged and the mechanical + doc ones fixed. Suite: **193
passing / 6 pending**, green.

### Re-verification of the auditor's fixes — 20 checked, 13 SOLID

Five fixes were code-correct but had **no negative regression test** (deleting the guard left the suite green).
Backfilled this round so an accidental future removal is caught by CI:

| finding | the fix (still correct) | new negative test |
|---|---|---|
| **M-2** | `launch()` reverts `NotRegistrar` when the LockVault's registrar ≠ this factory | `test/regression/M2-I19.factory-guards.test.js` |
| **I-1(19)** | ctor reverts `LockVaultMismatch` when factory PM ≠ LockVault PM | `test/regression/M2-I19.factory-guards.test.js` |
| **M-21** | `setFloor`/`setAmbush` reject a non-receiving contract (`EthSendFailed`) | `test/unit/RobinCurveV4.grief.test.js` (`[M-21]`) |
| **M-24** | `setFloorRecipient(hook)` reverts; `_payout` refuses a self-send | `test/unit/RobinFeeHook.adversarial.test.js` (`[M-24]`) |
| **M-26** | ambush ctor cross-checks all five PoolKey fields vs the curve | `test/unit/RobinAmbushVault.test.js` (`[M-26]`) |

Two fixes were judged **INCOMPLETE** — real residuals, surfaced as design decisions (below), not silently closed:

- **H-2 INCOMPLETE.** The registry is pinned, but the securities check still self-certifies from the STOCK
  side: `IStockRegistry` exposes only `paused()/isBlocked()`, no membership query, so a fake stock that returns
  the (public) pinned registry address passes the gate and the freeze primitive is fully restored. Closing it
  needs the registry to *attest the stock* (a new interface method + a gate on it). Stock pad has no live
  surface today — left as a design decision.
- **H-5 INCOMPLETE.** `MIN_DWELL` is observation-gated, not duration-enforced: `belowSince` is only reset by an
  above-band poke that nothing forces, so two momentary pushes `MIN_DWELL` apart satisfy the dwell check and the
  carve drains 20%/`COMMIT_COOLDOWN` indefinitely. The griefing mode survives. Must be redesigned together with
  M-15 (floor idles in a drawdown) and L-33 — see design decisions.

### Open findings fixed this round (mechanical + doc)

| id | class | what changed |
|---|---|---|
| **M-4** | mech | `setFloorRecipient` requires the recipient to be a contract (`code.length > 0`) — matches the other four sink setters; an EOA floor target would strand the sell-tax carve. |
| **M-11** | mech | `LockVault.claimStaking` PARKS (`NoStakingRecipient`) while the staking recipient is unwired instead of silently paying the platform; the accrual survives and pays the real recipient once wired. |
| **M-22** | mech | `PresaleVault.finalize` checks the reveal FIRST (a wrong-salt poke can't leak a real preimage); header trust-model comment corrected. |
| **L-1** | mech | `CurvePadFactoryV4.launch` computes the ETH the `[gradTick,startTick]` position yields for `curveSupply` and reverts `BadGeometry` below `MIN_RAISE_WEI` (1e15) — a too-high `startTickMag` no longer truncates the raise to ~0 and bricks `graduate()`. |
| **L-2** | mech | `DualStaking.fundTokenPushed` is now permissionless (measured-delta accounting; a stranger can only credit already-transferred tokens) — the old rewarder gate broke `flushStaking()`'s documented recovery. `fundToken`/`fundETH` keep their gate. |
| **L-4** | mech | `_decodeReferrer` matches only an intentionally-encoded referrer (`length == 32` + high-12-bytes-zero), so an aggregator payload can't silently name a pseudo-random referrer and strand the carve. |
| **L-5** | doc | Corrected the stale buy-tax "buffer → LP/staking" comments (it routes to the PLATFORM at graduation) and the "bps of token output" mislabels (the buy tax is a money-side fee-on-INPUT) across `RobinV4FeeConfig`, `CurvePadFactoryV4`, `RobinFeeHook`, `IRobinInterfaces`, `PadFactory`. |
| **L-6** | mech | `deploy-curve.js` requires `PLATFORM_WALLET` (no silent default to the hot deploy key); `DEPLOY.md` lists `RobinV4FeeConfig` as multisig/timelock-critical. |
| **L-8** | mech | The anti-grief nudge's ETH (swap proceeds from third-party planted liquidity below the ceiling) is captured and EXCLUDED from the measured raise; it falls through to the platform sweep. |
| **L-10** | mech | `DeterministicDeployer.deploy` rejects value sent on the adopt branch (`ValueOnAdopt`) instead of locking it. |
| **L-11** | mech | `RobinFloorVault` resolves the platform sink LIVE from the timelocked registry at every use (mirrors LockVault/RobinFeeHook), so a wallet rotation reaches an already-deployed floor vault. |
| **L-12** | mech | `PresaleVault.finalize` requires `MIN_FINALIZE_GAS` before the launch and bubbles an EMPTY-revert (out-of-gas) instead of irreversibly burning a funded presale to `Failed(3)`; only a typed launch-collision → `Failed(3)`. |
| **L-13** | mech | The `Failed(2)` escape hatch (and finalize's upper bound) are anchored to `filledAt` (when the raise closed), not the deadline — an early-filled raise's contributors aren't locked until a far-off deadline+grace. |
| **L-15** | doc | Hook-flag literals corrected `0x00C4 → 0x00CC` across `ROBIN-V4-ARCHITECTURE.md`, `DEPLOY.md`, and a fork-test title (`BEFORE_SWAP_RETURNS_DELTA 0x08` was missing from the decomposition). |
| **L-16** | mech | `ready()`/`graduate()` gate on the SQRT PRICE, not the tick, closing the `tick == gradTick && spot > gradSqrt` window that let the permanent LP seed above the ceiling. |
| **L-17** | mech | `RobinAmbushVault` requires a non-zero `stakingRecipient` at deploy (add-only vault, no setter — a 0 sink would strand token-side fees forever). |
| **L-18** | mech | `RobinFloorVault`/`RobinAmbushVault` pre-realize accrued fees (zero-liquidity poke, routed like the collect path) BEFORE a positive add, so the fee destination no longer depends on whether the add or the collect lands first (a 1-wei donation could otherwise divert it). Guarded on liquidity > 0 (empty-position poke reverts). |
| **L-20** | mech | `PresaleVault.finalize` expires at `filledAt + finalizeGrace` (`AfterDeadline`), so finalize and the `Failed(2)` hatch are never both live. |
| **L-21** | mech | `PresaleVaultFactory.createPresale` re-runs the five pure-cfg `BadConfig` checks up front; `PresaleVault.initialize` rejects `minContribution > perWalletCap` (else every deposit reverts). |
| **M-14, M-5, M-10, M-12, M-15** | doc | Honesty corrections landed regardless of the (still-open) design decisions — see below. |

### Honesty-doc corrections (unconditional — the statements were false)

- **M-14** `FeeWalletRegistry`/`DEPLOY.md`/`AUDIT-SCOPE.md §6`: `platformFeeWallet` is the protocol ROOT ADMIN
  key (authorizes every per-pad wiring setter), not merely a payout address.
- **M-10** `RobinV4FeeConfig` header/`DEPLOY.md`/`AUDIT-SCOPE.md §3`: `lpFee` is a second, effectively-uncapped
  take (capped only at Uniswap's 100%); `setDefaults` is a real un-timelocked knob, not a forward-only default.
- **M-12** `RobinV4FeeConfig` header: "can never touch an existing coin" is false for ETH already in an OPEN
  presale (geometry is read live at finalize).
- **M-5** `AUDIT-SCOPE.md §6`/econ doc: the `DualStaking` owner CAN reach user principal/rewards (retroactive
  `antiJitDelay`/`platformClaimFeeBps`) — "only its own cut, never user principal" was false on this path.
- **M-15** `RobinFloorVault` header/`AUDIT-SCOPE.md §4.4`: the floor is a FIXED band deepened while the token
  trades ABOVE it — it does not "only ever deepen"; in a drawdown the carve parks.

### Design / product decisions — DRIVEN this round (operator can still override)

The operator asked to drive all of these; resolved with governed defaults + adversarial self-verification:

- **M-3 / L-27 — RESOLVED (governed).** `PadFactory.launch` now enforces the curve path's ceilings: buy/sell tax
  ≤ 2%/side, floor share ≤ 50%, static fee ≤ 1% (`M3.padfactory-caps.test.js`). Recipients stay launcher-chosen
  (inherent to "the creator earns the sell tax"), documented not gated.
- **M-10 — RESOLVED.** `RobinV4FeeConfig.MAX_LP_FEE` = 1% (`10_000`); production lpFee passes at the boundary.
- **M-5 — RESOLVED (partial, as designed).** antiJitDelay is snapshotted at stake — a raise can no longer
  retroactively lock principal. The `platformClaimFeeBps` skim of already-accrued rewards remains (bounded by
  `MAX_CLAIM_FEE_BPS`); snapshotting fee-at-accrual is more invasive and left as a further operator option.
- **M-12 — RESOLVED.** PresaleVault snapshots geometry at initialize; `finalize` reverts `GeometryChanged` on a
  mid-presale retune (fails safe → 100% refunds).
- **H-2 — RESOLVED (conditional).** `IStockRegistry.isRegistered(stock)` added and gated fail-closed in the adapter
  ctor, so a fake stock pointing at the real registry is rejected unless the registry ATTESTS it
  (`H2.stock-gate.test.js` residual test). **Depends on the real Robinhood stock registry exposing `isRegistered`;
  until it does, the stock pad stays disabled** (fail-closed — no live stock path today).
- **M-14 — LEFT to the operator.** `platformFeeWallet` remains both payout + root-admin (honesty-doc corrected).
  Splitting the wiring role onto a separate hot `padAdmin` needs the operator to decide WHO holds that key — an
  operational call, not something to invent. No code change.
- **M-15 / H-5 / L-33 — INTERIM HARDENING SHIPPED; full redesign REFUTED → TWAP.** See `FLOOR-REDESIGN.md`. The
  natural "place add-only bands below spot" redesign was drafted and put through an adversarial gauntlet, which
  **broke it** (a fully-atomic sandwich: flash-push the tick down, poke to place the ETH band just below true price,
  sell back through it to sweep its ETH at above-market prices — worse than the shipped interim hardening). That is
  the FOURTH refuted attempt on this surface. The doc pivots to the only survivor — a TWAP-gated commit (likely just
  gating today's fixed-band commit on a TWAP tick) — and recommends the external auditor review it before build.
- **Still open for the operator/auditor:** **L-3** (leftover reserve if staking never wired), **L-14** (anti-JIT
  forfeit is claim-before-unstake dodgeable), **L-25** (untaxed sibling pool), **L-32** (two staking one-shots).

### Deferred mechanical (with rationale — revisit post-audit if the operator wants)

- **L-9** (bind `cfg.creator` into the CREATE2 pre-image) — impact is REFUTED (negative-EV grief, no gain) and
  the change touches `PadToken` (shared by 3 factories) + ~15 off-chain salt miners; not worth the churn/risk
  right before external re-audit.
- **L-24 (mech)** / **L-26** — touch the NFT-acceptance and the hot swap path respectively; deferred to avoid
  graduation/swap regression risk on LOW findings. **L-29**, **L-30/L-31** (stock, not live), **L-19** (event
  logs) — low value / design-gated.

### Round-2 SELF re-audit (adversarial gauntlet over the round-2 changes)

The round-2 changes above were then put through a 13-agent adversarial gauntlet (one skeptic per substantive fix
told to find a bypass/regression/underflow/reachability break, plus three holistic sweeps). Outcome: **9 SOLID,
1 NIT, 3 PROBLEMs — all 3 addressed**:

- **L-2 (medium, a REGRESSION the round-2 fix introduced) — FIXED.** Making `DualStaking.fundTokenPushed` fully
  permissionless let a stranger name the `side` for an asset listed on BOTH sides ("earn the other"),
  misattributing that asset's parked LP-fee delta to the wrong book (theft of reward attribution between stakers;
  `accountedReserve` is per-asset, `side` is caller-asserted). Fix: require the rewarder gate ONLY when the asset
  is dual-listed; single-listed stays permissionless (the `flushStaking()` recovery path is unaffected).
  Test: `DualStaking.adversarial.test.js` `[re-audit/L-2]`.
- **L-21 (low) — FIXED.** The hoisted pure-cfg checks missed launch's 6th unconditional reject, `tickSpacing <= 0`.
  Added to `createPresale`. Test: `presale.sim.test.js` bounds test.
- **H-5 (HIGH, re-confirmed by the floor sweep) — INTERIM HARDENING + OPEN.** The shipped `MIN_DWELL` guard is
  bypassable: `belowSince` is poke-observed, so a value left over from a prior healthy period is STALE, and after
  an un-poked dump an attacker force-fills the carve off it — the dwell contributes nothing. Interim fix
  (`MAX_OBSERVED_GAP` restarts a clock stale by >1h) closes the atomic WHOLE-CARVE fill and the >1h-stale replay
  (test `[re-audit/H-5]`), and the code's false "cannot be atomic" claim was corrected. A self-verification pass
  then caught that the first-cut comment still over-claimed, and it was corrected to the accurate residual: a
  BOUNDED slice (≤`MAX_COMMIT_BPS`) can still be force-committed off a ≤1h-stale `belowSince` in a single cheap tx
  (~2× pool fee per commit, no arbitrage cost), draining the carve over ~`1/MAX_COMMIT_BPS` commits. **Full closure
  is the floor redesign (M-15/H-5/L-33), the top open design decision — see the "Open — design / product decisions"
  list above and AUDIT-SCOPE §5.**


---

## 0c. Fee-model round — the platform takes ETH only, never holds pad tokens

Operator directive: *"Platform wants no tokens at all — if there's something in the code that gives it token supply, change it."* A full-system sweep for platform-token inflows (every `poolManager.take(currency1, …platform…)` / token transfer to `platformFeeWallet()`, across the hook, curve, both support vaults, and `LockVault`) found the model already ETH-only **except one live leak**, now closed:

- **`RobinFloorVault` (LEAK — FIXED).** Once spot trades into the floor band the single-sided ETH wall holds token, so its LP position accrues **token-side (currency1) fees**, and `_collect()` routed them to `platformFeeWallet()` (plus a defensive stray-token route in `_add`). Both now route the token leg to `address(this)` (**park in-vault**); a one-shot, platform-wired `tokenSink` + permissionless `sweepTokenFees()` forwards the parked token to the pad's staking / buyback pool (mirrors `hook.setFloorRecipient` / `LockVault.setStakingRecipient`; wired in `scripts/launch.js` step 5b). The **ETH leg still goes to the platform** — platform stays ETH-only. Test: `RobinFloorVault.test.js` `[fee-model]` asserts the treasury's token balance is *exactly* unchanged across a collection, and that the parked token only ever forwards to the wired sink.
- **`LockVault` (already correct; doc was stale — FIXED).** Token-leg (sell-side) LP fees already route to the staking recipient, and [M-11] already made an unwired recipient **park + revert** rather than fall back to the platform. The header comment still claimed the old "falls back to platform" behavior — corrected. `claimPlatform(_,1)` is unreachable (only `platformOwed[_][0]` is ever funded).
- **Hook / curve / ambush (verified clean).** Both trade taxes are money-side (currency0); the curve holds token fees → `fundTokenPushed` at graduation; the ambush vault forwards token → staking. No platform-token path.

**Invariant added:** *the platform wallet's pad-token balance is always exactly zero* — every token-denominated fee stream terminates at staking / buyback, never the treasury. Recorded in `ROBIN-V4-CURVE-ECON.md §5`.

**Still open (operator/design — deferred to the "when I'm home" conversation, NOT built):** the ETH-side LP split (curve phase is 80% platform / 20% floor today; "100% platform" is a config flip `buyLpFloorShareBps=0` that needs the floor re-funded elsewhere first), the token-leg staking-vs-buyback **split %**, and the creator-triggered **burn pool** contract (creator decides when to burn, pays gas). These are economics decisions, not leaks.

---

## 1. Summary

| severity | count | of which measured |
|---|---|---|
| **CRITICAL** | 2 | 2 |
| **HIGH** | 5 | 5 |
| **MEDIUM** | 26 | 13 |
| **LOW** | 34 | 17 |
| **INFO** | 24 (20 bundled as I-1, plus I-2 … I-5) | 3 |
| **total** | **89** | **39** |

§3 records a further set of plausible defects that were chased and did **not** survive verification, with the
disproof for each, so the next pass does not re-spend budget on them.

**Two IDs are deliberately vacant.** `M-23` was promoted to **H-5** and `M-28` demoted to **L-35** when later
evidence changed their severity; `L-34` was demoted into the **I-1(19)** bundle. The IDs are not reused, so a
reference to a vacated number in an older copy of this document still resolves unambiguously.

**How this was run, and where the loop stands.** The brief was to keep auditing until three consecutive passes
turn up nothing, so each pass is a distinct lens over the whole suite rather than a re-read. A pass counts as
**clean** only if it adds no finding *and* changes no existing finding's severity or substance; consolidation
and wording edits do not count either way.

| pass | lens | result |
|---|---|---|
| 1–3 | subsystem × attack-surface finders, each finding put to independent skeptics instructed to refute | not clean — C-1, C-2, H-1…H-3 and most of the MEDIUMs |
| 4 | the four contracts the register had barely touched: `BaseHook`, `FeeWalletRegistry`, `RobinLpVault`, the hook's claim-redemption path | not clean — 2 INFO |
| 5 | toolchain (`solc` advisories) and test-coverage-vs-stated-invariants | not clean — **I-5**, **M-19** |
| 6 | generalize each finding to hunt its siblings: short returns, one-shot targets, unbounded loops | not clean — six more short-return sites, the one-shot table, 1 INFO |
| 7 | netted fee deltas, owner-power retroactivity, park guards | not clean — 1 INFO extended; two lenses returned clean negatives |
| 8 | rounding direction across every division in the suite | claimed clean — **later refuted, see pass 11** |
| 9 | all 128 permissionless entry points, each asked what a stranger's worst-timed call does | claimed clean — **later refuted, see pass 11** |
| 10 | every balance-derived quantity, checked for an omitted liability — the seam L-18 and I-1(11) sit in | **clean — and the only one that survived pass 11's refutation attempt**, which returned UPHELD with no findings and strengthened it |
| 11 | agents pointed at passes 8–10 and told to **refute** them, rather than at the code; plus fresh lenses on events, timestamps and the presale | not clean — **M-20**, **M-22**, **L-19**–**L-22**, I-1(12)–(16), and corrections to **C-1**, **L-9**, **I-1(1)** and §4 |
| 12 | the two gaps §5 admits were never swept — cross-pad singletons and the PadFactory stack — plus the fee hook audited as a whole | not clean — **M-24**, **M-27**, **L-24**–**L-29**, I-1(17)–(18); §4's book-conservation claim attacked and **upheld** |
| 13 | the stock-pad path, made executable by building an action-dispatching PositionManager mock **outside** the repo (M-8's blocker) | not clean — **H-4** (99.9% of a payer's seed), **L-30**, **L-31** |
| 14 | the partial-wiring **matrix** — which setters are set at each lifecycle stage, and which *combinations* are harmful | not clean — **L-35** (filed M-28), **L-32**, **L-33**; corrections to **M-21** and **M-11** |
| 15 | four independent constructions of the floor-vault attack, each followed by a skeptic, to settle **H-5** | not clean — **H-5** promoted from MEDIUM, and its **mechanism corrected** |

Clean passes are counted in §4 as they land; each one's negative result is written down there so a later pass
does not re-derive it.

**The count stands at zero, and that is the most useful thing on this page.** Passes 8, 9 and 10 were
recorded as three consecutive clean passes — the stopping condition. Pass 11 then pointed agents at *those
conclusions* instead of at the code, with instructions to refute them, and **two of the three fell**:

- pass 9's "every permissionless entry point is either already a finding or safe" missed `donateETH`, the one
  funding path that is both un-gated and passes `extend = false` → **M-20**, which also **corrects C-1**;
- pass 8's "every division was checked" covered 20 of 32 sites, and its "only place where floor-and-forget
  strands value" was wrong → I-1(12). The *conclusion* survived re-checking; the claim of exhaustiveness did not.

Both surviving items are corrections to assertions made in this document, which is the outcome worth taking
seriously: the clean passes were not wrong about the code so much as overconfident about their own coverage.

**Passes 12–15 then made the point again, harder.** Every one of them found something, and four produced
corrections to entries already filed here — **C-1**, **M-11**, **M-21**, **L-9**, plus **H-5**'s mechanism and
two §4 assertions. The pattern is consistent enough to be the main methodological finding of this audit:

> **Passes aimed at the code found bugs. Passes aimed at *this document's conclusions* found errors in the
> conclusions.** Six of the eight self-corrections came from a pass whose brief was to attack a claim rather
> than a contract — and in the sharpest case (**H-5**) the original claim was right about the magnitude,
> right that a bug existed, and **wrong about the cause**, which is exactly the combination that produces a
> fix that does not work.

An auditor picking this up should assume the same is true of what remains: the findings have been attacked
harder than the negative results in §4, and §4's bullets are labelled individually by whether they have
survived a refutation attempt or merely been asserted.
Pass 10 was challenged the same way and **held** — the refuter re-derived it from source, returned UPHELD with
no findings, and closed a regime gap the original had missed (the band-geometry mint slack, 252,000 samples).
That is the difference between a pass that was verified and two that were merely asserted. The gauntlet that
produced passes 1–3 is also still
executing its rounds 4 and 5. This document is the register, not a snapshot — anything that survives lands here
and the count restarts from zero.

---

## 2. The pattern worth reading first

Individually these contracts are careful. The money-conservation core is sound — buy books balance their
ERC-6909 claims exactly, sell books balance their `take`s exactly, and the v4 delta plumbing is correct in
both directions (§4). The exposure is not in the arithmetic. It is in the seams:

> **Almost every high-impact item here is a wiring or parameter defect that is silent at launch and only
> becomes visible after a pad has taken real money.** `LockVault.setFactory`, `RobinFloorVault`'s `anchorTick`,
> `RobinCurveV4.setStaking`, `RobinFeeHook.setFloorRecipient`, `StockPadFactory`'s `adapter` and `guardWindow`,
> `RobinAmbushVault`'s `stakingRecipient`, and `RobinV4FeeConfig`'s geometry bounds are all one-shot or
> immutable, all accept values no contract validates, and all fail *late*.

Every one of those parameters is hand-typed in an out-of-band deploy step with no script and no on-chain
assertion (L-7). That single root cause is cheaper to fix once — scripted deployment plus a handful of
`require`s at launch — than five times downstream.

---

## 3. Findings

### C-1 · CRITICAL · Three wei arms a trap that takes 100% of a pad's staking reservoir — 9.7% of total supply  `PROVEN (×3)`

> **STATUS: FIXED** in `954e24f` · regression test `test/regression/C1.staking-capture.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/RobinLockStaking.sol:222-231` (`_startDrip`), `:135-139` (the empty-pool pause guard
in `withdraw`), `:114-118` (`stake`'s pending flush), `:205` (`_accrueReward`'s park branch).

**What is wrong — two defects that compose.**

*(a) The drip compresses.* `_startDrip`'s mid-window branch deliberately holds `periodFinish` fixed:

```solidity
} else {
    uint256 remaining = periodFinish - block.timestamp;
    uint256 leftover  = remaining * rewardRate;
    rewardRate = (amount + leftover) / remaining; // drip over the remaining window; periodFinish unchanged
}
```

The `[audit]` comment above it explains this stops dust-funding from stretching the window forever. Sound —
but as `block.timestamp` approaches `periodFinish`, `remaining` → 1, so **any tranche credited near the end of
a window is paid out within one second**.

*(b) The empty-pool pause cannot clear a zero-rate window.* `withdraw`'s guard is

```solidity
if (totalStaked == 0 && rewardRate > 0 && periodFinish > block.timestamp) { ...bank and pause... }
```

`rewardRate` is `amount / rewardsDuration`, which **truncates to 0** for any tranche below `rewardsDuration`
(2,592,000 wei at the 30-day default). So a 2-wei funding creates a live 30-day `periodFinish` with
`rewardRate == 0`, and because the guard requires `rewardRate > 0`, emptying the pool does **not** clear it.
The window survives as a zombie, with an expiry the attacker chose.

**The attack.** Total cost: **3 wei and gas.** Armed at pad launch, before any honest user exists.

1. `fund(2)` — pool is empty, so it parks in `pendingRewards`.
2. `stake(1)` — flushes it through `_startDrip(2)`: fresh window, `rewardRate = 2 / 2592000 = 0`,
   `periodFinish = now + 30 days`.
3. `withdraw(1)` — pool empties. The pause guard is skipped (`rewardRate == 0`), so `periodFinish` stays
   30 days out. **Walk away.**
4. Over the next 30 days the pad funds real holder rewards. With the pool empty they all park in
   `pendingRewards` (`_accrueReward`'s `totalStaked == 0` branch) — the whole reservoir, untouched.
5. At `periodFinish - 2`, `stake(1)`. `stake` flushes `pendingRewards` through `_startDrip`, which takes the
   **mid-window** branch because `block.timestamp < periodFinish` — with `remaining == 2`.
6. One second later, claim.

**Measured at real production geometry** — startTickMag 201600 / curveWidth 23000 / ts 100, 1B supply at
730M curve + 270M reserve, buy/sell tax 100 bps, waterfall 10/10/5 — driven through the actual
`CurvePadFactoryV4` + `RobinFeeHook` + `LockVault` stack, not a toy harness:

| | |
|---|---|
| attacker's capital | **0.001 ETH** of dust-buy (557,164 tokens) **+ 3 wei** to arm |
| reservoir at stake — the graduation leftover streamed to staking | **96,978,138 tokens = 9.70% of the entire 1B supply** |
| after `fund(1)` | `rewardRate` 0, `periodFinish` = now + 2,592,000 |
| after `withdraw(1)` | `totalStaked` 0, `rewardRate` 0, `periodFinish − now` = 2,591,999 — **pause skipped** |
| attacker `stake(1)` in the tail | `rewardRate` **48,489,069 tokens/sec**, `remaining` 2 s |
| **attacker claimed** | **96,978,138 tokens — 100.00% of the reservoir** |
| honest staker (500 tokens, staked 10 days later) | **0.000000** |
| `balanceOf == totalStaked + rewardsBalance` | holds throughout — the accounting invariant never trips |

That reservoir is not incidental. The reserve is 270M and the permanent LP absorbs only ~173M of it, because
the ETH leg binds by construction (see §4), so a large surplus is **structural and predictable on every pad**.
The sell-side token LP-fee stream then keeps feeding the same reservoir and parking in the same
`pendingRewards` while the pool is empty, so the take *grows* with time-to-first-staker.

**The landing zone is wide, not a single block.** Any position in the tail pays out the full reservoir over
`remaining` seconds — at `remaining = 600` the whole reservoir lands in ten minutes — so the attacker
schedules it rather than sniping it. Overshooting is not even a failure mode: past `periodFinish` the fresh
branch simply drips 100% of the parked reservoir to the same sole 1-wei staker over 30 days, still to the
exclusion of everyone who stakes later.

**Precondition, stated plainly.** The attacker must be the **first staker after arming** — the pool must stay
unstaked from the arm (pre-graduation) through the tail of the zombie window. That is a real narrowing, and it
does not reduce the severity, for two reasons. First, arming costs 3 wei plus gas and can be done on *every*
pad the launchpad produces, so the attacker only needs the subset that sit unstaked — and a fresh per-pad pool
is empty by construction until graduation. Second, **in the branch where an honest staker arrives first, the
bug still fires**: whoever stakes first inside the zombie window captures a compressed drip of the entire
reservoir, and every later staker earns exactly zero. The holder-staking product is broken regardless of who
wins the race, and the contract's headline guarantee at `:14-15` — *"a whale can never drain the pool in one
block and the reservoir lasts"* — is false in both branches.

**Root cause, precisely.** Three lines, each individually defensible: `_startDrip`'s fresh branch (`:224-225`)
sets a live `periodFinish` while `rewardRate` truncates to 0 for any tranche below `rewardsDuration` wei; the
pause at `:135` conditions on `rewardRate > 0` rather than on `periodFinish > block.timestamp` alone, so that
window survives an empty pool; and `stake`'s flush (`:113-117`) then routes the parked reservoir through
`_startDrip`'s mid-window compression instead of a fresh full window.

**A second, independent path to the same compression** (no zombie window needed): wait for any legitimate
window's end, stake large, and credit a tranche yourself. Every step is permissionless, and the attacker can
manufacture the tranche out of the pad's own LP fees —
`LockVault.collectFees(tokenId)` (`core/LockVault.sol:107`, permissionless) books the locked graduation LP's
token-side fees, then `LockVault.claimStaking(tokenId, 1)` (`:143`, permissionless) forwards them to the
staking pool with a plain `_payout` ERC-20 transfer and **no `fundTokenPushed` poke**, leaving an uncredited
pile the attacker credits at a moment of its choosing. (`RobinCurveV4._fundStaking` and
`RobinAmbushVault._forwardStaking` both poke; `LockVault` is the one push path that does not.) Measured at
1000× the honest pool: whale earns 499,500.5 of a 500,000 tranche, pays the 100,000 penalty, nets
**+399,500 tokens in ~2 blocks**.

Both contradict the contract's own guarantee (`:14-15`: *"rewards stream out of a finite reservoir at a
bounded `rewardRate` (Synthetix drip), so a whale can never drain the pool in one block"*) and
`AUDIT-SCOPE.md` §3.

**The sibling contract gets the important half right — on the path that matters here.** `DualStaking` has the
same zero-rate hole in its pause guard (`pads/DualStaking.sol:206` — `if (r.rewardRate > 0 && r.periodFinish >
r.lastUpdateTime)`), but its *stake* path is safe: `stake` → `_kickstartPending` →
`_applyReward(side, asset, amt, true)` (`:233`), and `extend == true` takes the fresh-window branch, so parked
rewards always get a full `duration` no matter what state the old window was in. `RobinLockStaking.stake`
(`:112-117`) instead calls `_startDrip(p)` directly, which falls into the mid-window branch whenever a stale
`periodFinish` is still live. That difference is what makes the *stake-flush* step of this exploit specific to
`RobinLockStaking`.

> **Correction.** An earlier revision of this paragraph read "that one difference is the whole exploit" and
> treated `DualStaking` as clear of the class. That was too strong, and a later pass broke it. Enumerating all
> six `_applyReward` call sites, **two pass `extend = false`** — the forfeit recycle (`:321`) and `donateETH`
> (`:404`) — and `donateETH` is also the only funding entry point with no `isRewarder` gate. `DualStaking` is
> therefore exposed to both halves of C-1's mechanism through that one function: window compression, and 1-wei
> arming of a zero-rate window. See **M-20**, which measures both.

**Fix direction.** All four are worth doing; the first two are the actual fix.
- **Floor the drip window.** Never let a tranche pay out faster than a minimum duration: cap
  `rewardRate` at `undrippedReservoir / MIN_DRIP_WINDOW`, or run two parallel schedules so a late top-up gets
  its own full window without extending the existing one (this keeps the anti-dust property the `[audit]`
  comment was protecting).
- **Fix the pause guard.** Drop the `rewardRate > 0` condition — pause whenever
  `totalStaked == 0 && periodFinish > block.timestamp`, so a zero-rate window cannot survive an empty pool.
- **Reject sub-rate tranches.** Require `amount >= rewardsDuration` in `_startDrip`'s fresh-window branch (or
  carry the remainder), so a tranche can never truncate to `rewardRate == 0` in the first place. This also
  fixes the dust-stranding in I-1(5).
- **Close the easiest setup:** have `LockVault.claimStaking` poke `fundTokenPushed` at transfer time, exactly
  as the curve and ambush vault already do.

---

### C-2 · CRITICAL · 100 wei of dust liquidity pushes `graduate()` *and* `restoreCeiling()` past the block gas cap, trapping the whole raise  `PROVEN`

> **STATUS: FIXED** in `7b0b3a5` · regression test `test/regression/C2.graduation-brick.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/RobinCurveV4.sol:540-556` (`_graduatePull`'s ceiling nudge) and `:582-590`
(`_restore`). Neither takes a caller-supplied intermediate price limit, so neither can be split across
transactions.

**The setup is the ordinary sellout, not an attack.** A trader buying the curve out with the router-default
`sqrtPriceLimitX96 = MIN_SQRT_PRICE + 1` slides spot all the way to the floor, because below `gradTick` there
is no liquidity and v4's swap loop walks the price for zero input. **Verified independently:** after a normal
sellout the tick is **−887272**, `ready()` is `true`, and the nudge must therefore walk back **890,272 ticks**
to reach `gradTick`. Baseline `graduate()` costs **1,217,937** gas — the empty walk is cheap because v4 skips
uninitialized ticks a bitmap word at a time.

**The attack is to make that walk expensive.** Every *initialized* tick the swap crosses costs real gas, and
initializing one is nearly free when spot is far below it:

| | measured |
|---|---|
| attacker plants 100 positions of `liquidityDelta = 1`, one per 60-tick band below `gradTick` | **1 wei each — 100 wei total** (currency0-only, spot is far below) |
| attacker's gas, spread over 100 unbounded transactions | 16,116,942 total, ~161k each |
| **`graduate()` afterwards** | **33,767,571 gas** — over the 30,000,000 block cap, **reverts forever** |
| **`restoreCeiling(bag)`, the documented recovery** | **31,776,972 gas** — also over the cap |
| trapped | **63.7 ETH of raise** in the v4 position + 100e18 reserve tokens on the curve |
| **attacker's total cost** | **0.000486 ETH** at the repo's own 30,180,000 wei gas hint, plus 100 wei |

The asymmetry is the whole attack, and it is worth stating in the units that were actually measured — per
**planted position**, since how many *ticks* each position initializes depends on whether the bands are
contiguous (a shared boundary is initialized once) or spaced (two each):

- attacker: `16,116,942 / 100` = **161,169 gas per position**, spread over as many transactions as they like,
  none of which has a deadline;
- victim: `(33,767,571 − 1,217,937) / 100` = **325,496 gas per position**, all of it inside **one** transaction
  that must complete atomically.

Roughly 2× leverage, against a hard 30M ceiling, with the attacker under no time or gas pressure at all.

**This is not the grief the suite already handles.** `test/unit/RobinCurveV4.grief.test.js` covers planting
*deep* liquidity so the nudge's 1%-of-reserve token budget runs out — that path fails closed with
`CeilingNotRestored` and `restoreCeiling` recovers it (and is why L-8 is only LOW). Here the positions are
`L = 1`, so essentially no token is consumed and the budget never binds. The swap runs out of **gas**, and
`restoreCeiling` is bricked by the identical mechanism. **The documented recovery is defeated by the thing it
exists to recover from.**

There is no other exit. `poolManager.modifyLiquidity(..., liquidityDelta: -int256(uint256(curveL)) ...)` at
`:568` is the only negative-liquidity call in the file, and `graduate()` is its only caller.

**Fix direction.** Make the walk-back segmentable and bound the gap.
1. Give `restoreCeiling` a caller-supplied `sqrtPriceLimitX96`, requiring
   `current < limit <= getSqrtPriceAtTick(gradTick)`, so anyone can push spot toward the ceiling across as
   many transactions as it takes. This alone converts an unrecoverable brick into a recoverable one.
2. Split `graduate()` so ceiling restoration is a separate, retryable, partial-progress step rather than an
   all-or-nothing swap inside `_graduatePull`.
3. Consider preventing the deep overshoot in the first place — the sellout only reaches the floor because
   nothing stops a buy below `gradTick`.

---

### H-1 · HIGH · Any seller can waive the sell tax entirely — and it is *cheaper* than paying it  `PROVEN (×3)`

> **STATUS: FIXED** in `fc28f7f` · regression test `test/regression/H1.selltax-waiver.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/hooks/RobinFeeHook.sol:297-302` (`afterSwap`'s guarded `take`).

**What is wrong.** The sell fee is collected by physically taking the just-produced output, and the take is
try/caught so a blocklisted or paused fee currency cannot brick trading:

```solidity
try poolManager.take(key.currency0, address(this), fee) {}
catch {
    emit SkimSkipped(id, 0, fee);
    return (IHooks.afterSwap.selector, int128(0));
}
```

On the catch path nothing is booked and `int128(0)` is returned, so the seller keeps the **full** output. The
fee is not deferred — it is **permanently waived**. And the failure is not something only a hostile token can
cause: for native ETH, `PoolManager.take` ends in `Currency.transfer`, which does a raw `call` of `amount` wei
and reverts `NativeTransferFailed` if the singleton does not hold it
(`v4-core/src/types/Currency.sol`, `PoolManager.sol`'s `take`).

**Anyone can starve the singleton for free**, because v4's flash accounting lets a caller take a currency with
no collateral as long as they settle before the unlock closes. It is enough to leave the PoolManager holding
**less native than `fee`** — a full drain is not required:

1. `poolManager.unlock(...)`; inside the callback:
2. `poolManager.take(Currency.wrap(address(0)), self, <enough to drop the singleton below `fee`>)` — free,
   creates a matching negative delta.
3. `poolManager.swap(padKey, {zeroForOne: false, amountSpecified: -tokenAmount, ...})` — the sell. In
   `afterSwap` the hook's `take` of `fee` wei now reverts (the singleton holds ~0 ETH) → caught →
   `SkimSkipped` → `int128(0)` → **no tax**.
4. `poolManager.settle{value: X}()` returning the borrowed ETH, then take the untaxed swap output.

Net effect: the entire `sellTaxBps` — **0.8% creator + 0.2% floor** at production settings — is evaded, on
every sell, at will, by anyone.

**It costs less than paying the tax.** Measured: the attack path consumes **194,842 gas against 201,788 for
the honest sell — 6,946 gas *cheaper*** — because the catch path skips the two cold `SSTORE`s to
`creatorOwed`/`floorOwed` and the ETH transfer into the hook, and those exceed the extra `take` + `settle`.
So there is no minimum profitable trade size and no gas or slippage threshold that makes this negative-EV.

**And it does not stay a per-attacker trick.** The drain and the swap only need to share one `unlock`, so a
third-party router can wrap the flash-take around *every* user's sell and truthfully advertise "0% sell tax".
That turns an expert-only evasion into a protocol-wide defunding of the creator's income and the floor, with
no sophistication required from the traders themselves. The expected loss is the whole sell-tax revenue line,
curve phase and post-graduation alike — not a fraction of it.

**A second, narrower exempt route exists, and it is worth writing down only to bound it.**
`RobinFeeHook:284` exempts the pad's own curve controller from the sell tax
(`sender == c.bufferRecipient`, wired by `CurvePadFactoryV4:227`), so that graduation's nudge and
`restoreCeiling`'s anti-grief swap are not taxed — deliberate, and correct on its face. But `restoreCeiling`
(`RobinCurveV4:428`) is **permissionless** and swaps the *caller's* tokens, refunding them the ETH. That is a
public token→ETH route whose swap the hook does not tax.

It is not a second finding, because three guards confine it and the last one is decisive:
`:430` reverts `AlreadyGraduated` (pre-graduation only), `:433` reverts `NotReady` unless spot is strictly
**below** `gradTick`, and the swap's `sqrtPriceLimitX96` is `gradTick` itself, so it stops at the ceiling. In
the honest case the zone below `gradTick` holds no liquidity at all, so a seller routing through it receives
~0 ETH — there is nothing to sell into. It carries real volume only when a third party has *planted* liquidity
down there, which is the exact situation `restoreCeiling` exists to unwind, and the ETH extracted is the
planter's. Planting your own liquidity to sell into it tax-free is trading against yourself.

So the exemption's blast radius is bounded, and everything it could achieve is already available, unbounded and
cheaper, through the flash-take above. Recorded so a later pass does not re-file it as its own MEDIUM — but
note that if H-1's `catch` is fixed, this route stays open, and a `sender` exemption keyed to an address that
also exposes a permissionless swap entry point is a shape worth not repeating.

**Severity note.** This is fee evasion, not theft: the singleton is left solvent (its ETH balance is identical
after honest and attack runs, and the unlock closes clean), nothing is drained from the pool, from user
principal, or from other pads. That is why it is HIGH rather than CRITICAL. Three independent reproductions
against a real local v4 `PoolManager` agree on the mechanism and the severity.

**Why this is worse than the `[D2]` disclosure it hides behind.** The NatSpec (`:40-42`) frames the try/catch
as *"a blocklisted/paused stock fee currency skips or defers, never bricks trading"*, and `AUDIT-SCOPE.md` §4.1 (`:55-56`)
asserts *"every fee booked is claimable exactly once."* Neither holds: the fee is never booked, it is
attacker-triggerable on the ordinary ETH path, and the creator's entire income stream plus the floor's funding
can be zeroed by any trader who routes through their own unlock. The buy side is unaffected — `beforeSwap`
uses `poolManager.mint`, which is pure accounting and cannot be starved, exactly as its comment claims.

**Fix direction — the buy side already shows the answer.** `beforeSwap` collects its fee with
`poolManager.mint` (`:215`), pure ERC-6909 accounting that cannot be starved by singleton depth, and redeems
it later through `_pullClaimsAndPay` / `unlockCallback` (`:448-462`), machinery that already handles a failing
physical take retriably. Give the sell side the same treatment: `mint` the fee as a claim and return the
`+fee` delta unconditionally. If the physical `take` is kept instead, the catch **must** book the fee to a
pending ledger rather than dropping it — silently returning `int128(0)` is what converts a deferral into a
waiver.

---

### H-2 · HIGH (gating the stock pad; no live surface today) · A `StockPadFactory` launcher ships a pad it can freeze at will, and the securities gate is self-certified  `PROVEN`

> **STATUS: FIXED** in `29339d6` · regression test `test/regression/H2.stock-gate.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/core/StockPadFactory.sol:69` (`adapter`, caller-supplied), `:68` (`guardWindow`,
caller-supplied, unbounded `uint32`), `:172`/`:176` (both stamped immutably into the hook), enforced at
`contracts/hooks/RobinFeeHook.sol:190-197`.

**Scope first, because it decides how to read this.** Nothing deployed today is exposed. The curb only runs
when `quoteIsStock` is true, and only `StockPadFactory` ever sets it — `CurvePadFactoryV4.sol:188/194/195` and
`PadFactory.sol:172/178/179` hardcode `guardAdapter: address(0)`, `guardWindow: 0`, `quoteIsStock: false`, so
the ETH curve pad and the plain ETH pad are **structurally immune**. `StockPadFactory` is deferred as
informational by `AUDIT-SCOPE.md` §2, appears nowhere in `DEPLOY.md`, and per M-8 cannot even be executed
locally. So this is not a live incident — it is a **blocker on shipping the stock pad**, and it is filed HIGH
because that is its severity the day the stock pad launches, not because anything is at risk now.

**What is wrong.** The corporate-action curb sits at the very top of `beforeSwap` — above the direction check
and above the `sender == address(this)` exemption:

```solidity
if (c.guardWindow > 0 && c.quoteIsStock && c.guardAdapter != address(0)) {
    uint256 ea = _scheduledEffectiveAt(c.guardAdapter);
    if (ea != 0) {
        uint256 diff = nowTs > ea ? nowTs - ea : ea - nowTs;
        if (diff <= c.guardWindow) revert CorporateActionCurb();
    }
}
```

So it freezes **buys and sells alike**, and both of its inputs are chosen by whoever calls `launch()`. A
launcher therefore ships a pad it can freeze and unfreeze at will: trade normally, dump the `tokenRemainder`
that `launch` sends to `cfg.creator` (`:187-188`), then schedule an "effective at" on its own adapter and no
holder can ever exit. `RobinFeeHook.registerPool` (`:135-163`) validates only the tax and share fields — it
never bounds `guardWindow` — and neither does `StockPadFactory`.

Be precise about the duration, because it differs by adapter:

- **With an attacker-supplied adapter** (the case above) the freeze is *unconditional and indefinite*: the
  launcher simply keeps `scheduledEffectiveAt()` returning a value near `block.timestamp`, so the curb holds
  for as long as they choose, and a `uint32` `guardWindow` lets one call cover ~136 years without further
  action.
- **With a genuine `StockQuoteAdapter`** the curb is self-limiting: `scheduledEffectiveAt()` returns non-zero
  only while the stock has a pending `newUIMultiplier` (`adapters/StockQuoteAdapter.sol:86-97`), so an
  oversized window freezes trading for as long as that corporate action stays pending, not unconditionally.
  That is still an unbounded misconfiguration — a legitimate pad can be frozen far past any real
  corporate-action window — but it is not attacker-held.

The freeze semantics are already established by the repo's own test,
`test/unit/RobinFeeHook.adversarial.test.js:163-186`, using `MockGuardAdapter` — a 22-line contract that is
exactly what an attacker would deploy.

**The hook's own safety claim is false here.** `RobinFeeHook.sol:177-178` states *"the adapter read is
try/caught so a broken adapter can't freeze trading."* `_scheduledEffectiveAt` (`:255-261`) does try/catch —
but only a **reverting** adapter, which it reads as "no scheduled action". An adapter that simply *lies*,
returning a plausible non-zero `effectiveAt` forever, passes the try/catch cleanly and freezes trading
exactly as intended. The guard defends against a broken adapter, not a dishonest one, and the NatSpec claims
the latter.

**The gate this is supposed to rest on does not hold.** `StockPadFactory.sol:32-35` states: *"SECURITIES /
LEGAL GATE: the StockQuoteAdapter's ctor already requires the stock's registry to match the platform's known
STOCK_REGISTRY, so only registry-governed stocks can be paired."* Two links are missing:

1. `StockQuoteAdapter`'s constructor takes `expectedRegistry` **as an argument**
   (`adapters/StockQuoteAdapter.sol:60-70`). It proves only that the stock and the registry agree with each
   other — not that the registry is the platform's. The adapter's deployer names both sides.
2. `StockPadFactory` has **no registry immutable and no adapter allow-list at all**. Grepping `contracts/` for
   `expectedRegistry` / `ACCESS_CONTROLLED_REGISTRY` / `isAdapter` outside `adapters/StockQuoteAdapter.sol`
   returns only `test/MockStock.sol`. `launch()` checks `cfg.adapter != address(0)` and then simply calls
   `.stock()` on whatever it was handed (`:124-126`).

**PROVEN:** deploying `MockStockRegistry` → `MockStock(thatRegistry)` → `StockQuoteAdapter(thatStock,
thatRegistry)` from an attacker account **succeeds**, and `adapter.registry()` returns the attacker's own
registry. The resulting pad carries `quoteIsStock == true` and is on-chain indistinguishable from a genuine
one.

`AUDIT-SCOPE.md` §2 defers the stock pad as "informational", but this is not a stock-market risk — it is a
rug primitive in shipped, in-scope code, reachable by anyone.

**Fix direction.** Pin the registry as an immutable on `StockPadFactory` and require
`StockQuoteAdapter(cfg.adapter).registry() == STOCK_REGISTRY`, or keep a platform-curated
`mapping(address => bool) approvedAdapter`. The guard adapter should not be launcher-chosen at all — derive it
from the approved adapter for that stock. Give `guardWindow` a hard ceiling: a corporate-action window is
hours, not years.

---

### H-3 · HIGH (gating the stock pad) · `try/catch` does not absorb a short return, and `guardAdapter` has no setter  `PROVEN`

> **STATUS: FIXED** in `b405502` · regression test `test/regression/H3.short-return.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/hooks/RobinFeeHook.sol:255-261` (`_scheduledEffectiveAt`), reached from the curb at
`:190-197` on **every swap** of a stock pad.

```solidity
try IStockGuardAdapter(adapter).scheduledEffectiveAt() returns (uint256 ea) { return ea; }
catch { return 0; }
```

Solidity's `try/catch` catches reverts. It does **not** catch a failure to decode the return data: that
happens in the *caller's* frame after the call has already succeeded, outside the protected region. A callee
that returns **zero bytes** therefore reverts the whole transaction, uncatchably.

**PROVEN** against the sibling site: a 5-byte contract whose runtime is `PUSH1 0, PUSH1 0, RETURN` — succeeds,
returns nothing, for any selector — was installed as `DualStaking`'s boost oracle. `boostOf` reverted despite
its try/catch and its *"Never reverts"* NatSpec, and `stake`, `unstake` and `claim` all reverted with it. The
same shape applies here.

**On a stock pad the consequence is permanent.** `guardAdapter` is written once in `registerPool` (`:160`) and
there is **no setter anywhere in the contract** — grep returns only the field (`:75`), that write, and the
read. So a stock pad launched with a short-returning adapter has every swap revert forever, with the seed LP
already locked in `LockVault` and no path to change the adapter, unwind the position, or recover the seed.
Reaching it needs only a contract that has code and a working `stock()` — which is all
`StockPadFactory.launch:123` checks (see H-2).

**Swept exhaustively, because one instance of this is never one instance.** Every `try` in `contracts/`
(excluding tests) was enumerated and classified. Only sites carrying a `returns (...)` clause decode at all:
every defensive `try` on a hot path — `poolManager.mint` / `take`, `claimBuffer`, `fundTokenPushed` (both call
sites), `addFloor`, `onWeightChange` — omits the clause and therefore never decodes, so those are genuinely
safe. Of the sites that do decode:

- **Two put user funds at risk**, and both read a value back from an address someone else chose: this one
  (`RobinFeeHook:256`, `guardAdapter` from `registerPool`) and `DualStaking:188` (`boostOracle`, **M-17**).
- **Six more sit inside `StockQuoteAdapter` itself** (`:87`, `:89`, `:103`, `:112`, `:123`, `:128`, `:133`),
  every one reading the caller-chosen `stock` or its `registry`. These are reachable — H-2's premise is a
  hostile `stock` that satisfies the constructor's `ACCESS_CONTROLLED_REGISTRY()` check — and each one
  falsifies a "Never reverts" / "NEVER-reverting" NatSpec claim. **Their blast radius is advisory, not
  financial**, and that was checked rather than assumed: `tradeable()`, `displayScalar()` and
  `marketDataStale()` have **no on-chain callers anywhere in the suite** — they exist for the router and UI, as
  documented. The one that *is* read on chain, `scheduledEffectiveAt()`, would **revert** rather than
  short-return, and `RobinFeeHook:255-261` catches a revert. So a hostile *stock* breaks integrators; only a
  hostile *adapter* — this finding — bricks the pad.
- **Four trust canonical contracts**: the three `poolManager.initialize` sites and `PresaleVault:178`'s
  `launch`. Worth one line even so: a codeless `poolManager` would make `initialize`'s empty-body
  `returns (int24) {}` decode-revert *outside* its own catch, which is the same mechanism wearing a
  configuration hat rather than an adversarial one (see **I-3**).

**Fix direction.** Use a low-level `staticcall` and check `returndata.length == 32` before decoding, e.g.
`(bool ok, bytes memory d) = adapter.staticcall(...); if (!ok || d.length != 32) return 0;`. Apply the same at
`DualStaking.boostOf` and — since it is the identical three lines and makes the "never reverts" NatSpec true —
at all six `StockQuoteAdapter` sites. Independently, `guardAdapter` should be repointable by the platform,
since today a single bad address at launch is unrecoverable.

---

### H-4 · HIGH (gating the stock pad) · `StockPadFactory.launch` pulls the seed from `msg.sender` and refunds it to `cfg.creator` — 99.9% of a payer's balance, measured  `PROVEN`

> **STATUS: FIXED** in `1c02825` · regression test `test/regression/H4.stock-seed-refund.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/core/StockPadFactory.sol:182` (`safeTransferFrom(msg.sender, …)`) against `:185` (the
comment) and `:189-190` (the refund), with sizing at `:204-210`.

The stock path is the **only** launch path where the funder and the creator are two explicitly-modelled,
distinct roles: `launch` is not `payable`, and the NatSpec at `:112-113` states *"The caller must have approved
this factory to pull `stockSeed`."* `:182` duly pulls from `msg.sender`.

`_mintSeedLp` then sizes the position with
`LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, minTick, maxTick, stockSeed, lpTokenAmount)`, which
binds on **one** side only — so the other side is over-supplied by construction, and `SETTLE_PAIR` pulls only
what the mint actually owes. Whatever stock the mint did not consume stays in the factory. Then:

```solidity
uint256 stockRemainder = IERC20(stock).balanceOf(address(this));   // :189
if (stockRemainder > 0) IERC20(stock).safeTransfer(cfg.creator, stockRemainder);   // :190
```

Two defects in one statement. The destination is `cfg.creator`, **not the payer**. And the amount is the
factory's whole balance of that asset, not this launch's remainder (see I-1(17) for what that composes with).

*Precision, since this entry was filed on another auditor's measurement and I checked it afterwards:* the
comment at `:185` reads *"register the lock, send the token remainder to the creator, return any unused
stock"*. It names `cfg.creator` explicitly for the **token** remainder and says only "return" for the stock —
so the contrast implies return-to-payer rather than stating it. That is weaker than "the comment says to refund
the payer", which an earlier revision of this entry claimed. The **code** defect is unaffected: both refunds go
to `cfg.creator`, and only the token one is correct, since the token is minted to the factory while the stock
came from `msg.sender`.

**Measured** against a real local `PoolManager` with an action-aware `PositionManager` mock, payer ≠ creator,
`lpTokenAmount = 1e20`, `stockSeed = 1e23`, 1:1 price, `ts` 60:

| | |
|---|---|
| payer's stock balance | 100,000e18 → **0** |
| reached the pool | **100e18** |
| sent to `cfg.creator` | **99,900e18 — 99.9% of the payer's balance** |

Independently re-derived: `cfg.stockSeed` is bounded only by `!= 0` (`:120`), so over-supplying is permitted;
`_mintSeedLp` binds on the smaller leg, so at 1:1 price with `lpTokenAmount = 1e20` only 1e20 of stock is
consumed; and `1e23 − 1e20 = 99,900e18` is exactly the reported refund. The arithmetic holds.

Silent, irreversible, and it lands on the *modelled* flow: a platform funding a launch on a creator's behalf,
or any arrangement where the approver and the named creator differ. HIGH by impact, labelled as stock-pad
gating for the same reason as H-2 and H-3 — no stock pad exists today.

**Fix direction.** Refund to `msg.sender`, and refund **this launch's** remainder rather than
`balanceOf(address(this))` — snapshot the balance before the pull and return the delta. Fix the comment either
way; right now it documents behaviour the code does not have.

---

### L-30 · LOW (gating the stock pad) · `guardWindow == 0` silently disables the only stock-specific control, on a pad that still advertises `quoteIsStock`  `PROVEN`

**Where** `contracts/core/StockPadFactory.sol:68`, `:118-121` (the complete validation), `:176-177`;
enforced at `contracts/hooks/RobinFeeHook.sol:190`.

`StockPadFactory` hardcodes `quoteIsStock: true` (`:177`) and `guardAdapter: cfg.adapter` (`:170`), but passes
`guardWindow` straight through from calldata. The curb is
`if (c.guardWindow > 0 && c.quoteIsStock && c.guardAdapter != address(0))` — so **`guardWindow == 0` makes the
entire clause dead**. `registerPool` validates every other economic field (both taxes against `MAX_TAX_BPS`,
all three shares against `BPS`, a non-zero creator) and validates `guardWindow` not at all; `launch` does not
either. Grepping outside tests returns exactly four non-test sites — the struct field, one `registerPool`
write, and two reads — so **there is no setter anywhere** and the value is frozen for the pad's life.

**Measured:** a pad launched with `guardWindow: 0` reports `quoteIsStock == true` and a genuine
`StockQuoteAdapter` as its `guardAdapter` — on-chain indistinguishable from a curbed stock pad — while
`adapter.scheduledEffectiveAt()` returned a live value and a buy executed normally through `beforeSwap`.

Not H-2, which is `guardWindow` unbounded **above** (a launcher-held freeze primitive) and whose fix direction
is *"give `guardWindow` a hard ceiling"* — a ceiling does nothing about zero. Not L-22, which is about the
window's post-event half being unenforceable.

**Fix direction.** Require `guardWindow > 0` in `StockPadFactory.launch` (and a floor, not just H-2's ceiling),
or have `registerPool` reject `quoteIsStock == true` with `guardWindow == 0` so the two cannot disagree.

---

### L-31 · LOW (gating the stock pad) · `tradeable()`'s registry reads fail **open** while its stock read fails closed, so the only on-chain compliance surface passes a blocked account  `PROVEN`

**Where** `contracts/adapters/StockQuoteAdapter.sol:123-126` (stock pause — fail-closed) against `:128-130`
(registry pause) and `:131-136` (the `isBlocked` loop) — both bare `catch {}`.

The three reads are guarded in two contradictory directions. The stock's own `paused()` failing returns
`false`, with an explicit comment — *"unreadable pause state → treat as not tradeable"* — which is correct,
fail-closed. The registry's `paused()` and the per-account `isBlocked()` use empty catches, so a failed read
falls through to `return true`. Those two are precisely the compliance-critical reads: the venue-wide halt and
the sanctions/blocklist check.

**Measured:** with a registry whose `paused()` and `isBlocked()` both revert, `tradeable([a, b])` returns
**`true`**; with the stock's own `paused()` reverting, the same call correctly returns `false`.

It is also unfixable per pad — `registry` is `immutable`, snapshotted once from what the adapter's own NatSpec
calls a beacon proxy — and `tradeable()` is the **only** on-chain compliance gate the stock pad has, since the
hook never consults it. The `[D1]` disclosure leans on exactly this function.

Not H-3, which enumerates the same lines for the opposite mechanism — a *short return* failing to decode in the
caller's frame and reverting uncatchably. This is the ordinary revert path, caught and then ignored.

**Fix direction.** Make all three reads fail closed: `catch { return false; }` on both registry reads, matching
the stock read directly above them.

---

### L-35 · LOW · The buy-LP floor carve is credited *before* graduation and released *only* by graduation, so a pad that never graduates freezes it forever  `PROVEN`

*(Filed as M-28; downgraded to LOW by an independent skeptic that reproduced it and argued the severity down —
see the note at the end of this entry.)*

**Where** `contracts/pads/RobinCurveV4.sol:603-617` (`_takeFeesToBook`), `:230-234` (`collectFees`,
permissionless, pre-graduation), `:405-411` (`flushFloor`), `:283-291` (`sweepToPlatform`).

`_takeFeesToBook` runs during the **curve phase** and splits one realized LP fee into two books in one place:

```solidity
platformEthOwed += e - toFloor;      // 80% at the shipped buyLpFloorShareBps
floorEthOwed    += toFloor;          // 20%
```

Same wei, same `take`, two books — and their exits are **not symmetric**. `claimPlatform()` (`:239`) has no
lifecycle gate at all. `floorEthOwed` has exactly two consumers, `graduate()` step 8 and `flushFloor()`, and:

```solidity
function flushFloor() external nonReentrant {
    if (!graduated) revert NotReady();      // ← checked FIRST, before wiring
    if (floor == address(0)) revert ZeroAddress();
```

So `setFloor(realVault)` does **not** unlock it. `sweepToPlatform()` is graduated-gated too, and explicitly
subtracts `floorEthOwed` from what it will sweep. On a pad that stalls short of the ceiling — which for a
launchpad is the ordinary outcome, not the edge case — **20% of every ETH LP fee the curve ever realized is
permanently unreachable**, while the sibling 80% from the identical `take` pays out normally. No attacker, no
operator error; it is the default.

`floorEthOwed` is also unique in shape: `creatorEthOwed`, `ambushEthOwed` and `gasBountyOwed` are credited only
*at* graduation, so for them a graduation gate is coherent. This one is credited from the first buy.

> **Correction to M-21.** M-21 states that never wiring the sinks does not burn the money, because *"a late
> `setFloor` + `flushFloor` recovers it in full"* — and measures exactly that. That measurement was taken
> **after graduation**, and it does not generalize: `flushFloor`'s `!graduated` check is unconditional and runs
> before the wiring check. M-21's recovery is real only for pads that graduate. M-21 has been annotated.

**Severity, argued down and accepted.** A skeptic reproduced this on a real local `PoolManager` — `ready()`
false, `platformEthOwed = 1,900,800,000,000,000,000`, `floorEthOwed = 475,199,999,999,999,997` (exactly 80/20
at the shipped `buyLpFloorShareBps = 2000`), `claimPlatform()` pays the 1.9008 out, the curve balance then
equals `floorEthOwed` to the wei, and `flushFloor` / `sweepToPlatform` / `flushAmbush` / `flushStaking` /
`graduate` all revert with the book unchanged — then argued MEDIUM down to LOW, and the argument is right.
Everything at risk is the **platform's own** fee revenue, not user or creator funds; there is no counterparty;
it is fully recovered the moment the pad graduates, so it only bites pads that die; and the amount scales with
the fees a *failed* pad generated. The register already prices this exact shape — value stranded in a
protocol-owned pocket behind an action nothing forces — at LOW in **L-3** and **L-17**. M-21 keeps its MEDIUM
because there the funds are silently **burned** on a live pad by a plausible mis-wire; here they are merely
unreachable on a pad nobody is using.

**Fix direction.** Let `flushFloor` run pre-graduation once `floor` is wired — the vault's own park guard
already handles a spot that is inside the band — or drop `floorEthOwed`'s graduation gate and let
`sweepToPlatform` release it on a pad declared dead. Simplest of all: do not credit the carve to a separate
book until graduation, so the pre-graduation split matches the post-graduation exits.

---

### L-32 · LOW · `curve.setStaking` and `LockVault.setStakingRecipient` are two one-shots for one concept, and they are **mutually exclusive**  `VERIFIED`

**Where** `contracts/pads/RobinCurveV4.sol:360` (`onGraduated(..., staking)`), `:447-453` (`setStaking`),
`contracts/core/LockVault.sol:84-88` (`registerLaunch` writes the slot), `:94-101` (`setStakingRecipient`
reverts once it is non-zero).

`graduate()` copies whatever `curve.staking` holds **at that instant** into `registerLaunch`'s
`stakingRecipient`, and `LockVault.setStakingRecipient` refuses to run once that slot is non-zero. So on the
curve path `setStakingRecipient` is reachable **if and only if the pad graduated while `curve.staking` was
still unset.**

The diligent ordering is the losing one. `setStaking` must be called *before* `graduate()` for step 7's reserve
stream to fire at all, and `deploy-curve.js:119-122` tells the operator to do exactly that. When they comply,
the `LockVault` slot is permanently bound to the **staking pool contract** — an address chosen to satisfy
`IStakingFund.fundTokenPushed`, a completely different interface from "where the locked LP's token-side fees
should go" — and the platform's one chance to route that stream is gone. `graduate()` being permissionless and
bounty-paid means the race is not even under the operator's control.

> **Correction to M-11.** M-11 asserts that registering with `stakingRecipient == address(0)` is the normal
> outcome, and its fix direction leans on `setStakingRecipient` remaining available as the correction. That
> holds only on the branch where nobody wired `setStaking` first. M-11 has been annotated.

**Fix direction.** Decide which contract owns the concept and delete the other setter. If `LockVault` owns it,
have `registerLaunch` take `address(0)` always and require the platform to set it explicitly; if the curve owns
it, drop `setStakingRecipient`. Two one-shots for one idea is the M-7 pattern, and here they actively cancel.

---

### L-33 · LOW · M-7's own prescribed fix makes the add-only floor wall buildable **mid-curve**, widening M-4  `VERIFIED`

**Where** `contracts/hooks/RobinFeeHook.sol:383-391` (`setFloorRecipient`, callable from the launch transaction
onward), `:340-348` (`claimFloor`, permissionless), `contracts/pads/RobinFloorVault.sol:109-119` (`addFloor`).

The register treats the floor as a post-graduation instrument — but it is one *only because*
`hook.setFloorRecipient` is never called, which is M-7. Apply M-7's fix as written ("add it to the runbook")
and the picture changes: `claimFloor` becomes claimable from the first sell, `scripts/keeper.js` starts
delivering the sell-tax carve into the vault immediately, and `addFloor()`'s single guard is then the only
thing deciding whether that carve is irreversibly committed to liquidity **while the pad is still mid-curve**.

Which way it decides is a pure function of the unverifiable `anchorTick` an operator typed (M-4). Anchored at
the launch tick, the guard never fires during the curve phase — spot only ever walks *down* from `startTick` —
so every keeper pass permanently commits carve while the pad is far below its eventual graduation price.
Anchored at `gradTick`, it parks until spot reaches the final tick spacing.

No funds are lost — both destinations are protocol-owned and permanent — but the price a pad's permanent floor
defends ends up set by an off-chain parameter interacting with a permissionless keeper, rather than by any
on-chain rule. And **M-7's fix, applied as written, widens M-4's blast radius from graduation-onward to the
whole pad lifetime.**

**Fix direction.** Fix M-7 and M-4 together, not separately: when wiring `setFloorRecipient` early, either gate
`addFloor()` on `graduated` (the curve knows), or require the vault's anchor to be derived from the curve's
`gradTick()` on-chain — which is M-26's fix for the ambush vault, and closes M-4 at the same time.

---

### M-1 · MEDIUM · A presale pays buy tax on the whole target even when the curve fills a fraction of it  `PROVEN`

> **STATUS: FIXED** in `ce119fc` · regression test `test/regression/M1.presale-overtax.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/presale/PresaleVault.sol:211` and `:225` (`finalize` → `unlockCallback`), against
`contracts/hooks/RobinFeeHook.sol:205-213`.

**What is wrong.** The pooled buy is one exact-input swap for the entire raise, price-limited at the
graduation ceiling. `RobinFeeHook` computes the buy fee on the **requested** input, and v4 charges the caller
the full `hookDeltaSpecified` regardless of how much executed (`v4-core/src/libraries/Hooks.sol` —
`amountToSwap += hookDeltaSpecified` in `beforeSwap`, then `swapDelta = swapDelta - hookDelta` in
`afterSwap`). When `target` exceeds curve capacity, contributors pay `buyTaxBps × target` while only a
fraction is swapped.

**Why this is not accepted design item (b).** `AUDIT-SCOPE.md` §5 accepts partial-fill over-taxing because it
is *"buyer-controlled, by design"* — the buyer chose a tight `sqrtPriceLimit`. Here the limit is the
protocol's own `gradTick`, no contributor chooses it, and the loss is socialised pro-rata. The justification
does not transfer.

**Measured.** START 6000 / GRAD 3000 / ts 60, buyTax 1%, `curveSupply` 0.2 token, `target` 3 ETH:

| | |
|---|---|
| `totalRaised` | 3.0 ETH |
| `pooledEthSpent` | 0.158817 ETH |
| buy tax booked by the hook | **0.03 ETH** — 1% of the full target |
| ETH actually swapped | 0.128817 ETH |
| honest 1% on the filled leg | 0.001288 ETH |
| **over-tax borne by contributors** | **0.028712 ETH** — 0.96% of the entire raise |
| effective rate on the filled leg | **23.29%** |

As `target / capacity` grows the effective rate is unbounded and the loss converges on the full
`buyTaxBps × target`. `test/sim/presale.sim.test.js:90` deliberately uses a *"deep-curve config"* so no
existing test reaches this state.

**Fix direction.** Have `finalize()` derive the absorbable input from `stateView.getSlot0` plus the immutable
curve geometry and swap `min(totalRaised, capacity)`, letting the remainder flow into the existing pro-rata
ETH-back. Validating `target` at `createPresale` is weaker — the FeeConfig geometry can be retuned between
create and finalize.

---

### M-2 · MEDIUM · `LockVault` has one registrar slot but three factories register launches  `PROVEN`

> **STATUS: FIXED** in `032191e` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/core/LockVault.sol:71` (`setFactory`, one-shot), `:84` (`registerLaunch` gate). Callers:
`core/PadFactory.sol:187`, `core/StockPadFactory.sol` (launch step 4), and `pads/RobinCurveV4.sol:360` →
`core/CurvePadFactoryV4.sol:243`.

**What is wrong.** One `LockVault` can serve exactly **one** of the three factories, and nothing on-chain
detects a mismatch — not in any constructor (the factory↔vault cycle makes that impossible) and not in
`launch()`, where it would be trivial.

The failure modes are asymmetric, and that is the whole problem. `PadFactory` / `StockPadFactory` call
`registerLaunch` **inside** `launch()`, so a miswire reverts the launch: loud, immediate, harmless.
`CurvePadFactoryV4` calls it only at **graduation**, via `RobinCurveV4.graduate()` step 5, **not** wrapped in
try/catch. A miswire is invisible for the pad's entire life and then bricks it permanently, after it has
collected a real raise.

**Measured.** Point a shared `LockVault` at a `PadFactory` (`setFactory` then reverts `FactoryAlreadySet` for
the curve factory — there is no second chance). Launch a curve pad: **succeeds, no warning**. Let traders buy
the curve out. `curve.ready()` returns `true`; `curve.graduate()` reverts `NotFactory` for every caller,
forever. The raise is still inside the curve's Uniswap position — only `_graduatePull` can remove it, and it
is reachable *solely* from `graduate()` — and the reserve tokens sit on the curve with no exit
(`flushStaking` is gated on `graduated`). Both unrecoverable. No admin path, no rescue, no migration.

**Mitigating:** `scripts/deploy.js` and `scripts/deploy-curve.js` each deploy their own `LockVault`, so the
shipped happy path is correct today. This is a one-wrong-address failure with an unbounded blast radius and no
on-chain guard.

**This is the weakest link in a set of nine, and the sweep is worth having.** Every one-shot setter in the
suite, with what each actually checks:

| setter | one-shot | non-zero | callee has code | **target identity** |
|---|---|---|---|---|
| `RobinCurveV4.setStaking` `:447` | ✓ | ✓ | **✓ `code.length`** | ✗ |
| `RobinCurveV4.setFloor` `:457` | ✓ | ✓ | **✓ `code.length`** | ✗ |
| `RobinCurveV4.setAmbush` `:467` | ✓ | ✓ | **✓ `code.length`** | ✗ |
| `RobinFeeHook.setFloorRecipient` `:387` | ✓ | ✓ | ✗ | ✗ |
| `RobinFeeHook.setBufferRecipient` `:400` | ✓ | ✓ | ✗ | ✗ |
| `RobinFeeHook.registerPool` `:137` | ✓ | creator only | ✗ | ✗ — `guardAdapter` unchecked (**H-3**) |
| `LockVault.registerLaunch` `:85` | ✓ | — | — | — |
| `LockVault.setStakingRecipient` `:98` | ✓ | ✓ | ✗ | ✗ (**M-11**, **L-17**) |
| **`LockVault.setFactory` `:73`** | ✓ | ✓ | **✗** | **✗** |

`RobinCurveV4` learned the `code.length` lesson (its comment cites `[LOW-3]`); `LockVault` and `RobinFeeHook`
never did. And `setFactory` is the one slot where the target's *identity*, not merely its shape, is what
matters — a code check would not have caught M-2, because a `PadFactory` has code. No setter anywhere in the
suite validates identity, which is why the same root shows up three more times as M-11, L-17 and H-3.

**Fix direction.** Any one closes it; the first is two lines:
- `if (lockVault.factory() != address(this)) revert NotRegistrar();` at the top of `CurvePadFactoryV4.launch`
  (and the other two). Equivalently, and better because it fixes the wiring at the moment it is created:
  make `setFactory` assert the round-trip — `if (ICurvePadFactoryV4(factory_).lockVault() != address(this))
  revert NotRegistrar();` — so a factory that does not point back at this vault can never be installed.
- Make `LockVault` multi-registrar: `mapping(address => bool) isFactory`, managed by `initializer`.
- Wrap `onGraduated` in try/catch **plus** a permissionless deferred-registration path — the try/catch alone
  is not enough, or the locked LP's fee stream is stranded instead of the raise.

---

### M-3 · MEDIUM · `PadFactory` lets the launcher set their own taxes and point every revenue stream at themselves

**Where** `contracts/core/PadFactory.sol:56-61` (`LaunchConfig`), `:116-118` (the only validation),
`:171-175` and `:187` (values passed straight into `registerPool` / `registerLaunch`).

`PadFactory.launch` validates the dynamic-fee flag, a non-zero creator, a non-zero supply and
`lpTokenAmount <= supply`. It validates **nothing** about `buyTaxBps`, `sellTaxBps`, `sellFloorShareBps`,
`floorRecipient` or `stakingRecipient` — all five are caller-supplied and stamped immutably. The only ceiling
is the hook's own `MAX_TAX_BPS = 300` (`RobinFeeHook.sol:49`) and `sellFloorShareBps <= BPS` (`:142`).

A pad launched through `PadFactory` can therefore carry **3% buy + 3% sell**, with **100% of the sell tax
routed to an address the launcher chose** — labelled, in the hook's own storage and in every doc, as "the
floor" — and with the locked LP's token-side fee stream (`stakingRecipient`) pointed anywhere as well.

This is the opposite of the trust model the suite is sold on. `CurvePadFactoryV4.sol:29-33` states: *"every
economic parameter … is read from `feeConfig.defaults()` and stamped immutably here — NEVER taken from the
caller. So a launcher can never set their own tax."* True of `CurvePadFactoryV4`, false of `PadFactory`, and
both are in scope in the same repo behind the same brand. `RobinV4FeeConfig`'s caps (`MAX_TAX_BPS = 200`,
`MAX_FLOOR_SHARE_BPS = 5000`) — the caps the governance story rests on — are simply not on this path.

**Fix direction.** Decide what `PadFactory` is. If it is a governed launchpad, read its taxes from
`RobinV4FeeConfig` like the curve factory does. If it is a permissionless primitive, say so explicitly in
`AUDIT-SCOPE.md` and in the front end, and at minimum bound `sellFloorShareBps` so the "floor" label cannot be
100% launcher revenue.

---

### M-4 · MEDIUM · `RobinFloorVault`'s band anchor is an unverifiable deploy parameter, and the band is permanent

> **STATUS: NOT FIXED — flagged for a decision.** A fix was specced against the live code and put to a
> skeptic, which found a blocking problem: the proposed fix created a deployment DoS on a one-shot path; binding the anchor correctly is a design choice. See §0 for the full reason. The finding below is
> unchanged from how it was filed.

**Where** `contracts/pads/RobinFloorVault.sol:77` (ctor `anchorTick`), `:95`
(`_alignUp(anchorTick + 1, tickSpacing_)`).

The floor band is derived from an `anchorTick` a human types in. The constructor validates only that the
resulting band lands inside the usable tick range. It never checks that the anchor relates to the pool it is
*also* handed (`currency0/currency1/fee/tickSpacing/hooks`), nor that that `PoolKey` corresponds to an
initialised pool at all. Because the vault is **add-only by design** — no remove, withdraw or burn path
exists, and that absence *is* the "can't rug to zero" guarantee — a wrong anchor is permanent. Every carve
routed there is deployed into a band that can never be moved, reclaimed or turned off. The anchor also
determines what "floor" economically *means* for that pad (at the launch price it is ~10× below the graduation
price at production geometry; near `gradTick` it overlaps the ambush band), and nothing records the intent.

**The sibling was already hardened against exactly this.** `RobinAmbushVault.sol:108` carries an `[H1]` note —
*"Anchor to the curve's IMMUTABLE `gradTick()` read on-chain — never a passed hint, never a live spot"* — and
its constructor takes `curve_` and reads it. `RobinFloorVault` never received the same treatment. The deploy
runbook even reassures the reader that the ambush reads its anchor on-chain
(`scripts/deploy-curve.js:121`) while saying nothing about the floor's, which is the one a human must get
right.

**Compounding.** `RobinFeeHook.setFloorRecipient` (`:383-391`) is platform-only and one-shot and — unlike
`RobinCurveV4.setStaking` / `setFloor` / `setAmbush` (`:447` / `:457` / `:467`) — does **not** require the
recipient to have code. The sell-tax floor carve can be permanently pointed at an EOA or a wrong-pool vault in
one transaction, with no undo. `ROBIN-V4-CURVE-ECON.md:62` tells the reader these setters' *"targets must be
contracts"*. Not true of `setFloorRecipient` — and it is the only one of the four that omits the check.

Two points of precision, both from verification:

- **It can strand the carve entirely, not merely misroute it.** If the recipient cannot receive the money side
  — a contract with no `receive`, or one that reverts — `claimFloor` reverts on every call, and the hook has
  **no rescue path**: its complete external surface is `registerPool`, `beforeSwap`, `afterSwap`,
  `claimPlatform` / `claimCreator` / `claimFloor` / `claimBuffer` / `claimReferral`, `setFloorRecipient`,
  `setBufferRecipient` and the creator repoint. No sweep, no withdraw, no re-point. The accrued
  `floorOwed` is then permanently unreachable.
- **Size it at production parameters, not the caps.** The ceiling
  (`MAX_TAX_BPS` 200 × `MAX_FLOOR_SHARE_BPS` 5000) would make this 1% of sell volume, but the shipped values
  are `sellTaxBps 100` / `sellFloorShareBps 2000` (`scripts/deploy-curve.js:35-36`, `scripts/launch.js:48-49`,
  `ROBIN-V4-CURVE-ECON.md:29`) — **0.2% of the ETH sell leg**. On 1,000 ETH of lifetime sell volume that is
  2 ETH at risk, not 10. This is an operator-error and documentation defect, not an attacker path.

**Fix direction.** Give `RobinFloorVault` the ambush treatment — take the curve (or another on-chain source of
the pad's launch tick) and read the anchor on-chain — and assert the pool is initialised via
`stateView.getSlot0` in the constructor. Add the `code.length != 0` check to `setFloorRecipient`.

---

### M-5 · MEDIUM · `DualStaking`'s owner can reach existing stakers' principal and already-accrued rewards  `PROVEN`

**Where** `contracts/pads/DualStaking.sol:471` (`setAntiJitDelay`), `:477` (`setPlatformClaimFee`), `:466`
(`setBoostOracle`); enforced at `:307` (`unstake` reads the **current** `antiJitDelay` against a `stakedAt`
recorded earlier) and `:343` (`claim` applies the **current** fee to the whole accrued balance).

Both setters are retroactive, and `StakingFactory.createPool` hands ownership to `platformOwner`
(`StakingFactory.sol:59`) with `antiJitDelay` documented as *"no lock by default"* (`:12-13`).

**Measured.**
- Deploy with `antiJitDelay = 0`. Alice stakes 1,000 and unstakes freely, as advertised. The owner calls
  `setAntiJitDelay(7 days)` → Alice's *already-staked* principal reverts `Locked` for seven days.
- Alice stakes 1,000; the owner funds 10 ETH while `platformClaimFeeBps == 0`; the full 7-day window elapses;
  Alice has earned **9.9999999999996768 ETH**. The owner then calls `setPlatformClaimFee(1000)`. Alice's claim
  pays **8.9999999999997091** — **0.9999999999999677 ETH** taken from rewards that accrued entirely under a 0%
  promise.
- Not tested but plain from the code: `setBoostOracle` can point at an oracle returning `MAX_BOOST_BPS` (4×)
  for a chosen address, and `sync(side, user)` is permissionless, so the owner can quadruple its own weight and
  dilute every honest staker's share by up to 4×.

**Why it matters beyond "the owner is trusted".** `AUDIT-SCOPE.md:66` and `ROBIN-V4-CURVE-ECON.md:62` both
tell the auditor that *"a compromised platform wallet can mis-route only the platform's OWN cut, never user
principal."* `pads/DualStaking.sol` and `pads/StakingFactory.sol` are in scope, and on that path a compromised
owner can freeze user principal for up to 7 days, take up to 10% of rewards earned under a 0% promise, and
dilute the stream 4×. Direct theft of principal is **not** possible — `_payout` is reachable only from
`claim` / `claimPlatformFees`, and principal moves only in `unstake` to `msg.sender` — so a bound exists, but
it is not the bound the docs state.

**Fix direction.** Snapshot `antiJitDelay` into the position at stake time (or apply a raise only to later
stakes); snapshot `platformClaimFeeBps` at accrual rather than at claim; timelock `setBoostOracle`. And
correct `AUDIT-SCOPE.md` §6 to describe these powers.

---

### M-6 · MEDIUM · The architecture doc handed to the external auditor describes a materially different system

> **STATUS: FIXED** in `4fe6d2b` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `ROBIN-V4-ARCHITECTURE.md` (30 KB), listed as required reading by `AUDIT-SCOPE.md:6`.

| Doc claims | Shipped code |
|---|---|
| *"a platform/creator/holder **3-way** afterSwap fee split"* + *"the **holder O(1) bucket**"* (`:33`, `:51`, `:99`) | `RobinFeeHook` has no holder bucket. It is directional: buy taxed fee-on-input in `beforeSwap`, sell taxed from output in `afterSwap`; books are platform / buffer / referral / creator / floor. |
| *"a **USDG-yield ERC-4626** locked floor"* with `totalAssets`, `convertToShares`, `availableRewardsOf`, and a resolved first-depositor inflation attack (`:187`, marked `[RESOLVES C3]`) | `RobinFloorVault.sol:25`: *"Not a vault-with-shares: nobody deposits, nobody redeems, no USDG is ever trapped."* None of those functions exist. |

Symbol counts against `contracts/`: `convertToShares` 1 doc / **0** code; `availableRewardsOf` 3 / **0**;
`totalAssets` 4 / 1 (a stale comment, `RobinStateView.sol:10`); `USDG` 20 / 4 (all four stale comments).

**This is a live code artifact, not only a doc problem.** `DualStaking` still carries the wiring for that
removed hook: `IHookWeightSink` (`:16`), `hook`/`poolId`/`weightedSide`/`hookWired` (`:61-64`), and
`hook.onWeightChange(...)` in `_reweigh` (`:271-273`), with NatSpec (`:35-38`) telling integrators *"this
contract reports that side's boosted weight to the hook so the hook's 3-way holder cut streams to those
stakers."* `onWeightChange` is implemented **only by `contracts/test/MockWeightSource.sol`** — `RobinFeeHook`
does not have the selector. `StakingFactory.createPool` always passes `hook_ = address(0)`
(`StakingFactory.sol:51`), so the path is inert in the shipped flow, but `DualStaking`'s constructor is public
and the machinery advertises a reward stream this suite cannot deliver.

**Why MEDIUM rather than informational.** An auditor briefed on a 3-way holder-accumulator hook and an
ERC-4626 share vault will hunt for share-inflation and accumulator bugs in code that does not exist, and will
not look hard at the fee-on-input ERC-6909 claim path that actually holds the money. A misdirected audit is
worse than none.

**Fix direction.** Rewrite or retire `ROBIN-V4-ARCHITECTURE.md` before the package goes out —
`ROBIN-V4-CURVE-ECON.md` is accurate and can be the basis. Delete the dead `IHookWeightSink` wiring from
`DualStaking`, or implement it. Fix `RobinStateView.sol:10` and `DualStaking.sol:35-38`.

---

### M-7 · MEDIUM · The curve-pad runbook never wires the hook's floor recipient, so the sell-tax floor carve accrues to nobody

> **STATUS: FIXED** in `4fe6d2b` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/core/CurvePadFactoryV4.sol:187` (registers `floorRecipient: address(0)`, by design — the
vault does not exist yet), `contracts/hooks/RobinFeeHook.sol:383` (`setFloorRecipient`, the only way to point
it anywhere), `scripts/deploy-curve.js:119-122` (the shipped post-launch runbook).

Step 3 of that runbook lists `curve.setStaking(staking) / curve.setFloor(floor) / curve.setAmbush(ambush)` —
and **not** `hook.setFloorRecipient(...)`. Nothing else in `scripts/` or `DEPLOY.md` calls it on the curve path
(`scripts/launch.js:90` does, but that is the `PadFactory` path).

Follow the runbook exactly and every curve pad accrues its `sellFloorShareBps` carve into
`hook.floorOwed[id][0]` indefinitely, with `claimFloor` reverting `NoFloorRecipient` (`:342`). The funds are
not lost — a later `setFloorRecipient` makes the parked balance claimable — but the pad's advertised floor is
unfunded from the sell side for as long as it is missed, and the miss is silent.

This is also the second of the two independent floor wirings: `curve.setFloor` (buy-side LP carve) is in the
runbook, `hook.setFloorRecipient` (sell-tax carve) is not, nothing requires them to name the same address, and
both are one-shot. The same shape recurs for staking: `RobinCurveV4.setStaking` and
`LockVault.setStakingRecipient` are separate one-shot platform calls for one concept, each silently defaulting
to "platform gets it" if missed.

**Fix direction.** Add `hook.setFloorRecipient` to the runbook and to a scripted post-launch wiring step that
asserts all of the one-shots are set together and consistently.

---

### M-8 · MEDIUM · The entire `StockPadFactory` launch path has zero executed local coverage  `PROVEN`

**Where** `contracts/test/MockPositionManagerV4.sol:48-54` vs `contracts/core/StockPadFactory.sol:218`.

The mock unconditionally decodes `params[2]`, because it was written against the 3-action batch
`MINT_POSITION, SETTLE_PAIR, SWEEP` that `PadFactory` (`:228`) and `RobinCurveV4` (`:639`) emit.
`StockPadFactory._mintSeedLp` emits only **two** actions, so the mock dies on `panic 0x32` (array
out-of-bounds) before doing anything:

```
panic code 0x32 … at MockPositionManagerV4.modifyLiquidities (contracts/test/MockPositionManagerV4.sol:54)
                  at StockPadFactory._mintSeedLp (contracts/core/StockPadFactory.sol:226)
```

`StockPadFactory` therefore cannot be exercised at all in the default suite, and its only test
(`test/fork/StockPadFactory.launch.fork.test.js`) calls `this.skip()` unless `FORK_RPC` is set. The 130-test
baseline executes **no** stock-pad launch — so H-2 is untested in both directions: nothing confirms the path
works either.

Related and worth flagging in the hand-off: the mock also **ignores `amount0Max` / `amount1Max` entirely** (it
decodes those fields as `,,`), so the real `PositionManager`'s slippage caps are unexercised outside the fork
suite. §4 has the numerical check that closes that specific risk.

**Fix direction.** Make the mock decode by action byte rather than by fixed index, and add a local
`StockPadFactory` launch test.

---

### M-9 · MEDIUM · The creator repoint covers the hook's book but not the curve's

> **STATUS: FIXED** in `ce119fc` · regression test `test/regression/M9-M27.creator-and-relaunch.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/hooks/RobinFeeHook.sol:406-420` (2-step repoint) vs
`contracts/pads/RobinCurveV4.sol:106` (`address public immutable creator`) and `:250-260` (`claimCreator`).

The hook gives the creator a proper 2-step repoint, so the sell-tax stream can always be redirected. The
curve's creator is `immutable`, and `claimCreator` pays it unconditionally:

```solidity
(bool ok,) = payable(creator).call{value: c}("");
if (!ok) { creatorEthOwed = c; revert EthSendFailed(); }
```

There is no repoint, no `claimCreatorTo`, and no other exit — `sweepToPlatform` explicitly subtracts
`creatorEthOwed` (`:285`), so the balance stays reserved forever. If the creator address is a contract that
reverts on ETH receive, a multisig later retired, or a lost key, the creator's **10% share of the raise is
permanently trapped** while the sell-tax stream keeps flowing to the repointed address.

`AUDIT-SCOPE.md:69` lists *"creator repoint is 2-step"* among the access-control invariants without noting it
covers only the hook's book.

**Fix direction.** Have `RobinCurveV4.claimCreator` read the creator from the hook
(`RobinFeeHook.config(poolId).creator`) so one repoint governs both — the curve already knows the hook and the
pool id. Failing that, add `claimCreatorTo(address)` callable by the current creator, and correct the
invariant text.

---

---

### M-10 · MEDIUM · The 2% tax cap is cosmetic: `lpFee` is capped only at Uniswap's 100%, and routes mostly to the platform

**Where** `contracts/core/RobinV4FeeConfig.sol:22` (`MAX_LP_FEE = 1_000_000`), `:101` (`_validate`'s only
`lpFee` check), consumed at `contracts/core/CurvePadFactoryV4.sol:166` (`fee: uint24(d.lpFee)` in the
`PoolKey`).

`_validate` enforces `buyTaxBps`/`sellTaxBps` ≤ `MAX_TAX_BPS = 200` — the 2%-per-side ceiling the trust story
rests on — and then permits `lpFee` up to **1,000,000 = 100%**, checking only that the dynamic-fee flag is
clear. But the pool's LP fee is not neutral revenue on a Robin pad: it accrues to positions the protocol
itself owns.

- **Curve phase:** the only in-range liquidity is the curve's own single-sided position, so the whole LP fee
  lands there. `RobinCurveV4._takeFeesToBook` (`:603-620`) splits the money-side leg
  `buyLpFloorShareBps` → floor, remainder → `platformEthOwed` (80/20 at production settings), and keeps the
  token leg for staking.
- **Post-graduation:** the permanent LP is owned by `LockVault`, whose `collectFees` books currency0 to
  `platformOwed` and currency1 to `stakingOwed` (`core/LockVault.sol:124-125`).

So `lpFee` is a second, uncapped tax on exactly the same trades, and its money-side share is predominantly
platform revenue. A FeeConfig owner can launch pads carrying an effective double-digit or higher levy while
`AUDIT-SCOPE.md` §3 and `RobinV4FeeConfig`'s own header advertise a ≤2%-per-side ceiling.

Reachability is owner-only and forward-only — live pads keep the fee they were born with, the change emits
`DefaultsUpdated`, and the pool fee is publicly readable in the `PoolKey` — so this is observable, not
stealthy, and it is not theft from existing holders. It is reported above a plain "the owner can set a fee"
note for three reasons:

1. **The contract leans on the false claim to justify having no timelock.** `RobinV4FeeConfig.sol:12-14`:
   *"Hard caps below bound what any future launch can carry, so even a compromised/fat-fingered owner cannot
   push a new pad's tax past the ceiling … so there is no timelock."* The caps do not bound `lpFee`, so the
   premise of the no-timelock argument is wrong.
2. **`DEPLOY.md:60` repeats the error at the system level** — *"The only mutable knob system-wide is
   `FeeWalletRegistry.platformFeeWallet` (Ownable2Step + 2-day timelock)."* `RobinV4FeeConfig.setDefaults` is
   a second mutable knob, `onlyOwner` with **no** timelock, and it governs both the fee and the geometry (see
   L-1). Same misstatement as L-6.
3. **`CurvePadFactoryV4.launch` is permissionless**, so between a bad retune and anyone noticing, unrelated
   third parties can launch pads that permanently carry the new fee.

**Fix direction.** Add a real ceiling: `MAX_LP_FEE` should be a Robin policy number (e.g. 10,000 = 1%), not
Uniswap's structural maximum. If a high `lpFee` is ever intended, state the *combined* effective take in
`AUDIT-SCOPE.md` §3 rather than the hook taxes alone.

### M-11 · MEDIUM · The locked LP's holder fees default to the platform, and on the curve path nothing ever wires them away  `PROVEN`

**Where** `contracts/core/LockVault.sol:81-89` (`registerLaunch` stores `stakingRecipient` verbatim, no zero
check), `:107` (`collectFees`, permissionless), `:143-153` (`claimStaking`, permissionless), specifically
`:149`:

```solidity
address to = lk.stakingRecipient == address(0) ? feeRegistry.platformFeeWallet() : lk.stakingRecipient;
```

**Reachability is the shipped default, not an edge case.** `RobinCurveV4.graduate()` registers the lock with
whatever `curve.staking` holds at that instant (`pads/RobinCurveV4.sol:360`), and `deploy-curve.js:121` tells
the operator to call `curve.setStaking(...)` *"at/near graduation"* — so registering with
`stakingRecipient == address(0)` is the normal outcome. Wiring it afterwards requires
`LockVault.setStakingRecipient`, a **second, separate** platform one-shot which appears **zero times in
`scripts/deploy-curve.js` and zero times in `DEPLOY.md`**. On the curve path — the flagship product — nothing
ever tells anyone to make that call. The default is therefore permanent, and every `claimStaking(tokenId, 1)`
routes the locked LP's token-side (sell) fees, an advertised holder reward stream, to the platform treasury
forever.

The `PadFactory` path is better documented but still has a window: `scripts/launch.js:52` passes
`stakingRecipient: ZeroAddress` into `launch()`, and `setStakingRecipient` only happens at `:102`, three
transactions later.

**The likely trigger is the project's own keeper, not a griefer.** `scripts/keeper.js:53` calls
`lockVault.claimStaking(L.lpTokenId, 1)` unconditionally in its sweep loop, and every step is wrapped in
`tryStep` (`:24-32`), which catches, prints a tick, and moves on. So an unwired pad is swept silently, the
operator sees `✓ staking LP (token) -> keeper`, and the fees are irreversibly at the treasury instead.

**Two corrections to the obvious framing.**

1. **It is misrouting, not theft, and the caller gains nothing.** Funds always land at
   `feeRegistry.platformFeeWallet()` — the 2-day-timelocked treasury. A griefer would pay gas to enrich the
   platform, and the platform gains nothing it did not already have, since it holds the one-shot
   `setStakingRecipient` and could simply point it at itself. The harm is that an outsider (or an honest bot)
   can pre-empt the platform's intent to route those fees to stakers, irreversibly.
2. **`collectFees` alone is safe.** It only credits `stakingOwed[tokenId][1]`; nothing leaves the vault. If
   nobody calls `claimStaking` during the unwired window, the whole accrual survives `setStakingRecipient`
   and pays the real recipient in full. The exposure is exactly the balance owed at the moment someone calls
   `claimStaking` — which is why the keeper matters more than the griefer.

Note the intended design: `stakingRecipient` is a *reward-keeper EOA*, not the pool. `launch.js:102` points it
at `rewardKeeper`, and `keeper.js:56-59` has that keeper forward the tokens on via `pool.fundToken(...)`.

**Fix direction.** Make the unwired case *park* rather than pay: revert `claimStaking` (or accrue) while
`stakingRecipient == address(0)`, exactly as `RobinFeeHook.claimFloor` already does with `NoFloorRecipient`
(`hooks/RobinFeeHook.sol:342`). That one change removes the silent-misroute hazard entirely and makes the
missing runbook step fail loudly instead of expensively. Independently, add `LockVault.setStakingRecipient` to
the curve runbook and to `DEPLOY.md` — see M-7 for the identical omission on the floor side.

---

> **Later correction.** "Registered with `stakingRecipient == address(0)`" is the normal outcome **only if
> nobody called `curve.setStaking` before `graduate()`**. `graduate()` copies that value into
> `registerLaunch`, and `LockVault.setStakingRecipient` refuses to run once the slot is non-zero — so on the
> ordering `deploy-curve.js` actually prescribes, the correction this entry's fix direction relies on is not
> available. See **L-32**.

### M-12 · MEDIUM · A presale's launch geometry is read at finalize, so an in-cap retune can leave the coin permanently un-graduatable  `PROVEN`

**Where** `contracts/presale/PresaleVault.sol:196-206` (`finalize` re-reads
`RobinV4FeeConfig(curvePadFactory.feeConfig()).defaults()`), `contracts/core/CurvePadFactoryV4.sol:118-122`
(`launch` derives `startTick`/`gradTick` from the same live struct), against
`contracts/core/RobinV4FeeConfig.sol:76` (`setDefaults`, `onlyOwner`, no timelock).

**What is wrong.** A presale commits its `LaunchConfig` at `createPresale` — but that struct
(`interfaces/ICurvePadFactoryV4.sol:8-17`) carries only name/symbol/decimals/supply/curveSupply/
reserveSupply/tickSpacing/creator. **No geometry.** `startTickMag`, `curveWidth` and `lpFee` — the values that
set the launch price — are read live at finalize, and `saltCommitment` covers only the three CREATE2 salts.
`PresaleVaultFactory.sol:12` states the deferral as a design choice (*"Heavy geometry/reserve validation is
deferred to `CurvePadFactoryV4.launch()` at finalize"*) without noting that it defers the price with it.

Nothing catches the change. `finalize`'s `KeyMismatch` guard (`:204`) **structurally cannot fire** — it
rebuilds the key from the same live struct `launch` just used, in the same transaction. There is no
min-tokens-out, no expected-geometry argument, and only `ZeroBought` (`:215`) as a sanity check. Contributors
have no exit they control: no withdraw function, and once `totalRaised == target`, `fail()` reverts
`TargetMet` (`:282`) until deadline + grace.

**The impact is not the pro-rata repricing — that part is nearly harmless.** The retune is *homothetic*: it
rescales the whole curve, so contributors buy the same slice of curve progress in a different denomination.
Measured realizable value destruction (claim, then instantly round-trip back into the same curve) is **3.44%
at baseline versus 3.60% after a −6,600-tick retune — an incremental 0.16pp, ~0.006 ETH on a 4.05 ETH raise**.
The 3–4% floor is the unavoidable fee stack, present either way. A "contributors lost N%" framing would be
wrong, because the token count falls and the unit price rises together.

**The real harm is that the reachable range is enormous, and one end of it kills the coin.** The only binding
constraints are `_validate` (`startTickMag > 0`, `curveWidth > minGradWidth > 0`),
`CurvePadFactoryV4.sol:120` (tick-spacing alignment), `:131` (tick bounds), and `:140`
(`reserveSupply·ss·100 >= curveSupply·sg·105`) — **and that last check constrains `curveWidth` only, never
`startTickMag`.** Measured at production geometry (201600 / 23000 / ts 100, 1B supply at 730M + 270M, 2 ETH
deposited):

| `startTickMag` at finalize | tokens the presale receives | outcome |
|---|---|---|
| 201600 (baseline) | 545,546,800 (74.73% of the curve) | normal |
| 195000 | 374,333,692 (51.27%) | −31% token count, ~unchanged ETH value |
| **100** (lowest that still passes every check) | **1.979899 tokens** (−99.9999996%) | graduation raise becomes ~5.6×10⁸ × 4.05 ETH — **the coin can never graduate** |
| 400000 | 99.99% of the curve for 0.020 ETH | harm runs the *other* way: the pad graduates on a 0.02 ETH raise |

Every case finalized cleanly — no revert, `KeyMismatch` never tripped, `state() == 1`, `claim()` paid at the
new price. At the low end the pad is permanently dead: contributor ETH has been spent into a curve that can
never sell out, so there is no locked LP, no staking stream and no graduation waterfall, ever. At the high end
the curve is given away for almost nothing.

**This is a centralization and operational footgun, not an attack.** The owner is negative-EV in the harmful
direction — forfeiting a ~0.405 ETH graduation cut to collect ~0.032 ETH of buy tax — so the realistic trigger
is an *honest, in-cap retune landing while presales are open*: precisely the operation
`CurvePadFactoryV4.sol:29-32` advertises as safe. And `RobinV4FeeConfig.sol:13-14`'s justification for having
no timelock — *"forward-only and can never touch an existing coin"* — is simply false about ETH already
sitting in a presale vault. That sentence is the defect being documented.

**Fix direction.** Snapshot `startTickMag` / `curveWidth` / `lpFee` into the vault at `initialize` and pass
them to `finalize` as expected values, reverting on mismatch — or fold them into `saltCommitment` so any
change is detectable. Correct `RobinV4FeeConfig.sol:13-14` regardless. Note that `DefaultsUpdated` *is*
emitted, so the change is observable on-chain; what is missing is any contract that acts on it, and any way
for a contributor to react before their ETH is spent (a preimage-holder can withhold `finalize` and let
`fail()` reason 2 open refunds after deadline + grace, but contributors cannot force that).

---

### M-13 · MEDIUM · Permissionless `flushStaking()` launders a dust poke through `DualStaking`'s rewarder gate and stalls the drip  `VERIFIED`

> **STATUS: FIXED** in `608599c` · regression test `test/regression/M13.relay-poke.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/RobinCurveV4.sol:395-403` (`flushStaking`, permissionless) →
`contracts/pads/DualStaking.sol:428-440` (`fundTokenPushed`, rewarder-gated) → `:246-252` (`_applyReward`
with `extend = true`).

`DualStaking` gates `fundTokenPushed` on `isRewarder[msg.sender]` precisely so that funding cannot be spammed.
But the pad's curve **is** registered as a rewarder in practice — `scripts/testnet-e2e-graduate.js:95` does
`ds.setRewarder(curveAddr, true)`, as do `test/fork/CurveGraduation.fork.test.js:83`,
`test/fork/MainnetSwarm.fork.test.js:147`, `test/unit/RobinCurveV4.graduation.test.js:65` and three more. And
`RobinCurveV4.flushStaking()` is **permissionless**, forwarding straight into that gated call.

The curve is therefore a confused deputy: anyone can call `flushStaking()` and have the rewarder gate treat it
as an authorised funding. **And it is not the only relay** — `RobinAmbushVault.flushFees()` (`:151`) is
likewise permissionless and reaches `fundTokenPushed` through `_forwardStaking()` (`:176`), so a pad that
wires its ambush vault as a rewarder exposes a second identical path. And `_applyReward` on the `extend = true` path resets the window —
`r.periodFinish = uint64(block.timestamp + dur)` — so each poke pushes the finish line out by a full duration
and re-divides the remaining reservoir over it. Note the asymmetry with the sibling path: the identical call
in `_fundStaking` (`:654-663`) **is** try/caught and gated behind a balance check; `flushStaking`'s only gates
are `!graduated` and `s == address(0)`, and its `fundTokenPushed` poke runs unconditionally — the `bal > 0`
check guards only the transfer on the line above.

**Sized correctly, this is a delay, not a loss.** Rewards are re-stretched, never burned: the delivered
fraction converges to `1 − e^(−t/duration)` regardless of how often the griefer pokes, so poking harder does
not deepen the harm past that curve. Measured with poking sustained throughout: **63.88% delivered at 7 days,
98.30% at 28 days** on a 7-day window; 99% takes 4.6× the duration (32 days instead of 7) and 99.99% takes
9.2× (64 days). The accurate statement is that the 7-day drip is stretched into a months-long asymptotic tail
for as long as someone keeps paying gas — not that it never pays out. The only permanently lost value is the
`(amount + leftover) / dur` truncation, ≤ 604,799 wei-units of an 18-decimal token per poke, which is dust.

**The codebase already named this exact band — for the other contract.**
`RobinLockStaking.sol:219-221` explains its fixed-`periodFinish` choice by describing precisely this grief:
*"a griefer could dust-fund (1 wei) repeatedly to re-stretch the undripped reservoir over a fresh full
duration each time and push `periodFinish` out forever, slowing honest stakers' rewards ~2.3-4.6x."* That is
the same 2.3–4.6× band measured here. The defence was reasoned through, written down, and applied to
`RobinLockStaking` — and `DualStaking` was left exposed to it through a relay the note did not anticipate.

**Scale it at production geometry.** The reservoir at risk is the graduation leftover streamed to staking —
**96,978,138 tokens, 9.70% of the 1B supply**, the same pot as C-1, roughly **$3.3k at the ~$34k graduation
market cap**. The relative damage (63.88% at 7 days) is geometry-independent.

**And it is mitigable — at the cost of re-opening L-2.** The `DualStaking` owner can stop it immediately with
`setRewarder(curve, false)`, after which the curve can no longer credit its own graduation stream at all.
That is precisely L-2. The pair has no configuration that satisfies both; only a code change does.

This is exactly the grief `RobinLockStaking._startDrip`'s `[audit]` comment was written to prevent — *"if a
top-up reset the window a griefer could dust-fund (1 wei) repeatedly to re-stretch the undripped reservoir
over a fresh full duration each time"* — and `DualStaking` is exposed to it through a relay the note did not
consider.

**Note the tension with L-2.** L-2 records that a curve *not* wired as a rewarder cannot credit its
graduation stream at all and that `flushStaking()` reverts `NotRewarder` for everyone. The operational fix for
L-2 — `setRewarder(curve, true)`, which the testnet script already does — is precisely what opens this. The
two must be fixed together.

**Fix direction.** Either gate `flushStaking()` (platform- or creator-only; it is a recovery path, not a hot
path), or have it call a non-extending variant, or make `DualStaking._applyReward`'s pushed path behave like
`RobinLockStaking._startDrip`'s mid-window branch and leave `periodFinish` fixed. The last is the most
consistent with the rest of the suite.

---

### M-14 · MEDIUM · `platformFeeWallet` is the protocol's root admin key, not merely a payout address

> **STATUS: NOT FIXED — flagged for a decision.** A fix was specced against the live code and put to a
> skeptic, which found a blocking problem: mechanically safe, but it relocates a time-critical per-pad capability onto the root cold key — a trust-model change. See §0 for the full reason. The finding below is
> unchanged from how it was filed.

**Where** `contracts/core/FeeWalletRegistry.sol` (the wallet), used as the **authorization** check in
`contracts/pads/RobinCurveV4.sol:447` / `:457` / `:467` (`setStaking` / `setFloor` / `setAmbush`),
`contracts/hooks/RobinFeeHook.sol:383` (`setFloorRecipient`) and `contracts/core/LockVault.sol:92`
(`setStakingRecipient`).

Every document describes this address as a destination. `FeeWalletRegistry`'s own header calls it *"THE ONLY
mutable knob in the entire Robin V4 system … only this one address"* and stresses *"no fee-rate change, no
pause, no fund movement, no LP path here."* `DEPLOY.md:60` repeats it. But the same address is also the
**capability** that binds, one-shot and irreversibly, every one of a pad's value sinks: where the sell-tax
floor carve goes, where the buy-LP floor carve goes, where the ambush share goes, where the staking stream
goes, and where the locked LP's token-leg fees go.

At launch all five are `address(0)` — the runbook wires them afterwards (`scripts/deploy-curve.js:119-122`) —
so whoever controls `platformFeeWallet` in that window permanently determines each one, with no undo and no
timelock on the *use* of the capability.

**Sized at production geometry, largest first:** the **staking sink is the big one — 96.98M tokens, about
1.0718 ETH realizable per pad**, roughly **5.3×** the ambush share (0.2023 ETH, per I-2). The floor carves and
the locked LP's token leg follow. It is worth stating in that order, because the ambush number is the one that
looks quotable and it is the smallest of them. (The 2-day timelock in `FeeWalletRegistry` governs *changing* the
wallet, not what the wallet can do.) Combined with M-4 — `setFloorRecipient` does not even require the target
to be a contract — a single transaction from that key can permanently point a pad's floor at an EOA.

This is the unifying statement behind M-4, M-7 and M-11, and it matters because it changes what an auditor
must assume about key management: the platform fee wallet needs the operational security of a root admin key,
not of a treasury receiving address.

**Fix direction.** Separate the roles — an `admin` (or the existing `Ownable2Step` owner) for the one-shot
wiring, and `platformFeeWallet` purely as a destination. If they must stay unified, say so plainly in
`AUDIT-SCOPE.md` §6 and `DEPLOY.md`, and drop the "only this one address / no fund movement" framing.

---

### M-15 · MEDIUM · The floor can only deepen while the price is *above* it, so any drawdown idles the carve  `PROVEN`

> **STATUS: NOT FIXED — flagged for a decision.** A fix was specced against the live code and put to a
> skeptic, which found a blocking problem: the proposed fix would have re-opened H-5 by re-introducing a live slot0 read; needs designing with H-5 and L-33 together. See §0 for the full reason. The finding below is
> unchanged from how it was filed.

**Where** `contracts/pads/RobinFloorVault.sol:110-116` (`addFloor`'s band guard), with the add-only design at
`:24-30`.

```solidity
(, int24 tick,,) = stateView.getSlot0(_poolId());
if (tick >= floorTickLower) { parkedQuote = amt; emit FloorSkipped(tick, amt); return 0; }
```

A single-sided currency0 add requires spot to sit **below** the range, so the vault can only deploy carve
while the token trades *above* the top of its own wall. The moment spot enters the band — the moment the price
falls to where the floor is supposed to start working — every subsequent carve delivery parks instead of
deploying, and keeps parking for as long as the token stays there.

**With the shipped parameters that window is tiny.** `scripts/launch.js:24` sets `FLOOR_BAND_SPACINGS = 20`
with `TS = 60` and `anchorTick` = the launch tick, giving a band of `[60, 1260]` — roughly 0.6% to 12% below
the launch price. So the carve deploys only while the token is within ~0.6% of where it launched. A 2.95%
drawdown puts spot at tick 299, **inside** the band with the wall barely touched, and from that point on every
sell-tax floor carve the pad ever earns parks in the vault and does nothing.

**This falsifies the guarantee, not just the tuning.** `AUDIT-SCOPE.md` §4.4 and the vault's own header state
the floor is *"ADD-ONLY — there is deliberately NO remove/withdraw path, so the wall can only ever deepen.
That absence IS the 'can't rug to zero' guarantee."* The wall can only ever deepen **while the price is above
it**. In the regime the floor exists for — a token trading down — it is frozen at whatever depth it happened
to reach before the first drawdown, while fee revenue earmarked for it accumulates unusable. **It is a conditional lock, not a burn — proven in both directions.** `addFloor()` reads
`currency0.balanceOfSelf()` fresh on every call, so the whole accumulated balance deploys in a *single* call
the instant spot returns below `floorTickLower`. Verified: after buying the price back to tick −33555, one
`addFloor()` emitted `FloorAdded`, minted 172,240,917,046,477,496,316 of liquidity and left the vault holding
**0.0 ETH — all 10 parked ETH recovered**. So `parkedQuote` being an overwrite rather than an accumulator
(I-1(9)) is cosmetic: the real ledger is the balance.

The accurate statement is therefore: **the funding window is one `tickSpacing` wide, so once a pad trades
below its anchor by that much — ~0.6% at `ts = 60` (hook pads, `scripts/launch.js`) or ~1.005% at `ts = 100`
(curve pads) — 100% of incoming floor carve sits idle, with no admin rescue, no re-anchor and no second band,
until the price recovers.** `RobinAmbushVault.seedAmbush` (`:127-137`) has the identical shape, which is why
I-2 exists. Nothing is stolen and nothing is permanently lost, but
the advertised mechanism does not operate in the state it was built for, and for a token that never recovers
its anchor it never operates again.

**Fix direction.** The band must be able to follow the price down, which a single fixed range cannot do.
Options: (a) let `addFloor` place *new* liquidity in a fresh band below current spot when the anchor band is
unreachable — every band stays add-only, so the "can't rug" property is preserved, since no remove path is
added, only more ranges; (b) accept the limitation and restate the guarantee honestly as "a fixed buy wall at
the launch price, funded while the token trades above it"; (c) at minimum surface the parked amount so
"wall is deep" and "carve is stuck" are distinguishable. Note (c) is cosmetic on its own — and per I-1(8)
`parkedQuote` is assigned rather than accumulated, so it does not even report the parked total correctly.

---

---

### M-16 · MEDIUM · `donateETH` promises donations reach holders untouched by the platform cut; `claim` takes it anyway  `PROVEN`

> **STATUS: FIXED** in `608599c` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/DualStaking.sol:396-401` (the `donateETH` NatSpec) against `:337-352` (`claim`).

The docstring is explicit, and it is aimed at creators:

> *"Permissionless ETH top-up of a side's reward stream — anyone (typically the CREATOR) can deposit ETH
> straight to holders WITHOUT being a rewarder and **WITHOUT touching the platform cut**."*

That is true of the deposit path — `donateETH` charges nothing and needs no rewarder role. It is false of the
money. `claim` applies `platformClaimFeeBps` to the **entire** accrued balance with no provenance tracking:

```solidity
uint256 amount = rewardsAccrued[side][asset][msg.sender];
uint256 fee = (amount * platformClaimFeeBps) / BPS;
```

Donated ETH is indistinguishable from rewarder-funded ETH by the time it is claimed, so the platform takes its
cut of it — up to `MAX_CLAIM_FEE_BPS` = 10%. A creator who donates 50 ETH to their holders on the strength of
that sentence hands up to 5 ETH to the platform instead.

**Measured:** with `platformClaimFeeBps = 0`, a creator donates 50 ETH; the sole staker accrues
`earned = 49.9999999999995936 ETH` over the 7-day window; the owner then calls `setPlatformClaimFee(1000)`
and the claim credits `platformFeesOwed[ETH]` with 10% of it. Note this compounds M-5: the fee is applied at
claim time, so it reaches ETH donated long before the fee existed.

**Fix direction.** Either honour the docstring — track donated principal separately and exempt it from the
claim fee — or correct the sentence to say the exemption applies only to the deposit, not to the payout. The
second is a one-line change and is what the code actually does.

---

### M-17 · MEDIUM · The same short-return gap freezes `DualStaking` principal  `PROVEN`

> **STATUS: FIXED** in `b405502` · regression test `test/regression/H3.short-return.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/DualStaking.sol:186-196` (`boostOf`), reached from `_reweigh` on every `stake`,
`unstake` and `sync`.

Same root cause as H-3. `boostOf`'s NatSpec promises *"Never reverts"* and it is wrapped in `try/catch`, but a
boost oracle that returns fewer than 32 bytes makes the decode revert in `boostOf`'s own frame.

**PROVEN.** Deploy a 5-byte contract whose runtime is `60006000F3` (returns empty for any selector), then
`setBoostOracle(thatAddress)`:

| | before | after |
|---|---|---|
| `boostOf` | 10000 | **reverts** |
| `stake` | works | **reverts** |
| `unstake` | works | **reverts — principal frozen** |

`setBoostOracle` (`:466-469`) validates nothing — not zero, not `code.length`, not the interface — and the
reachable bad values are ordinary operational mistakes: an EOA, a CREATE2 address for an oracle not yet
deployed, or a proxy whose implementation slot is momentarily zero.

**It is recoverable, which is why MEDIUM not HIGH.** `setBoostOracle` is a plain assignment with no one-shot
guard, so the owner can point it back at `address(0)` (which short-circuits to `BPS` before any call) or at a
working oracle, and everything resumes. But until they do, every staker's principal is frozen, and the freeze
is invisible until someone tries to unstake.

**Fix direction.** As H-3: low-level `staticcall` with a `returndata.length == 32` check. Also validate the
oracle has code at set time — it does not make the contract safe, but it removes the commonest way in.

---

### M-18 · MEDIUM · The "LOCKED SPEC" describes the ambush as the exact **mirror image** of the ambush that shipped  `VERIFIED`

> **STATUS: FIXED** in `4fe6d2b` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `ROBIN-V4-CURVE-SPEC.md:31-39` ("Ambush (held reserve, active from launch)"), against
`contracts/pads/RobinAmbushVault.sol:30-44` (the contract's own header) and
`contracts/pads/RobinCurveV4.sol:685-696` (`_fundAmbush`).

`AUDIT-SCOPE.md:6` lists `ROBIN-V4-CURVE-SPEC.md` as one of four companion documents for the external review,
and the spec's own first lines call it *"the locked reference — build to it."* It is not a stale draft; it is
handed to the auditor as ground truth. On the ambush it is wrong in every structural dimension, and each error
inverts the mechanism rather than blurring it:

| | `ROBIN-V4-CURVE-SPEC.md:31-39` | `RobinAmbushVault` as shipped |
|---|---|---|
| what the band holds | **token** ("single-sided TOKEN sell-wall") | **ETH** ("at/above the graduation price the band holds only ETH") |
| where it sits | ticks ***below*** the graduation tick | `ambushTickLower = _alignUp(gradTick + 1, ts)` — strictly ***above*** `gradTick` (`:108-111`) |
| what it does to price | "**capping pumps**" | "it can **NEVER cap the chart**" (`:35`); it *buys dips* |
| where it is funded from | tokens "**held back** (not sold on the curve)" | `ambushGradBps` (5%) of the **ETH raise**, wired at graduation (`RobinCurveV4.sol:685-696`) |
| when it is live | "**active from launch**" | funded at graduation, then a separate permissionless `seedAmbush()` (see I-2) |
| at graduation | "the remaining ambush tokens **pair the permanent locked LP**" | contributes nothing to the LP; the band is add-only and permanent |

The spec even names the shape it is not: *"implemented in `RobinAmbushVault` as the exact mirror of the audited
`RobinFloorVault`."* The shipped vault is not the floor's mirror — it is a **second buy-wall on the same side**,
one band above it. The spec's money model inherits the error: it lists the floor as fed by "the ambush's pump
sales", a revenue line that cannot exist for a band that never sells into pumps.

This is not a documentation nit, and it is not M-6 again. M-6 is a *stale* architecture document — it describes
an older system that once existed. This is a **currently-authoritative** document describing the sign-flipped
version of a live contract, in the one subsystem where getting the sign wrong changes what the auditor looks
for. An auditor reading §"Ambush" will go hunting for token-side inventory risk, sell-wall exhaustion, and
pump-capping complaints from holders. None of those exist. Meanwhile the real risks of an ETH buy-wall — the
seeding race in I-2, the add-only ETH that cannot be withdrawn, and L-17's stranded token fees — are in a part
of the design space the spec tells them is not there.

It also means the *product* question was never settled on paper. "Held-back tokens that cap pumps and then pair
the LP" and "5% of the raise parked as a permanent dip-buyer" are different products with different token
economics, and the launched supply split (`curveSupply`/`reserveSupply`) reflects only the second.

**Fix direction.** Rewrite §"Ambush" and the ambush line of the money model to describe the shipped vault, or —
if the spec is the intent and the contract is the deviation — say so explicitly and treat the divergence as a
design decision to be re-approved. Either way it must not go to an external auditor in its current state. Do
this together with M-6; the two documents disagree with the code in different directions, so fixing one alone
still leaves the package self-contradictory.

---

### M-19 · MEDIUM · The invariant suite tests the case **adjacent** to each of this report's findings  `VERIFIED`

**Where** `AUDIT-SCOPE.md` §4 ("Key invariants — what to try to break") against the 34 test files under `test/`.

This is a process finding, not an exploit: nothing here loses money by itself. It is filed at MEDIUM because it
is the single most useful input to the remediation plan — it says which regression test to write next to each
fix, and it explains why these particular defects shipped in code this careful. Every invariant in §4 **does**
have executing tests. In six cases the test covers the shape one step away from the defect.

| §4 invariant | what the suite executes | what it does not reach |
|---|---|---|
| 1. Money conservation | `economics.sim`: *"platform+creator+floor owed == every wei skimmed; claims drain exactly"*; `curve.graduation.sim`: mixed tape + donation, curve ends empty | — covered |
| 2. Split-backing solvency | `RobinFeeHook.skim`: buy claim → platform+buffer, sell take → creator+floor | — covered |
| 3. Non-bricking | `adversarial`: blocklisted currency (D2), malformed `hookData`, hostile referrer, reverting floor sink, *"the stock curb … when adapter **reverts**"* (`MockGuardAdapter`) | an adapter/oracle that **returns nothing** — a revert is caught, a short return is not (**H-3**, **M-17**). The whole invariant rests on `try/catch`, and the one case `try/catch` cannot absorb is the one case not tested. |
| 4. Permanent lock | `LockVault`: *"exposes NO liquidity-exit selector"*; floor and ambush: *"exposes NO remove/withdraw selector"* | — covered (structural selector-absence tests, the right shape) |
| 5. Raise integrity | `curve.graduation.sim` (donation); `grief.test`: a griefer plants **one deep position**, `tickLower: GRAD-120, tickUpper: GRAD, liquidityDelta: 10000e18` → `CeilingNotRestored` → `restoreCeiling()` recovers | **depth** is tested, **breadth** is not: **C-2** plants ~100 wei across many *initialised ticks*, which does not stop the nudge — it makes the tick-bitmap walk exceed the block gas cap, so `restoreCeiling()` is bricked too. Also untested: swap-sourced ETH counted as raise (**L-8**). |
| 6. Governance | `RobinV4FeeConfig`: caps, retune-within-caps, param sanity | nothing asserts a retune cannot reach an **open presale** (**M-12**), and `lpFee` has no policy bound to assert (**M-10**) |
| 7. Access control | `setFloorRecipient` platform-only + one-shot; `registerLaunch` factory-only + one-shot; `setStakingRecipient` platform-only + one-shot; creator repoint 2-step | `LockVault.setFactory` is tested only for `NotInitializer` and `FactoryAlreadySet` — **nothing asserts it points at a curve factory**, which is exactly **M-2**. The one-shot is proven; its *target* is not. |

The pattern is consistent enough to be worth naming: the suite proves each mechanism **works**, and proves it
**cannot be called by the wrong party**, but rarely proves it was **pointed at the right thing** or that it
survives the *malformed* rather than the *hostile* input. That is the same seam §2 identifies in the contracts,
showing up in the tests.

Two gaps are structural rather than adjacent, and are recorded elsewhere: the entire `StockPadFactory` launch
path has no executing local coverage at all (**M-8**), and `test/fork/*` — the only place the real
`PositionManager`, real Permit2 and real `nextTokenId` are exercised — needs a `FORK_RPC` that CI does not
appear to provide (§5).

**Fix direction.** Add one regression test per fix, aimed at the uncovered variant rather than re-covering the
tested one: a `MockShortReturnAdapter` returning zero bytes (H-3, M-17); a dust-breadth planter that initialises
N ticks and measures `graduate()` / `restoreCeiling()` gas against the 30M cap (C-2); an assertion in the launch
path that `lockVault.factory() == address(curveFactory)` (M-2); a presale whose FeeConfig is retuned between
`createPresale` and `finalize` (M-12). Each is a few lines against a harness that already exists.

---

### M-20 · MEDIUM · `donateETH` is the one permissionless funding path that passes `extend=false`, so a creator's gift streams over the *residue* of the live window  `PROVEN`

> **STATUS: FIXED** in `d85dfeb` · regression test `test/regression/M20.dualstaking-jit.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/DualStaking.sol:399-406` (`donateETH`), `:245-253` (`_applyReward`'s two branches),
against the `[AUDIT]` NatSpec at `:393-398` that justifies the design.

**This finding also corrects C-1.** C-1 clears `DualStaking` on the ground that its route into `_applyReward`
passes `extend == true`. That is true of the *stake* path (`_kickstartPending:233`) and of every **gated**
funding path — `fundETH:389`, `fundToken:421`, `fundTokenPushed:438`, `receive():509`. It is not true of the
contract. Enumerating all six call sites, **two pass `extend = false`**: the forfeit recycle at `:321`, and
`donateETH` at `:404` — which is also the only one of the six with **no `isRewarder` gate**. Permissionless
*and* `extend = false` is the combination that matters, and exactly one function has it.

**Mechanism.** `_applyReward` compresses when `extend == false` **and** a window is still live:

```solidity
if (extend || block.timestamp >= r.periodFinish) {   // fresh: full duration
    ...
    r.rewardRate = (amount + leftover) / dur;
    r.periodFinish = uint64(block.timestamp + dur);
} else {                                             // compress into what is left
    uint256 remaining = r.periodFinish - block.timestamp;
    r.rewardRate = ((remaining * r.rewardRate) + amount) / remaining;
}
```

So a donation does not get its own window — it is divided by however many seconds happen to remain. The
comment at `:397-398` describes this as the safe choice (*"a donation TOPS UP the live stream (raising the
rate) but can NEVER push `periodFinish` out — otherwise a 1-wei spammer could perpetually reset the window"*).
It stops the dilution it names and creates a sharper problem: **who receives the donation is decided by who is
staked during those residue seconds, not by who supported the pad.** `periodFinish` is a public getter, so the
residue is not a race — it is a schedule.

**Measured**, against the real `DualStaking` on a local chain. Honest setup: alice stakes and a 1 ETH stream
runs for 7 days. At `periodFinish − 121`, a whale stakes and the creator donates 10 ETH "to holders":

| | |
|---|---|
| `periodFinish` after the donation | **unchanged** — the comment's stated invariant does hold here |
| `rewardRate` after the donation | **0.08403526688453159 ETH/sec** — 10 ETH over 121 seconds |
| alice — staked the **entire 7 days** | **1.0998 ETH** |
| whale — staked **121 seconds** | **9.9002 ETH = 99.00% of the creator's gift** |

With an equal-sized JIT stake instead of a whale one, the split is 5.0001 / 5.9999 — the compression is the
defect, and the attacker simply sizes their stake to choose their share of it. This voids the contract's own
headline claim at `:31-33` (*"rewards STREAM over a window (a flash-staker accrues ~0)"*) for the whole
donation channel — the channel `:393-395` explicitly aims at creators.

**The second half: 1 wei installs a window whose expiry the attacker chooses.** `extend = false` only selects
the compressing branch while a window is live; once `block.timestamp >= r.periodFinish`, the **fresh** branch
runs regardless of `extend` and writes `periodFinish = block.timestamp + dur`. So the invariant in the comment
— *"can NEVER push `periodFinish` out"* — is false precisely when the previous window has lapsed. Measured on
a never-funded pool with one staker, called by an account that is **not** a rewarder:

```
donateETH{value: 1}  →  rewardRate == 0,  periodFinish − now == 604800
after 8 days         →  earned() == 0, and the 1 wei is stranded in the contract
```

That is C-1's arming primitive in a second contract: for 1 wei an attacker installs a live 7-day window on a
pool nobody has funded, at a moment of their choosing, and every donation arriving inside it is compressed
into whatever residue remains. It converts the compression from an accident that bites late donors into
something that can be scheduled.

**Severity.** MEDIUM, not HIGH: the attacker must actually post the stake and be exposed for the residue
(minutes, not seconds of risk-free time), and nothing is taken from principal or from the pool's solvency —
this redirects *donated* value between stakers. It is not LOW because the redirection is near-total at
attacker-chosen size, the channel is the one creators are told to use, and both halves are permissionless.

**Fix direction.** Give a donation its own window rather than the residue: pass `extend = true` from
`donateETH` as every other funding path does. The dilution the comment fears is then handled where it
belongs — by requiring `msg.value >= duration` (which also stops the `rewardRate` truncation to zero and the
1-wei arming), or by rate-limiting donations, not by compressing them. Correct `:397-398` either way: the
invariant it asserts does not hold across a lapsed window. If the residue behaviour is deliberate, the
anti-JIT claim at `:31-33` must be qualified to exclude donations.

---

### M-21 · MEDIUM · The floor/ambush ETH books have exactly one exit, it is a one-shot, and spending it on a non-receiving contract burns the funds silently  `PROVEN`

> **STATUS: FIXED** in `032191e` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/RobinCurveV4.sol:457-473` (`setFloor` / `setAmbush`, platform-only, one-shot),
`:665-680` (`_fundFloor`) and `:682-696` (`_fundAmbush`), against `:381` (step 9) and `:283-291`
(`sweepToPlatform`).

Both ETH books are excluded from every sweep by design — `:381` computes
`platformEthOwed = balance − floorEthOwed − creatorEthOwed − ambushEthOwed − bounty`, and `sweepToPlatform`'s
subtotal (`:285`) subtracts them again — so the *only* way either book leaves the curve is a successful
`call{value:}` to the address its one-shot setter holds.

**The obvious reading is wrong, and worth stating so nobody re-files it** — *with one exception added later,
see the note below.* Never wiring the sinks does **not** burn the money. `_fundFloor`/`_fundAmbush` return early leaving the book intact (`:669`, `:686`), and a *late*
`setFloor` + `flushFloor` recovers it in full. Measured: graduating fully unwired leaves
`floorEthOwed = 0.383736708601921926` and `ambushEthOwed = 31.881124873009680078` booked;
`sweepToPlatform()` moves neither; `flushFloor()`/`flushAmbush()` both revert `ZeroAddress` — and then a late
`setFloor(realVault)` + `flushFloor()` drives `floorEthOwed` to **0.0**. The retry design works.

**What actually burns the funds is spending the one-shot on a contract that cannot receive ETH.** The setter
validates only `a != address(0) && a.code.length != 0` (`:470`) — it never checks that the target can accept a
value transfer, or that it is a vault at all. `_fundAmbush` then re-parks on the failed send (`:692`) and
returns **without reverting**, and `setAmbush` can never be called again. Measured, continuing the same run:

```
setAmbush(<a TestERC20 — has code, no payable receive>)
flushAmbush()                    → succeeds, emits nothing, parks
ambushEthOwed                    → 31.881124873009680078 ETH, unchanged
setAmbush(anything else)         → reverts AlreadySet — the setter is permanently spent
```

Three properties compound into the severity. The failure is **silent**: `flushAmbush()` returns success, so an
operator running it sees no error and no event, and only a balance check reveals that nothing moved. It is
**terminal**: one-shot, no re-point, no clear, no timelock, no admin escape, and `sweepToPlatform` is
specifically written to leave the book alone. And the plausible mis-wires all have code — pointing at the pad
token, the hook, or another pad's vault passes `code.length != 0`; `PadToken` in particular is a plain OZ
ERC20 with no `receive()`, so it produces exactly this state.

The comments describe the park as *"retriable"* (`:675`, `:692`) and the design as *"non-bricking"*. Both are
true of a *transient* failure — a vault that is temporarily reverting — and false of the case the setter's own
weak validation admits, where retrying the same dead address forever is the only option the contract has.

> **Later correction.** The recovery measured above was run **after graduation**. `flushFloor`'s `!graduated`
> check is unconditional and runs *before* the wiring check, so on a pad that never graduates the floor book is
> unreachable however it is wired. See **L-35**.

**Not the wiring cluster, and not M-4.** M-7/M-11/L-3/L-17 are all "a sink was never wired, so value sits
waiting" — recoverable by wiring it, as measured above. M-4 is the floor *band anchor* being an unverifiable
deploy parameter. This is the narrower and worse case: the wiring *happened*, it was accepted, and it consumed
the only chance to get it right.

**Fix direction.** Two independent fixes, either sufficient:
- **Probe the sink at set time.** In `setFloor`/`setAmbush`, send 1 wei (or `call{value: 0}`) and require it
  succeeds, so a non-receiving target is rejected before the one-shot is spent. Cheap, and it turns a silent
  permanent loss into a revert at the moment the operator can still fix it.
- **Make the re-point possible while the book is non-zero.** Allow `setFloor`/`setAmbush` to be re-pointed by
  the platform for as long as the corresponding `*EthOwed > 0` and the current sink has never successfully
  received — which preserves the "immutable once it works" property the one-shot is protecting.

Independently, `flushFloor`/`flushAmbush` should **revert** (or at minimum emit) when the send fails, rather
than returning success. Silent failure is what makes this survivable long enough to become permanent.

---

### M-22 · MEDIUM · One reverted `finalize()` burns the salt commitment forever, and the reveal survives even on a chain with no public mempool  `PROVEN`

> **STATUS: NOT FIXED — flagged for a decision.** A fix was specced against the live code and put to a
> skeptic, which found a blocking problem: the proposed recommit is sealed by the very state M-22 measures; the workable alternative is a presale-terms decision that must land with L-20. See §0 for the full reason. The finding below is
> unchanged from how it was filed.

**Where** `contracts/presale/PresaleVault.sol:164-167` (guard order), `:123` (`saltCommitment` written once
inside the one-shot `initialize`, with no setter anywhere), against the header's security claim at `:31-35`.

`finalize` takes the three salts as plain calldata and validates them **last**:

```solidity
if (finalized || failed) revert NotOpen();        // :165
if (totalRaised < target) revert TargetNotMet();  // :166
if (keccak256(abi.encode(tokenSalt, hookSalt, curveSalt)) != saltCommitment) revert BadReveal();  // :167
```

Any call that trips `:165` or `:166` has **already carried the real preimage on-chain**. A reverted transaction
is still mined, and its calldata is public forever — so the reveal does not depend on a mempool at all. That
matters because the header defends the design precisely on mempool grounds: *"on Robinhood Chain's
single-sequencer FCFS ordering (no public mempool) the finalize tx can't be sniped."* Block history is public on
that chain too, so the defence is defeated on the chain it names as safe.

There is no recovery: `saltCommitment` is assigned once at `:123` and no function writes it again. Once the
preimage is public, `CurvePadFactoryV4.launch(cfg, salts)` is permissionless and fully determined by
`cfg` + salts, so any stranger can land the committed launch whenever they like; the vault's own `finalize`
then reverts inside the try and the catch marks the presale `Failed(3)`.

**The trigger is benign, which is what makes it likely.** Calling `finalize` before the target is met — an
operator or a bot jumping the gun — is enough. So is a retry after someone else's `fail()`. Neither is an
attack; both are ordinary operational noise, and either one permanently spends the commitment.

**Measured.** Salts recovered from the reverted transaction's calldata match `saltCommitment` exactly; a
stranger's `launch` with those salts returns token `0x83BF85492891564659896b9f55098749F626E166`, equal to the
predicted CREATE2 address; the presale then emits `Failed(3)` and `state() == 2`.

This falsifies two claims in the package: the header at `:31-35`, and **L-9**'s bound in this document, which
cited the presale as the place the pre-committed-address problem is already handled. L-9 has been corrected.

**Fix direction.** Check `BadReveal` **first**, before `NotOpen` and `TargetNotMet` — a one-line reordering that
means a premature or duplicate call reverts without ever having a correct preimage compared against it. That
alone does not help the caller who reveals correctly into a `TargetNotMet` revert, so also either (a) allow the
platform or creator to re-commit while `!finalized && !failed`, or (b) take the salts as a signature/preimage
bound to `msg.sender` so a leaked preimage is not universally replayable. Fix the header comment regardless: a
mined revert publishes calldata on any chain.

---

### L-20 · LOW · `finalize()` has no upper time bound, so the grace period is a race rather than an expiry  `PROVEN`

**Where** `contracts/presale/PresaleVault.sol:164-167` (`finalize` reads **no** timestamp at all) against
`:272-284` (`fail`, which is time-gated) and the NatSpec at `:35-36` / `:269-271` describing `finalizeGrace` as
an escape hatch.

`fail()` is gated on `deadline` and `deadline + finalizeGrace`; `finalize()` is gated on neither. So once the
target is met, the preimage-holder's option to launch **never expires**. Past `deadline + finalizeGrace` both
functions are live and permissionless simultaneously, and the outcome is decided by whoever transacts first —
indefinitely.

Contributors have no unilateral exit: `deposit` is irreversible, `refund()` requires `failed` (`:300`), and
`fail()` reverts `TargetMet` inside the grace window (`:282`). Their only escape is to win a race they must pay
gas for, and for a small contributor that gas can exceed their share.

**Measured:** a presale that met target on day 0, with `deadline = now + 2 days` and `finalizeGrace = 7 days`
(`GRACE_MAX`), was successfully finalized **365 days after the escape hatch opened** — `Finalized` emitted,
`state() == 1`, the pad launched and the curve bought with the full raise.

This is L-13 from the opposite end. L-13 is that the grace is anchored to `deadline` rather than to when the
raise closed, so contributors are locked for up to 37 days. This is that after those 37 days the creator's
option does not lapse *at all*. Combined with **M-12** — geometry is read live at `finalize` — the price the
option is exercised at is not the one anyone contributed against, a year later.

**Fix direction.** Gate `finalize` on `block.timestamp <= deadline + finalizeGrace`, which is what the NatSpec
already describes. Then the grace is an expiry, `fail()` becomes the only reachable path afterwards, and L-13's
lock acquires a ceiling.

---

### L-21 · LOW · `createPresale` accepts configs that `launch` rejects unconditionally, and `initialize` validates no `cfg` field at all  `PROVEN`

**Where** `contracts/presale/PresaleVaultFactory.sol:34-51` (`createPresale` checks only
`saltCommitment != 0`; `cfg` passes straight through), `contracts/presale/PresaleVault.sol:113-118`
(`initialize`'s bounds cover `target`/`deadline`/`minContribution` — no `cfg` field), against
`contracts/core/CurvePadFactoryV4.sol:112-115`.

The five `BadConfig` conditions at `CurvePadFactoryV4:112-115` are **pure functions of `cfg`** — no geometry, no
FeeConfig, no timing, nothing retunable. They can be evaluated at `createPresale` for the same gas they cost at
`launch`, and are not. So a presale whose `supply` is one wei off `curveSupply + reserveSupply` is registered
(`isPresale == true`), advertised, funded by the public to target, and discovered dead only at `finalize` —
where the launch revert hits the blanket catch and is mislabelled `Failed(3)`, *"sniped"*, irreversibly. An
operator then hunts a front-runner that never existed.

The same gap covers the presale's own terms: `initialize` enforces `minContribution <= target` but never
`minContribution <= perWalletCap`, so a vault in which **every possible deposit reverts** — below the floor →
`BelowMin`, at or above it → `CapExceeded` — is creatable and sits in the registry looking live.

**Measured.** (a) `launch.staticCall` → `BadConfig`, yet `createPresale` succeeds, `isPresale == true`, 3.0 ETH
raised from two wallets, `finalize` → `Failed(3)`, `state() == 2`, retry → `NotOpen`. (b) deposits of 0.5 / 1 /
3 ETH all revert on a `minContribution > perWalletCap` vault.

Contributors recover 100% via `refund()`, so this is availability and dead capital — up to L-13's 37 days at the
permitted maxima — not loss. Distinct from **M-12**: those fields are not geometry, are not governed, and are
not retunable; the config is invalid at the instant of `createPresale`.

**Fix direction.** Re-run the five `BadConfig` checks in `createPresale` (or expose them as a `view` on the
factory and call it), and add `minContribution_ <= perWalletCap_` to `initialize`'s bounds.

---

### L-22 · LOW (gating the stock pad) · The corporate-action curb can only enforce the half of its window *before* the event

**Where** `contracts/hooks/RobinFeeHook.sol:189-196` (the curb), `contracts/adapters/StockQuoteAdapter.sol:86-97`
(`scheduledEffectiveAt`), `contracts/interfaces/IRobinInterfaces.sol:39` (`guardWindow` documented as seconds
*around* a scheduled action).

The curb computes `diff = |block.timestamp − ea|` and reverts while `diff <= guardWindow`, which reads as a
symmetric halt over `[ea − w, ea + w]`. But the hook stores **no** per-action state — it re-derives `ea` on
every swap from the adapter, and the adapter only returns one while the action is still *pending*:
`scheduledEffectiveAt()` reads `newUIMultiplier()` and returns 0 when it is 0 (`:87-88`). `newUIMultiplier` is
by name the not-yet-applied multiplier, so the moment the stock token applies the action and clears that slot,
`scheduledEffectiveAt()` returns 0, the `if (ea != 0)` gate at `:191` fails, and the pool reopens — at `ea`,
not at `ea + w`.

Whether *any* of the post-event half is enforced is therefore decided by a third-party contract's cleanup
timing, which this repository does not control and cannot observe. And it is the wrong half to lose: the window
after `ea` is exactly when a price discontinuity has already landed and a stale pool price is arbitrageable
against the new share basis. The passive counterparty is the pad's own locked graduation LP plus the floor and
ambush bands.

Argued from source rather than measured — the deciding behaviour lives in the third-party stock token, and
neither `MockStock` nor `MockGuardAdapter` models the clear-on-apply step (which is itself a gap, given M-8).
The code-side claims are exact: the curb's only inputs are `block.timestamp` and the live adapter read, and the
hook holds no corporate-action state.

Note this reaches the **opposite** conclusion to H-2's treatment of the same curb. H-2 is that `guardWindow` and
`guardAdapter` are unbounded launcher-chosen inputs, i.e. a *freeze* primitive — too much curb. This is that on
a genuine adapter the curb is *self-clearing* on the side that matters — too little. Both are true, of different
inputs, and a fix for one should not be assumed to address the other.

**Fix direction.** Latch the action in the hook: on first observing a non-zero `ea`, store it per pool, and
enforce the window from stored state until `block.timestamp > ea + guardWindow` — so clearing the source cannot
reopen the pool early. Failing that, document the curb as pre-event only and stop describing `guardWindow` as
"around".

---

### H-5 · HIGH · `addFloor()`'s slot0-only guard flips the parked carve from "mint nothing" to "mint everything at a stale band" — 88.43% forced-fill loss, measured  `PROVEN`

> **STATUS: FIXED** in `9bf789f` · regression test `test/regression/H5.floor-forced-fill.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

*(Filed initially as M-23. Promoted, and its mechanism corrected — see "the diagnosis was wrong" below.)*

**Where** `contracts/pads/RobinFloorVault.sol:109-119` (`addFloor`, permissionless), `:137` (`_add`'s sizing),
against the round-trip argument in `AUDIT-SCOPE.md` §4.4 that §4 of this document endorses.

`addFloor()`'s entire protection is one live `slot0` read:

```solidity
if (tick >= floorTickLower) { parkedQuote = amt; emit FloorSkipped(tick, amt); return 0; }
```

No TWAP, no block delay, no rate limit, no cap on `amt`, no caller gating. In **M-15**'s state — the pad has
dumped, spot sits at or above the band, the carve has been parking — an attacker buys to force the tick below
`floorTickLower`, calls `addFloor()`, and sells back.

**Measured — and the magnitude is regime-dependent, with the attribution still contested.** Five independent
constructions were run, four at the shipped hook config (`buyTaxBps = sellTaxBps = 100`). **Robust across all
of them:**

- the guard bypass is real and reproducible — `floorLiquidity` goes 0 → non-zero inside the attacker's own
  transaction, in every run;
- the attack is **profitable**, including in a fully atomic construction using a real attacker contract and a
  real 0.05% flash loan (**+4.0684 ETH**, with every fee and the flash premium inside the figure);
- the honest baseline is that the carve **parks** and nobody loses anything — all of it is attacker-created;
- the pad loses either way: both candidate counterparties, the floor band and the graduated locked LP, are
  protocol-owned and un-withdrawable.

**The apparent conflict between runs resolves into a threshold, and two independent constructions agree on
where it is.** The attacker pays a **fixed** cost to shove the tick from above the band down past
`floorTickLower` — measured at ~1.5 ETH of price impact plus 2–4% in LP fee and buy tax on the push. That cost
scales with the **pool's depth**; the extractable margin scales with the **parked balance**. So there is a
ratio threshold, independently measured at **~4–5%** and **~5–7%** of the pool's ETH-side depth (the latter
verified scale-invariant at 1×/100×/1000×). Above it the attacker profits; below it they do not.

**But the vault loses in both modes, which is the part no single run showed:**

| regime | attacker | vault |
|---|---|---|
| parked **above** ~5% of pool ETH depth | **profits** — realized, token-flat: +0.32, +0.33, +0.86, and **+4.07 ETH** in a fully atomic build with a real 0.05% flash loan | loses |
| parked **below** the threshold | **loses** (−0.21 ETH at 2% of pool depth, at every dump depth tested) | **still loses 39–77% of the parked carve** |
| spot only *marginally* above the band | loses (−0.0247 ETH) | safe |

So below the threshold this is not a profitable exploit — it is **pure griefing that still burns 39–77% of the
floor**, available to anyone willing to eat the push cost. Above it, it is profitable extraction. Either way the
carve is destroyed against a baseline where it would simply have parked and lost nothing.

> **Two figures withdrawn, and the accounting rule they establish.** An earlier revision quoted **+28.84 ETH**
> attacker profit and a **36.25 ETH** vault loss from one construction. A later skeptic reproduced that run **to
> the wei** and showed neither means what it claimed. The +28.84 is a **mark on a short** — the attacker ends
> 701.9e18 token short, valued at the pinned spot; forcing the same attacker token-flat on the identical setup
> collapses it to **+0.33 ETH**, and forcing full liquidation instead raises it to +379 ETH. A number that moves
> 87× down or 13× up with the convention is not a settled PnL. And the 36.25 ETH "vault loss" was **reproduced
> identically with no attacker present** — it is the band filling as price moves, which is the band's job, not
> attack damage. Both struck.
>
> Every figure above therefore obeys: **count only realized wei with the attacker ending token-flat, and measure
> the vault against a no-attacker baseline on the same tape.** Marks on inventory are not profit; a loss that
> happens anyway is not an attack cost. This is the same trap that earlier produced a phantom +0.924 ETH — it
> caught a headline number the second time, and one this document had quoted.

Two qualifiers stated because they bound the finding honestly. Reaching the threshold takes accumulation: the
carve is 0.2% of sell output (1% sell tax × 20% floor share), so parking ~5% of pool ETH depth needs sell volume
on the order of **25× the pool's ETH depth**, accumulated *while the token sits dumped above the band* — very
plausible for a graduated memecoin, but a real precondition rather than a given. And a **mild** dump is safe:
profit requires spot materially above the band, which is exactly M-15's state.

The remaining disagreement is narrow and about **attribution**, not existence: whether the value comes
principally from the floor band or the graduated locked LP varies with regime and with whether the vault is
marked at the attacker's chosen final spot or at the pinned pre-attack price. Both are protocol-owned and
un-withdrawable, so the pad loses either way, and the fix is the same.

**Fix direction.** Do not let a single live `slot0` read gate the irreversible commitment of the whole balance:
(1) require the tick to have been below `floorTickLower` for a minimum number of blocks, or compare against a
short TWAP rather than spot; (2) rate-limit — cap each `addFloor()` at a fraction of `parkedQuote` per block,
so no single transaction can commit the whole carve; (3) failing both, make the keeper the only caller, since
permissionlessness buys nothing here. Note the fix must target the **park→commit flip**, not the timing: a
guard that merely randomises or delays *when* the call may run changes nothing, because what gets minted does
not depend on the tick. **M-15**, **L-33** and this finding are the same guard read three ways.

### M-24 · MEDIUM · The hook's floor pointer accepts the hook itself, and then `claimFloor` reports success while moving nothing — permanently  `VERIFIED`

> **STATUS: FIXED** in `032191e` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/hooks/RobinFeeHook.sol:383-391` (`setFloorRecipient`), `:340-348` (`claimFloor`),
`:467-475` (`_payout`), `:478` (`receive`).

`setFloorRecipient` is platform-only and permanently one-shot, and its **only** content check is
`if (recipient == address(0)) revert ZeroAddress()` (`:388`). No code check, no value-transfer probe. `_payout`
for native ETH is a bare `payable(to).call{value: amount}("")`, and the hook has an open
`receive() external payable {}`.

So setting the floor recipient to **the hook's own address** makes `claimFloor` a self-send:

```
floorOwed[id][0] = 0;                  // book zeroed FIRST
_payout(...)  → hook.call{value: amt}  → ok == true (its own receive())
emit FloorClaimed(id, 0, to, amount);  // a transfer is asserted in the log
```

The balance is byte-identical before and after. The ETH sits in the hook's raw balance backing **no book**, and
the hook exposes **no** rescue, sweep, recover or withdraw selector — verified, zero matches. The one-shot is
spent, so every later `setFloorRecipient` reverts `FloorRecipientAlreadySet`.

**This is strictly worse than M-21, which is the same shape one contract away.** M-21's failure mode *re-parks*
the book, so the ETH stays owed and a fix can still deliver it. Here the book is **zeroed before** the send and
the send succeeds, so the ETH is not even owed any more — and the event says it was paid. It also validates
*less* than the curve's setter: `RobinCurveV4.setFloor` at least requires `code.length != 0`.

It breaks `AUDIT-SCOPE.md` §4.1 — *"every fee booked is claimable exactly once"* — in a direction H-1 does not:
H-1 is fees never booked; this is fees booked, reported claimed, and claimable **zero** times. The victim is the
pad's entire sell-tax floor carve, which is the protection M-15 and M-21 both lean on.

**Fix direction.** Same as M-21 and worth doing in one pass across all four setters: probe the target with a
value transfer before spending the one-shot, and reject `address(this)` explicitly. Independently, `_payout`
should not treat a self-send as success — compare balances across the call, or require `to != address(this)`.

---

### L-24 · LOW · `LockVault`'s "acceptance IS the lock" is dead code on every path it claims to secure  `VERIFIED`

**Where** `contracts/core/LockVault.sol:13-17` (NatSpec) and `:169-173` (`onERC721Received`),
`ROBIN-V4-ARCHITECTURE.md:217`, against `node_modules/@uniswap/v4-periphery/src/PositionManager.sol:364` and
`node_modules/solmate/src/tokens/ERC721.sol:157`.

The contract's own NatSpec and the architecture doc both state the lock is structural because the vault accepts
NFTs *only* from the canonical `PositionManager` — *"that acceptance IS the lock"*. Verified against the
deployed periphery, both halves are wrong:

- **It never fires on the paths in use.** `PositionManager._mint` (`:364`) calls solmate's plain
  `_mint(owner, tokenId)` (`ERC721.sol:157`), **not** `_safeMint` — solmate invokes `onERC721Received` only in
  `_safeMint` (`:198`, `:213`) and `safeTransferFrom` (`:120`, `:136`). Every path the suite uses to place an
  NFT in the vault — `PadFactory._mintSeedLp:244`, `StockPadFactory._mintSeedLp:226`,
  `RobinCurveV4._mintPermanentLp:647`, all passing `lockVault` as the `MINT_POSITION` owner — is a plain mint.
  The guard is unexecuted code. This is invisible locally because `MockPositionManagerV4` takes a different
  route, which is M-8's blind spot showing up again.
- **What it does gate, it gates the wrong way.** The one path that *does* reach it is a third party calling
  `safeTransferFrom` — and the check accepts any position from the canonical manager, into a contract with no
  exit selector. Anyone who sends a v4 position NFT to the shared `LockVault` by mistake, or because they read
  the NatSpec and believed the vault validates provenance, loses the principal and all future fees permanently,
  with no recovery for any party including the platform.

**The lock itself still holds** — `LockVault` genuinely exposes no liquidity-exit selector, and
`test/unit/LockVault.test.js` asserts exactly that. The defect is that the *stated mechanism* is not the one
doing the work, so a reader (or an auditor) reasoning from the documented invariant is reasoning from a check
that never runs.

**Fix direction.** Delete the claim from the NatSpec and the architecture doc, or make it true by having the
factories `safeTransferFrom` into the vault rather than minting directly to it. Either way, add an explicit
`revert` in `onERC721Received` for tokens not registered by the factory, so a mis-sent position bounces instead
of vanishing.

---

### L-25 · LOW · A sibling pool carrying the pad's own hook is unregistered, so it is untaxed on both sides — and anyone can create it  `VERIFIED`

**Where** `contracts/hooks/RobinFeeHook.sol:189` (exact-output rejection, gated on `c.registered`), `:201-203`
(unregistered early return), `:280` (`afterSwap` early return); `contracts/hooks/BaseHook.sol:30`
(`REQUIRED_FLAGS` has no `BEFORE_INITIALIZE` bit).

A v4 `PoolId` is `keccak(currency0, currency1, fee, tickSpacing, hooks)`, and `registerPool` binds exactly one.
Because the hook's flag word omits `BEFORE_INITIALIZE`, `BaseHook`'s reverting `beforeInitialize` stub is never
invoked, so **any EOA** can call `poolManager.initialize` with the same currency pair and the same hook address
but a different `fee` or `tickSpacing`. On that id `config[id].registered` is false, so `beforeSwap` falls
through at `:201` with a zero delta and `afterSwap` returns 0 at `:280` — no mint, no take, no book.

The result is a permanently untaxed venue for the pad coin **that carries the pad's own hook address**, so any
indexer, front end or router identifying "a Robin pad pool" by its hook treats it as genuine. Volume migrating
there pays none of the buy tax (platform + buffer + referral) and none of the sell tax (creator + floor). It
also restores exact-output swaps, since the `:189` guard rejecting them is itself conditioned on
`c.registered` — so the shape that guard exists to forbid is available one pool id away.

Distinct from **H-1**, which evades the *sell* tax on the *registered* pool via a flash-take starve. This
evades **both** taxes on a *different* pool id, and needs no cleverness at all.

**Fix direction.** Add `BEFORE_INITIALIZE` to the hook's flags and revert in `beforeInitialize` for any key the
factory did not register — which requires re-mining hook addresses, so it is a launch-time change, not a
patch. Cheaper mitigation if that is unacceptable: have the front end and indexer key on the registered
`PoolId`, never on the hook address, and say so in the integration docs.

---

### L-26 · LOW · A buy that fills zero still pays the full buy tax, and on a stuck pad that is every buy  `VERIFIED`

**Where** `contracts/hooks/RobinFeeHook.sol:205-213` (fee computed on the requested exact input), `:222` (the
`beforeSwap` specified delta), `:236-252` (`_bookBuy`).

The buy fee is computed from `-params.amountSpecified` **before** the swap executes, minted, booked, and charged
through the `beforeSwap` specified delta — which v4 applies regardless of how much actually executed. The
over-tax is bounded in absolute terms at `buyTaxBps × requested input`, but the *effective rate on value
received* is unbounded, and at a zero fill it is infinite.

The boundary case is the one that matters: on a **sold-out but not-yet-graduated** curve there is no liquidity
below `gradTick`, so a plain buy with no price limit fills **zero** — and the swap succeeds rather than
reverting, having paid full buy tax for no tokens. Normally that is a one-block window, since `graduate()` is
permissionless and bountied. **C-2 makes it permanent**: a pad whose `graduate()` exceeds the block gas cap
sits in exactly this state forever, so every buy on it burns `buyTaxBps` for nothing.

The proceeds route as ordinary buy tax — buffer 20% + platform 60% + referral 20% — and per **L-5** the buffer
is swept into `platformEthOwed` at graduation, so the platform keeps 80% with a referrer named and 100%
without.

Distinct from **M-1**, which is scoped to `PresaleVault.finalize` where the limit is the protocol's own
`gradTick` and the loss is socialised across contributors. `AUDIT-SCOPE.md` §5 accepts this arithmetic only for
"a partial-fill on a tight price limit"; a zero fill with no limit set is not that case.

**Fix direction.** Charge the tax on the **executed** input rather than the requested one — `afterSwap` knows
it — or revert a buy whose fill is zero. At minimum, document the zero-fill case in §5 rather than letting the
partial-fill wording cover it.

---

### M-25 · MEDIUM · `RobinLockStaking.fundTokenPushed` ignores the `asset` it is handed and returns 0, so a mis-wired `setStaking` swallows the whole graduation reservoir silently  `VERIFIED`

> **STATUS: FIXED** in `d85dfeb` · regression test `test/regression/M25.staking-sink-mismatch.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/RobinLockStaking.sol:190-198`, called from
`contracts/pads/RobinCurveV4.sol:654-663` (`_fundStaking`), against `contracts/pads/DualStaking.sol:428-435`
which honours the same signature.

```solidity
function fundTokenPushed(uint8, address) external nonReentrant returns (uint256 pushed) {
    uint256 bal = token.balanceOf(address(this));      // its OWN token, not the one it was handed
    uint256 accounted = totalStaked + rewardsBalance;
    if (bal <= accounted) return 0;                    // returns, does not revert
```

Both parameters are **unnamed and never read**, and the NatSpec says so deliberately — *"`side`/`asset` are
ignored (single-token pool) — kept for curve interface parity."* The sibling implementation of the same
interface does the opposite: `DualStaking` reverts `BadAsset` on ETH, `NotListed` on an unlisted asset, and
`Zero` when nothing arrived.

The caller pays for that difference. `_fundStaking` transfers **first**, then pokes:

```solidity
IERC20(token).safeTransfer(s, amount);
try IStakingFund(s).fundTokenPushed(uint8(0), token) { emit StakingFunded(amount); } catch {}
```

If `setStaking` was pointed at a `RobinLockStaking` belonging to a **different pad**, every step reports
success: the ERC-20 transfer is valid, the callee measures *its own* `token` balance — unmoved by receiving a
foreign ERC-20 — takes the `bal <= accounted` branch, returns 0 without reverting, and `StakingFunded(amount)`
is emitted. The graduation leftover (C-1 measures this reservoir at **9.70% of total supply**) now sits in
another pad's staking contract, which has no rescue path for a foreign token. Nothing reverts, nothing warns,
and the log asserts the funding happened.

`setStaking` validates only `s != address(0) && s.code.length != 0` (`:450`), and it is a one-shot, so the
mis-wire cannot be corrected afterwards.

Distinct from **L-19(a)**, which is that `StakingFunded` sits inside the `try` and so is silent when the poke
*fails*. Here the poke **succeeds** and the event fires — the failure is that the callee cannot tell it was
handed the wrong asset, because it threw the parameter away.

**Fix direction.** Honour the parameter: `if (asset != address(token)) revert BadAsset();`. Two lines, and it
converts a silent total loss into a revert inside `_fundStaking`'s `try` — which re-parks the tokens on the
curve for a later `flushStaking()`, exactly the non-bricking behaviour the design already intends. Also
consider reverting rather than returning 0 when nothing arrived, as `DualStaking` does.

---

### M-26 · MEDIUM · `RobinAmbushVault` verifies its tick against the curve and takes the entire pool key on trust  `VERIFIED`

> **STATUS: FIXED** in `032191e` · covered by the existing suite. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/pads/RobinAmbushVault.sol:86-121` (constructor), `:257-259` (`_poolKey`), against
`contracts/pads/RobinCurveV4.sol:91-96`.

The constructor's `[H1]` comment presents the design as safe on exactly this ground:

> *"Anchor to the curve's IMMUTABLE `gradTick()` read on-chain — never a passed hint, never a live `getSlot0`,
> so no front-run or bad param can mis-place the wall."*

It reads `gradTick()` from `curve_` (`:111`) — one field, correctly. But `currency0_`, `currency1_`, `fee_`,
`tickSpacing_` and `hooks_` arrive as constructor parameters and are stored verbatim (`:100-106`) with **no
comparison to `curve_`**. The only rejections are `bandWidthSpacings == 0` and the band-geometry test.
`_poolKey()` is then built purely from those five unvalidated fields, and it feeds both `seedAmbush`'s spot
guard and `_add`'s `modifyLiquidity`.

**The fix is sitting right there, unused.** `RobinCurveV4` publishes all of them as public immutables —
`currency0` (`:91`), `currency1` (`:92`), `token` (`:93`), `fee` (`:94`), `tickSpacing` (`:95`), `hooks`
(`:96`). The vault already holds `curve_` and already calls into it. It reads one getter of six.

So a hand-deployed vault can anchor its band to pad A's `gradTick` while pointing its pool key at pad B's pool.
`_fundAmbush` then delivers pad A's ambush share — `ambushGradBps`, 5% of the raise at production settings —
and `seedAmbush` adds it as permanent liquidity in **pad B's** pool. The vault is add-only with no withdraw, so
that is unrecoverable, and per **L-7** these vaults have no deploy script at all: the arguments are hand-typed
once, by the operator, unverifiably.

Distinct from **M-4**, which is `RobinFloorVault`'s `anchorTick` being an unverifiable deploy parameter. The
floor vault takes no curve reference, so it *cannot* self-validate; the ambush vault can and does not. And it is
worse than a plain missing check, because the comment tells a reviewer the class of bug has been handled.

**Fix direction.** Read all six from the curve rather than accepting them:
`require(currency0_ == curve.currency0() && currency1_ == curve.currency1() && fee_ == curve.fee() &&
tickSpacing_ == curve.tickSpacing() && hooks_ == curve.hooks())`, or drop the parameters entirely and derive
the key from `curve_`. Then the `[H1]` comment becomes true as written. Apply the same reasoning to
`RobinFloorVault` by giving it a curve reference (which also closes M-4).

---

### M-27 · MEDIUM · `PadFactory` has no one-pool-per-token guard, so anyone can relaunch a live pad — reusing the victim's own hook — and repoint the registry at their own pool  `VERIFIED`

> **STATUS: FIXED** in `ce119fc` · regression test `test/regression/M9-M27.creator-and-relaunch.test.js`. The finding below is unchanged from how it was filed — see §0 for what the fix does.

**Where** `contracts/core/PadFactory.sol:111` (`launch`, permissionless), `:137-140` (hook deploy), `:204`
(`poolOf[token] = poolId`), with `contracts/core/DeterministicDeployer.sol:24` and
`contracts/hooks/RobinFeeHook.sol:137`.

Three individually-correct idempotency decisions compose into a re-registration primitive. All three verified:

1. **`DeterministicDeployer` adopts** a byte-identical pre-deploy rather than reverting (`:24 return predicted`).
   `PadToken`'s init-code is `(name, symbol, decimals, supply, factory)` — every field public. A second `launch`
   with the same `tokenSalt` and the same four fields returns the **existing, live** token and mints nothing.
2. **The hook's init-code is `(poolManager, address(this), feeRegistry, token)`** (`PadFactory:139`) — it depends
   only on the token. So the **victim's own `hookSalt`, copied out of their public launch calldata, re-adopts
   the victim's own hook.** No salt mining is required.
3. **`registerPool` rejects re-registration only for the same `PoolId`** (`RobinFeeHook:137`). `fee` and
   `tickSpacing` are in the `PoolKey` but in *neither* init-code, so changing one yields a different `PoolId`
   that registers cleanly — against the same token and the same hook.

The attacker then owns the new pool's `PoolFeeConfig`: their taxes, their `creator`, their `floorRecipient`,
their `stakingRecipient`. And `:204` **overwrites** `poolOf[token]` — the factory's only on-chain token→pool
index, which the repo's own tests resolve pads through (`test/fork/PadFactory.launch.fork.test.js:65`). A
second `PadLaunched` fires for the same token naming the attacker as creator, so an event-sourced indexer sees
a fresh launch.

Cost is a second launch: roughly 1000 wei of seed plus gas.

**Not L-9, and not M-3.** L-9 is a *pre-launch* race — copying a pending launch's calldata to burn the
victim's transaction, where the pad holds 0 wei at steal time. This is *post-launch* re-registration of a pad
that is already live and already holds value. M-3 is what a launcher may set **for their own pad**, and assumes
one launch per token; nothing in it contemplates a second launch against a token that already has a pool.

**Fix direction.** One line: `if (!PoolId.unwrap(poolOf[token]).isZero()) revert AlreadyLaunched();` before
registration. Note the curve path is not obviously safe by inspection either — `CurvePadFactoryV4` should get
the same guard, and the two fork tests that resolve pads through `poolOf` should assert it is write-once.

---

### L-27 · LOW · `PadFactory`'s `cfg.fee` is launcher-chosen up to Uniswap's structural 100%, and it is the one launch parameter M-3 does not enumerate  `VERIFIED`

**Where** `contracts/core/PadFactory.sol:55` (`uint24 fee; // STATIC lp fee`), `:116` (the only check — the
dynamic-fee flag), `:148` (straight into the `PoolKey`).

`launch` validates that the dynamic-fee flag is clear and nothing else. Uniswap's `LPFeeLibrary.validate`
permits any static fee up to `MAX_LP_FEE = 1_000_000` (100%), so the launcher stamps the pool's LP fee freely
and immutably. `RobinFeeHook`'s `MAX_TAX_BPS` bounds only the two **hook** taxes; the LP fee is a third,
unbounded levy on the same trades. On a `PadFactory` pad the seed LP is the `LockVault` position, whose token
leg routes to the launcher-supplied `stakingRecipient` — so the fee and its destination are chosen by the same
party in the same call, and `LockVault.setStakingRecipient` then refuses to repoint it.

It is LOW because the fee is publicly readable in the `PoolKey` (observable, not stealthy) and it is
launcher-configured rather than applied retroactively to anyone's existing position.

**Not M-10.** M-10 is the same defect class on a different contract with different reachability: it is
`RobinV4FeeConfig.MAX_LP_FEE` on the **governed, owner-only, curve** path. This is the **permissionless**
factory, where no governance step stands between an arbitrary launcher and the number.

---

### L-28 · LOW · The `PadFactory` launch path has zero executed local coverage — and unlike M-8, nothing was blocking it  `PROVEN`

**Where** `test/fork/PadFactory.launch.fork.test.js:21-23` (`if (!process.env.FORK_RPC) this.skip()`) is the
only test that calls `PadFactory.launch`; `PadFactory` appears in no file under `test/unit` or `test/sim`.

`PadFactory` is in scope per `AUDIT-SCOPE.md` §1 and is the only path that seeds an LP with real ETH, mints a
permanently-locked position, and refunds a launcher. The default suite executes **none** of it.

**M-8 gave a technical reason for the equivalent gap on `StockPadFactory`** — `MockPositionManagerV4:48-54`
decodes `params[2]` unconditionally while `StockPadFactory` emits a two-action batch, so the mock panics
`0x32`. **That reason does not apply here.** `PadFactory:227-228` emits the exact three-action batch
(`MINT_POSITION, SETTLE_PAIR, SWEEP`) the mock was written for. Proven by construction: a from-scratch harness
(real `PoolManager` + the existing mocks + the real `DeterministicDeployer`/`FeeWalletRegistry`/`LockVault`/
`PadFactory`) ran the honest launch, the seed-LP mint, the `LockVault` registration, both refund paths, a
100%-fee launch, and M-27's relaunch primitive — **in under five seconds, with no change to any contract, mock
or config file.**

So this is missing tests, not missing infrastructure. It matters because a reader of M-8 would reasonably
conclude the ETH pad *is* covered locally, and M-19's coverage table inherits that impression.

---

### L-29 · LOW · The seed mint's `SWEEP` takes the shared `PositionManager`'s entire native balance, and the dust path forwards it to `cfg.creator`  `VERIFIED`

**Where** `contracts/core/PadFactory.sol:228` (`Actions.SWEEP`), `:241`
(`params[2] = abi.encode(currency0, address(this))`), then `:196-200` (`dust = address(this).balance` →
`cfg.creator`). Same pattern at `RobinCurveV4:647` and in `StockPadFactory`.

`SWEEP` is **not** scoped to the caller's own unspent value. Any native balance sitting in the canonical
`PositionManager` at the moment a pad launches is transferred to the factory, joins `address(this).balance`,
and is paid out as "ETH dust" to the launcher's chosen `cfg.creator`.

Bounded, and honestly so: the `PositionManager` cannot be donated to directly — `NativeWrapper.sol:31-33`
restricts `receive()` to WETH9 and the `PoolManager` — so a residue arises only when a third-party integrator
forwards value to `modifyLiquidities` and omits a `SWEEP` of their own. That is a known v4-periphery footgun on
a singleton every integrator on the chain shares. It is found money rather than protocol funds, which is why
this is LOW.

It is reported because it makes `dust` **unbounded and unrelated to the launcher's own `msg.value`**, and routes
a stranger's stranded ETH to an arbitrary launcher-chosen address with no event distinguishing it from a genuine
refund (see **L-19** on that class). **Not I-1(2)**, which is the factory's *own* balance — a different pocket,
filled only by mis-sends to the factory itself. This is a second, upstream pocket.

**Fix direction.** Scope the sweep, or snapshot `address(this).balance` before `modifyLiquidities` and refund
only the delta.

---

### L-1 · LOW · `RobinV4FeeConfig` accepts curve geometries whose raise floors to zero  `PROVEN (numerically)`

**Where** `contracts/core/RobinV4FeeConfig.sol:102-103` (`_validate`), with
`contracts/core/CurvePadFactoryV4.sol:120-132`.

`_validate` bounds only signs and ordering. The factory's `[D-2]`/`[D-3]` guards bound the ticks against
`minUsableTick` and `maxUsableTick - 80000` — those protect the permanent LP's token-leg pairing, not the
raise. At high start ticks the token is so cheap in ETH that the whole curve integral truncates to zero wei.

Computed with the real integer `TickMath` / `LiquidityAmounts` math (ts 100, `curveSupply` 730M,
`curveWidth` 23000):

| `startTickMag` | full-curve raise |
|---|---|
| 201600 (production) | 4.053195282705641405 ETH |
| 300000 | 216,049,609,281,871 wei |
| 400000 | 9,813,542,304 wei |
| 500000 | 445,756 wei |
| 600000 | **20 wei** |
| 700000 | **0 wei** |
| 807200 (highest `gradTick` the factory accepts) | **0 wei** |

From ~600000 up, `graduate()` reverts `EmptyRaise` (`RobinCurveV4.sol:339` or `:353`) or `BadLiquidity` in
`_mintPermanentLp` — permanently, for every caller — and the reserve has no exit either, because
`flushStaking` is gated on `graduated`. Owner-only reachability (the config is `Ownable2Step`, no timelock,
deliberately forward-only), but there is no floor and no warning, and every pad launched between the mistake
and its discovery is unrecoverable.

**Same root cause as M-12's worst case.** M-12 reaches an un-graduatable pad by moving `startTickMag` *down*
(the token becomes so expensive the curve can never sell out); this finding reaches one by moving it *up* (the
token becomes so cheap the curve sells out for 0 wei). Both are the same missing bound, and one check closes
both ends.

**Fix direction.** Bound `startTickMag` in `_validate`, or — better, because it is the property you actually
care about — have `CurvePadFactoryV4.launch` compute the curve's ETH integral for the requested `curveSupply`
and revert below a minimum. Consider a rescue path for a curve that can provably never satisfy `graduate()`.

---

### L-2 · LOW · `RobinCurveV4` and `DualStaking` disagree on who may call `fundTokenPushed`, and the documented recovery cannot work

**Where** `contracts/pads/RobinCurveV4.sol:654-663` (`_fundStaking`) and `:395-403` (`flushStaking`), against
`contracts/pads/DualStaking.sol:428-433` vs `contracts/pads/RobinLockStaking.sol:190`.

The curve calls `IStakingFund(s).fundTokenPushed(0, token)` through a shared interface whose two
implementations have opposite authorisation: `RobinLockStaking`'s is permissionless; `DualStaking`'s requires
`isRewarder[msg.sender]`, and `StakingFactory.createPool` (`:52-57`) only ever grants that to `platformOwner`
and an optional `extraRewarder` — it cannot grant it to a curve that does not exist at pool-creation time.
`RobinCurveV4.setStaking` (`:447`) accepts any contract and cannot tell them apart.

If a curve is pointed at a `DualStaking` pool, `_fundStaking` transfers the whole leftover reserve in and then
swallows the `NotRewarder` revert in its try/catch, so the tokens land uncredited. The advertised recovery
also fails: `flushStaking()` is **not** try/caught and reverts `NotRewarder` for every caller, so
*"flushStaking() completes later"* is false on this path. Recovery needs the platform to call
`DualStaking.fundTokenPushed` from an authorised rewarder — a step that appears nowhere in `DEPLOY.md`.

**Correction to the obvious fix.** `setRewarder(curve, true)` *is* the operational answer, and
`scripts/testnet-e2e-graduate.js:95` already does it — but it appears nowhere in `DEPLOY.md`, and performing
it opens **M-13** (the curve then becomes a permissionless relay through `DualStaking`'s rewarder gate). The
two findings are a pair: the wiring that makes crediting work is the wiring that makes the drip griefable.

**Fix direction.** Fix both at once. Make `DualStaking.fundTokenPushed` permissionless like its sibling (it is
measured-delta accounting, so the gate buys little), *and* stop the pushed path from resetting `periodFinish`,
per M-13. Document whichever wiring you settle on in `DEPLOY.md`; today it exists only in a testnet script.

---

### L-3 · LOW · Leftover reserve tokens have exactly one exit, gated on a platform action nothing forces

**Where** `contracts/pads/RobinCurveV4.sol:654-657`, `:395-398`, `:447-453`.

If the platform never wires `staking`, the leftover reserve at graduation parks on the curve forever — at
production geometry roughly 270M − 173M ≈ **97M tokens**, plus every token-side LP fee the curve realised.
`sweepToPlatform` (`:283`) handles only ETH. No deadline, no fallback recipient, no creator- or
holder-triggered path.

**Fix direction.** Require `staking != address(0)` before `graduate()` can run, or give `flushStaking` a
fallback sink after a grace period.

---

### L-4 · LOW · `_decodeReferrer` treats any 32-byte `hookData` as a referrer, permanently stranding the carve

**Where** `contracts/hooks/RobinFeeHook.sol:428-435`, used at `:241`.

The decoder takes the low 20 bytes of the first calldata word whenever `hookData.length >= 32` — no length
equality check, no discriminator, no magic prefix. Any router or aggregator that uses `hookData` for its own
payload silently names a pseudo-random referrer. `referralOwed[thatAddress][quote]` then holds value only that
address can claim (`claimReferral` pays `msg.sender` and nobody else, `:367`), so it is permanently stranded —
and the matching ERC-6909 claim stays minted on the hook forever, so its claim balance never fully drains.

Bounded to the platform's own cut, so no user funds are at risk; it is a silent revenue leak plus a
permanently un-reconcilable book, which matters because "the hook's ERC-6909 balance backs the buy books
exactly" is an invariant you want to be able to assert cleanly.

**Fix direction.** Require `hookData.length == 32`, or a 4-byte magic prefix followed by the address.
Optionally add a platform sweep for referral balances untouched for N days.

---

### L-5 · LOW · Buy-tax "buffer" NatSpec says LP/staking in three places; the code routes it to the platform

**Where** `contracts/core/RobinV4FeeConfig.sol:26` (*"a slice of the BUY tax stays in the curve as a liquidity
buffer (softens price impact + deepens the permanent LP)"*), `contracts/core/CurvePadFactoryV4.sol:226`
(*"hardens the LP-binding reserve + deepens staking"*), `contracts/hooks/RobinFeeHook.sol:74` (*"the curve → permanent LP"*).

`graduate()` pulls the buffer **before** the `donatedBefore` snapshot (`RobinCurveV4.sol:319-327`), which
deliberately **excludes** it from the measured raise, and step 9 (`:381`) sweeps it into `platformEthOwed`.
The buffer never enters the permanent LP, never deepens staking, never hardens the reserve — and while held it
sits as an idle balance on the curve contract, not in any pool position, so it provides no price support
either. `AUDIT-SCOPE.md` §3 and `ROBIN-V4-CURVE-ECON.md:28`/`:31` state the correct behaviour, so only the
in-code NatSpec is wrong — but that is what an auditor and an integrator read first, and it is the difference
between a user-side liquidity feature and platform revenue.

**Also stale, same category:** `contracts/interfaces/IRobinInterfaces.sol:24` and
`contracts/core/PadFactory.sol:56` both describe the buy tax as *"bps of the token output"*. It has been
money-side fee-on-input since the rebuild — and `IRobinInterfaces.sol` contradicts itself four lines later,
where the struct field comment gets it right.

---

### L-6 · LOW · Deploy scripts leave the governed config on the hot key, and the riskiest transfer is only a `console.log`

`scripts/deploy-curve.js:59` — `const platform = process.env.PLATFORM_WALLET || deployer.address;`. If
`PLATFORM_WALLET` is unset the platform fee wallet **silently becomes the hot deploy key**, with no guard.
Undoing it costs `FeeWalletRegistry.TIMELOCK` = 2 days.

`:67` — `RobinV4FeeConfig` is deployed with `deployer.address` as owner, and the transfer is out-of-band.
`DEPLOY.md:24-25` spells out transferring **`FeeWalletRegistry`** ownership and calls it *"the only mutable
knob in the system"*; it never names `RobinV4FeeConfig` in that section, which appears only in a `console.log`
at `scripts/deploy-curve.js:117`. Given L-1, that framing is wrong: the FeeConfig sets the curve geometry, and
a bad value there permanently bricks every pad launched under it.

**Fix direction.** `revert` rather than default when `PLATFORM_WALLET` is missing; describe `RobinV4FeeConfig`
as multisig-critical alongside the registry.

---

### L-7 · LOW · Several in-scope contracts have no deploy path; the ones that do rely on hand-typed constructor args

- **`pads/RobinLpVault.sol` (317 lines) is referenced nowhere** except `AUDIT-SCOPE.md:17`, this file's
  previous contents, and its own unit test. No deployer, no factory, no script, no wiring — pure audit surface
  with no deployment path. An auditor will spend time on it for nothing, or assume it is live.
- **`pads/RobinLockStaking.sol` has no deploy script** — the contract carrying H-1. `deploy-curve.js:119`
  instructs a human to deploy `RobinLockStaking(token, 30d, 30d)` by hand, per pad.
- **`pads/RobinFloorVault.sol` and `pads/RobinAmbushVault.sol`** are likewise hand-deployed (`:120`).
- `core/StockPadFactory.sol`, `adapters/StockQuoteAdapter.sol`, `adapters/EthQuoteAdapter.sol` — no deploy
  script, though all three are in the audit scope.

This is the root cause behind M-2, M-4, L-1 and M-5's durations, and it is fixable once — scripted deployment
plus on-chain assertions at launch — rather than five times.

---

---

### L-8 · LOW · The ceiling nudge counts swap proceeds from third-party liquidity as raise

**Where** `contracts/pads/RobinCurveV4.sol:327` (the `donatedBefore` window opens), `:540-556` (the nudge swap
and its `_resolve(currency0, sd.amount0())`), `:337` (the raise is measured), against
`:631` (`_mintPermanentLp`'s reserve check).

`graduate()` snapshots `donatedBefore` to keep a hostile `receive()` donation out of the measured raise —
the `[AUDIT-HIGH]` fix. But the anti-grief nudge swap runs **inside** that window, and its ETH proceeds are
taken by `_resolve` at `:552` and therefore counted as raise at `:337`. Those proceeds do not come from
buyers; they come from whatever liquidity the nudge crosses. A third party can mint a pure-currency0 band
below `gradTick` (the hook's flags are `0x00CC` — no `beforeAddLiquidity` permission, so anyone may add
liquidity to a pad's pool), push spot into it, and have their own ETH booked as raise.

Because the band sits far below the ceiling, the token there is cheap in ETH terms, so the nudge's `reserve/100`
budget is **not** the binding constraint: measured at production geometry (startTick 201600 / gradTick 178600 /
ts 100, 730M curve / 270M reserve, waterfall 1000/1000/500), parking **~2.2–2.3 ETH against a 4.053 ETH honest
raise** inflates `lpEth` until `_mintPermanentLp`'s check fails and `graduate()` reverts `InsufficientReserve`.

**Impact is a temporary, self-healing DoS, not a brick — but see C-2.** The recovery this rests on,
`restoreCeiling`, is itself brickable by gas (C-2), so "self-healing" holds only while nobody has planted dust
ticks. Fixing C-2 restores the assumption this finding depends on. It is the same class as the planted-liquidity grief
`restoreCeiling` was built for and `test/unit/RobinCurveV4.grief.test.js` already covers, with the same
permissionless recovery — and the recovery is enormously over-incentivised, because `restoreCeiling` pays the
caller the griefer's entire parked ETH (one skeptic measured 1.2 token buying back 401 ETH). The attacker must
park 0.17–0.56× the raise at a 14–48× mispricing that the first arbitrageur takes in full, to achieve a denial
the already-accepted `CeilingNotRestored` variant achieves for ~0.06 ETH. Strictly dominated.

**Two things are nonetheless worth fixing.**
1. **`AUDIT-SCOPE.md` §4.5 is imprecise.** It asserts *"a donation can't inflate `lpEth` past the reserve's
   pairing capacity (brick)"*. That holds for `receive()` donations only — not for swap-sourced ETH, which is
   exactly what the nudge takes. An auditor relying on §4.5 would not look here.
2. **The failure is misdiagnosed.** An operator hitting this sees `InsufficientReserve` — an error the docs
   (`ROBIN-V4-CURVE-ECON.md:53`) and the launch-time guard (`CurvePadFactoryV4.sol:140`) both attribute to a
   launch-time misconfiguration. It reads as "this pad was configured wrong", not "someone is griefing you,
   call `restoreCeiling`".

**Fix direction.** Measure the nudge's proceeds separately and exclude them from `raisedEth` (the nudge exists
to move price, not to raise capital), or re-snapshot `donatedBefore` after the nudge. Independently, give the
revert a distinct error so the recovery path is obvious, and correct §4.5 to say "a donation or swap-sourced
ETH".

---

### L-9 · LOW · `cfg.creator` is in neither CREATE2 pre-image, so a copied launch can burn a victim's launch tx  `VERIFIED — impact refuted`

**Where** `contracts/core/CurvePadFactoryV4.sol:105` (`launch` is permissionless), `:148` (token init-code is
`(name, symbol, decimals, supply, factory)`), `:158` (hook init-code is
`(poolManager, factory, feeRegistry, token)`) — `cfg.creator` appears in neither.

**The mechanism is real.** For a given `(cfg, tokenSalt, hookSalt)` the token and hook land at the same
addresses whoever calls `launch()` and whatever `creator` they name. Copy a pending `launch()` calldata,
change `creator`, land first: the attacker's transaction deploys token and hook at exactly the addresses the
victim intended and registers the pool with itself as creator, after which the victim's transaction reverts
(`registerPool` throws `AlreadyRegistered`, and the factory no longer holds the supply).

**The impact claim does not survive.** This was originally filed HIGH as creator-revenue theft. It is not:
the steal lands at the one instant the pad is worth exactly zero. Reproduced at production geometry against
the real factory stack, the hijacked pad holds **0 wei, `creatorEthOwed` 0, `hook.creatorOwed` 0** — the 10%
graduation share and the 80 bps sell stream only ever exist for whichever pad actually attracts a raise, and
nothing about the attacker's empty shell attracts one. The victim's remedy is a relaunch under a fresh
`tokenSalt` and a re-mined `hookSalt`, which costs off-chain mining and gas but no principal.

The economics run against the attacker: they pay a **full ~6.5M-gas launch per attempt** to burn the victim's
**83k-gas** transaction, gain nothing transferable, and cannot repeat without fresh calldata. That is
negative-EV griefing, not theft.

**Reachability is broader than a mempool race.** The precondition is only *"the attacker learns
`(cfg, tokenSalt, hookSalt)` before inclusion"*, and transaction ordering is one leak among several. Any
launch UI that mines the hook salt server-side and returns the salts to the client leaks everything needed
with no ordering advantage at all. And the repo's own launcher derives the token salt **deterministically from
public data** — `scripts/launch.js:62`:

```js
const tokenSalt = ethers.id(`${cfg.symbol}-${cfg.name}-${d.padFactory}-${process.env.SALT_NONCE || "0"}`);
```

Under that convention an attacker who knows only the announced name and symbol can compute `tokenSalt`, mine
their own `hookSalt`, and pre-empt a launch that has been *announced but not yet sent* — no mempool access
required. That materially raises the likelihood while leaving the payoff unchanged, which is why it stays LOW
rather than rising: the pad is still empty at the moment it is taken.

**Where it would matter, the suite defends — but only once.** The case where a launch address is
*pre-committed* — so an audience is pointed at it before it exists — is the presale, and `PresaleVault` aims at
exactly this: the salts are commit-revealed, and a front-run launch makes `finalize` fail the presale into
immediate 100% refunds (`:180-192`).

> **Correction.** This paragraph originally treated that as a complete defence. It is not: the commit-reveal is
> single-use and destroyed by any reverted `finalize`, because `BadReveal` is checked *last* and the salts are
> already in mined calldata by then. See **M-22**. The residual below still holds for direct launches; for
> presales, read M-22 first.

**Fix direction.** Bind the creator into the deployment so a replayed calldata lands at a *different* address
instead of colliding: add `cfg.creator` to the token's constructor arguments, or require
`msg.sender == cfg.creator`. Either removes the griefing window entirely for a line of code.

---

### L-10 · LOW · `DeterministicDeployer.deploy` is payable but the adopt branch neither forwards nor refunds  `VERIFIED`

**Where** `contracts/core/DeterministicDeployer.sol:22-32`.

```solidity
function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address addr) {
    address predicted = addressOf(salt, keccak256(initCode));
    if (predicted.code.length != 0) return predicted;   // msg.value neither forwarded nor refunded
```

The contract's **entire external surface is `addressOf` and `deploy`** — verified at runtime: two ABI
fragments, no `receive`, no `fallback`, no owner, no withdraw, no `selfdestruct`, and a plain 1 wei transfer
to it reverts. So anything sent on the adopt branch is permanently locked.

**No protocol funds are exposed, and the original MEDIUM framing was wrong.** All seven in-repo call sites are
value-free — `PadFactory.sol:121,137`, `CurvePadFactoryV4.sol:144,156`, `StockPadFactory.sol:126,139`, and
`CurveV4Deployer.sol:22` (which is itself non-payable). And a value-bearing *fresh* deploy cannot strand
anything either: every in-repo init-code has a non-payable constructor, so `create2` with value reverts and
the whole call reverts with `DeployFailed`. The no-adversary variants originally claimed — racing operators,
a re-broadcast — cannot strand value for the same reason.

What remains is a hardening gap for third parties. The NatSpec designates this contract as pinned ecosystem
infrastructure (*"its address is then pinned as a constant everywhere hook-address mining happens"*) and
`deploy` is permissionless, so an outside integrator deploying a payable, self-funding contract can be
front-run into the adopt branch by anyone submitting the same `initCode` first — and their value is gone.

**Fix direction.** One line: `if (msg.value != 0) revert();` on the adopt branch — or drop `payable`
altogether, since every in-repo init-code has a non-payable constructor and value-bearing deploys already
revert. The NatSpec's *"(No value is forwarded on adoption; our callers deploy value-free.)"* should state the
hazard rather than record the assumption.

---

### L-11 · LOW · `RobinFloorVault` pins the platform wallet as an immutable, so a timelocked rotation never reaches it  `VERIFIED`

**Where** `contracts/pads/RobinFloorVault.sol:45` (`address public immutable feeRecipient`), set once at `:84`.

The vault has **no `IFeeWalletRegistry` import at all** — while every other platform sink in the suite resolves
the wallet live: `RobinFeeHook.sol:323`/`:384`, `LockVault.sol:136`/`:149`, and `RobinCurveV4.claimPlatform`.
`scripts/launch.js:85` hands the vault the platform address directly.

So the compensating control for a compromised platform key does not work here. `FeeWalletRegistry` exists to
rotate that wallet through a 2-day timelock — its NatSpec: *"a repoint only affects fees claimed after it
commits"* — but a rotation silently fails to reach any already-deployed floor vault. The permissionless
`collectFloorFees()` keeps paying that pad's floor-band LP fees to the **retired** address forever, and lets
whoever holds the retired key keep pulling them. There is no setter and no redeploy path: the vault is
add-only and holds a live position.

**One claim I made here is disproved, and the reason is worth knowing.** I wrote that taking inline to
`feeRecipient` under the pool lock lets a reverting recipient brick `collectFloorFees()`. It does not, and not
merely because the recipient is an EOA: **`addFloor()` is a second, permissionless fee-realization path.**
`_add` (`:139-157`) calls `modifyLiquidity` with a positive delta, and v4-core returns
`callerDelta = principalDelta + feesAccrued` — so an *add* realizes exactly the same accrued fees a
zero-delta poke does. The currency0 leg is taken to self at `:150` and compounds into the wall; the currency1
leg leaves by ERC20 `take`, which has no callback. So an ETH-rejecting recipient cannot strand anything.

The inline take still departs from the suite's accrue-and-pull rule, but here that is a style inconsistency,
not a live DoS.

Bounded to one small fee stream per pad and reachable only after a platform-domain event, which is why LOW.

**Fix direction.** Read `feeRegistry.platformFeeWallet()` at collect time, as every other consumer does.

---

### L-12 · LOW · `finalize()`'s bare catch turns an under-gassed call into an irreversible `Failed(3)` — and the tx reports success  `PROVEN`

**Where** `contracts/core/RobinV4FeeConfig.sol:102-105` (`_validate` bounds only signs and ordering),
`contracts/core/CurvePadFactoryV4.sol:120` / `:131` / `:140` (the launch-time geometry and reserve checks),
`contracts/presale/PresaleVault.sol:180-192` (`finalize`'s blanket `catch`).

If an owner retune leaves the *committed* `LaunchConfig` unlaunchable under the *new* geometry — a
`startTickMag`/`curveWidth` that no longer divides the presale's `cfg.tickSpacing`, or an aligned-but-narrower
`curveWidth` that trips the `reserveSupply·ss·100 >= curveSupply·sg·105` check — then
`CurvePadFactoryV4.launch` reverts. `PresaleVault.finalize` wraps that call in a catch-all written for a
different scenario (a sniped launch), so it treats the revert as a front-run and marks the presale
`Failed(3)`.

**PROVEN:** `setDefaults({...D0, startTickMag: 6030})` is accepted by `_validate`; `launch` then reverts
`BadGeometry` at `CurvePadFactoryV4.sol:120` for a presale committed with `tickSpacing = 60`; `finalize`
swallows it, sets `finalized = false` / `failed = true`, emits `Failed(3)`, and `state()` becomes 2.
**The transition is irreversible:** a retry reverts `NotOpen` even after the owner repairs the config in the
very next block. There is no un-fail path.

**Bounded, and funds are safe.** Contributors recover 100% via `refund()` / `refundTo()`, so this is an
availability failure, not a loss. The blast radius is narrower than it first appears: `cfg.tickSpacing` is
caller-chosen, so any spacing that still divides both new values launches fine — a retune is not a
launchpad-wide halt. Only presales whose committed spacing no longer divides the geometry are killed.

**The trigger set is far broader than a retune.** The handler is a bare `catch { }` (`:180-192`) with no
error-selector matching, so it absorbs *every* revert reason while its comment reasons only about a snipe. In
particular, under EIP-150's 63/64 rule an under-gassed `finalize` lets the inner `launch` run out of gas while
the outer frame survives — so an **honest caller who merely under-estimates gas permanently kills a fully
funded presale**. There is no retry: `state()` is 2 and every path reverts `NotOpen`. The same applies to any
future revert in `launch` that nobody anticipated.

**This is an accident, not an attack — the malicious reading does not hold.** Calling `finalize` requires the
salt preimages, so only a preimage-holder can trigger it, and that actor already has a strictly better way to
kill the raise: simply never call `finalize`. `fail()` (`:278`) then fires `Failed(2)` past deadline + grace
and everyone refunds 100% — the terminal state is identical. The gas trick is in fact *friendlier* to
depositors, because it opens refunds immediately instead of making them wait out the grace window.

What is left is the case that matters: a wallet's gas estimate, or a launch that grew gas-heavier than the
estimator expected, silently converting a recoverable condition into an irreversible one. No malice is
required and none should be assumed.

**And the caller is told it worked.** The transaction returns **status 1** and emits `Failed(3)` —
*"committed launch sniped"* — so the operator sees a successful call and a reason code that is factually wrong
about what happened. This is an availability and observability bug, not a fund-loss or profitable-attack
vector, which is why LOW.

**Fix direction.** Three independent improvements. (1) Match the error — treat only the specific
already-launched signatures (`AlreadyRegistered`, and the drained-factory transfer failure) as a snipe, and
let everything else bubble so the caller can retry. (2) Require a gas floor before the sub-call
(`require(gasleft() > N)`), the standard defence against a 63/64 griefing catch. (3) Make the transition
recoverable: `Failed(3)` should be re-openable while the deadline has not passed, since unlike reasons 1 and 2
it asserts a fact about the outside world that may simply be false. The geometry snapshot in M-12 removes the
retune trigger specifically, but not the class.

---

---

---

### L-13 · LOW · The escape hatch is anchored to `deadline`, not to when the raise closed, locking contributors for up to 37 days  `PROVEN`

**Where** `contracts/presale/PresaleVault.sol:278-291` (`fail`), against `:104-113` (`initialize`'s bounds:
`MAX_DURATION` 30 days, `GRACE_MAX` 7 days).

```solidity
if (block.timestamp <= deadline) revert BeforeDeadline();
```

`fail()` cannot fire before `deadline` under any circumstances, and `finalize()` has **no upper time bound**.
But a presale stops accepting deposits the moment `totalRaised == target` — `deposit` reverts `TargetMet`
(`:150`). So the raise can close in its first minute while the escape hatch stays shut for the full term.

At the permitted maximums — `deadline = now + 30 days`, `finalizeGrace = 7 days` — a presale that fills 60
seconds after creation leaves contributors with **no exit for a measured 36.9999 days**: they cannot deposit, cannot refund
(`refund` requires `failed`), cannot claim (`claim` requires `finalized`), and cannot force the issue
(`fail` reverts `BeforeDeadline`, then `TargetMet` until deadline + grace). Meanwhile the creator holds a free
37-day option: finalize whenever the market suits, or let it lapse into reason 2.

**The lockup is bounded and self-service at the end.** `fail()` is fully permissionless — no modifier, no
`msg.sender` check (`:272`) — so the instant `block.timestamp > deadline + finalizeGrace` any contributor can
flip the vault themselves and pull 100%. Proven: a contributor-initiated `fail()` emits `Failed(2)`, the
subsequent `finalize()` reverts `NotOpen`, and `refund()` returns the full 1 ETH. The exposure is the dead
window, not a permanent trap — which is why LOW.

**Nothing is extractable.** Refunds pay exactly 100%, no party profits from the dead window, and the creator
gains only optionality, not value. One reviewer scored this INFO on that basis and the other LOW; it is
recorded at LOW because it is a fixable design defect touching user funds' availability, not because anything
is at risk.

But "trustless, refundable" is doing less work than it appears: the refund is guaranteed *eventually*, on a clock the contributor does not control and which
is not anchored to anything they can observe.

**Fix direction.** Anchor the hatch to the raise closing, not the calendar: record `filledAt` when
`totalRaised` first reaches `target`, and let `fail()` fire at `min(deadline, filledAt) + finalizeGrace`. That
preserves the grace window's purpose — giving a preimage-holder time to finalize — while removing the dead
time between a full raise and an arbitrary deadline.

---

---

---

### L-14 · LOW · Forfeit-to-stayers is opt-out: `claim()` is not gated by `antiJitDelay`, so only uninformed stakers pay  `PROVEN`

**Where** `contracts/pads/DualStaking.sol:307` — the *only* use of `antiJitDelay`, inside `unstake` — against
`:337` (`claim`, ungated) and `:313-326` (`unstake`'s forfeit loop).

`unstake` confiscates **all** of the caller's unclaimed rewards on that side and re-streams them to whoever
stays:

```solidity
uint256 f = rewardsAccrued[side][asset][msg.sender];
if (f > 0) { rewardsAccrued[side][asset][msg.sender] = 0; _applyReward(side, asset, f, false); }
```

But `claim` carries no hold at all. So the forfeit is trivially avoidable: call `claim` first, *then*
`unstake`, and nothing is forfeited. The mechanism therefore does not deter early exit — it only penalises
users who do not know the order.

**Measured** with the maximum `antiJitDelay = 7 days`, ETH listed on the TOKEN side and fee 0: Alice and Bob
each stake 1,000 tokens, the owner funds 10 ETH, and after 7 days each has accrued
**4.9999999999998384 ETH**. Bob calls `unstake` directly — his ETH balance changes by **−0.000163 ETH (gas
only)** and his `earned` drops to **0**; the full ~5 ETH is confiscated and re-streamed. Alice calls `claim`
first, keeps her ~5 ETH, and then unstakes freely.

The contract's header presents this as one of two anti-JIT defences — *"rewards STREAM over a window (a
flash-staker accrues ≈0), and an `antiJitDelay` hold gates unstake"* — and as `forfeit-to-stayers`. As
implemented it is neither a deterrent nor a redistribution from JIT actors; it is a transfer from
less-sophisticated stakers to more-sophisticated ones.

**Fix direction.** Gate `claim` on the same `stakedAt + antiJitDelay` hold as `unstake`, so the forfeit
applies to anyone exiting early rather than only to those who exit in the wrong order. If the intent is that
rewards should always be claimable, then drop the forfeit — a mechanism that only catches the uninformed is
worse than none.

---

### L-15 · LOW · The architecture doc tells the operator to mine the hook salt to the **wrong flag word**  `VERIFIED`

**Where** `ROBIN-V4-ARCHITECTURE.md:102`, `:245`, `:271` say `0x00C4`; `contracts/hooks/BaseHook.sol:30` and
`contracts/core/CurvePadFactoryV4.sol:46` both say `0x00CC`.

The launch path requires the mined hook address to satisfy `uint160(hook) & 0x3FFF == REQUIRED_FLAGS`, and
`CurvePadFactoryV4` reverts `HookFlagsMismatch` otherwise. The architecture document states that constant three
times — including as a literal instruction, *"MINE `hookSalt` so `CREATE2(...) & 0x3FFF == 0x00C4`"* — and every
one of them is off by the `0x08` bit (`AFTER_SWAP_RETURNS_DELTA`, which the hook genuinely needs: it returns an
`int128` from `afterSwap` to take the sell tax).

There is exactly one hook contract and one flag constant in the whole suite, and **both** factories bind it:
`PadFactory.sol:44` (`HOOK_FLAGS = 0x00CC`, cross-checked twice at `:142-143`) and `CurvePadFactoryV4.sol:46`.
So `0x00C4` is wrong for every stack — this is not I-4's PadFactory/curve confusion wearing a different hat.

`ROBIN-V4-CURVE-ECON.md:37` has the correct value, so the docs disagree with each other as well as with the
code, and the wrong number has since propagated into places a reviewer would treat as corroboration:
`DEPLOY.md:33` writes `hook@0x…C4`, and `test/fork/PadFactory.launch.fork.test.js:23` names its test *"hook
flags 0xC4"* (the assertion itself is fine — only the title is wrong, which is worse, because a test name that
agrees with the doc is exactly what a skim-reader checks). `scripts/mine.js` reads the flags from the compiled
artifact rather than from the doc, so the shipped tooling is unaffected — this bites the operator who mines by
hand, which `DEPLOY.md` and `deploy-curve.js:119-122` both contemplate. The failure is loud (`HookFlagsMismatch` at launch, before any state is written) and costs a
wasted mining run rather than funds, which is why this is LOW rather than a wiring MEDIUM.

**Fix direction.** Correct all three occurrences to `0x00CC`, and derive the number in the docs from
`BaseHook.REQUIRED_FLAGS` rather than restating it — this is the third place in this report where a hand-copied
constant drifted from the code it describes (see also L-5, L-6).

---

### L-16 · LOW · `graduate()` gates on the **tick**, the anti-grief nudge gates on the **sqrt price**, so the LP can seed above the ceiling  `PROVEN`

**Where** `contracts/pads/RobinCurveV4.sol:297-298` (`ready()`), `:309` (`graduate()`'s gate), against `:531-533`
(the nudge's gate) and `:556` (`CeilingNotRestored`), consumed at `:623-628` (`_mintPermanentLp`).

Three guards, two different notions of "at the ceiling":

```solidity
:298  return tick <= gradTick;                      // ready()
:309  if (tick > gradTick) revert NotReady();       // graduate()
:533  if (curSqrt < gradSqrt) { … nudge … }         // _graduatePull()
:556      if (nowSqrt != gradSqrt) revert CeilingNotRestored();
```

A tick index is a *range* of sqrt prices. The state `tick == gradTick && curSqrt > gradSqrt` — spot strictly
inside tick index `gradTick`, above its lower boundary — satisfies both tick gates and fails the sqrt gate, so
graduation proceeds and **the nudge and its `CeilingNotRestored` check never execute**. That is precisely the
sliver of the curve range that is still unsold, so the pad graduates with the curve *not* fully sold.

It is reached by an ordinary buy that stops a hair short of the ceiling. Measured on a real local v4
`PoolManager` at the top of the window (`sqrtPriceLimitX96 = sqrtAt(gradTick+1) - 1`, geometry START 6000 /
GRAD 3000 / ts 60):

```
gradTick            3000
sqrt(gradTick)      92049301871182272007977902845
sqrt(gradTick+1)    92053904221219956504424993032
spot sqrt AFTER     92053904221219956504424993031   tick 3000
spot > gradSqrt?    true       tick <= gradTick? true
ready() == true  →  graduate() succeeds, nudge SKIPPED
```

Two comments in the file are therefore false as written. `:298`: *"curve fully sold (spot at the ceiling, or
below it if a buy overshot)"*. And `:623`, load-bearing for the LP sizing: *"Spot is guaranteed == gradTick here
(the nudge + `CeilingNotRestored` check), so price at the canonical ceiling."*

**What it costs.** `_mintPermanentLp` sizes `L` from `spGrad` (`:627`) but `PositionManager` binds the position at
the pool's actual price, which is higher, so the mint pulls **less** ETH than `lpEth` and the `SWEEP` action
returns the difference to the curve — where step 9 books it to `platformEthOwed`. That is the leak `[HIGH-2]`
exists to prevent (*"so the WHOLE `lpEth` binds into the locked position — never let the token leg bind and leak
unbound ETH to the platform book"*). Exact v4 integer arithmetic at the worst point in the window:

| `lpEth` | ETH actually bound | unbound → platform book |
|---|---|---|
| 1 ETH | 999950003749687533 | 49,996,250,312,467 wei (0.005000%) |
| 3 ETH | 2999850011249062599 | 149,988,750,937,401 wei (0.005000%) |
| 100 ETH | 99995000374968753283 | 4,999,625,031,246,717 wei (0.005000%) |

Capped at one tick, so ~5 bps of the LP leg — real but small, which is why this is LOW and not a MEDIUM
alongside M-11. The second-order effect deserves a line even so: the `InsufficientReserve` guard at `:630` is
also evaluated at `spGrad`, while the mint's true `amount1` requirement is computed at the higher spot — for
`lpEth = 3 ETH`, 171,101,814,838,709,507,352,469,880 actually required against 171,093,260,389,545,913,825,336,142
checked. The 11.5M-token margin measured in §4 absorbs it comfortably at production geometry, but the check does
not prove what it is written to prove.

**Fix direction.** Make all three guards agree on sqrt price. `ready()` and `graduate()` should compare
`getSlot0`'s `sqrtPriceX96` against `TickMath.getSqrtPriceAtTick(gradTick)`, not the tick — that closes the window
in one line and makes `:623`'s guarantee true. If the tick comparison is kept deliberately (it is cheaper and one
tick of slack is intentional), then `_mintPermanentLp` must size `L` from the **live** `sqrtPriceX96` rather than
`spGrad`, and `:298`/`:623` must stop claiming an equality the code does not enforce.

---

### L-17 · LOW · `RobinAmbushVault.stakingRecipient` is a nullable **immutable** in an add-only vault, so unset means permanently stranded  `VERIFIED`

**Where** `contracts/pads/RobinAmbushVault.sol:57` (`address public immutable stakingRecipient; // may be 0`),
`:94-96` (the constructor's zero-address check, which covers `floorRecipient` but deliberately not this one),
`:176-186` (`_forwardStaking`).

```solidity
:94   if (poolManager_ == address(0) || stateView_ == address(0) || floorRecipient_ == address(0) || curve_ == address(0))
:95       revert ZeroAddress();
…
:177  address s = stakingRecipient;
:178  if (s == address(0)) return 0;
```

The band accrues LP fees on both sides. The ETH side goes to `floorRecipient`, which the constructor requires be
non-zero. The token side goes to `stakingRecipient`, which the constructor explicitly permits to be zero, and the
comment records the intended consequence: *"then token fees stay idle-in-vault"*. `_forwardStaking` duly returns
early, and the token accumulates in the vault.

The problem is that "idle-in-vault" is terminal here, not deferred. `RobinAmbushVault` has **no owner, no
`withdraw`, no `sweep`, no `rescue`, and no setter** — the header states the add-only property as a security
feature (*"there is deliberately NO remove/withdraw/burn path"*), and it applies to the token balance as much as
to the ETH principal. So a vault deployed with `stakingRecipient_ == 0` sends holders' token-side band fees to a
contract from which no party — platform, creator, holders, or a future governance — can ever retrieve them.
`flushFees()` is permissionless, so any caller can move fees from the pool position into that terminal state.

Every other staking sink in the suite is a settable one-shot precisely so this cannot happen:
`RobinCurveV4.setStaking` (`:457`), `LockVault.setStakingRecipient`. The ambush vault is the only one that fixes
it at construction *and* allows it to be null. It is also the only in-scope contract with **no deploy script at
all** — `scripts/deploy-curve.js:120` mentions it solely inside a `console.log` runbook line — so the argument is
hand-typed, by the operator, once, unverifiably (the same L-7 hazard, with a worse failure mode).

Severity is LOW because it is fees rather than principal, it is entirely under the deployer's control at deploy
time, and getting it right costs nothing. It is reported because it is *silent*: nothing reverts, nothing emits,
and the loss is only visible as a token balance that grows and never moves.

**Fix direction.** Cheapest: add `stakingRecipient_` to the `ZeroAddress` check and delete the "may be 0" comment.
Better: make it a one-shot setter like `LockVault.setStakingRecipient`, so the vault can be deployed before the
staking pool exists — which is the actual sequencing constraint that motivated allowing zero — and wired
afterwards, with the accrued token forwarded on the first `flushFees()` after wiring.

---

### L-18 · LOW · Whoever calls first decides where a band's ETH LP fees go — and the diverting call costs 1 wei  `PROVEN`

**Where** `contracts/pads/RobinFloorVault.sol:150` (`_add`'s `_resolve(currency0, delta.amount0(), address(this))`)
against `:161-172` (`_collect`, which takes to `feeRecipient`); the same shape in
`contracts/pads/RobinAmbushVault.sol:210` (`_add`'s `_resolve(currency0, delta.amount0())`, which takes to
`address(this)`) against `:141-148` (`collectFees`, which forwards to the floor).

A positive `modifyLiquidity` in v4 returns `callerDelta = principalDelta + feesAccrued`, so **adding** liquidity
realizes the position's accrued fees as a credit against the principal owed. Both vaults have two permissionless
entry points that realize the same fees to **different destinations**:

| | realized by `collect…()` | realized by `add…()` |
|---|---|---|
| `RobinFloorVault` | `take(currency0, feeRecipient, …)` → the platform (`:170`) | `_resolve(…, address(this))` → stays in the vault, folded into the wall by the next `addFloor()` (`:150`) |
| `RobinAmbushVault` | `_forwardFloor(ethFee)` → the floor vault (`:145`) | `_resolve(…)` → `take` to `address(this)` (`:247`), where `seedAmbush`'s `balanceOfSelf() - pendingFloorEth` (`:128`) turns it into band principal |

Neither vault has a remove path, so once the fees land in principal they are there permanently. And ETH sitting
in the vault's plain balance is **not** recoverable by the fee path: `_forwardFloor` only ever forwards
`fresh + pendingFloorEth`, and `flushFees()` passes `fresh = 0`, so a retained balance can only ever leave as
principal on the next `add`.

`receive()` is open on both vaults (`RobinFloorVault.sol:208`, `RobinAmbushVault.sol:265`), so anyone can create
the `amt > 0` precondition for the `add` path with a dust transfer. Measured — identical tape, identical fees,
only the call order differs:

```
keeper calls collectFloorFees() first:
   ETH to platform         27,199,391,316,139,840        (0.0272 ETH)
   floorLiquidity added    0
anyone donates 1 wei and calls addFloor() first:
   ETH to platform         0
   floorLiquidity added    610,019,229,311,931,910
```

Two things follow. First, the documented revenue line is not a fact about the system: `DEPLOY.md:53` and the
money model both state the wall's LP fees go to the platform, and `scripts/keeper.js` collects on a schedule on
that assumption — but any third party can pre-empt every sweep for 1 wei plus gas, permanently. Second, the
ambush instance **falsifies the contract's own header invariant** (`RobinAmbushVault.sol:42-44`: *"Only accrued
LP fees ever leave (ETH → floor, token → staking)"*). ETH fees can instead be silently absorbed into the band
they came from, so the floor — the protection the whole design is sold on — never receives them.

This is LOW rather than a MEDIUM because **no value leaves the protocol and no attacker gains anything**: both
destinations are permanent, non-withdrawable, protocol-owned positions, and the griefer's only reward is moving
money between two of the platform's own pockets. It is reported because the accounting is genuinely
non-deterministic — you cannot state what a pad earns from either band without knowing the call order — and
because the contract asserts an invariant it does not hold.

Note the contrast that shows this was thought about once and not carried through: `RobinFloorVault._add:152-154`
handles exactly this case for the **token** leg, with a comment explaining that a positive `delta.amount1()` is
realized fees and must go to `feeRecipient` *"(exactly like `_collect`)"* because taking it to the vault would
strand it. The currency0 leg is the same situation with the opposite treatment, and the comment above it
(*"currency0 is the floor's own working capital"*) is true of principal but not of the fees mixed into the same
delta.

**Two of ten, and the fix is already written twice in this repository.** Every `poolManager.modifyLiquidity`
call site in `contracts/`:

| site | delta | fees mixed into the delta? |
|---|---|---|
| `RobinCurveV4:500` (`seed`) | `+L` | no — the position is new, nothing has accrued |
| `RobinCurveV4:512` | `0` | pure realization ✓ |
| `RobinCurveV4:560` (`_graduatePull` a) | `0` | pure realization ✓ — **and it runs immediately before the removal** |
| `RobinCurveV4:568` (`_graduatePull` b) | `−curveL` | no — `:560` already drained them in the same unlock |
| `RobinLpVault:210` (`_add`) | `+L` | no — `_harvest()` realizes in a *separate* `unlock` first |
| `RobinLpVault:221` (`_remove`) | `−L` | no — same `_harvest()` discipline |
| `RobinLpVault:235` (`_collect`) | `0` | pure realization ✓ |
| `RobinFloorVault:162` (`_collect`) | `0` | pure realization ✓ |
| `RobinAmbushVault:218` (`_collect`) | `0` | pure realization ✓ |
| **`RobinFloorVault:139`** (`_add`) | `+L` | **yes — this finding** |
| **`RobinAmbushVault:200`** (`_add`) | `+L` | **yes — this finding** |

Three contracts handle it correctly and two do not, so this is a local slip rather than a misunderstanding of
v4 — which also means the remediation needs no new idea.

**Fix direction.** Split the delta rather than netting it: `modifyLiquidity(0)` first, routing the fees to the
policy destination, then `modifyLiquidity(+L)` for the principal. `RobinCurveV4._graduatePull` already does
exactly this inside one lock (`:560` then `:568`), and `RobinLpVault` does it across two — copy either. Failing
that, pick one destination per vault and make both paths use it. Correct `RobinAmbushVault`'s header either way.

---

### L-19 · LOW · Four money movements the logs get wrong — one asserts a transfer that did not happen, three are silent  `PROVEN`

**Where** `contracts/pads/RobinCurveV4.sol:369`/`:382`/`:654-663`; `contracts/pads/RobinLpVault.sol:140-141`,
`:151-154`, `:217`; `contracts/pads/RobinLockStaking.sol:112-117`; `contracts/pads/RobinFloorVault.sol:151-157`.

Filed as one finding because all four share a root and a fix: **value moves without a log, or a log asserts a
movement that did not occur.** Nothing here risks funds — the transfers themselves are correct. What breaks is
anyone reconstructing the system from its own events: an indexer, a TVL dashboard, a keeper, a monitoring
alert, or an auditor totalling "how much reached holders". All four were measured against a real local
`PoolManager`; none of these event names appears anywhere else in this report.

**(a) `Graduated.toStaking` reports a transfer that did not happen — on the default deployment ordering.**
Step 7 calls `_fundStaking(leftoverToken)` (`:369`), which returns early and silently when `staking ==
address(0)` (`:656`). Step 9 then emits `Graduated(lpTokenId, raisedEth, leftoverToken, …)` (`:382`), whose
third field is declared `toStaking` (`:132-139`). Because `setStaking` is a one-shot the runbook performs
*after* graduation (M-7, M-11, I-4), "graduated before staking was wired" is the ordinary path. Measured with
staking unwired: `Graduated.toStaking = 354,484,424,081,845,287,800`, tokens actually moved = **0**, tokens
still sitting on the curve = the same 354.48e18, `StakingFunded` never emitted.

Worse, `emit StakingFunded(amount)` sits **inside** the `try` (`:660-661`), and the contract's own comment
(`:658-659`) says that poke is *expected* to revert when the token is not yet listed. So on the branch where
the tokens have physically moved into the staking pool but the credit poke failed, nothing is emitted at all.
`StakingFunded` is therefore unusable in both directions — silent when the reservoir moves, and later emitted
as `StakingFunded(0)`-shaped noise when `flushStaking()` credits it.

**(b) `RobinLpVault.Deposited` logs the amounts *offered*, not the amounts used — and the refund has no log.**
`deposit` stashes `_ethIn = msg.value` and `_tokIn = tokenMax` (`:140-141`) before the unlock, and `_add`
emits `Deposited(_who, L, _ethIn, _tokIn)` (`:217`) under field names `ethUsed` / `tokenUsed`. But
`getLiquidityForAmounts` (`:206-208`) binds on one side only, so the other is over-supplied by design and
refunded at `:151-154` — with **no event**. The token refund is at least visible as a raw ERC-20 `Transfer`;
the ETH refund is a bare `call{value:}` that emits nothing, and `msg.value` never appears in a log, so the ETH
a depositor actually contributed is **not reconstructible from the receipt at all**. Measured: offering
1 ETH + 50,000 token logs `tokenUsed = 50,000e18` against 1e18 actually consumed (**50,000×**); offering
100 ETH + 1 token logs `ethUsed = 100e18` against 1e18 (**100×**). Since `tokenMax` is meant to be generous —
the vault refunds the rest as a feature — the overstatement is the normal case, not a corner.

**(c) `RobinLockStaking.stake`'s reservoir flush is silent, and it is C-1's arming step.** Every other route
into the drip announces itself through `_accrueReward`, which emits `RewardAdded` on both its park and drip
branches (`:206`, `:211`). `stake` does not use it — it inlines the flush (`:112-117`) and calls `_startDrip(p)`
directly, which writes `rewardRate` and `periodFinish` and moves the whole parked reservoir into an active
stream. The transaction's only log is `Staked`. Measured: `fund(1000e18)` on an empty pool emits
`RewardAdded(…, 1000e18, false)`; the next transaction, `stake(1e18)`, emits **only**
`Staked(…, 1e18, 1789234579)` while `pendingRewards` goes 1000e18 → 0 and `rewardRate` goes 0 →
385,802,469,135,802 wei/s. The sibling `DualStaking._kickstartPending` (`:230-235`) does emit on the identical
path, so this is a local slip. Its significance is detection: **C-1's exploit arms with exactly this call**, so
a monitoring system watching this contract sees an ordinary 1-wei `Staked` and no rate change at all.

**(d) `RobinFloorVault.addFloor()` pays token-side LP fees to the platform with no log.** On this single-sided
currency0 wall a positive `delta.amount1()` in `_add` is entirely realized token fees — the code says so at
`:151-153` — and `_resolve` `take`s it straight to `feeRecipient` (`:154`). The only event is
`FloorAdded(amt, L, floorLiquidity)` (`:157`), which has no token field. The sibling path `_collect` emits
`FloorFeesCollected(amount0, amount1, to)` for the same money. Measured: a 1 ETH carve + `addFloor()` moved
**15,596,599,508,071,243 wei of token (0.0156)** to the platform wallet, and the only event in the transaction
was `FloorAdded(1e18, 33939159639764788040, 203634957838588728241)`. So the platform's floor-vault token
revenue cannot be totalled from the vault's logs, and **which path a given accrual takes is decided by call
order** — the same non-determinism L-18 describes for the ETH leg. Note the pairing: L-18 is the currency0 leg
going to the wrong *destination*; this is the currency1 leg going to the right destination with no *record*.

**Fix direction.** (a) emit `Graduated` with the amount `_fundStaking` actually delivered (have it return that),
and move `emit StakingFunded` outside the `try` — or emit a distinct `StakingParked` on the early return and a
`StakingPushedUncredited` on the catch. (b) emit `Deposited` from after the refunds, with
`-delta.amount0()` / `-delta.amount1()`, and add a `Refunded` event. (c) route `stake`'s flush through
`_accrueReward` like every other path, or emit `RewardAdded` from `_startDrip`. (d) emit `FloorFeesCollected`
from `_add`'s currency1 branch, exactly as `_collect` does.

---

### L-23 · LOW · `RobinLpVault`'s fee carry is credited to the accumulator *and* retained, so booked fees drift above the reserve that backs them  `PROVEN (numerically)`

**Where** `contracts/pads/RobinLpVault.sol:246-263` (`_collect`), against `:119-120` / `:277-278` / `:284-285`
(what a user is actually paid) and `:188-189` (`claim`'s `feeReserve -= …`).

```solidity
feeReserve0 += f;                              // the reserve grows by f ONLY
uint256 amt = f + feeCarry0;                   // …but the carry re-enters the distributable base
uint256 inc = (amt * ACC_PRECISION) / tl;
accFee0PerLiq += inc;                          // acc credits the FULL amt, carry included
feeCarry0 = amt - (inc * tl) / ACC_PRECISION;  // …and the carry is retained again
```

The round believes it attributed `d = (inc·tl)/ACC` and carries the rest. But a user is paid
`⌊liq·acc/ACC⌋` — the floor of the **cumulative** product — which recovers the fractional part as soon as `acc`
crosses the next integer. So the carry is credited through `acc` *and* held in `feeCarry`, and re-enters `amt`
next round. Per round the gap is at most a wei; across rounds it accumulates, because `acc` only grows.

**This falsifies a claim in §4 of this document.** That section asserted the accumulator was checked
algebraically — *"`Σ⌊liq_u·acc⌋ ≤ ⌊Σliq_u·acc⌋`, so claims can never exceed `feeReserve`"*. The first
inequality is true and the conclusion does not follow from it: it bounds total claims by `⌊tl·acc/ACC⌋`, and
**`⌊tl·acc/ACC⌋` itself was never checked against `feeReserve`**. That is exactly where the drift lives.

**Measured** by replicating `_collect`'s integer arithmetic exactly (the same harness used for L-1), a single LP
holding all of `tl`:

| `tl` | fee per harvest | rounds | `feeReserve` | claimable | over by |
|---|---|---|---|---|---|
| 2^64 = 18,446,744,073,709,551,616 | 1000 wei | **14** | 14,000 | 14,001 | **1 wei** |
| 2^64 | 5 wei | 29 | 145 | 147 | 2 wei |
| 13,019,129,659,372,280,635,197 (≈1.3×10^22) | 518,638,994,705 wei | 5,000 | 2,593,194,973,525,000 | 2,593,194,973,528,825 | **3,825 wei** |

Both `tl` values are ordinary full-range positions, so this is not a toy regime — though it is
divisibility-sensitive: `tl` = 1e18+1, 3e18 and 1e20+7 showed no drift within 5,000 rounds. `_harvest()` runs
on **every** `deposit`, `withdraw` and `claim`, so "many small collect rounds" is this vault's normal operating
mode, not a contrived one.

**Impact, stated at its real size.** `claim` (`:188-189`) does `feeReserve -= …` under checked arithmetic, so
once the last claimant's `pending` exceeds what is left, their `claim()` **reverts entirely** — not partially —
and their whole accrued fee balance is stuck, not just the dust. Two things bound it. Principal is never at
risk: `withdraw` books pending but does not pay it and does not touch `feeReserve`, so liquidity always exits.
And the condition is **self-healing on a live pool** — each later harvest adds `f` to the reserve while adding
at most ~1 wei of drift, so the reserve outruns it and the claim succeeds on a retry. It is only permanent when
the pool stops earning, which for a launchpad is the ordinary end state of most pads.

That is why this is LOW rather than the MEDIUM it first looks like: the arithmetic defect is real and the
solvency invariant genuinely does not hold, but the failure is a transient revert on a live pool and a
dust-scale stranding on a dead one.

**Fix direction.** Do not re-enter the carry into the distributable base. Either drop `feeCarry` entirely —
paying users `⌊liq·acc/ACC⌋` already recovers the remainder once `acc` advances, which is what makes the carry
redundant — or keep it and subtract the carry from what `acc` credits, so the two mechanisms are not both
claiming the same wei. Then assert the real invariant in a test: `⌊tl·accFee0PerLiq/ACC⌋ ≤ feeReserve0` after
every `_collect`.

---

### I-1 · INFO · Recorded so the next pass does not re-derive them

1. **`PresaleVault`'s implementation is never initialised.** `PresaleVaultFactory.createPresale` clones and
   initialises atomically (`:42-45`), but the template is left open — anyone can `initialize()` it and run a
   presale on it. It will not appear in `isPresale`, so a front end that checks the registry is safe.
2. **`PadFactory.launch` sends the factory's entire ETH balance to `cfg.creator`** as "dust"; `StockPadFactory`
   does the same with its entire stock balance. Both are plain recipients, so anything donated or stranded goes
   to whoever launches next.
3. **`StakingFactory.createPool` is fully permissionless with a caller-chosen `extraRewarder`**, and
   `poolsOf[token]` is a public registry. Anyone can squat a plausible-looking pool for any token, with
   themselves as a rewarder.
4. **`LockVault.collectFees` uses whole-contract balance deltas** over currencies shared by every launch it
   holds. The delta arithmetic is correct, but a direct ETH donation to the vault is credited to whichever
   launch is collected next.
5. **`RobinLockStaking._startDrip` truncation** (`amount / rewardsDuration`) permanently strands up to
   `rewardsDuration - 1` wei per tranche in `rewardsBalance` — never dripped, never claimable. Dust-scale, but
   `rewardsBalance` and `reservoir()` slowly drift from what is actually payable.
6. **`RobinCurveV4.restoreCeiling` is a tax-exempt sell route** — the curve is `sender == bufferRecipient` and
   so is exempted in `RobinFeeHook.afterSwap` (`:284`). It is bounded by the gap between spot and `gradTick`
   and is the intended anti-grief incentive, but the sell tax *can* be legally avoided on that leg, and that
   should be stated rather than discovered.
7. **`RobinFeeHook.claimReferral` NatSpec** (`:366`) says one call *"aggregates across every ETH pad you
   referred, so one call sweeps them all."* Each pad gets its own hook contract (the token is in the hook's
   init-code, `CurvePadFactoryV4.sol:151`), so a referrer must claim on every pad's hook separately.
8. **`PresaleVault.launchConfig()` does not exist.** The field comment at `:51` reads *"exposed via
   `launchConfig()` (explicit getter → returns string members cleanly)"* — but no such function was ever
   written, and `cfg` is `internal`. So a depositor evaluating a live presale can read `target`, `deadline`,
   `totalRaised`, `perWalletCap`, `minContribution`, `saltCommitment` and `state()`, but **not** `supply`,
   `curveSupply`, `reserveSupply`, `tickSpacing`, `name` or `symbol` — the values that decide how many tokens
   their wei buys. Combined with M-12 (the geometry is not committed either), a contributor can verify almost
   nothing on chain about what they are funding.
9. **`StockQuoteAdapter`'s constructor comment is wrong about its own failure mode.** `:59` says the
   `ACCESS_CONTROLLED_REGISTRY()` probe *"reverts (or returns 0) for a non-stock"*. There is no returns-0 path:
   against a contract with a permissive fallback the call succeeds with empty returndata and the **decode**
   reverts. It fails closed either way, so this is a comment fix, not a defect — but it is the same
   misunderstanding of return-data decoding that produced H-3 and M-17, written down three files away.
10. **`parkedQuote` and `parkedEth` are write-only.** `RobinFloorVault:58/114/156` and
    `RobinAmbushVault:69/132/213` declare, assign and clear them, and **nothing — no contract, no script —
    ever reads either**; `addFloor` and `seedAmbush` both re-derive the amount from the live balance. Both are
    `public`, so an indexer or front end will read them as accounting, and both can lie: they are assigned
    `=` rather than `+=`, and `parkedEth` is computed as `balanceOfSelf() - pendingFloorEth` at park time, so a
    later failed floor send silently makes it an overstatement. Harmless on chain; misleading off it.
11. **`RobinLpVault.deposit` refunds the vault's *entire* non-reserve balance to the depositor**
    (`:151` `address(this).balance - feeReserve0`, `:153` `balanceOf(this) - feeReserve1`). `receive()` is open
    (`:316`), the vault has no owner and no rescue path, and nothing in the suite routes value to it, so any ETH
    or token that reaches it outside a deposit is swept by whoever deposits next. The fee reserve and the
    `feeCarry` remainder are correctly excluded, so this can only ever capture a mis-send — but a mis-send here
    has no recovery other than being someone else's refund.
12. **`DualStaking._applyReward` floors `rewardRate` with no carry and no sweep** (`:248`
    `(amount + leftover) / dur`, `:252` `((remaining * rate) + amount) / remaining`). Total streamed is
    `rate × dur`, so `(amount + leftover) mod dur` wei of reward capital already received is dropped from every
    future accrual on that call, unrecoverable by anyone including the owner. Bounded by `duration − 1` wei per
    funding call — ≤604,799 wei on the constructor-listed 7-day ETH stream, ≤31,535,999 on a 365-day one — so
    it is dust, but it contradicts the "only place" claim §4 used to make, and unlike `RobinLpVault` there is
    no `feeCarry` to catch it. `RobinLockStaking` has the same shape; I-1(5) records its zero-rate case, which
    C-1 then weaponises.
13. **`RobinLockStaking.rewardPerToken()` omits the underflow guard its sibling has — and C-1's fix touches
    exactly those lines.** `:84` computes `_lastTimeRewardApplicable() − lastUpdateTime` unguarded under checked
    arithmetic, where `DualStaking:173-175` returns early on `tApp <= r.lastUpdateTime`. `_updateReward` is on
    the entry path of `stake`, `withdraw`, `getReward`, `fund` and `fundTokenPushed`, so one underflow would
    revert **every** state-changing function permanently, principal included. It is not reachable today: the
    invariant `lastUpdateTime <= periodFinish` holds across all four writers (`:94`, `:138`, `:225`, `:231`),
    and `withdraw:138` — the one place `periodFinish` moves *backwards* — is safe only because `:126` ran
    `_updateReward` first. Recorded as a **remediation hazard**: C-1's fix directions edit this exact block, and
    an edit that moves `periodFinish` backwards without updating `lastUpdateTime` first converts C-1 from a
    theft into a permanent freeze.
14. **The instant `block.timestamp == deadline` belongs to neither presale phase.** `PresaleVault:139` reverts
    `AfterDeadline` on `>=` while `:274` reverts `BeforeDeadline` on `<=`, both against the same variable, so
    for one second an under-target presale can neither be topped up nor closed out (`finalize` is unreachable
    too, since `totalRaised < target`). Proven on a real stack: at a block mined with `block.timestamp ==
    deadline`, `deposit()` → `AfterDeadline()` and `fail()` → `BeforeDeadline()`; at `deadline + 1`, `fail()`
    succeeds. The grace boundary has the mirror slip — `:278` is strict, so the hatch opens at
    `deadline + finalizeGrace + 1` and the effective grace is one second longer than `GRACE_MIN`/`GRACE_MAX`
    name. Nothing is extractable; recorded because `>=`/`<=` on one variable is usually a real bug, and here it
    happens not to be.
15. **Every `PositionManager` call passes `block.timestamp` as its own deadline**, so v4-periphery's
    `checkDeadline` is structurally disabled at all four sites that touch it (`PadFactory:244`,
    `LockVault:117`, `StockPadFactory:226`, `RobinCurveV4:647`) — `t > t` is never true. Nil impact today, and
    checked rather than assumed: all four are atomic within a transaction whose price is already pinned, and
    the two that could drift are independently defended (`PadFactory:158-161` reverts `PoolAlreadyInit` on any
    other init price; `_mintPermanentLp` runs after the nudge has forced spot to `gradTick`). Worth fixing as
    hygiene, since the guard is free and its absence is invisible.
16. **`isPresale` / `PresaleCreated` authenticate the factory, not the creator.** `createPresale` is
    permissionless and writes a caller-supplied `cfg.creator` into both on-chain identity signals, with no check
    that `msg.sender` is related to it. Combined with I-1(8) — `cfg` has no getter — there is no on-chain field
    distinguishing a genuine presale for project X from one an arbitrary address opened while naming X as
    creator. **This corrects I-1(1)**, which offers "it will not appear in `isPresale`, so a front end that
    checks the registry is safe" as the mitigation for the uninitialised template: registry membership does not
    carry that much. No principal is at risk — vault ETH only ever moves to the pooled buy or back to its
    depositor.
17. **`StockPadFactory`'s `stockRemainder` sweep is an arbitrary-ERC20 sweep of the shared factory.** `launch`
    derives the quote by calling `.stock()` on a **caller-supplied** adapter with no allow-list (H-2), then at
    `:189-190` sweeps `IERC20(stock).balanceOf(address(this))` in full to a caller-supplied `cfg.creator`. So
    `stock` is whatever the caller's adapter names — including another pad's `PadToken` — and the sweep takes
    the *shared factory's entire balance* of it. No protocol flow parks value there, so this is a mis-send
    recovery race rather than a loss of protocol funds. Recorded because it is what H-2 and I-1(2) compose
    into, which neither entry states on its own.
18. **The hook's only reentrancy fixture targets a function that does not exist.**
    `contracts/test/ReentrantClaimer.sol:7/:29/:35` re-enters `hook.claimHolder(id, idx)`; `RobinFeeHook` has
    no `claimHolder` — the surface is `claimPlatform`/`claimCreator`/`claimFloor`/`claimBuffer`/`claimReferral`.
    Grepping `test/`, `contracts/` and `scripts/` for `ReentrantClaimer` and `claimHolder` returns hits in that
    one file and nowhere else, so it is never instantiated either. Had it been wired, it would not have tested
    the guard: a call to a missing selector makes `_payout`'s raw call return false and the claim dies with
    `PayoutFailed`, not the `Reentrancy()` the fixture claims to prove. So `AUDIT-SCOPE.md` §4.3's "a reverting
    recipient can never brick a claim" has **zero** executed coverage on the hook's claim path — a gap M-19's
    table missed because it audits `test/`, not `contracts/test/` fixtures.
19. **`LockVault` and `CurvePadFactoryV4` hold two independent, never-cross-checked `positionManager`
    immutables** (`LockVault.sol:26`/`:63-65` against `CurvePadFactoryV4.sol:37`/`:93`). Grepping `contracts/`,
    `scripts/` and `test/` for `.positionManager()` returns **zero** call sites, so nothing compares them, and
    the gate that would have caught a mismatch at mint time is dead code (**L-24**). **Measured** with two
    independent mock managers: `graduate()` **succeeds with no warning**, `posmA.ownerOf(1) == lockVault`,
    `locks[1].registered == true`, `posmB.nextTokenId()` is still 1, and `collectFees(1)` reverts — permanently,
    since `positionManager` is immutable, `registerLaunch` and `graduate()` are one-shots, and the vault exposes
    no transfer selector. Filed here rather than as its own finding because the precondition is a typo in a
    canonical per-chain constant that appears two lines apart in the same script, and because it is one instance
    of a generic class rather than a distinct defect: `feeRegistry` (`LockVault.sol:27` vs
    `CurvePadFactoryV4.sol:39`) is uncross-checked in exactly the same way. **L-7** already registers hand-typed
    constructor arguments as the shared root cause. Both `lockVault.positionManager()` and
    `IPositionManagerMinimal.ownerOf` are free, public and never called.
20. **`FeeWalletRegistry` proposals never expire.** `pendingEta` is only cleared by a commit or an explicit
    `cancelProposal`, so a proposal made and abandoned stays committable forever. Given M-14 — this address is
    effectively the protocol's root admin — a stale proposal is a live capability sitting in storage.

---

### I-2 · INFO · `graduate()` does not poke `seedAmbush()`, so a ~0.015 ETH back-run can defer the band's arming  `PROVEN`

**Where** `contracts/pads/RobinCurveV4.sol:685-696` (`_fundAmbush` sends the ETH and stops), against its own
sibling `_fundFloor` at `:668-680`, which *does* poke (`try IFloorVault(f).addFloor() {} catch {}`). Seeding
guard at `contracts/pads/RobinAmbushVault.sol:127-134`.

Step 8b of the waterfall (`:375`) runs with `tick == gradTick` — the one moment the band is guaranteed to be a
clean single-sided ETH add — and does not take it. **PROVEN at production geometry** (startTick 201600 /
gradTick 178600 / ts 100): `ambushTickLower = 178700`, exactly 100 ticks (**1.005%**) below the graduation
price, and a 900,000-token dump (≈ **0.0146 ETH** of notional) moves tick to 178703, after which
`seedAmbush()` emits `AmbushParked` and adds nothing.

**Filed as INFO because every part of the harm claim fails on inspection:**

- **Not trapped.** `seedAmbush()` is `external nonReentrant` with no auth, and sizes itself from
  `currency0.balanceOfSelf() - pendingFloorEth` — not from the stale `parkedEth` bookkeeping variable
  (`RobinAmbushVault.sol:128`). Any unprivileged caller re-seeds the entire balance atomically:
  buy-with-price-limit → `seedAmbush()` → sell back, measured at a net **0.0000938 ETH + ~374k gas**, roughly
  0.2% of the seed once the 1%/1% hook taxes are counted.
- **Self-healing.** It arms with no rescue at all as soon as spot returns within 1.005% of the graduation
  price.
- **Small.** The exposed amount at production geometry is **0.2023 ETH** — 5% of a ~4.05 ETH raise.
- **Seeding at graduation would not have preserved the ETH anyway.** The first dip would have converted it to
  token inside the same add-only vault. The band doing its job and the band being unarmed are only
  distinguishable for that one dip.

So the entire residual harm is: one dip goes undefended, and 5% of the raise sits idle until somebody notices.
Worth fixing as hardening — add the same try/catch poke `_fundFloor` already uses — but it is not a fund
defect, and it is recorded here mainly so a future pass does not re-litigate it.

---

---

### I-3 · INFO · The idempotent-init `catch` blames a front-run for every `initialize` failure  `mechanism refuted, diagnostics only`

**Where** `contracts/core/CurvePadFactoryV4.sol:170-175`; same shape in `core/PadFactory.sol` and
`core/StockPadFactory.sol`.

The `[MEDIUM-3]` idempotent-init handler catches **every** `initialize` revert, re-reads `getSlot0`, and
reverts `PoolAlreadyInit` unless the price matches. For a pool that was never initialised `sqrtPriceX96` is 0,
which never matches — so any future `initialize` failure surfaces as *"someone front-ran you"* regardless of
the real cause. Fail-closed and non-exploitable; no funds or state are at risk.

**The `tickSpacing` route into it is refuted.** This was originally filed MEDIUM on the premise that
`tickSpacing` is unbounded because `:120` checks only `ts <= 0`. It is bounded — as a divisibility constraint
rather than a comparison. `:120` also requires `d.curveWidth % ts == 0`, and `RobinV4FeeConfig._validate`
requires `curveWidth > 0`; a positive divisor of a positive `int24` cannot exceed it, so **`ts <= curveWidth`
is structurally enforced**. At the shipped geometry that is `ts <= 23000 < 32767`, and the alignment
constraint is tighter still: `ts` must divide `gcd(startTickMag, curveWidth)` = `gcd(201600, 23000)` = **200**.
The test geometry gives 600. `TickSpacingTooLarge` is arithmetically unreachable, so the catch does not
currently mis-report anything.

The residual is purely diagnostic, and only bites a future geometry retune that pushes some parameter out of
v4's accepted range — at which point a creator-misconfigured launch dies with a misleading `PoolAlreadyInit`
(and, through a presale, an equally misleading `Failed(3)` — see M-15).

**Fix direction.** Distinguish the revert rather than adding a `MAX_TICK_SPACING` check: only blame a
front-run when `getSlot0` returns a **non-zero** price, and otherwise bubble the original error.

---

### I-4 · INFO · The only runbook in the audit package deploys a **different stack** — and following it produces M-2  `VERIFIED`

**Where** `DEPLOY.md` in full, listed by `AUDIT-SCOPE.md:6` as one of four companion documents.

`DEPLOY.md` is the sole operational document in the package, and it is a complete, competent runbook for the
**PadFactory** stack. The curve suite that `AUDIT-SCOPE.md:1` puts in scope has no runbook at all. Neither
`CurvePadFactoryV4`, `RobinV4FeeConfig`, `CurveV4Deployer`, `RobinCurveV4`, nor `RobinAmbushVault` is named
anywhere in the file, and `scripts/deploy-curve.js` — the curve path's actual deploy script — is never mentioned.

Line by line against the suite under audit:

- **§1** deploys `… → LockVault → PadFactory → (lockVault.setFactory) → StakingFactory`. Pointing
  `lockVault.setFactory` at `PadFactory` is exactly **M-2**: `LockVault` has one registrar slot, so the curve
  factory's `registerLaunch` then reverts `NotFactory` at `graduate()` step 5, permanently, for every caller.
  The runbook does not merely fail to prevent M-2 — as written it *instructs* it.
- **§2** runs `scripts/launch.js`, wires `hook.setFloorRecipient` and a `DualStaking` pool. On the curve path
  the launcher is `deploy-curve.js`, and the required wiring is a different and longer list —
  `curve.setStaking`, `curve.setCreator`, `LockVault.setStakingRecipient`, plus the hand-deployed floor and
  ambush vaults. That omission is the wiring cluster in **M-7**, **M-11**, **L-7** and **L-17**.
- **§2** also writes `hook@0x…C4` — a fourth occurrence of **L-15**'s wrong flag word.
- **Money model** is the PadFactory's flat 1% tax with LP fees split platform/staking. The curve's model is the
  directional buy/sell tax plus the graduation waterfall, and the table matches neither.
- **"The only mutable knob system-wide is `FeeWalletRegistry.platformFeeWallet`"** (`:60`, repeated at `:24`) is
  false for both stacks — see **L-6** and **M-10**.

Filed as INFO because the impact is already counted under the findings it produces rather than being additional
loss on top of them. It is recorded separately because those findings share one root cause, and it is not in the
contracts: the curve suite was never given a runbook, so its operator guidance is being read off another
system's. Any fix to M-2, M-7 or M-11 that does not also produce a curve-specific runbook leaves the next
operator following this document again.

**Fix direction.** Write `DEPLOY-CURVE.md` for the stack in scope, generated from `scripts/deploy-curve.js` so
the two cannot drift, with an explicit post-graduation wiring checklist that asserts every one-shot
(`lockVault.setFactory` → `CurvePadFactoryV4`, `hook.setFloorRecipient`, `curve.setStaking`, `curve.setCreator`,
`LockVault.setStakingRecipient`, both vaults' constructor arguments). Retitle `DEPLOY.md` to say which stack it
covers, and remove it from `AUDIT-SCOPE.md:6`'s reading list or mark it out of scope.

---

### I-5 · INFO · The pinned compiler carries an open `viaIR` advisory — the build does not trip it, but the package never says so  `VERIFIED`

**Where** `hardhat.config.js:11-15` (`version: "0.8.26"`, `viaIR: true`, `optimizer.runs: 1`, `evmVersion:
"cancun"`), restated as fact in `AUDIT-SCOPE.md` §1's toolchain line.

Checked against Solidity's official `docs/bugs.json`. Two documented bugs are **still unfixed** at 0.8.26:

| bug | severity | condition | fixed in |
|---|---|---|---|
| `UnsoundSpillInMutualRecursion` | medium | **`viaIR: true`** | 0.8.36 |
| `LostStorageArrayWriteOnSlotOverflow` | low | none | 0.8.32 |

The first matters because this project builds with `viaIR`. Its summary: *"Local variables of a function involved
in mutual recursion may spuriously be moved to fixed memory offsets and overwritten across recursive calls."*
Silent wrong values in a fee or liquidity computation is the worst class of defect in a contract like this one,
because nothing reverts.

**It does not fire here, and that was checked rather than assumed.** A contract-scoped call-graph scan over every
compiled unit — the 28 in-scope contracts plus the v4-core / v4-periphery libraries and the OpenZeppelin
`utils`/`token`/`access` trees they link against, **164 units, 1,339 function bodies** — found **zero
mutually-recursive cycles**. Calls were resolved only within their own contract or library, since a call through
an address or interface cannot participate in the compiler's local-variable spill. The 18 apparent
self-recursive hits are all either same-name **overload chains** (`Math.mulDiv(x,y,d)` → `mulDiv(x,y,d,rounding)`;
`SqrtPriceMath.getAmount0Delta(a,b,int128)` → `getAmount0Delta(a,b,uint128,bool)`) or genuinely recursive
OpenZeppelin utilities that **no Robin contract imports** (`Arrays._quickSort`, `Heap._siftDown`,
`ERC7739Utils`, `SignatureChecker`, `NoncesKeyed`). Confirmed by grep: none of those modules appear anywhere
under `contracts/`.

The second bug needs a storage array whose slot arithmetic straddles the end of the 2^256 storage space. No
contract in scope computes a storage slot by hand — and the one hand-picked slot that exists,
`BaseHook.REENTRANCY_SLOT`, is **transient** (`tstore`/`tload`), which the advisory does not cover.

Filed as INFO because it is a build-policy item, not a defect: today the code is outside both bugs'
preconditions. It is recorded because "no mutual recursion anywhere in the dependency tree" is currently an
**unwritten invariant** that an ordinary refactor or a dependency bump could break silently, and because an
external auditor will run this same check — the answer should already be in the package rather than costing
them a round trip.

**Fix direction.** Add one line to `AUDIT-SCOPE.md`'s toolchain note stating that 0.8.26 carries these two open
advisories, that neither precondition is met, and why 0.8.26 is pinned (matching the deployed
`PoolManager`'s build, per `DEPLOY.md`'s ground-truth section). Move to ≥ 0.8.36 when the dependency set allows,
which retires the unwritten invariant entirely.

---

---

## 4. Checked and clean

Recorded so the next pass spends its budget elsewhere. Each was a plausible bug that did not survive
verification.

- **Graduation LP mint vs `amount0Max`.** `_mintPermanentLp` sizes `L` from `lpEth` and passes `lpEth` as
  `amount0Max`; v4 rounds the required `amount0` **up**, so an off-by-one would revert the real
  `PositionManager` with `MaximumAmountExceeded` and brick graduation deterministically. Checked against the
  real integer math (`getLiquidityForAmount0`'s double-floor vs `getAmount0Delta(roundUp: true)`) over
  **20,009 sampled `lpEth` values: `amount0Required` never exceeds `amount0Max`, worst-case delta 0.** The
  double-flooring leaves enough slack. This matters precisely because no local test could have caught it —
  see M-8 on the mock ignoring both caps.
- **Factory reserve guard vs the real token leg.** At production geometry the guard
  (`CurvePadFactoryV4.sol:140`) demands ≥ 242,716,039 tokens; a 100%-to-LP graduation — the worst case the
  FeeConfig permits — needs 231,158,132. **11.5M margin**, and it holds at the guard's exact boundary.
- **Hook split-backing / money conservation.** Buy books (`platformOwed + bufferOwed + referralOwed`) sum
  exactly to each minted ERC-6909 claim; sell books (`creatorOwed + floorOwed`) sum exactly to each `take`;
  `_pullClaimsAndPay` burns then takes the exact amount before `_payout`, so redeeming a buy claim never draws
  on sell-side ETH. Dust falls to the platform on buys and the creator on sells, never negative, never
  double-paid.
- **v4 delta sign conventions.** `beforeSwap`'s positive specified delta and `afterSwap`'s `int128` return were
  traced through `v4-core/src/PoolManager.sol` and `libraries/Hooks.sol` in both directions; the hook's own
  delta nets to zero against its `mint` / `take` in each case.
- **Graduation waterfall underflow.** Step 9's
  `platformEthOwed = balance - floorEthOwed - creatorEthOwed - ambushEthOwed - bounty` cannot underflow: after
  the LP mint the balance always dominates the still-owed books plus the bounty, in both the
  `_fundFloor`/`_fundAmbush` success and re-park branches.
- **Sandwiching `RobinLpVault.withdraw`** (which has no `minOut`, unlike `deposit`'s `minMinted`). For a
  constant-product full-range position the withdrawn bundle's value *at the honest price* is minimised at the
  honest price, so a price-manipulating sandwich hands the withdrawer **more** value, not less, while the
  attacker pays fees both ways. Not exploitable.
- **Curve seeding front-run.** `seed()` seeds the curve's whole token balance, but the token does not exist
  until the same transaction and its entire supply mints to the factory, so no third party can hold tokens to
  inflate the seed — including via a `DeterministicDeployer` pre-deploy, which mints to the factory anyway.
- **`DeterministicDeployer` adopt-on-collision.** Safe: the CREATE2 address binds `keccak256(initCode)`, and
  all three init-codes in use (`PadToken`, `RobinFeeHook`, `RobinCurveV4`) have constructors whose emitted
  runtime code is a pure function of their arguments.
- **`_alignUp` on negative ticks** (`RobinFloorVault.sol:190`, `RobinAmbushVault.sol:251`) — correct ceiling in both
  signs under Solidity's truncate-toward-zero division. Absurd `bandWidthSpacings` / `gapSpacings` fail closed
  on checked `int24` multiplication rather than wrapping.
- **The anti-grief nudge in `_graduatePull`.** Budgeted to ≤1% of the reserve, floors to 1 wei rather than 0,
  compares sqrt price (not tick) so a buy capped exactly at the ceiling is not re-nudged into
  `PriceLimitAlreadyExceeded`, and fails closed with `CeilingNotRestored` rather than bleeding the reserve.
  The nudge itself is right; **L-16** is that the two gates *upstream* of it compare the tick instead, so it
  can be skipped in a state it should have handled.
- **Balance-derived quantities, and whether each one subtracts every liability it owes.**
  > **Independently upheld.** Unlike the rounding and permissionless-surface bullets above, this one was later
  > handed verbatim to an agent instructed to refute it, which re-derived it from source rather than re-reading
  > it and returned **UPHELD with no findings**. It also went further than the original sweep in three ways,
  > folded in below: it audited `RobinLockStaking.fundTokenPushed` (a site this bullet never named), it re-ran
  > the mint-slack check in the *band* geometry rather than the full-range one, and it swept forced-ETH
  > donation paths across every contract.

  This is where L-18 and I-1(11) live, so all 28 sites that read `address(this).balance`, `balanceOfSelf()` or
  `balanceOf(address(this))` were listed and checked for an omitted book. They hold:
  - `RobinCurveV4:381` — the step-9 platform recompute omits `totalGasBountyOwed`, correctly: bounties can only
    book during `graduate()`, which is one-shot, so it is zero at that instant. `sweepToPlatform:286` runs
    *after* graduation and does subtract it, along with the other four books. `restoreCeiling` refunds inline
    and leaves no standing liability for either to miss.
  - `flushStaking:395` sweeps the **entire** token balance to staking, which would ship the curve reserve if it
    were reachable early — it is gated `if (!graduated) revert NotReady()`. (M-13 is the post-graduation dust
    poke, which stands.)
  - **`DualStaking`'s `accountedReserve` invariant holds at every write.** `stake += received` (`:295`),
    `unstake -= amount` (`:328`), reward payout `-= amount` (`:374`), `fundToken += received` (`:420`),
    `fundTokenPushed = bal` (`:436`). That is what makes `received = balanceOf − accountedReserve` unable to
    mistake staked principal for an arrived reward — the `[audit C1]` case, which matters precisely because
    "earn the other" lets one asset be principal on one side and reward on the other.
  - `PresaleVault:209-214` measures `totalTokensBought` as a before/after delta, and the token does not exist
    outside that transaction, so nothing can be donated in between. Sharper on re-derivation: `balBefore` is
    read *after* `launch` (`:178`), so a pre-existing balance would be **excluded** rather than counted, and
    `CurvePadFactoryV4:114` enforces `curveSupply + reserveSupply == supply` so no path puts the pad token in
    the vault beforehand.
  - `RobinLockStaking.fundTokenPushed:190-198` derives `pushed = bal − (totalStaked + rewardsBalance)`. Its
    five book writes — `stake:108`, `withdraw:128`/`:149`, `getReward:163`, `fund:182` — each pair an
    accounted delta with an exactly equal physical one (`withdraw` moves `−amount+penalty` on the books
    against `−(amount−penalty)` on the balance). The `stake` credit is the caller's argument rather than a
    measured delta, which would drift against a fee-on-transfer token — but this pool is hand-deployed per pad
    against `PadToken`, a plain OZ ERC20 with no hooks, so there is no drift path. H-1 attacks *when* a tranche
    is credited here, not the arithmetic.
  - **The narrow-band mint has the same slack property as the full-range one — checked separately, because it
    is a different regime.** `RobinAmbushVault.seedAmbush:128` computes `balanceOfSelf() − pendingFloorEth`; if
    `_add`'s settle ever needed more than `amt` it would eat into `pendingFloorEth` and that subtraction would
    underflow **permanently**, on an add-only vault with no rescue. The 20,009-sample check elsewhere in this
    section covers the curve's *full-range* mint, which does not transfer. Re-run for band geometry —
    **252,000 samples** over anchors {−60000, 0, 60000, 200000, 220000, 230000, 240000} × spacings {10, 60,
    200} × widths {1, 2, 5, 20} spacings × random `amt` ∈ [1, 3e18], comparing
    `getAmount0Delta(sA, sB, getLiquidityForAmount0(sA, sB, amt), roundUp: true)` against `amt`: **zero samples
    over budget, worst-case delta 0.** Closed form: exceeding `amt` needs the flooring slack below `1/√sA`
    (~1e-34), i.e. `frac(sA·sB / Q96) < ~1e-12`, which is fixed by the band ticks and not attacker-choosable.
  - **Forced ETH** (`selfdestruct`, coinbase payment) was swept against every derived quantity. Everything it
    can move is already registered: the curve excludes it from the raise (`:327`) and sweeps it to the platform
    after graduation, `RobinLpVault:151/153` is I-1(11), `LockVault:155-156` is I-1(4), and either band turns
    it into permanent band principal, which is L-18. `RobinFeeHook`, `DualStaking`, `RobinLockStaking` and
    `PresaleVault` derive nothing from an ETH balance at all — `PresaleVault` has no `receive`/`fallback` and
    its pro-rata uses the `totalRaised`/`pooledEthSpent` books only.
  - **Dismissed with the number, so a later pass does not re-derive it:** `_mintPermanentLp:642` passes
    `uint128(tokAvail)` as `amount1Max`, and `CurvePadFactoryV4` bounds `cfg.supply` only by
    `curveSupply + reserveSupply == supply` (`:114`) — never absolutely. The cast truncates at 2^128 ≈
    3.4×10^38 base units, **11 orders of magnitude above** the 1e27 of production geometry, and the only party
    who can reach it is the launcher, against their own pad. Not a finding.
- **Permissionless entry points, enumerated and asked the worst-timing question.** All 128 non-view
  `external`/`public` functions in `contracts/` were listed and the internally-gated ones separated out. The
  genuinely permissionless, state-changing ones are already this report's findings (`graduate`,
  `restoreCeiling`, `flushStaking`, `addFloor`, `collectFloorFees`, `seedAmbush`, `collectFees`, `flushFees`,
  `LockVault.claimStaking`, `finalize`, `fail`, the three `launch`es). The remainder were checked and hold:
  - `claimGasBounty(to)` is callable by anyone but pays only `gasBountyOwed[to]`, booked to `msg.sender` at
    graduation, and re-parks on a failed send. `totalGasBountyOwed` is tracked precisely so `sweepToPlatform`
    cannot mis-book a pending bounty — and `sweepToPlatform`'s `booked` subtotal covers every standing
    liability (`platform`, `creator`, `floor`, `ambush`, `gasBounty`); `restoreCeiling` refunds inline and
    leaves none.
  - `flushFloor` / `flushAmbush` are graduated-only, require the vault wired, and re-park on failure.
  - **`StakingFactory.createPool` is permissionless and cannot be used to squat.** `poolsOf[token]` is an
    append list, not a single slot, so no existing pool can be displaced; a squatted pool gets the factory's
    own `platformTreasury` and hands ownership to `platformOwner`, so its fees are not the squatter's; and the
    obvious follow-up — create a pool for someone else's token with a punitive hold — is closed by
    `MAX_ANTI_JIT = 7 days`, enforced in **both** the constructor (`:142`) and `setAntiJitDelay` (`:472`).
    `stock == token` is rejected outright (`[audit C1]`).
  - `PresaleVault.claimTo(to)` routes `msg.sender`'s own claim; it takes no victim argument.
- **The test suite is not vacuous — checked, because M-19 raised the question and nobody had answered it.**
  M-19 audits *coverage against stated invariants*; it never asks whether the tests that exist actually assert
  anything. Enumerated all **136 `it()` blocks across 33 files** and counted assertions per block. Exactly
  **one** has zero `expect()` calls — `calibrate-testnet.sim.test.js`'s *"prints the raise for several
  curveSupply sizes"*, which is honestly named as a print/calibration run rather than a test. The two other
  zero-assertion blocks are false positives: `curve.e2e.sim.test.js`'s scenarios A and B are five-line
  delegations to a shared `scenario()` helper carrying 38 assertions. No block was long-but-unchecked (none
  with <2 assertions over 25 lines). The eight assertions made against **mock** state are all
  `posm.ownerOf(...) == lockVault` — the one property `MockPositionManagerV4` models faithfully, and one that
  does not depend on the `amount0Max`/`amount1Max` handling M-8 flags as divergent. So the coverage gaps M-8,
  M-19 and L-28 describe are gaps in *what is tested*, not in *whether the tests test it*.
- **Rounding direction — swept, but the sweep was not exhaustive, and this bullet was wrong once.**
  > **Correction.** This bullet originally claimed "every division and bps computation in `contracts/`" had
  > been checked, and that `RobinLpVault`'s accumulator was "the only place where floor-and-forget would
  > actually strand value". A later refutation pass established both are false. The cited set covers **20 of
  > the 32** division sites in `contracts/`; the twelve omitted are the Synthetix accumulators in *both*
  > staking contracts (including that `DualStaking` scales by `ACC = 1e30` while `RobinLockStaking` uses
  > `1e18` — a 1e12 difference in per-update precision this bullet never mentioned), the rate-scheduling
  > divisions in `_applyReward`, and the per-user `pending`/`debt` divisions. Each of the twelve was then
  > checked individually and **none lets a caller extract more than they are owed or leaves a contract owing
  > more than it holds** — so the conclusion survives, but it was asserted before it was earned, and
  > `_applyReward` is a second floor-and-forget site (see I-1(13)). The claim below is now scoped to what was
  > actually verified.

  Of the divisions and bps computations verified, all floor, and all floor safely: All of them floor, and all of them floor *safely*: the hook's buy and sell
  fees (`:208`, `:236`, `:243`, `:293`, `:303`) round in the trader's favour; the graduation waterfall
  (`:346-351`) and the buy-LP floor carve (`:609`) leave their remainder in the balance that step 9 sweeps to
  the platform book; `DualStaking`'s claim fee (`:343`) and boosted weight (`:262`) both round toward the
  staker and the pool respectively; `RobinLockStaking`'s early-exit penalty (`:143`) rounds toward the
  withdrawer; `PresaleVault`'s pro-rata `mulDiv`s (`:257-258`, `:315-316`) floor, so the vault can never owe
  more than it holds. `RobinLpVault`'s accumulator is the one place with an explicit remainder carry
  (`:250-253`, `[audit L6]`) — checked algebraically: `inc·tl/ACC ≤ amt` so the carry never underflows, and
  `Σ⌊liq_u·acc⌋ ≤ ⌊Σliq_u·acc⌋` — **but that is where the original check stopped, and it was not enough**:
  it bounds claims by `⌊tl·acc/ACC⌋` without ever checking *that* against `feeReserve`, which is precisely
  where the carry double-credit in **L-23** lives. `DualStaking._applyReward` is a second site that floors
  without a carry; it strands dust rather than breaking solvency, and is recorded as I-1(12).
- **`nextTokenId()`-before-mint is safe against the real `PositionManager`** — checked against the pinned
  periphery rather than the mock. `PositionManager.sol:359-364` assigns `tokenId = nextTokenId++` inside
  `_mint`, which is the **first** action in the curve's `MINT_POSITION, SETTLE_PAIR, SWEEP` batch. There is one
  mint per batch; nothing external runs between the `nextTokenId()` read and `modifyLiquidities` (both approvals
  precede the read); the hook's `0x00CC` flags fire no `modifyLiquidity` callback that could re-enter and mint;
  and `SETTLE_PAIR` runs after the id is assigned, settling native ETH and `PadToken`, neither of which has a
  transfer hook. Two curves graduating in one transaction each re-read immediately before their own mint and get
  N and N+1 correctly. The id is right — **I-1(19)** is that nothing asserts it.
- **The permanent lock has no bypass — searched exhaustively, not assumed.** `LockVault` exposes no `approve`,
  `transfer`, `decreaseLiquidity` or `burn` selector. v4-periphery's ERC-721 `permit` cannot help either:
  Permit2's `SignatureVerification` falls through to ERC-1271 for a contract owner, and `LockVault` has no
  `fallback()` — only `receive()` — so `isValidSignature` reverts. `PositionManager.subscribe` is
  `onlyIfApproved` and the vault cannot call it. This is the strongest evidence in the document for
  `AUDIT-SCOPE.md` §4.4's headline "permanent lock" invariant, which was previously supported only by the
  selector-absence unit test.
- **`LockVault`'s books cannot be cross-contaminated between pads or currencies.** `collectFees` writes only
  `platformOwed[id][0]` and `stakingOwed[id][1]`, and nothing else in the contract writes either mapping. Since
  `platformOwed[id][1]` is never credited, a caller-supplied `currencyIndex` of 1 always reverts
  `NothingToClaim`; the mirror holds for `claimStaking`. So no index can pay currency1 out of the currency0 book
  or vice versa, and no pad's book is reachable from another's — checked including the strongest cross-pad
  construction available, a `StockPadFactory` pad whose caller-supplied adapter names a victim pad's token as
  its `stock` (reachable given H-2).
- **C-2 has no siblings inside this codebase.** Every loop in `contracts/` was enumerated: four, all hard
  bounded — three in `DualStaking` (`:203`, `:227`, `:316`) iterate `_rewardTokens[side]`, capped at
  `MAX_REWARD_TOKENS = 8` and enforced in `_listReward:447`, and one in `StockQuoteAdapter:131` walks a
  caller-supplied `parties` array in a view with no on-chain callers. C-2's gas blow-up is not a loop in this
  repository at all — it is v4's own tick-bitmap traversal inside the `PoolManager`, driven by how many ticks
  an attacker has initialised. No amount of reading this codebase's loops would have found it, which is why it
  is worth writing down that they were read.
- **`BaseHook`'s flag word and both of its guards.** `REQUIRED_FLAGS = 0x00CC` decodes correctly against
  v4-core's `Hooks` constants (`BEFORE_SWAP 0x80 | AFTER_SWAP 0x40 | BEFORE_SWAP_RETURNS_DELTA 0x08 |
  AFTER_SWAP_RETURNS_DELTA 0x04`), the constructor self-assert and the factory's check read that same constant,
  and every unflagged `IHooks` entry point reverts rather than returning a selector. The transient-storage
  `nonReentrant` is sound: EIP-1153 rolls `tstore` back on revert, so a *caught* revert cannot leave the flag
  latched, and the slot is per-address so instances cannot collide. One design consequence is worth knowing
  rather than fixing — the same flag guards `beforeSwap`/`afterSwap` *and* the five user-facing `claim*`
  functions, so no claim can execute inside a swap. That is deliberate, and it is designed around at the one
  place it matters: `RobinCurveV4.graduate()` calls `claimBuffer` before its own `unlock`, not inside it.
- **The hook's per-swap book conservation — independently attacked and held.** §4 originally *asserted* that
  buy books sum exactly to each minted ERC-6909 claim and sell books to each `take`. A later pass handed that
  assertion to an agent told to break it, which worked the algebra per swap — `bufferCut = ⌊fee·bufBps/BPS⌋`,
  `referralCut = ⌊platformCut·refBps/BPS⌋`, `platformOwed += platformCut − referralCut` — and confirmed the
  three sum to `fee` **identically by construction**, because every split is a subtraction rather than a second
  multiplication, with `registerPool`'s `<= BPS` checks bounding the inputs. It could not produce a
  counterexample. Unlike the rounding and permissionless-surface bullets, this one survived challenge.
- **The hook's claim-redemption path.** `unlockCallback` is gated on `msg.sender == poolManager`, and v4 only
  ever calls back the address that called `unlock`, so no third party can supply its `data`. Burn-then-take is
  ordered correctly, and `_payout` runs after the unlock closes, so a hostile recipient re-entering finds the
  owed slot already zeroed and the lock already released.
- **`FeeWalletRegistry`.** Propose / commit / cancel are internally consistent, `pendingEta == 0` is an
  unambiguous "no proposal" sentinel, and `renounceOwnership` is disabled so the system's only mutable knob
  cannot be frozen at zero. The one nit is not a finding: a proposal never expires, so one made and forgotten
  stays committable indefinitely by whoever holds ownership later. An expiry would be cheap.
- **`RobinLpVault`'s fee accounting.** The MasterChef accumulator, the `feeCarry` remainder, and the
  debt/pending resets are correct across every liquidity change, and `feeReserve0/1` is incremented exactly
  when the contract physically receives a fee and decremented exactly when it pays a claim. Most relevant to
  **L-18**: this vault gets the netting question right. It harvests fees in a *separate* `unlock` before it
  ever adds or removes principal, so `modifyLiquidity`'s `principalDelta + feesAccrued` can never mix the two —
  which is exactly the discipline `RobinFloorVault` and `RobinAmbushVault` lack. `_settleOwed`'s positive branch
  is unreachable for a full-range add once fees are already harvested.

---

## 5. What this pass did **not** cover

- **No fork run.** `test/fork/*.js` needs `FORK_RPC`, which this environment does not have. Everything
  involving the *real* v4 `PositionManager` — `amount0Max`/`amount1Max` enforcement, real Permit2, real
  `nextTokenId` — is argued from source and arithmetic, not executed. M-2's proof used the mock position
  manager; the LP mint (`graduate()` step 4) *succeeds* under it and the revert comes at step 5,
  `onGraduated` → `LockVault.registerLaunch`, which touches no PositionManager state. A real
  `PositionManager` therefore reaches the same revert — just after a real mint that is rolled back with the
  rest of the transaction.
- **No economic simulation of the ambush/floor bands** under adversarial order flow beyond the round-trip
  argument in `AUDIT-SCOPE.md` §4.4, which holds: round-tripping a passive add-only LP costs the attacker the
  spread plus two lots of LP fee.
- **Securities/legal review of the stock pad** remains out of scope per `AUDIT-SCOPE.md` §2. The disclosed
  `[D1]` (a paused or blocklisted stock hard-freezes that pad) and `[D3]` (`adminBurn` can burn the pool's
  reserve) remain accurate and unfixable on-chain. H-2 is a separate, on-chain-fixable defect.
- **Off-chain infra** (indexer, launch bot, front end) was not reviewed. The `scripts/` directory *was* read,
  but only as evidence about the on-chain system — what the runbook wires and in what order (L-6, L-7, I-4),
  and what the keeper pokes (M-11, M-13, L-18). The scripts were not audited as software: no key handling, no
  RPC failure behaviour, no idempotency-under-retry, no review of `deploy.local.json` as a trust anchor.
- **No formal verification and no fuzzing.** The measured findings come from hand-built adversarial cases, so
  the coverage argument is "these specific attacks work", never "no other attack exists". The two places that
  would most repay a fuzzer are the graduation waterfall's balance arithmetic and `DualStaking`'s
  weight/`accountedReserve` bookkeeping under interleaved stake/unstake/fund sequences — both are integer
  state machines with many reachable orderings, and both are where §4's negative results rest on
  case-enumeration rather than proof.
- **Cross-pad and cross-version interaction.** Every pad launches its own hook, curve and vaults, but they
  share `FeeWalletRegistry`, `LockVault`, `StakingFactory` and `RobinV4FeeConfig`. Findings were reasoned
  per-pad; the question of what a hostile *pad* (rather than a hostile trader) can do to the shared
  singletons — `LockVault`'s single registrar slot is one instance, M-2 — was not swept exhaustively.
- **The `PadFactory` and `StockPadFactory` stacks** were audited only where they touch the curve suite or
  share code with it. `AUDIT-SCOPE.md` §1 puts `PadFactory` in scope and §2 marks the stock pad
  informational; M-3, H-2, H-3, M-8 and I-1(2) are what surfaced from that partial attention, not the result
  of a dedicated pass.

---

## 6. Reproducing the measured findings

Reproductions were run as throwaway Hardhat tests against a real local Uniswap v4 `PoolManager`. **They were
deleted before commit — this repository is unmodified apart from this document.**

```bash
cd pad-v4 && npm ci && npx hardhat compile
```

Every finding tagged `PROVEN` has a recipe below, in ID order. Two harnesses are reused throughout and are
worth building once: the curve `deployStack` from `test/sim/curve.e2e.sim.test.js` (real `PoolManager`, mock
`PositionManager`/`Permit2`) and the presale `deployStack` from `test/sim/presale.sim.test.js`.

**C-1** — the standalone version needs no curve at all. Deploy `TestERC20` + `RobinLockStaking(token,
rewardsDuration = 30 days, lockDuration = 30 days)`. Then, as the attacker:
`fund(2)` (pool empty ⇒ parks in `pendingRewards`) → `stake(1)` (flushes it through `_startDrip(2)`:
`rewardRate = 2 / 2_592_000 = 0`, `periodFinish = now + 30 days`) → `withdraw(1)`. **Assert the arm took:**
`rewardRate() == 0`, `totalStaked() == 0`, and `periodFinish() - block.timestamp == 2_591_999` — the pause
guard was skipped. Now fund the reservoir (`fund(96_978_138e18)` stands in for the graduation leftover); with
the pool empty it parks. `time.increaseTo(periodFinish - 2)`, attacker `stake(1)`, advance 1 s, `getReward()`
→ the attacker takes **100.00%**. Add an honest staker 10 days into the window and assert `earned()` is
**0**. Check `token.balanceOf(pool) == totalStaked() + rewardsBalance()` at every step — it holds, which is
why no invariant catches this. For the full-stack figure (9.70% of a 1B supply), drive the same sequence
through `CurvePadFactoryV4` at production geometry (`startTickMag` 201600, `curveWidth` 23000, `ts` 100,
730M curve + 270M reserve, taxes 100/100 bps, waterfall 10/10/5) and arm with a 0.001 ETH dust buy.

**C-2** — **raise Hardhat's `blockGasLimit` well above 30M for this test** (e.g. 100_000_000): the finding is
the *measured* gas against the real 30M cap, and at the default limit the transaction merely fails without
giving you a number. Build the curve `deployStack`, launch two identical pads, and sell both curves out using
the router default `sqrtPriceLimitX96 = MIN_SQRT_PRICE + 1`. Assert `getSlot0().tick == -887272` and
`ready() == true` on each. Pad A: `graduate()` → **1,217,937** gas (baseline). Pad B: before graduating, have
an attacker call `PoolModifyLiquidityTest.modifyLiquidity` **100 times**, once per distinct 60-tick band below
`gradTick`, each with `liquidityDelta: 1` — each costs **1 wei** of currency0 because spot is far below the
band. Then `graduate()` → **33,767,571** and `restoreCeiling(bag)` → **31,776,972**. Both exceed 30,000,000,
so on-chain both revert permanently.

**H-1** — deploy `TestERC20` + `RobinLockStaking(token, 30d, 30d)`. Alice stakes 1,000; `fund(1,000)`; record
`periodFinish`. `time.increaseTo(periodFinish - 3)`; whale stakes 1,000,000; credit a 500,000 tranche (either
`fund(500_000)`, or — the realistic path — transfer tokens in and call the permissionless
`fundTokenPushed(0, token)`). `time.increaseTo(periodFinish)`; read `earned(whale)` → **499,500.5**. Then
`getReward()` + `withdraw(1e6)` → net **+399,500**.

**H-2** — deploy `MockStockRegistry`, then `MockStock(thatRegistry)`, then
`StockQuoteAdapter(thatStock, thatRegistry)` from a non-platform account: it deploys, and `adapter.registry()`
is the attacker's. Pass it as `cfg.adapter` with any `guardWindow > 0`. The freeze half is already covered by
`test/unit/RobinFeeHook.adversarial.test.js:163-186`. Note that an end-to-end local `StockPadFactory.launch`
is currently impossible — see M-8.

**H-3** — deploy a two-line short-returner and hand it to a pad as the guard adapter:

```solidity
contract ShortReturnAdapter { fallback() external { assembly { return(0, 0) } } }
```

It answers every selector with **empty** returndata, so the call *succeeds* and the decode fails. Register a
pool with `cfg.guardAdapter = address(thatAdapter)`, `cfg.guardWindow > 0` **and `cfg.quoteIsStock = true`** —
all three are required to reach the curb (`RobinFeeHook.sol:190`). Then attempt any swap: `beforeSwap:191`
calls `_scheduledEffectiveAt`, whose `try … returns (uint256 ea)` decodes empty returndata and reverts
**outside** its own `catch`. Every swap on that pad reverts, in both directions, permanently — `guardAdapter`
has no setter. Contrast the case the suite *does* cover: point `guardAdapter` at `MockGuardAdapter` with
`setRevert(true)` and the swap succeeds, because a revert *is* caught.

**M-8** — no test needed; it reproduces on the existing suite. Write any local test that calls
`StockPadFactory.launch(...)` and it dies at `MockPositionManagerV4.sol:54` with `panic 0x32`, because the mock
decodes `params[2]` unconditionally while `StockPadFactory._mintSeedLp` emits a **two**-action batch. Confirm
the coverage claim with `npx hardhat test` and note that no stock-pad launch appears in the run, and that
`test/fork/StockPadFactory.launch.fork.test.js` calls `this.skip()` without `FORK_RPC`.

**M-11** — build the curve `deployStack`, launch and graduate a pad **without** calling
`LockVault.setStakingRecipient` — which is the shipped order, since `scripts/deploy-curve.js` performs it after
graduation. Then, from any unrelated account, `lockVault.collectFees(tokenId)` followed by
`lockVault.claimStaking(tokenId, 1)`. Assert the token-side fees arrive at `feeRegistry.platformFeeWallet()`
rather than at any holder sink, and that the claim cannot be undone.

**M-1** — build the `deployStack` from `test/sim/presale.sim.test.js` verbatim, but with
`curveSupply = reserveSupply = 2e17` instead of the deep-curve default. Open a presale with `target = 3 ETH`,
fill it, `finalize(...)`, then compare `vault.pooledEthSpent()` against
`hook.platformOwed(poolId, 0) + hook.bufferOwed(poolId)`.

**M-2** — build the curve `deployStack` from `test/sim/curve.e2e.sim.test.js`, but call
`lockVault.setFactory(<any other address>)` instead of the curve factory (a `PadFactory` makes the point).
Use a shallow curve — `curveSupply = reserveSupply = 1000e18` at START 6000 / GRAD 3000 — so the buy-out fits
inside a default Hardhat account's 10,000 ETH. Launch (succeeds, silently), buy the curve out with
`PoolSwapTest`, assert `curve.ready() == true`, then assert `curve.graduate()` reverts `NotFactory` — for
every caller, permanently.

**M-21** — reuse `test/unit/RobinCurveV4.graduation.test.js`'s harness verbatim but **wire nothing** — no
`setStaking`, `setFloor` or `setAmbush`. Buy the curve out, `graduate()`, and read the books: `floorEthOwed`
and `ambushEthOwed` are both non-zero, `sweepToPlatform()` moves neither, and `flushFloor()`/`flushAmbush()`
revert `ZeroAddress`. Now show the recovery works — `setFloor(realVault)` then `flushFloor()` drives
`floorEthOwed` to 0. Then show the terminal case: `setAmbush(<any contract with code and no payable receive —
a `TestERC20` will do>)`, call `flushAmbush()` (it **succeeds** and moves nothing), assert `ambushEthOwed` is
unchanged, and assert `setAmbush(anythingElse)` reverts `AlreadySet`.

**M-12** — build the presale `deployStack` at production geometry (`startTickMag` 201600, `curveWidth` 23000,
`ts` 100, 1B supply at 730M + 270M). Open a presale, deposit 2 ETH, and then — **between `createPresale` and
`finalize`** — call `feeConfig.setDefaults(...)` as the owner with a different `startTickMag`. Finalize and
read the tokens the vault received. The four measured points: **201600 → 545,546,800** (74.73% of the curve),
**195000 → 374,333,692** (51.27%), **400000 →** ~99.99% of the curve for 0.020 ETH, and **100 → 1.979899
tokens**, at which the graduation raise is scaled so far out of reach that the coin can never sell out.
Assert in every case that `finalize` does **not** revert, `KeyMismatch` never fires, `state() == 1`, and
`claim()` pays at the new price.

**M-15** — build the curve `deployStack`, graduate, and let the floor carve accumulate. Push spot **down**
into/below the band and call `addFloor()` → it parks (`FloorSkipped`) and the carve idles, which is the
finding. Then prove the lock is conditional rather than permanent: buy the price back up to tick **−33555**
and call `addFloor()` once — it mints **172,240,917,046,477,496,316** liquidity and leaves the vault at
**0.0 ETH**, recovering all 10 parked ETH. Both halves matter: the first is the defect, the second is why it
is MEDIUM and not HIGH.

**M-16** — deploy `DualStaking` with a non-zero `platformClaimFeeBps`. Have a staker stake, then call
`donateETH{value: X}()` from the creator — the function whose NatSpec promises the donation reaches holders
*"WITHOUT touching the platform cut"* (`:396-401`). Advance past the window, `claim()`, and assert the payout
is short by `platformClaimFeeBps` of the whole balance: `claim` (`:337-352`) applies the fee to everything,
donated and funded alike, so the promise does not hold.

**M-17** — deploy `DualStaking`, then `setBoostOracle(address(new ShortReturnAdapter()))` using the same
two-line contract as H-3. `boostOf` (`:186-196`) now decodes empty returndata outside its `catch`, so
`stake`, `unstake` and `claim` all revert and every staker's principal is frozen. Unlike H-3 this one is
recoverable: `setBoostOracle` is not one-shot, so the owner can point it at a working oracle — which is the
whole severity difference.

**M-5** — deploy `DualStaking(tok, stk, owner, antiJitDelay = 0, …)`. Alice stakes, unstakes freely, then
`setAntiJitDelay(7 days)` → her existing position reverts `Locked`. Separately: stake, `fundETH(10)` at 0% fee,
advance 7 days, read `earned`, then `setPlatformClaimFee(1000)` and claim — the payout is 10% short.

**L-12** — build the presale `deployStack`, fill a presale to target, then call `finalize(...)` **with an
explicit gas limit** chosen so the inner `curvePadFactory.launch` runs out of gas while the outer frame
survives — EIP-150 forwards only 63/64 of the remaining gas, so a limit a little above `finalize`'s own
overhead does it. Binary-search the limit if needed. Assert the transaction **succeeds** (`status == 1`),
that `state()` is `Failed` with reason **3**, and that the receipt gives a caller no way to distinguish this
from a genuine snipe. The presale is then dead and the outcome is irreversible.

**L-13** — create a presale with a long `deadline`, fill it to `target` on day 1, and never finalize. Assert
`fail()` reverts `TargetMet` (`:282`) and that no contributor has any withdraw path, then advance time and
show refunds only open at `deadline + grace` — up to 37 days at the bounds `initialize` accepts, measured from
a raise that closed on day 1.

**L-14** — deploy `DualStaking` with `antiJitDelay = 7 days`. Two stakers with equal stakes, both funded from
the same tranche. Staker A calls `claim()` first and *then* `unstake(...)`; staker B calls `unstake(...)`
directly. Assert A keeps their accrued rewards while B forfeits theirs to the remaining stakers — `unstake`
(`:302-307`) is gated by the hold, `claim` (`:336`) is not, so the forfeit only ever lands on whoever did not
know to claim first.

**I-2** — build the curve `deployStack`, launch, sell the curve out and graduate, with an ambush vault wired
so `_fundAmbush` delivers the 5% carve. In the **same block** as `graduate()`, back-run a sell of about
**0.015 ETH** — enough to push the tick up into the band, which sits one tick spacing above `gradTick` at the
default `gapSpacings = 0`. Now `seedAmbush()` parks instead of seeding (`AmbushParked`) and keeps parking on
every later call while spot stays in the band. Then measure the recovery: buying the price back below the
band costs about **0.0000938 ETH**, after which one `seedAmbush()` succeeds — which is why this is INFO
rather than the "stranded forever" it first looks like.

**L-16** — build the curve `deployStack` from `test/sim/curve.e2e.sim.test.js` with
`curveSupply = reserveSupply = 1000e18` at START 6000 / GRAD 3000 / ts 60. Buy once through `PoolSwapTest`
with `sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(gradTick + 1) - 1` (any oversized `amountSpecified`; the
limit binds). Read `getSlot0`: `tick == gradTick` while `sqrtPriceX96 > getSqrtPriceAtTick(gradTick)`. Assert
`curve.ready() == true`, then `curve.graduate()` — it succeeds with the nudge and `CeilingNotRestored` both
skipped. The leak column is exact v4 integer arithmetic:
`L = getLiquidityForAmount0(√grad, √maxUsable, lpEth)`, then compare
`getAmount0Delta(√grad, √maxUsable, L, true)` against `getAmount0Delta(√(grad+1) − 1, √maxUsable, L, true)`.

**L-18** — same curve `deployStack`, `curveSupply = reserveSupply = 1000e18` at START 6000 / GRAD 3000 / ts 60.
Buy 200 ETH (tick falls to `t0`), deploy `RobinFloorVault(..., anchorTick = t0 + 300, bandWidthSpacings = 20)` so
the band sits above spot, send it 5 ETH and `addFloor()`. Then run a dip-and-recovery so the band is crossed in
both directions — sell the whole bag (tick up through the band), then buy 200 ETH again (tick back down through
it, which is what accrues **currency0** fees). Now run the same tape twice and change only the last step:
`collectFloorFees()` versus `{ send 1 wei; addFloor(); addFloor(); }`. Compare the platform's balance delta
against `floorLiquidity()`.

**L-1** — evaluate `getLiquidityForAmount1(√grad, √start, curveSupply)` then
`getAmount0Delta(√grad, √start, L, false)` in exact integer arithmetic across `startTickMag`, holding
`curveWidth = 23000`, `ts = 100`, `curveSupply = 730M`. The raise hits 0 wei at ~700000, inside what
`CurvePadFactoryV4` accepts.

---

## 7. Compositions — where fixing one finding touches another

Read this before §8. Findings that interact change the *order*, and two of them change what the
correct fix actually is.

**1. The staking-wiring dilemma has no clean branch, and the register previously implied the wrong one.**
`M-11`, `L-32` and `C-1`'s second path compose into a forced choice at graduation:

- **Wire `curve.setStaking` before `graduate()`** — what `deploy-curve.js:119-122` prescribes, and what step 7's
  reserve stream requires. Then `graduate()` copies that address into `LockVault.registerLaunch`, and
  `setStakingRecipient` is permanently spent (**L-32**). `claimStaking` (`LockVault.sol:143-152`) then pays the
  locked LP's token leg to the staking pool with a plain `_payout` and **no `fundTokenPushed` poke** — an
  uncredited pile. Recoverable, but only by a party who can credit it: permissionless on `RobinLockStaking`,
  `isRewarder`-gated on `DualStaking` (`:430`).
- **Don't wire it first.** Then `LockVault.stakingRecipient` is zero and `claimStaking` falls back to
  `platformFeeWallet` — **permanently, on the first claim**, because the book is zeroed in the same call
  (**M-11**).

So the late branch is *strictly worse*: permanent misrouting versus a recoverable uncredited pile. **M-11's fix
direction leans on `setStakingRecipient` still being available, which L-32 shows it is not.** Until the two
one-shots are unified, the operational guidance is **wire early and then credit the pile**, which is the
opposite of what M-11 alone suggests.

**2. The tax set makes the taxed venue the irrational one.** **H-1** waives the sell tax on the registered pool
for anyone who asks; **L-25** gives a sibling pool, carrying the pad's own hook address, that charges **neither**
tax and re-opens exact-output; **L-26** charges the full buy tax on a fill of **zero**. Taken together the
economics point one way: an informed trader uses the untaxed sibling, and the honest pool's worst case is paying
for nothing. Fixing H-1 alone leaves the sibling; fixing L-25 requires re-mining hook addresses, so it is a
launch-time change rather than a patch — which is why the three should be costed together rather than
sequentially.

**3. A burned presale commitment plus an unbounded finalize is a perpetual option.** **M-22** publishes the
salts on any reverted `finalize`; **L-20** means `finalize` never expires; **M-12** means the geometry — and so
the price — is read live at `finalize`. A preimage-holder therefore holds an option on **both the timing and
the price**, indefinitely, over contributors who have no unilateral exit. Each finding is LOW-to-MEDIUM alone;
together they are the presale's most serious property, and **L-20's one-line fix (gate `finalize` on
`deadline + finalizeGrace`) collapses the composition** even if M-22 and M-12 are deferred.

**4. Four one-shot setters accept a value nothing validates, and they fail differently.** **M-2** (`setFactory`,
wrong registrar), **M-21** (`setFloor`/`setAmbush`, non-receiving target), **M-24** (`setFloorRecipient`, the
hook itself), **M-26** (the ambush pool key), plus **I-1(19)** (`positionManager`). They share a root — L-7's
hand-typed constructor arguments with no on-chain assertion — but their failure modes differ enough that
fixing one teaches nothing about the others: M-2 fails loudly, M-21 re-parks, M-24 **zeroes the book and emits
success**, M-26 mis-places permanent liquidity, and I-1(19) succeeds at graduation and only breaks later. A
single "validate the target" pass across all five is one PR and closes the class.

**5. Already recorded, listed so they are not re-derived:** **C-2** makes **L-26** permanent (a gas-bricked pad
sits forever in the zero-fill state, so every buy burns tax for nothing); **M-7**'s fix widens **M-4** (that is
**L-33**); **L-24**'s dead guard is what would have caught **I-1(19)**; and **M-15**, **H-5** and **L-33** are
the same `addFloor` guard read three ways — a fix aimed at one must be checked against the other two.

---

## 8. Suggested remediation order

> **This ordering is the audit's, written before any remediation.** Items 1–4 and the one-shot-setter class in
> §7(4) have since been done — see §0 for the ledger. It is kept as written because the *reasoning* about
> sequencing (which fixes interact, which must be costed together) is still what a reader needs, and because
> the remaining items are ordered against it.

1. **C-2** — 100 wei traps the entire raise, and the documented recovery is bricked by the same mechanism.
   Fix (1) alone — a caller-supplied price limit on `restoreCeiling` — converts it from unrecoverable to
   recoverable, which is the single highest-value line in this document.
2. **C-1** — the only finding that takes 100% of a user-facing pot, for 3 wei, permissionlessly. Fix the
   drip-rate floor *and* the pause guard; the sub-rate-tranche check closes the arming step and the dust
   stranding in I-1(5) at the same time.
3. **H-1** — no minimum trade size, cheaper than paying the tax, and a router can hand it to every user. It
   defunds the creator's entire income and the floor. The buy side already shows the fix.
4. **H-5** — the floor's `addFloor()` guard. A permissionless, atomic, repeatable **88.43%** loss on the
   parked carve, measured at the shipped tax config, against a baseline where the carve simply parks and loses
   nothing. Fix the **park→commit flip** (TWAP or block-delay the guard, or rate-limit the commit), not the
   timing — the control proves timing is worth exactly 0 wei. Do it with **M-15** and **L-33**, which are the
   same guard read two other ways.
5. **M-21** — add a value-transfer probe to `setFloor`/`setAmbush` before the one-shot is spent, and make
   `flushFloor`/`flushAmbush` revert on a failed send instead of returning success. Both are a few lines, and
   together they convert a silent permanent loss of the ambush share into a revert at the one moment the
   operator can still act. Fold into the same PR as M-2 and M-4 — all three are one-shots that accept a value
   nothing validates.
6. **M-20** — one word (`false` → `true` at `DualStaking.sol:404`) plus a `msg.value >= duration` check. It
   is the cheapest fix on this list relative to what it closes: a measured 99.00% capture of a creator's
   donation by a 121-second staker, on the channel creators are explicitly told to use. Do it in the same PR
   as C-1 — they are the same `extend`/window mechanism in two contracts, and C-1's "reject sub-rate tranches"
   is the same guard M-20 needs.
7. **M-15** — the floor only deepens while the price is above it, so the pad's headline protection does not
   operate in the state it exists for. It falsifies an `AUDIT-SCOPE.md` §4.4 invariant rather than mis-tuning
   one, so it needs a design answer, not a parameter change.
8. **M-2 and M-4** — one-shot wiring defects with permanent, unrecoverable failure modes, both cheap to close
   (an assertion at launch; an on-chain anchor read).
9. **H-2, H-3 and H-4** — before any stock pad exists. It is a rug primitive, and M-8 means it is currently untestable
   locally, so fix the mock in the same pass.
10. **M-11** — holder fees routed to the platform by the ordinary post-graduation flow, with no attacker
   required. One line, and the right shape already exists in the same file (`claimFloor`'s
   `NoFloorRecipient`). Fold in **I-2**'s `seedAmbush()` poke while you are there — same pattern, same file.
11. **M-1**, then **L-1** and **M-10** — real value loss and two permanent bricks, all gated on configuration
   that is easy to get wrong and currently unbounded.
12. **M-6 and M-18** before the package goes to the external auditor. Auditing from a stale architecture
   document is the most expensive mistake on this list, because it wastes the engagement rather than the code
   — and M-18 is worse than stale: the "locked spec" describes the ambush with every sign reversed, so it
   points the review away from the risks the shipped vault actually has. Fix both together with **I-4**; the
   three documents disagree with the code in three different directions, so correcting any one alone still
   ships a self-contradictory package.
13. **M-3, M-5 and M-12** are product decisions as much as code ones: decide what `PadFactory` is, which owner
   powers you are willing to defend, and whether a presale's terms may move under its contributors. Then make
   the code and the docs agree.
14. **M-19** alongside every fix above, not after them — it names the specific regression test each finding
    needs, and each one is a few lines against a harness that already exists.
15. **M-7, M-9, L-2, L-3, L-6, L-7, L-17, L-32, L-33** — the wiring/runbook cluster. Fix them together, as one scripted
    post-launch wiring step that asserts every one-shot is set and consistent, and produce the curve-specific
    runbook **I-4** calls for in the same pass — I-4 is the common root, and without it the next operator
    reaches for the PadFactory runbook again.
16. The rest as cleanup, with **L-4**, **L-5**, **L-8** and **L-15**'s doc corrections folded into whichever PR
    touches those files, **L-16**'s three guards brought onto one comparison while someone is already in
    `RobinCurveV4`, and **L-18**'s netted fee delta split in both vaults at once — it is the same three lines
    in each. Note that L-8 and M-10 each falsify a specific sentence an auditor is told to rely on
    (`AUDIT-SCOPE.md` §4.5 and `RobinV4FeeConfig`'s no-timelock justification), and L-16 falsifies two
    load-bearing comments in the graduation path — those sentences should be corrected even if the underlying
    code is left as is.
17. **L-19** last, but not never, and two of its four parts are worth pulling forward. Part (a) —
    `Graduated.toStaking` asserting a transfer that did not happen — fires on the **default** deployment
    ordering, so fix it in the same PR as M-11 and M-7, which are about that same unwired state. Part (c) —
    `RobinLockStaking.stake`'s silent reservoir flush — is C-1's arming step, so anyone building detection for
    C-1 before the fix ships needs the event first; none of C-1's own fix directions would add it.
