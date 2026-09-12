# No-Pool-Forever — design + status

Status: **core `RobinCurveV4` mechanism implemented and unit-tested, plus a new
`RobinDividendPool` holder-reward sink (114/114 passing across the full unit suite, zero
regressions to the legacy path). One real bug found by this session's own adversarial
security-audit pass and fixed (see below). Not deployed. Not wired into any factory/pad-type/
frontend yet. Not audited by anyone but this session's own research/audit passes — a real
external audit is planned before this ever touches mainnet or real funds.**

## Audit finding, fixed: `stakingEthOwed` double-booking

An adversarial security-review pass on the diff (this session, not an external auditor) found
a real bug: **`sweepToPlatform()`'s `booked` total and `graduate()`'s step-9 `platformEthOwed`
formula both omitted `stakingEthOwed`** from the set of "money already spoken for" they exclude
from what gets swept to the platform. Pre-existing code, unaffected in practice before this
diff since `stakingEthOwed` only ever held the small buy-tax-buffer carve — but `noPoolForever`
folds the entire would-be-permanent-LP ETH leg (`lpEth`, potentially the majority of the raise)
into that same bucket. If `staking` isn't wired yet at checkpoint time (`_fundStakingEth()`
re-parks instead of sending) — an already-documented, expected scenario per `ArrowLauncher`'s
own notes ("graduates with curve.staking unset") — that money would be claimed by
`platformEthOwed` *and* still claimed by `stakingEthOwed`. Paying the platform first would then
leave the contract's real balance short when `flushStakingEth()` later tried to actually send
it, permanently stranding the stakers' share.

**Fixed** by subtracting `stakingEthOwed` in both formulas, exactly like the other pending
books (`floorEthOwed`/`creatorEthOwed`/`ambushEthOwed`) already were. Verified the fix is real,
not cosmetic: temporarily reverted it and confirmed the new regression test
(`test/unit/RobinCurveV4.noPoolForever.test.js`, "audit-fix regression" describe block) fails
without it — the platform's book overshoots the real balance and `flushStakingEth()` comes up
short — then re-applied the fix and confirmed all 105 tests pass.

## Why this exists

The product pivot (see `ROBIN-PAD-NEXT-GEN-IDEAS.md` at the repo root, "Core pivot" section):
the bonding curve becomes the permanent market forever instead of handing off to a real
Uniswap pool at graduation. No more full LP mint, no more "the curve is done, now it's an
ordinary pool anyone can add to."

## What "no-pool-forever" turned out to actually mean

The original framing ("buy = mint from curve, sell = redeem into curve") does not describe
how this codebase trades, even during the pre-graduation curve phase — buys and sells are
already ordinary Uniswap v4 swaps against the curve's own single-sided AMM position, taxed by
`RobinFeeHook`. There is no mint/redeem contract to build. The pivot reduces to: **don't fully
withdraw the curve's liquidity at graduation, and don't let it ever hand off to an open pool.**

Two research passes and one adversarial security-audit pass (all from this session, not an
external auditor) converged on this design:

1. **`graduate()` becomes a one-time reward CHECKPOINT, not a full exit**, for pads
   constructed with `noPoolForever = true`. It withdraws only `visibilityWithdrawBps` (capped
   at `MAX_VISIBILITY_WITHDRAW_BPS = 5000`, i.e. never more than half) of the curve's own
   liquidity — the same platform/creator/ambush/keeper-bounty reward waterfall as a legacy
   pad runs on that withdrawn slice, unchanged. The rest of `curveL` stays exactly where it
   already was, still owned by the curve contract, still the pool's liquidity.

   This works because at the checkpoint, spot sits exactly at `gradTick` (the ceiling) —
   the position is ~100% currency0 (ETH) at that exact boundary — so a bps-slice of the
   *liquidity* yields the same bps-slice of the *ETH value*, linearly, with no separate
   liquidity↔amount conversion math needed. The real pool delta is measured directly, same
   as the legacy full-removal code already did.

