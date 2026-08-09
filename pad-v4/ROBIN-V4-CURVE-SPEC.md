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
- **Creator:** 0.8% of sells + 0.5 ETH at graduation. Can also **deposit ETH into staking directly** (no platform cut touched).
- **Floor:** permanent, add-only ETH buy-wall (rug-proof), fed by the **0.2% sell carve + the 20% buy-LP slice (@grad) + the ambush's pump sales**. Never pullable.
- **Stakers:** the **sell-side (token) LP fees**, streamed via the Synthetix accumulator — funded by trading, no token injection.

## Ambush (held reserve, active from launch)
At launch some tokens are **held back** (not sold on the curve) as the ambush reserve. It is placed as a **passive
single-sided TOKEN sell-wall above the price in value terms** — a fixed band of liquidity at ticks *below* the
graduation tick (in V4, a higher token value = a lower tick), implemented in `RobinAmbushVault` as the exact
mirror of the audited `RobinFloorVault` (add-only, no remove path). When the coin pumps into it, AMM mechanics
sell those tokens for ETH and the wall's ETH-side LP fees are routed to the **floor** — capping pumps and growing
the rug-proof floor. Combined with the floor's
ETH buy-wall (which catches dumps), this is a **passive two-sided support band** — "buy and sell to support the
floor" WITHOUT a gameable active market-maker. At graduation, the remaining ambush tokens **pair the permanent
locked LP**; the ETH it earned has already deepened the floor.

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
5. **`DualStaking.donateETH`** — permissionless ETH top-up so the creator can feed holders (no platform cut).
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
