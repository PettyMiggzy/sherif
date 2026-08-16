# Robin V4 — external auditor response, Round 3 (commit `73ba4e5`)

Reviewed against `73ba4e5` (`RobinFloorVault.sol` is byte-identical at `73ba4e5` and the branch tip `883812a` —
the only later diffs are audit docs, so this response applies to the tip as well). Method: adversarial finder→challenge
workflows with runnable Hardhat PoCs under `test/scratch/`. Full suite `233 / 6 pending / 0 failing`; sims `32 / 0`.

## Verdict on the three gating calls

| # | Call | Verdict | Severity |
|---|---|---|---|
| **1** | **Floor H-5 forced-fill** | **BLOCKS MAINNET as-shipped** | **HIGH** |
| **2** | Floor TWAP redesign direction | **Sound direction, two corrections** | (design) |
| **3** | Arrow front-run — ship? | **Ship for the FCFS target; salt-binding is oversold** | LOW |
| **4** | Break the two contract-enforced invariants | **Could not — both hold** | INFO |

**Bottom line: the package is NOT clear for mainnet.** The test suite is green, but green tests do not cover the
H-5 economic attack — the code *concedes* the residual in comments; it is not gated. One HIGH blocks the round.

---

## 1 · Floor H-5 residual — HIGH, blocks mainnet (confirmed net-profitable extraction, not griefing)

The shipped interim hardening (`MIN_DWELL`, `MAX_COMMIT_BPS`, `MAX_OBSERVED_GAP`) correctly killed the *atomic
whole-carve* flash-fill (the original +4.07 ETH one-tx exploit) and the >1h stale-`belowSince` replay. **Keep it.**
But it bounds only the *pace and per-tx size* of the residual, not its *per-round profitability*, and the residual
is independently confirmed as **profitable extraction** — worse in absolute terms than the original, just slower.

**Mechanism** (`RobinFloorVault.addFloor` `:174-211`). On an already-dumped pad (true spot at/above the fixed band,
carve parked), a single attacker, holding **no position between commits**:
1. buys token to shove the tick momentarily below `floorTickLower`, pokes `addFloor` (sets `belowSince=T0`, still
   parks), then **sells the token back** — a swap, which never touches `belowSince`. Token-flat, spot restored.
2. `belowSince` stays stale at `T0` (no poke lands while `tick>=band`; the attacker keeps `lastObserved` fresh with
   sub-1h pokes so the `MAX_OBSERVED_GAP` reset never fires). After `MIN_DWELL`, the commit is allowed.
3. Because `COMMIT_COOLDOWN == MIN_DWELL`, each cooldown force-commits a 20% slice of the carve into the **fixed,
   deploy-anchored** band `[floorTickLower..]` — i.e. the vault mints an ETH buy-wall at ~launch price while the
   token is worth far less at true spot. The attacker sells token back through that fresh wall and **pockets the ETH
   spread**. On single-sequencer FCFS + private mempool there is *no* competing arbitrage to correct the mispricing —
   so the attack works **best precisely in Robin's environment**.

**Why extraction, not griefing** — the decisive control (challenge PoC `test/scratch/CHAL-h5-residual-challenge.test.js`):
running the identical round-trips with the vault carve **absent** nets **negative** (−1.17 ETH / 6 rounds). Profit
appears *only* when a committable carve exists to skim. The conservation ledger closes to gas: the vault's ETH outflow
splits to the attacker (+) and pool LP fees; no ETH is minted; the attacker's gain is funded entirely by the floor carve.

**Measured** (`test/scratch/JC1-h5-residual-measure.test.js`, deployed geometry band `[60,1260]`):

| carve / pool-ETH-depth | attacker optimal-stop PnL |
|---|---|
| ~5–6% | ~0 (break-even threshold) |
| 12% | +2.5 ETH (4 rounds) |
| 36% | +9.8 ETH (7 rounds) |
| 93% | +18.5 ETH (10 rounds) |
| thin pool, deep dump, 120-ETH carve | **+23.3 ETH, ~4 rounds (~40 min)**, ~59% of carve consumed |

