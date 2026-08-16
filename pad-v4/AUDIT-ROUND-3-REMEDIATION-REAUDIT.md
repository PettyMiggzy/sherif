# Round-3 remediation RE-AUDIT — verifying the F1/F2/F3 fixes at tip `7ee04c2`

Independent re-audit of the build session's round-3 remediation, run against the **fetched branch tip `7ee04c2`**
(not the pre-remediation `954faf8` the original findings were written on). Goal, per the hand-off: *re-audit the
fixes, don't re-report the findings.* Method: a 10-agent adversarial workflow (5 fix-dimensions × finder→skeptic,
each skeptic told to REFUTE) plus manual confirmation of every load-bearing claim against the code at `7ee04c2`.

**Test/sim baseline on `7ee04c2`:** `npx hardhat test` → **231 passing / 6 pending** (was 225 pre-fix; +6 = the new
`R3F1` regression [3] + `DualStaking.adversarial [F1]` [3]). Full sim suite → **32 passing** (Arrow migration
end-to-end, curve graduation/conservation/slippage/fee-conservation, lock-staking graduation drip, presale). Compile
clean. **No fix-induced test regression.**

> **Bottom line for the external-auditor package:** write it against `7ee04c2`, but do **NOT** yet advertise "all
> three findings cleanly closed." **F1 is fully closed (structural, verified).** **F2 and F3 have residuals** and the
> remediation introduced **two new items** (a broken deploy script + an inaccurate fix rationale). All residuals are
> **LOW or NONE fund-safety** — no theft / brick / permanent-strand — but they are the same *documentation- and
> operator-robustness* class the original findings were about, and an external auditor reading `deploy.js` / the ECON
> doc / `launch.js` will hit the same contradictions and lose trust in the brief unless they're cleared first.

---

## Verdict table

| # | Fix | On-chain contract fix | Completeness | Fund-safety |
|---|---|---|---|---|
| **F1** | pad-token via staking claim fee | ✅ **CLOSED — structural, unbypassable** | ✅ complete | NONE (closed) |
| **F2** | `RobinFloorVault.setTokenSink` guard | ✅ setter fully guarded | ⚠️ **INCOMPLETE** — named peer left unguarded | LOW (admin fat-finger) |
| **F3** | curve token model / docs | ✅ reservoir → 100% staking (wiring) | ⚠️ **INCOMPLETE** — docs still misstate the curve path | NONE |
| **N1** | *(new, fix-induced)* `launch.js` runtime throw | ❌ **regression** | — | NONE (fails loudly, recoverable) |
| **N2** | *(new)* "probe rejects the treasury" rationale | ❌ **inaccurate** | — | NONE (operator-dependent) |

---

## F1 — CLOSED (structural, verified unbypassable)

`DualStaking.claim()` (`:399`): `fee = asset == address(tokenAsset) ? 0 : (amount * platformClaimFeeBps) / BPS;`

Adversarially verified — could not be broken:
- The exemption keys on **`asset` only, not `side`** — so even the "earn-the-other" config `claim(STOCK, tokenAsset)`
  is exempt. No side-listing choice routes a pad token to the platform.
- `platformFeesOwed` is written at **exactly one** site (`:402`), inside `if (fee > 0)`, and `fee` is the literal `0`
  for `tokenAsset`. No other writer (`fundETH`/`fundToken`/`fundTokenPushed`/`donateETH`/`receive`/stake/unstake never
  touch it). So `platformFeesOwed[tokenAsset]` is **permanently 0**, and `claimPlatformFees(tokenAsset)` reverts
  `Zero` (`:412`) — the only pad-token path to `platformTreasury` (`:414`) is dead.
- **Narrow (no over-fix):** non-`tokenAsset` rewards (ETH/stock) still charge `amount*bps/BPS`. Proven by the
  `[F1] narrow` test and the money-side sim.
- Edges (`tokenAsset == ETH-sentinel`, `stockAsset == tokenAsset`) only *widen* the exemption — never leak. `:163`
  blocks `tokenAsset == address(0)`.

