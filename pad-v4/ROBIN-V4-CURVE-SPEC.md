# Robin V4 — "curve-on-V4" pad suite (LOCKED SPEC)

The flagship: a **free-to-launch, single-sided bonding curve on Uniswap V4**, with an unbypassable
per-swap fee hook, holder staking, and a permanent fee-funded floor. Native to Robinhood Chain (4663).
This doc is the locked reference — build to it.

## Why V4 (vs the live V3 curve)
- **Tax on every swap, unbypassable** — the fee lives in the V4 hook (`afterSwap`), so DexScreener /
  aggregator / raw-pool trades all pay. The V3 router tax leaks on non-router trades.
- **Holder staking + fee-funded floor** enforced on-chain — the "can't rug" story.
- Free launches (single-sided, self-seeded) — no one has to seed ETH.

## Locked economic model
Every trade pays **1% LP fee** (pool) + **1% directional trade tax** (hook). (v2 — refined economics.)

| Flow | → Destination |
|---|---|
| **Buy** LP fee | **80% → platform** now · **20% → held in the curve → floor at graduation** (governed `buyLpFloorShareBps`, default 2000) |
| **Buy** trade tax | **Platform** |
| **Sell** LP fee (token side) | **Staking pool** — holders earn the token, **no reserve injection needed** |
| **Sell** trade tax (1%) | **Creator 0.8% + Floor 0.2%** |
| **Graduation @ ceiling (~4.2 ETH raised)** | **0.5 ETH → platform + 0.5 ETH → creator** (`GRAD_REWARD`, capped raise/4 each); graduate() **gas reimbursed from the curve ETH**; rest → **locked LP** (paired with the ambush reserve) + **floor** |
| Staking reward claim | **5% → platform** |

- **Platform:** buy tax + 80% of buy LP fee (ongoing) + 0.5 ETH at graduation. (The 20% buy-LP slice is deferred into the floor.)
- **Creator:** 0.8% of sells + 0.5 ETH at graduation. Can also **deposit ETH into staking directly** (permissionless — no rewarder gate and no fee on the deposit; [M-16] the platform's claim fee, if the operator has set one, still applies when a staker later claims).
- **Floor:** permanent, add-only ETH buy-wall (rug-proof), fed by the **0.2% sell carve + the 20% buy-LP slice (@grad) + the ambush band's ETH-side LP fees** ([M-18]: not "pump sales" — the ambush never sells into pumps, see below). Never pullable.
- **Stakers:** the **sell-side (token) LP fees**, streamed via the Synthetix accumulator — funded by trading, no token injection.

## Ambush (ETH band above the graduation tick, funded AT graduation)

> **[M-18] CORRECTED.** This section previously described the ambush as the exact **mirror image** of what
> shipped — a token sell-wall below `gradTick`, held back at launch, capping pumps, and pairing the permanent
> LP at graduation. Every one of those is inverted relative to `contracts/pads/RobinAmbushVault.sol`. This doc
> calls itself "the locked reference — build to it" and is handed to external reviewers as ground truth, so the
> error is corrected here rather than annotated. The old text is in git history.

The ambush is a **passive single-sided ETH band** placed at ticks strictly **above** `gradTick`
(`ambushTickLower = _alignUp(gradTick + 1, tickSpacing)`) — i.e. **below** the graduation *price*, since in V4 a
higher tick means a cheaper token. It is funded at graduation from `ambushGradBps` (5%) of the **ETH raise**, not
from tokens held back at launch, and it is armed by a separate permissionless `seedAmbush()`.

It is **not** the floor's mirror — it is a **second buy-wall on the same side**, one band above the floor. It can
never cap the chart. A dip (a sell pushing the tick up into the band) converts its ETH to token, buying the dip;
a recovery (a buy pushing the tick back down) sells that token for ETH. The band's ETH-side LP fees are routed to
the **floor**. It is add-only with no remove path, and its band anchor is read from `curve.gradTick()` on chain
rather than passed in.

Together with the floor's own ETH buy-wall sitting just below it, that is the two-sided support the pad
advertises: two passive, un-pullable bands that catch dumps at different depths, with no gameable active
market-maker. At graduation the ambush contributes **nothing** to the permanent locked LP — the band is
permanent in its own right.

## Graduation (v2)
At the ceiling (geometry set so the raise ≈ 4.2 ETH):
1. Nudge spot to the exact ceiling (anti-grief), then pull the raised ETH from the curve.
2. Pay **0.5 ETH → platform + 0.5 ETH → creator** (capped raise/4 each), **reimburse the graduate() caller's gas
   from the curve ETH**, and sweep the **held 20% buy-LP slice → the floor**.
3. Seed a **permanent, LOCKED full-range 2-sided LP** (remaining raise + ambush reserve tokens, ETH leg binds)
   → held forever in `LockVault`; its LP fees route buy→platform, **sell→staking**.
4. Floor vault + ambush + hook keep running.

## Governance = "right the first time"
- **Per-pad fee config: IMMUTABLE at its launch** (the hook's `PoolFeeConfig`, registered once). Creators and
  traders get a hard guarantee the tax on their coin can never be raised.
- **Factory DEFAULTS (fee bps, sell-floor share, `buyLpFloorShareBps`, `gradRewardWei`, curve geometry): read
  from a governed `RobinV4FeeConfig`** (Ownable2Step, capped). Retune the defaults for *future* launches with a
  setter — **never a factory redeploy.** This is the single rule that avoids the V3 redeploy trap.

## Components
Already built + audited (reused as-is): `RobinFeeHook`, `DualStaking`, `RobinFloorVault`, `LockVault`,
`RewardConverter` (for the stocks-later reward path).

New for this suite:
1. **`RobinV4FeeConfig`** — governed default params (capped, Ownable2Step).
2. **`CurvePadFactoryV4`** — free single-sided launch: deploy token → init V4 pool w/ hook → seed single-sided
   curve (no ETH) → register immutable per-pad fee from the FeeConfig defaults → wire staking + floor.
3. **Curve/graduation logic** (`RobinCurveV4`) — single-sided position management + the v2 `graduate()` waterfall
   (per-side rewards + gas-from-curve → locked 2-sided LP → leftover → staking → held buy-LP carve → floor).
4. **`RobinAmbushVault`** — passive single-sided TOKEN sell-wall (floor-vault mirror); pump sales' LP fees → floor.
5. **`DualStaking.donateETH`** — permissionless ETH top-up so the creator can feed holders (no rewarder gate, no fee on the deposit; [M-16] the claim-time platform fee still applies, since the accumulator carries no per-tranche provenance).
6. **`scripts/auto-verify.cjs`** — watches `CurvePadFactoryV4.CurvePadLaunched`, auto-verifies token/hook/curve on Blockscout.

## Reward asset
- **ETH** is the reliable staking/yield asset (always payable from fees).
- **Stocks** are a gated, geo/KYC-restricted premium (via `RewardConverter` + `RobinStockSwap`) — later, after
  legal sign-off. Not a dependency of the core suite.

## Build order (audit + sim before deploy — standing rule)
1. `RobinV4FeeConfig` + tests.
2. `CurvePadFactoryV4` + curve/graduation logic + unit tests.
3. Economic sims: fee conservation, floor growth, graduation split, underwater-% at the chosen start geometry.
4. Adversarial audit → fix → re-audit clean.
5. Fork test against the live V4 PoolManager `0x8366…0951`.
6. Deploy + wire (indexer watches the new factory alongside V3; existing coins untouched).
