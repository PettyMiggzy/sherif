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
Every trade pays **1% LP fee** (pool) + **1% directional trade tax** (hook).

| Flow | Rate | → Destination |
|---|---|---|
| LP fee (buys, ETH-side) | 1% | **Platform** |
| LP fee (sells, token-side) | 1% | **Platform** |
| Trade tax — buy | 1% | **Platform** |
| Trade tax — sell | 1% | **Creator 0.8% + Floor 0.2%** |
| Unsold curve tokens @ graduation | — | **Staking pool** (streamed to holders) |
| Staking reward claim | 5% | **Platform** |

- **Platform net:** ~2% of buy volume (1% LP + 1% buy tax) + 1% of sell volume (token-side LP).
- **Creator:** 0.8% of sell volume.
- **Floor:** 0.2% of sell volume → permanent, add-only ETH buy-wall that grows from every sell.
- **Stakers:** the unsold curve-token reserve at graduation, streamed via the Synthetix accumulator.
- **Optional ETH-to-stakers slice:** a governed knob (`stakingEthShareBps`), **default 0** — turn it on later
  to route part of the platform LP fee to stakers as real ETH yield, no redeploy.

## Graduation (LOCKED)
When buys carry price to the curve **ceiling**:
1. Pull the raised ETH + all leftover curve tokens from the single-sided position.
2. Seed a **permanent, LOCKED full-range 2-sided LP** (raised ETH + a matching token amount) → held forever
   in `LockVault`; its LP fees → **platform**.
3. Route the **remaining unsold tokens → the staking pool** (streamed to holders).
4. Floor vault + hook keep running. No dev payout knob here beyond the locked fee flows.

## Governance = "right the first time"
- **Per-pad fee config: IMMUTABLE at its launch** (the hook's `PoolFeeConfig`, registered once). Creators and
  traders get a hard guarantee the tax on their coin can never be raised.
- **Factory DEFAULTS (fee bps, floor share, curve geometry, stakingEthShareBps): read from a governed
  `RobinV4FeeConfig`** (Ownable2Step, capped). Retune the defaults for *future* launches with a setter —
  **never a factory redeploy.** This is the single rule that avoids the V3 redeploy trap.

## Components
Already built + audited (reused as-is): `RobinFeeHook`, `DualStaking`, `RobinFloorVault`, `LockVault`,
`RewardConverter` (for the stocks-later reward path).

New for this suite:
1. **`RobinV4FeeConfig`** — governed default params (capped, Ownable2Step).
2. **`CurvePadFactoryV4`** — free single-sided launch: deploy token → init V4 pool w/ hook → seed single-sided
   curve (no ETH) → register immutable per-pad fee from the FeeConfig defaults → wire staking + floor.
3. **Curve/graduation logic** — single-sided position management + `graduate()` (seed locked 2-sided LP +
   unsold → staking). (V4 analogue of the V3 `CurvePool`.)

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
