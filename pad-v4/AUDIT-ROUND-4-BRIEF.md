# Robin V4 — Audit Round 4: scope brief for the external auditor

**One-page kickoff. Start here.** Round 3's blocking finding is closed; this round is about verifying that
closure and the ~180 lines of new code it put on the hot swap path.

| | |
|---|---|
| **Repo / branch** | `Robinlabz/Labs` (canonical) · `main` |
| **Compiler** | solc **0.8.26**, `viaIR: true`, optimizer **runs 1**, evmVersion **cancun** |
| **Build** | `cd pad-v4 && npm ci && npx hardhat compile` |
| **Test** | `npx hardhat test test/unit/*.js test/sim/*.js test/regression/*.js` → **272 passing / 0 failing** |
| **Fork test** | `FORK_RPC=https://rpc.mainnet.chain.robinhood.com FORK_CHAINID=4663 npx hardhat test test/fork/*.js` → **6 passing** against the **live** v4 `PoolManager` `0x8366…0951` |
| **Chain** | Robinhood Chain (Arbitrum Orbit L2, chainId **4663**). Uniswap **v4** hooks. NOT yet deployed. |
| **Companion stack** | the live v3 launchpad is a separate review — see `../launchpad/AUDIT-V3.md` |

---

## 1. What changed since Round 3 — and it is exactly one thing

**Round 3's blocking finding, H-5 (floor forced-fill), is CLOSED.** Everything else in this round is the
consequence of that closure. Nothing else in the economic model moved.

Your round-3 addendum (`AUDIT-ROUND-3-EXTERNAL-ADDENDUM.md`) left three demands on the table. All three are
answered in code:

| Your demand | What shipped |
|---|---|
| **N-A** — "the shipped interim fix is INSUFFICIENT; the sustained hold walks through it; there is no valid ship-interim posture" | Conceded in full. The interim constants are **retained unchanged** but are no longer load-bearing. A commit now requires `MIN_BELOW_DURATION` of **continuous, swap-witnessed** below-band price. The sustained hold is measured at **−1.10 ETH for one `EPISODE_BASE_WEI` slice** (was +10.48 ETH / 83% of the carve). |
| **N-B** — "P2's episode never resets on a SHALLOW dump; the `(≈660, 1260)` window is net-profitable and below the reset pivot; must-fix before this is a closure" | Fixed, and it is the **one place the shipped code deviates from the spec you design-reviewed**. The episode is anchored on `aboveLowerTs` (**any** touch of the band) instead of `aboveUpperTs`. The draft's second allowance term (`EPISODE_BAND_BPS`, 0.5% of the band) is **NOT shipped** — re-derived against the cheaper band-edge round trip it inverts once the band exceeds ~1.58× pool depth. Both deviations are argued in `RobinFloorVault`'s header and in `FLOOR-H5-CLOSURE-SPEC.md`'s banner. |
| **P1 is airtight — ship it** | Shipped as specified. |

### The measurement, on real contract code

`test/regression/H5.floor-forced-fill.test.js`, 20 ETH parked carve, pad dumped to tick 12000, real
`RobinFeeHook` at the shipped `1% buy / 1% sell`:

| run | attacker PnL | carve consumed | `floorLiquidity` |
|---|---|---|---|
| pre-fix constants (10 m cooldown) | **+8.7340 ETH** | 17.85 / 20 ETH | > 0 |
| your `COMMIT_COOLDOWN > MIN_DWELL` recommendation | **+8.7340 ETH** — inert, bit-identical | 17.85 / 20 ETH | > 0 |
| **shipped gate — the round-trip PoC** | **−1.1106 ETH** | **0.0000** | **0** |
| **shipped gate — [N-A] sustained hold, 12 h** | **−1.1042 ETH** | 0.0095 ETH (= the cap) | one slice |
| **shipped gate — [N-B] shallow mid-band dump** | **−0.0817 ETH** | 0.0095 ETH (= the cap) | one slice |
| control: the same run with **no carve** | −1.1106 ETH | — | 0 |

**The decisive line is the last one.** With the gate shipped, the presence of a 20 ETH carve changes the
attacker's PnL by **0 wei**. It is no longer extraction. The honest path is intact: a healthy pad still
deploys **14.76 of a 20 ETH carve over 40 pokes**.

---

## 2. Priority focus areas (please weight your effort here)