*Non-blocking nit:* `scripts/deploy.js:55` still comments that setting `STAKING_CLAIM_FEE_BPS > 0` "breaks the
invariant." Stale after the structural fix — the contract now holds the invariant for the pad token regardless of
`bps` (a nonzero `bps` would only charge ETH/stock rewards). Worth updating the comment so it doesn't mislead.

## F2 — setter CLOSED, but the named peer was NOT mirrored (INCOMPLETE)

`RobinFloorVault.setTokenSink` (`:227`) now rejects `zero || code.length == 0 || self` — matches the strongest peer
(`hook.setFloorRecipient`) and exceeds the curve peers (which omit the self-check). One-shot + platform-gating intact,
no regression. **The setter itself is fully fixed.**

**Residual:** the original finding explicitly said *"`LockVault.setStakingRecipient` shares the gap."* That peer was
**left untouched** (empty diff on `LockVault.sol`). `LockVault.setStakingRecipient` (`:98-106`) still validates only
`recipient == address(0)` (`:103`) — no `code.length`, no self-check. It is one-shot (`:102`), has **no rescue path**
anywhere in the contract, `claimStaking` (`:157-163`) pays `lk.stakingRecipient` permanently, and `LockVault` has a
`receive()` (`:188`) — so a platform-side fat-finger to an EOA or to the vault itself **permanently freezes/misroutes
the locked-LP sell-side token fee stream**. Platform-only (trusted-admin), no external attack surface — defense-in-
depth, exactly F2's class. **To close F2: mirror the `setTokenSink` guard onto `LockVault.setStakingRecipient`.**

## F3 — reservoir wiring CLOSED, but the docs still misstate the curve path (INCOMPLETE)

The reservoir fix is real: `launch`-time `curve.setStaking = pool` makes `graduate()` step 7 push the whole
`leftoverToken` via `_fundStaking` (`:768-777`) **100% to the pool** — no split, no fee. Verified.

**Residual — the doc reconciliation is wrong (and self-contradictory).** Ground truth from the code: on the **curve
path**, at graduation `onGraduated(…, staking = curve.staking = pool)` (`RobinCurveV4:417`) →
`CurvePadFactoryV4.registerLaunch` (`:287-289`) writes `locks[lpTokenId].stakingRecipient = pool` (`LockVault:91`),
and `setStakingRecipient` can never override it (`AlreadySet`). So `claimStaking` pays the **pool** for the token
(sell) leg — the curve-path LockVault sell-leg goes **100% to staking, not to the treasury**. Yet:
- `ROBIN-V4-CURVE-ECON.md §5` still says *"`LockVault`'s token leg … recipient = treasury"*;
- `§53 [F3]` says *"the `LockVault` sell-leg + `RobinFloorVault` + `RobinAmbushVault` route to the treasury"* — the
  same variable it then admits *"must be the pool"* (self-contradictory);
- `RobinTokenTreasury.sol:11` **still lists "`LockVault` sell-leg" as a treasury source** — the exact docstring the
  original F3 flagged as false, **untouched** in `954faf8..7ee04c2`.

Fund-safety **NONE** (100%-to-pool is *more* holder-favorable than 70/30; the platform holds no pad token either way).
**To close F3:** correct the three doc sites to say the curve-path LockVault sell-leg goes to the **pool (100%
staking)**; the treasury's real *curve-path* token sources are `RobinFloorVault.tokenSink` and `RobinAmbushVault`
only. (The **PadFactory** path *does* wire the sell-leg → treasury 70/30 — see N1 — so the docs should scope the
treasury claim to that path.)

---

## New items surfaced by the remediation

### N1 — `launch.js` now throws at runtime (fix-induced regression) · LOW/NONE