The break-even (~5–6% carve/pool-ETH-depth) matches the original H-5 measurement, and the regime is **realistic** for
the pads the floor exists to protect: 0.2%-of-sell-volume carve accrual + a thin post-graduation pool (1 ETH default
seed) + a price crash. Note the **floor-destruction envelope is wider than the profit envelope**: even a
cost-insensitive griefer consumes ~100% of the carve *and still nets +11 ETH* in the thin-pool case — so the
"permanent, un-ruggable floor" guarantee fails across a broader regime than just the profitable one.

**Why HIGH, not CRITICAL:** the value at risk is protocol floor-carve revenue, never user deposits/principal (no
deposit/redeem path); it only affects already-dumped pads; and a fast keeper fully neutralizes it (below).

**The keeper "defense" is real but off-chain and fragile.** A single `addFloor` poke while `tick>=band` resets
`belowSince=0` (`:181-182`); a keeper polling faster than `MIN_DWELL` during the dumped state blocks all commits
(verified: `floorLiquidity` stays 0). But this is one off-chain liveness dependency across every pad, and the code
itself concedes a poke-observed dwell "cannot prove continuous below-band price without a TWAP" (`:98-100`).

**Recommendation.** Do **not** ship on "TWAP fix tracked" alone. Either:
- **(preferred) land the real fix before mainnet** — the TWAP-gated commit (§2), or the M-15/H-5/L-33 below-spot
  band redesign; or
- **if you must ship interim, gate mainnet on BOTH, made explicit and monitored:** (a) a hardened keeper poking
  every live pad faster than `MIN_DWELL` with alerting when `belowSince` ages, and (b) a launch-parameter cap keeping
  parked-carve / pool-ETH-depth under the ~5–6% break-even (or an absolute per-commit ETH cap sized to the pool).
- Independently, **make `COMMIT_COOLDOWN` strictly greater than `MIN_DWELL`** (the residual exists *because* they are
  equal, `:193-194`): a cooldown>dwell forces the attacker to *hold* the tick-push as a price-risked position across
  the gap, reintroducing exactly the cost the FCFS/private-mempool environment currently removes. Cheap, and it
  materially raises the bar even before the full redesign lands.

## 2 · Floor TWAP redesign — sound direction, but two corrections before you build it