### 1. [TOP] The ~180 new lines on the hot swap path — `RobinFeeHook._observe` / `_preSwapTick`

This is the highest-consequence new surface in the system, because **a revert in `beforeSwap` bricks a pool
for everyone, permanently**, with the seed LP already locked in `LockVault`. Read `ORACLE.md` first, then
`contracts/hooks/RobinFeeHook.sol` (the `[H-5] the floor gate / oracle` section).

What we claim, and would like you to attack:
- the read is **infallible** — a pinned `extsload(bytes32)` (`0x1e2eaeaf`) via low-level `staticcall` + length
  check, decoded in assembly, never through `abi.decode` in our own frame (the `[H-3]` trap);
- it **fails closed** — an unreadable slot stamps both watermarks, which *parks* the floor;
- it takes **zero caller-controlled input** (no `sender`, no `params`, no `hookData`);
- overflow is **unreachable by sizing**, not merely `unchecked` (`int88` against a ≤2.8e15 century bound);
- the bucket-gated ring cannot be stuffed at any swap rate;
- measured marginal cost: **+21,790 gas** on a bucket rollover, 0 on the watermark write when it folds into
  the same slot (`test/unit/RobinFeeHook.oracle.test.js`).

**The one line we most want a second pair of eyes on** is the accumulator credit. It credits `[s.ts, now]` at
**this swap's pre-swap tick**, not the stored `lastTick`. The "obvious" V3-shaped rewrite (credit `lastTick`)
**reopens H-5 at zero holding cost**: push, latch with a 1-wei swap, sell back, idle for the window, one swap
credits the whole window at the pushed tick. It is pinned by a named regression, but it is exactly the kind of
thing a later refactor deletes.

### 2. The gate's liveness envelope — can a park become a brick, or a brick become a commit?

`RobinFloorVault.addFloor()` now has eight reasons to park and **must never revert on any of them**, because
`RobinCurveV4._fundFloor` pokes it at graduation and the keeper pokes it forever.
`test/regression/H5.gate-liveness.test.js` covers: hookless pool, zero-byte return, reverting hook, dirty
full-length word, a hook armed for a **different** band, the warm-up window, the grief case, and the `[P3]`
re-entrancy window where `_collect` hands full gas to the platform wallet mid-unlock. Please try to find a
ninth.

The mirror question: is there **any** path that commits without `MIN_BELOW_DURATION` of witnessed below-band
price? The claim rests on "`slot0.tick` is written only by `initialize` and `swap`" — which you confirmed in
your addendum, and which we re-checked against `@uniswap/v4-core@1.0.2`.

### 3. The economic bound, re-derived after the N-B fix

We would like you to check our arithmetic, because we changed your blessed sizing:

> Linearising near the band, `G ≈ 2·N_push/D` while a round trip costs `2·β_net·N_push`, so
> `profit/cost = cap/(β_net·D)` **independent of push depth**. At `cap = EPISODE_BASE_WEI = D/10,000` and the
> worst-attacker `β_net = 0.8%` (the creator who recovers 80% of the sell tax and self-refers), that is
> **~80× unprofitable at every depth**. Measured 116× (deep hold) and 8.6× (shallow) on the lab geometry.

Specifically: is there a lever we have not priced? The four we did price are ending the episode, pushing down
through a token-heavy band, generating carve inflow by wash trading, and donating ETH directly to the vault.

---

## 3. What is new or modified in the tree

**NEW**
- `contracts/core/FeeHookDeployer.sol` — holds `RobinFeeHook`'s `creationCode` so the three factories don't.
  All three inlined it, so every byte added to the hook was added to each of them, and `StockPadFactory` had
  **640 bytes** of EIP-170 headroom before this change (it now has 10,359). **CREATE2 derivation is
  unchanged** — it forwards to the same `DeterministicDeployer`, so `scripts/mine.js` and every mined hook
  address formula are byte-identical. All three factory constructors take it as a new final argument.
- `ORACLE.md` — what the observation record is, what it is not, and every sizing inequality.
- `contracts/test/FloorGateMocks.sol` — hostile hook stand-ins for the liveness suite.
- `test/regression/H5.gate-liveness.test.js`, `test/unit/RobinFeeHook.oracle.test.js`,
  `test/unit/FloorConstants.test.js`, `test/helpers/floor-gate.js`.