`launch.js` drives the **`PadFactory`** seed-LP path (`:58` `getContractAt("PadFactory", d.padFactory)`), whose
`PadLaunched` event is `(index, token, creator, hook, poolId, lpTokenId)` — **no `curve` field**
(`PadFactory.sol:226`). The F3 remediation grafted curve-only wiring into this script: `:78` now destructures
`curve` from that event (→ `undefined`) and `:108` calls `getContractAt("RobinCurveV4", curve)` → **throws
`invalid value for Contract target`** (reproduced empirically). It throws *after* the launch/floor/staking txs have
already executed, so a one-command launch **aborts mid-way**, leaving the treasury + floor sinks unwired. Recoverable
via the one-shot setters and it fails loudly (no fund loss), but the script is broken as shipped.

*Note:* on the PadFactory path the lock is registered **atomically inside `launch()`** (`PadFactory.sol:209`) with
`stakingRecipient = 0`, so `launch.js:123 setStakingRecipient(treasury)` *would* succeed there (sell-leg → treasury
70/30) — it's the curve graft above that breaks first. **To fix:** remove the curve/`setStaking` block from
`launch.js` (PadFactory pads never graduate — they have no curve or reservoir). The correct curve wiring already lives
in `scripts/testnet-e2e-graduate.js:97` / `deploy-curve.js`; that is where the F3 `setStaking = pool` belongs.

### N2 — the "`_probeStakeAsset` can never be the treasury" rationale is false · NONE

`launch.js:105-106` (and the ECON §53 note) justify the reservoir wiring by claiming `setStaking` "probes the sink's
stake asset and reverts `StakingAssetMismatch` on a non-pool, so it can never be the treasury." **Not true:**
`_probeStakeAsset` (`RobinCurveV4:545`) tries **both** `token()` and `tokenAsset()` (`:33-38,536`), and
`RobinTokenTreasury` exposes `token()` == the pad token (`RobinTokenTreasury.sol:34`) — so `setStaking(treasury)`
**passes the probe**. The `setStaking(treasury)` mis-wire the *original* F3 warned about (which silently burns 30% of
the reservoir) is still only prevented by **platform-gating + one-shot + operator discipline**, not the asset probe.
Correct the rationale wherever it appears; if belt-and-suspenders is wanted, `setStaking` could additionally reject a
sink whose `token()`/`tokenAsset()` resolves to a `RobinTokenTreasury` shape.

---

## What's clean (positive, re-confirmed at `7ee04c2`)

- **F1 contract fix** — structural, unbypassable, narrow; `platformFeesOwed[tokenAsset]` provably always 0.
- **F2 setter** — `setTokenSink` fully guarded, peer-matched, no regression.
- **F3 reservoir** — `_fundStaking` sends 100% of the graduation leftover to the pool; ETH-only waterfall elsewhere;
  the platform never receives a pad token on any graduation path.
- **Arrow contracts** — unchanged since round 3; five prior independent audits + this pass find no theft/brick/strand.
- **Accounting** — the `fee = 0` branch keeps `accountedReserve == balanceOf` (net == amount, full outflow to the
  staker); no stranded reward.

## Hand-off (for the build session — this auditor did not modify any code)

1. **F2:** mirror the `setTokenSink` guard onto `LockVault.setStakingRecipient` (`code.length == 0` + self).
2. **F3 docs:** fix `ECON §5`, `ECON §53`, and `RobinTokenTreasury.sol:11` to say the **curve-path** LockVault
   sell-leg → pool (100% staking); scope the treasury/70-30 claim to the **PadFactory** path + floor/ambush.
3. **N1:** remove the curve/`setStaking` graft from `launch.js` (or split scripts per factory); it throws on the
   PadFactory path and belongs in the curve deploy script.
4. **N2:** correct the "`_probeStakeAsset` rejects the treasury" claim in `launch.js:105-106` + ECON §53.
5. **F1 nit:** refresh the `deploy.js:55` comment — a nonzero claim fee no longer "breaks the invariant."

Once (1)-(4) are done, re-fetch and the external package can honestly state F1/F2/F3 all closed.