2. **No permanent LP is ever minted, and `RobinFeeHook.onGraduated()` is simply never
   called** for these pads. This is the mechanism that keeps third-party liquidity locked
   out forever: the hook's existing LP-1 lock (`beforeAddLiquidity` — gated on
   `PoolConfig.graduated`) never lifts, because the curve never flips the hook's copy of
   that flag. **Zero changes to `RobinFeeHook.sol`.** This was the single biggest finding of
   the security-audit pass: it's not just simpler than adding a new permanent-lock state to
   the hook (the originally-considered "Option B") — it reuses code that's already been
   through a real audit round (see `LP-GATE.md`), rather than adding new logic to the
   highest-stakes contract in the system.

   (`RobinCurveV4`'s OWN `graduated` bool is a *different* piece of state from the hook's
   `PoolConfig.graduated` — they're deliberately allowed to diverge for these pads: the
   curve's flips true at checkpoint so the reward waterfall runs exactly once; the hook's
   never flips, so the liquidity lock never lifts. See the audit finding below for why this
   is safe — a legacy pad still flips both, unchanged.)

3. **`collectFees()` keeps working after the checkpoint** (gated on `graduated && !noPoolForever`
   instead of just `graduated`) — the retained position keeps earning real swap fees forever,
   swept to the platform book exactly as during the pre-checkpoint curve phase.

4. **The would-be permanent-LP's ETH leg (`lpEth`) is folded into `stakingEthOwed`** instead
   of being stranded — it pays out through the same holder-reward/dividend path as the
   existing buy-tax-buffer ETH. Deliberate, not a fallback: value that would have gone into a
   permanent pool stays with the pad and its holders.

## Exact contract changes