**MODIFIED**
- `contracts/hooks/RobinFeeHook.sol` — the watermarks, the accumulator, `registerPool`'s seed, one line in
  `beforeSwap`, `armFloorGate`, `floorGateState`, `consultTick`. **The public ABI is additive only; no
  existing selector changed. `REQUIRED_FLAGS` stays `0x00CC`** (the write rides the already-set
  `BEFORE_SWAP_FLAG`; taking `AFTER_INITIALIZE_FLAG` would move the target to `0x10CC` and invalidate every
  mined salt).
- `contracts/pads/RobinFloorVault.sol` — the gate (`L1`–`L7`), the episode allowance, `bandQuoteWei`, the
  mint-time re-check, `poolId()`, `gateStatus()`, and an **11th constructor argument `episodeBaseWei`**.
- `contracts/core/{PadFactory,CurvePadFactoryV4,StockPadFactory}.sol` — the `FeeHookDeployer` argument only.
- `contracts/interfaces/IRobinInterfaces.sol` — `IRobinFloorGate`, `IRobinFloorBand`.
- `test/regression/H5.floor-forced-fill.test.js` — rewritten; the pre-fix baselines are retained verbatim.
- Runbooks: `scripts/launch.js` (arms the gate, asserts it), `scripts/check-wiring.js` (fails on an unarmed
  gate and on a band mismatch), `scripts/deploy*.js` (`FeeHookDeployer` bootstrap), `scripts/keeper.js`
  (logs the park reason).

---

## 4. The new operational requirement — one more one-shot wiring call

`hook.armFloorGate(poolId)` is a **SIXTH** platform-only, one-shot step, alongside the five in
`scripts/check-wiring.js`. **A pad whose gate was never armed parks its carve forever** (`FloorParked` with
reason `R_ORACLE`). Nothing is lost — the vault is add-only and `parkedQuote` stays exact — but nothing
deploys either. `scripts/launch.js` performs it and asserts `gateStatus().armed`; `check-wiring.js` exits
non-zero without it and also cross-checks that the hook's armed band equals the vault's band.

`RobinFloorVault`'s `episodeBaseWei` is the pad's **seed ETH / 10,000**, computed from the launch constant and
**never from a chain read** — a live depth read was measured 335× inflatable by a one-spacing JIT straddle
across the non-atomic launch → vault-deploy gap. A zero value is rejected by the constructor.

**Expect the floor to PARK for the first 195 minutes after arming, and again for 195 minutes after a curve pad
graduates** (the curve walks the tick down through the region above `gradTick`, so the last curve swap's
pre-swap tick is above the band and stamps the watermark). This is asserted as a regression in
`test/unit/RobinCurveV4.graduation.test.js`, and it is non-bricking: `_fundFloor` moves the ETH *before* its
try/caught poke.

---

## 5. Residuals we are disclosing, not hiding