The direction is right and I bless it: because the band **price** is immutable, the commit *gate* is the only
manipulable primitive, so gating the decision on a manipulation-resistant TWAP (not `slot0`) removes the staleness
the attacker monetizes. Q3 (gate today's fixed band on a TWAP tick) is close to the smallest correct change — **but
it is not a one-line gate swap, and it does not fully close H-5 by itself:**

- **(a) It is not a one-liner — the spot read is double-duty.** `addFloor`'s `getSlot0` (`:177`) is both the gate
  *and* the only guarantee the band is pure-`currency0` at current spot; `_add` → `getLiquidityForAmount0` then
  settles currency1 (`~:266,:283`), which **reverts `CurrencyNotSettled`** if spot has moved to `>= floorTickLower`.
  A TWAP gate *alone* lets `TWAP<band` while `spot>=band` → forced revert / DoS or an unclean add. **Fix = TWAP gate
  PLUS a retained live-spot-below-band safety check** before the mint.
- **(b) TWAP closes the *atomic* residual, but a *sustained-hold* sandwich survives on this chain unless the window
  is sized against a real bound.** A push held for the full window drags the average below the band and commits into
  the stale fixed band anyway; the usual "arbitrage bleeds the manipulator" bound that makes the hold unprofitable is
  **exactly what FCFS + private mempool remove**, and the target is a quiet pad with ~0 honest volume, so holding is
  near-free. "Size W conservatively" only lengthens a cheap hold — you need the hold-cost-vs-carve inequality to
  actually hold. Concretely: `W ≥ 3× COMMIT_COOLDOWN` (≈30 min), harmonized with `MAX_OBSERVED_GAP`; **park (never
  revert/commit) until the observation window is fully warm**; bump `cardinalityNext` at launch; reuse Uniswap's
  audited truncated-geomean oracle (per-block clamp), not a bespoke one. Record observations **inside `RobinFeeHook`**
  (it already runs every swap) off the pre-swap tick, with an infallible/bounded write, not a keeper-fed observer
  (that re-imports the poke-dependence you're trying to kill).
- **M-15 is not closed by this.** The fixed anchor still idles the carve in a sustained drawdown — a separate product
  decision (document it, or move to TWAP-*placed* bands, a larger change).

## 3 · Arrow front-run — ship for the FCFS target; the salt-binding is oversold

**Ship as-is for the stated target chain.** The identity-hijack / grief front-run (L1/L2) is genuinely **not
reachable** on single-sequencer FCFS + private mempool: pre-inclusion calldata is invisible, and post-inclusion
replay is inert (the deployer adopts byte-identical predeploys; `poolOf` reverts `AlreadyLaunched`). Residual risk is
LOW and non-theft (a malicious sequencer/untrusted RPC could see the tx, but the "attacker" burns ~0.5 + ~4.2 ETH on
a token they visibly solely control).

**But do not oversell the proposed salt-binding hardening.** It is `ArrowLauncher`-only, yet `factory.launch` is
**permissionless and takes raw salts**, and the effective salt would be a hash of **public** fields (salts = calldata,
`msg.sender` = tx origin). So a determined attacker on a public mempool simply **bypasses `ArrowLauncher` and calls
the factory directly** with the reconstructed effective salt; and the distributor's `merkleRoot` is a separate
`CREATE` arg **not bound to the pad address**, so identity-hijack of the airdrop survives (attacker reuses the public
salts to reproduce the announced token/hook, then deploys their own `ArrowDistributor` with their own root). The
`HookFlagsMismatch` defense only bites a *naive copy-through-`ArrowLauncher`* attacker. It is a fine cheap deterrent
against copycats, but it is **not a cryptographic close** — do not claim it "future-proofs a mempool opening."

**Recommendation:** ship Arrow for the FCFS chain; keep the salt-binding as a low-cost copycat deterrent if you like,
but if Arrow is ever deployed to a public/shared-mempool chain, the real fix is **commit-reveal** (or binding the
`merkleRoot` into the pad address itself), not an `ArrowLauncher`-only salt transform. Add a test either way.

## 4 · The two contract-enforced invariants — both HOLD (could not break)

Re-attacked from scratch with a runnable PoC (`test/scratch/JC4-invariants.test.js`, 3/3):

- **"Platform never holds a pad token" — holds.** Every platform book is `currency0`/ETH-only: `DualStaking.claim`
  forces `fee=0` for `asset==tokenAsset` (`:399`) on **both** sides, so `platformFeesOwed[token]` is never written;
  the hook's `platformOwed` only credits `[id][0]` (ETH leg); `LockVault` platform book is `[tokenId][0]`; the floor
  sends currency1 to itself, currency0 to platform; the curve's platform book is ETH-only. `currency1` is
  structurally the pad token (ETH pads: `currency0=address(0)`; stock pads revert `token<=stock`).
- **"Reservoir never routes through the 70/30 splitter" — holds.** `curve.staking` is written only by `setStaking`;
  the reservoir exits only via `_fundStaking`/`flushStaking` → `staking`; `setStaking` rejects any sink whose
  `TO_STAKING_BPS()` returns 32 bytes (`:552-553`), which the real treasury does (7000). Arrow's post-hoc
  LockVault→treasury sell-leg is a *distinct* stream, not the reservoir.

The only ways to route a pad token to the platform are **privileged mis-wires** — an owner listing a *different*
pad's token with a nonzero claim fee, or a setter (`setTokenSink`/`setStakingRecipient`) pointed at
`platformFeeWallet`. Both require the root admin and are consistent with the stated `FeeWalletRegistry` trust model,
so they are not breaks of the invariant as scoped. **Optional defense-in-depth** (not gating): have those three
setters reject `sink == feeRegistry.platformFeeWallet()`, which would make the literal marketed claim true even under
a fat-fingered root admin.

---

### Round outcome

- **F1/F2/F3 remediation + the two invariants:** confirmed closed / holding.
- **Arrow:** ship for FCFS; don't oversell the salt-binding.
- **Floor H-5 residual:** **HIGH — this gates mainnet.** Land the TWAP-gated commit (with the two §2 corrections) or
  the below-spot redesign, or ship interim only behind the two explicit, monitored compensating controls in §1.
- PoCs used for this response are under `test/scratch/` (untracked; not part of the audited commit).