All in `contracts/pads/RobinCurveV4.sol` (+ the `CurvePadFactoryV4.sol` call site, updated to
pass `noPoolForever: false, visibilityWithdrawBps: 0` explicitly so the live, production
factory's classic pads are byte-for-byte unchanged):

- Two new immutables: `bool noPoolForever`, `uint16 visibilityWithdrawBps` — constructor
  reverts `BadVisibilityBps` at deploy time if `noPoolForever` is true and the bps is 0 or
  over the cap (fail closed; both are immutable with no re-set, so a bad value would
  otherwise permanently brick the one and only checkpoint attempt).
- `_graduatePull()`: removes `curveL` in full for a legacy pad (unchanged), or
  `curveL * visibilityWithdrawBps / BPS` for a `noPoolForever` pad, updating `curveL` in
  storage to the true remaining amount either way (previously `curveL` was left stale at its
  original seeded value forever after a legacy graduation — harmless, but now accurate).
- `graduate()`: branches on `noPoolForever` — skips the hook lock-lift, the permanent-LP
  mint, and the `LockVault` registration entirely; folds `lpEth` into `stakingEthOwed`;
  emits a new `NoPoolCheckpoint(liquidityWithdrawn, liquidityRetained, toStakingEth)` event
  instead of a real `lpTokenId` in `Graduated` (which stays 0 for these pads).
- `collectFees()`: `if (graduated && !noPoolForever) revert AlreadyGraduated();`

## `RobinDividendPool` — "dividends, not staking" holder-reward sink

New contract, `contracts/pads/RobinDividendPool.sol` — the destination the folded-in
`lpEth` (and any leftover reserve token) actually pays into for a `noPoolForever` pad,
replacing "staking" with a no-lock, no-deposit snapshot-claim reward.

**Design, in one paragraph:** it wires into `RobinCurveV4`'s existing `staking` slot
through the exact same `IStakingFund`/`IStakingFundEth` surfaces `setStaking()` already
probes for (`token()`, `fundETH()`, `fundTokenPushed()`) — so a pad picks this OR
`DualStaking` at `setStaking()` time, and **zero changes to `RobinCurveV4.sol` were
needed**. The trust/claim shape is `ArrowDistributor`'s merkle+bitmap self-claim pattern
(already audited, see `ARROW.md`) generalized to recurring epochs: an off-chain indexer
periodically snapshots real holder balances, computes a merkle root of
`(index, account, amount)` leaves sized to that epoch's slice of the accumulated pool,
and the platform wallet (same address already trusted for `setStaking`/`setFloor`/
`setAmbush` — no new trust assumption) opens the epoch. Anyone then self-claims their
leaf — no lock, no stake, no action required beyond having held the token at snapshot
time. ETH is accrue-and-pull (`claimEth` books to `ethOwed`, `withdraw()` sends it —
matches `RobinCurveV4`'s own `claimPlatform`/`claimCreator` convention so one bad
recipient can never brick anyone else); token payouts use inline `safeTransfer` (matches
`ArrowDistributor`, since a plain `PadToken` can't revert on transfer). There is no
withdraw/rescue/sweep/owner path over pooled or committed funds anywhere in the
contract — money only ever leaves via a valid leaf claim, or sits unclaimed forever.

**Tested** (`test/unit/RobinDividendPool.test.js`, 9/9 passing): zero-address
construction reverts, `fundETH`/`pendingEth` accumulation and platform-gating of
`openEthEpoch`, `claimEth` accrue-and-pull + double-claim/wrong-proof reverts,
`withdraw()` payout and retriability on a failed send, payout clamping to an epoch's
remaining balance (dust shortfall can't brick the tail claim — the `ArrowDistributor`
[audit L3] pattern reused verbatim), `fundTokenPushed`'s balance-diff correctness
(including a same-block double-notify no-op and a mismatched-asset no-op),
`openTokenEpoch`+`claimToken`, and — the integration test that matters most — a REAL
`RobinCurveV4` deployed with `noPoolForever=true`, wired to a fresh `RobinDividendPool`
via the unmodified `setStaking()`, bought to ceiling, graduated, with both `pendingEth`
and `pendingToken` landing nonzero and `stakingEthOwed` correctly zeroed (proving the
money isn't stranded and confirming, again, that this integration needed no
`RobinCurveV4` changes at all).

**Not tested / not built yet:** the off-chain indexer that computes real snapshots and
opens epochs (no code written — this is pure off-chain infra, analogous to what a real
external audit + a keeper script would need before this pays anyone for real), any
UI wiring (the token page's "Dividends, not staking" panel is still static/mocked), and
burn-boosted reward weighting (a planned follow-up: bigger burn ⇒ bigger snapshot
weight — not started).

## What's tested vs. not

**Tested** (`test/unit/RobinCurveV4.noPoolForever.test.js`, local `PoolManager`, no hook
attached — same scope as the existing local graduation test):
- bad `visibilityWithdrawBps` reverts at construction, for both too-low (0) and too-high
- checkpoint withdraws exactly the configured bps-slice, leaves the rest live, `curveL > 0`
  after
- no LP ever minted (`PositionManager`'s token-id counter never advances), nothing ever
  registered with `LockVault`
- the reward waterfall still books correctly on the smaller slice
- the would-be LP ETH successfully reaches the staking pool via `stakingEthOwed`
- **the retained position is a genuinely live market after checkpoint** — a real sell swap
  trades against it and succeeds
- `collectFees()` keeps working (and keeps earning) after checkpoint
- checkpoint cannot run twice

**Not tested / not built yet:**
- **The hook's permanent-lock property itself**, end-to-end, against a real mined
  `RobinFeeHook` (the local unit test is hookless, matching the existing legacy graduation
  unit test's own scope — this needs a fork test with a real hook, mirroring
  `test/fork/CurveGraduation.fork.test.js`'s existing pattern).
- **Any factory / pad-type wiring.** `RobinCurveV4` supports `noPoolForever` now; nothing
  deploys a pad with it set to `true` yet. The live `CurvePadFactoryV4` deliberately still
  only produces classic pads. A new factory (or a new `LaunchConfig` path) for this pad type
  is a separate, deliberately deferred piece of work — not started.
- **Migration, burn-boost, vesting, keeper wiring** (visibility-restock keeper, holder
  dividend snapshot cadence) — separate research done this session (see conversation/session
  notes), no code written yet.
- **Frontend wiring.** The UI already built this session (Creator Hub, token page's
  Dividends/Earnings Day panels, Portfolio, Index tokens page) is static/mocked throughout —
  none of it reads from or writes to any of these contracts yet.

## Before this touches mainnet or real funds

Per the standing project rule: full test-suite coverage first (done for the core mechanism;
not done for factory wiring, which doesn't exist yet), then a real external audit, then
explicit user sign-off before any deployment. Nothing above changes that bar.