| # | Residual | Sev | Position |
|---|---|---|---|
| **R1** | Carve accrued in a **previous episode** deploys only 1:1 with new inflow. A pad that dumped, accrued a large carve, and recovered can commit only `EPISODE_BASE_WEI + new carve` per episode. | **MED (liveness)** | That backlog **is** the prize you measured; making it un-drainable in bulk is the security property, and it follows directly from `extraction ≈ G × commit rate`. Nothing is lost — add-only, `parkedQuote` exact, ETH can only leave into the band. If you want a bounded liveness valve, the single dial is a time refill of `EPISODE_BASE_WEI` per `REFILL_PERIOD`; default is 0 and it is yours to set. |
| **R2** | Anyone can hold the floor parked by touching the band once per `MIN_BELOW_DURATION`. | LOW | Costs a real round trip, gains the griefer nothing, loses nothing permanently. This grief existed identically before. |
| **R3** | A pad hovering at the band edge rarely commits. | LOW | Correct behaviour — at the band edge `G ≤ 0`, so the wall's marginal value is ~zero. |
| **R4** | Curve pads park for `MIN_BELOW_DURATION` after graduation. | LOW | Non-bricking and asserted. It also **strengthens L-33**: the floor cannot build mid-curve, structurally. |
| **R5** | **The oracle is bespoke.** "Reuse an audited truncated-geomean oracle" is not satisfiable and we do not pretend otherwise. | INFO | v4 removed the built-in oracle; `TruncGeoOracle` is unmerged, `UNLICENSED`, unaudited; v3-core's `Oracle.sol` is copyleft, `<0.8.0`, and relies on wrapping arithmetic 0.8.26 reverts on. What limits the risk is **scope** — the primary control is two `uint40` watermarks and two comparisons. Do not accept a claim of an audited dependency. |
| **R6** | `EPISODE_BASE_WEI` is a trusted launch parameter. | LOW | Same trust level `anchorTick` already carries, for the same reason: it cannot be derived on-chain without a live read, and a live read is the vector that broke an earlier design. Re-derivable from launch calldata; asserted in `check-wiring.js`. |
| **R7** | A malicious **platform** is not defended against. | INFO | The platform holds `setFloorRecipient`, `setTokenSink` and the fee registry; it can already do far worse. The seed LP is `LockVault`-locked with its currency0 fees routed to the platform, which is what preserves the 4× margin against a *creator* attacker. |
| **R8** | **M-15 / L-33 are untouched, and M-15 is slightly worsened.** The band is still FIXED at the launch anchor, so a sustained drawdown parks the carve, and R1 adds the episode scope on top. | **MED (product)** | Out of scope and previously acknowledged by you as "a separate product decision". Documented, not fixed. **This is why the floor must still not be marketed as "un-ruggable" without qualification.** |
| **R9** | ~180 lines now sit on the hot swap path of every pad. | MED | The revert-vector list is enumerated and closed and the write takes zero caller input — but this needs its own review pass, not just a floor-gate review. It is focus area 1. |

---

## 6. Everything else — unchanged from Round 3, already cleared by you

Your round-3 addendum's bottom line was: *"F1 / F2 / F3 / the two contract-enforced invariants / Arrow (for
FCFS): unchanged — cleared."* None of those surfaces moved this round. The invariants still hold and are still
contract-enforced:

- **Platform is ETH-only** — no pad token ever reaches the platform key (`R3F1` regression, 3 cases).
- **No dev mint** — `supply == curveSupply + reserveSupply`; creator premine 0.
- **LP locked forever** — graduation LP NFT → `LockVault`; no remove/decrease/burn/transfer selector.
- **Add-only floor + ambush** — still no remove/withdraw path; `FloorConstants.test.js` re-asserts that the
  gate did not smuggle one in.
- **Immutable per-pad economics** — every param stamped at launch.
- **Graduation is CEI + unbrickable** — `graduated = true` before any external call; every fund-out retriable.

Still-open LOW mechanicals from round 2 are unchanged: **L-3**, **L-14**, **L-25**, **L-32**
(`AUDITOR-HANDOFF.md §0b "Still open"`). Arrow's **L1/L2** mempool front-run remains documented and not
reachable on FCFS.

---

## 7. Out of scope

- **Stock pad** (`core/StockPadFactory.sol`, `adapters/StockQuoteAdapter.sol`) — **disabled / fail-closed**
  (H-2: no live Robinhood stock registry). Mechanically fork-tested; needs its own securities/legal review.
- **`pads/RobinLpVault.sol`** — not on the shipped launch path.
- **The live v3 launchpad** (`../launchpad/`) — separate review, see `../launchpad/AUDIT-V3.md`.
- Uniswap v4 core/periphery itself; off-chain infra (indexer, bots, front end).

---

## 8. Reading order

1. **This file.**
2. `ORACLE.md` — the new hot-path code, in one page. (focus area 1)
3. `FLOOR-H5-CLOSURE-SPEC.md` — the design, its banner (what shipped and the two deviations), §7's disposition
   of all 30 red-team findings, and §9's residuals.
4. `AUDIT-SCOPE.md` §5 — the open-items list, now with H-5 marked closed and M-15/L-33 still open.
5. `AUDITOR-HANDOFF.md` §0 → §0d — the full remediation ledger from rounds 1–3.
6. `AUDIT-ROUND-3-EXTERNAL-ADDENDUM.md` — your own round-3 addendum, unedited, for cross-reference.
7. `ECONOMICS-VERIFIED.md` · `ROBIN-V4-CURVE-ECON.md` · `ARROW.md` · `FLOOR-REDESIGN.md` · `DEPLOY.md`.

**Deploy to mainnet is gated on this round clearing focus areas 1–3.**
