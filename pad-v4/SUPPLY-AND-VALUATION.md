# Creator-chosen supply — bound the valuation, not the token count

**Status: built, tested, NOT deployed** (the whole v4 is pre-deploy). Contracts:
`core/PadValuation.sol`, `core/CurvePadFactoryV4.sol`, `core/RobinV4FeeConfig.sol`.
Tests: `test/regression/FDV.creator-supply.test.js` (7 cases). Client helper: `scripts/valuation.js`.

## The ask

"Let people choose their supply — 10,000 should work, not just 1,000,000,000."

## Why supply alone is the wrong knob

The v4 `LaunchConfig` already carried `supply` / `curveSupply` / `reserveSupply`, so a 10,000-token coin was
*nominally* launchable before this change. It just wasn't a coin anyone would want, because the launch price
was fixed by governance (`startTickMag`, the same tick for every pad). At a fixed price, supply IS the
valuation:

| supply | fixed start tick | opening valuation | ETH to graduate |
|---|---|---|---|
| 1,000,000,000 | 201600 | 1.76 ETH | ~4.1 ETH (73% on the curve) |
| 10,000 | 201600 | 0.0000000000000176 ETH | dust — `graduate()` bricks on `EmptyRaise` |

So "choose your supply" without also choosing your price is not a feature, it's a way to launch a broken coin.
Halving supply halved the raise; doubling it doubled the raise. The creator thinks they are picking a
cosmetic number and is actually re-pricing the entire launch.

## What we do instead

Two changes, and the second is the one that matters:

1. **`LaunchConfig.startTickMag`** — a per-launch start price. `0` means "use the governed default", so every
   existing caller is unchanged. `curveWidth` deliberately stays GLOBAL, so every coin still graduates at the
   same multiple of its own launch price. Only the absolute starting point moves.
2. **`RobinV4FeeConfig.minFdvWei` / `maxFdvWei`** — the factory bounds `supply x launch price`, the implied
   fully-diluted value, and reverts `MarketCapOutOfRange(fdvWei)` outside it. Supply itself is bounded by
   nothing at all.

Once price is a free variable, supply becomes genuinely cosmetic — which is the property the regression test
actually measures rather than asserts. At equal FDV, a 10,000-supply coin and a 1,000,000,000-supply coin take
the same money for the same **percentage** of the coin, and move the same number of ticks up the chart:

```
launch BIG   supply 1,000,000,000  startTickMag 0 (default 201600) → FDV 1.758 ETH
launch SMALL supply        10,000  startTickMag 86500              → FDV 1.756 ETH
0.25 ETH into each → identical share-of-supply (<1% drift) and identical tick move (<1 spacing)
```

## Where the numbers come from

The pool is ETH (`currency0`) / token (`currency1`), so its price is **tokens per ETH**:

```
P = 1.0001^tick                    FDV_wei = supplyRaw / P = supplyRaw * 2^192 / sqrtP^2
```

A HIGHER tick is a CHEAPER token (more per ETH) — which is why the curve launches at a high tick and
graduates downward. `PadValuation.fdvWei` computes this in two `mulDiv` steps because `sqrtP^2` alone
overflows uint256 above roughly tick 0, i.e. across the entire region Robin curves launch in.

`PadValuation` is a single library rather than three copies on purpose: `CurvePadFactoryV4` enforces the band
with it, and `PresaleVault` + `ArrowLauncher` both size a curve buyout from the same resolved start tick. A
second implementation in either launcher would price the buy off one tick while the factory initialized the
pool at another.

## The shipped band

`scripts/deploy-curve.js`, both env-overridable (`MIN_FDV_ETH` / `MAX_FDV_ETH`):

```
minFdvWei = 0.05 ETH        maxFdvWei = 100 ETH
```

Reference point: the shipped geometry puts a 1B-token supply at ~1.76 ETH FDV and a ~4.05 ETH raise, so the
band spans roughly 1/35x to 57x that launch. (The raise figure assumes 73% of supply on the curve, the
shape `scripts/testnet-bot.js` launches; it scales with `curveSupply`, not with total supply.)

**These are WEI, and they are a live governance knob.** This chain has no USD oracle, so there is no way to
express "between $2,000 and $10,000,000" on-chain — the operator retunes the band as ETH moves.
Consequences a launch client must respect:

- **Read `factory.fdvBand()`; never hardcode it.** A client that baked in yesterday's numbers starts quoting
  launches that revert.
- `factory.quoteFdvWei(supply, startTick)` is the exact value the launch check uses — same library, no second
  implementation — so a UI can show the creator their valuation before they spend gas.
- `scripts/valuation.js` turns a creator's actual choice ("1,000,000 tokens at ~2 ETH") into a tick:
  `startTickForFdv(factory, supplyRaw, fdvWei, tickSpacing)` estimates in floating point and then refines
  against `quoteFdvWei`, so the client and the chain can never disagree about whether a config is in band.

## The creator-facing layer: presets and dollars

A creator does not think in ticks and barely thinks in wei. They think *"1B supply, $4K market cap"* — which is
how hood.dev frames the identical two choices (supply quick-picks 100M / 420M / 1B / 69B, market-cap quick-picks
$2.5K / $4K / $10K / $25K, each with a freeform box beside it). `scripts/valuation.js` carries that layer:

```js
const f = await launchFieldsFor(factory, 1_000_000_000n, 4000, ethUsd, tickSpacing);
// -> { supply, startTickMag, fdvWei, marketCapUsd }   ready to drop into a LaunchConfig
```

The presets are a curated subset, never the limit — the contract's band is the only thing enforced, and
`test/regression/FDV.creator-supply.test.js` proves all **16** supply x market-cap combinations land inside it
and produce a valid launch tick, plus launches the widest corner (69,000,000,000 tokens at $25K) and trades it.
A UI that offers a button the contract would reject is a UI that reverts on click; that test is what stops it.

> **The dollars live entirely in the client, and `ethUsd` is the weak link.** This chain has no USD oracle, so
> the contract's band is wei and nothing on-chain can check a price the client supplied. A stale `ethUsd` does
> not create a wrong launch — it creates a launch at a different dollar valuation than the creator read on
> screen, and if it is stale enough the band simply rejects it. Quote it fresh and show the ETH figure next to
> the dollar one. `usdToWei` is deliberately its own exported function so this conversion is visible rather than
> buried. Note also that the tick grid rounds: `launchFieldsFor` returns the REALISED market cap, within one
> tick-spacing of the target, and that is the number to show.

## Four traps, taken from hood.dev's live implementation

Their launcher is source-verified on Blockscout, so these are read from deployed code and live `eth_call`, not
from their marketing. Three of the four we would have shipped ourselves.

| their bug | us |
|---|---|
| **The `$2.5K` preset reverts.** Their band is ETH-denominated (`minFdvWei` 1.11 ETH) but the buttons are labelled in dollars, so as ETH rose the cheapest button drifted under the floor. It is on their live page today and fails in the user's wallet. | **`marketCapPresetStatus(factory, ethUsd)`** returns a usable flag + reason per preset so a UI greys the dead ones out. Regression-tested at ETH prices that kill the bottom AND the top of the grid. |
| **"caps every wallet for roughly the first 74 minutes"** — `restrictionBlocks = 366` at a measured 0.1s block time is **36.6 seconds**. Someone hardcoded a 12s Ethereum assumption. | Not reachable: our v3 guard is denominated in **seconds** (`deadSecs`/`phase1Secs`/`antiSnipeSecs`), never blocks. |
| **Tick snapping is invisible** — you type 4000 and silently get $4,023 (their spacing 200 = 2.02% rungs). | `launchFieldsFor` returns the **realised** market cap, and our v4 spacing is 100 (~1.005% rungs). Show the realised number, never the typed one. |
| **A live Alchemy key ships in their client bundle.** | Ours is server-side behind `api.robinlab.io/rpc`; the browser never sees a provider key. |

One more worth copying rather than avoiding: **preflight the launch before asking for a signature.**
`preflightLaunch(factory, cfg, ...salts)` static-calls the real `launch` and decodes the custom error, so a
creator reads `MarketCapOutOfRange` or `BadGeometry` in the form instead of in a failed transaction. The band
check alone is not enough — geometry and the reserve margin can still reject a config the band accepts.

## Governance rails

`minFdvWei`/`maxFdvWei` are owner-tunable, and they have to be: the band is **wei** on a chain with no USD
oracle, so the operator must be free to move it a long way as ETH moves. `setDefaults` rejects a zero floor and
an inverted band, and `HARD_MAX_FDV_WEI` (**1,000,000 ETH**, mirrored on the v3 factory) caps the ceiling. That
constant is a fat-finger guard, not a policy — at ~10,000x the shipped 100 ETH ceiling it never binds a real
retune, it only stops `maxFdvWei` being set to `type(uint128).max` and silently disabling half the band.

## What the band is and isn't

It **is** an admission check that stops two failure modes, both fail-closed before any state write:

- a **dust** valuation, where the curve integral truncates toward zero and `graduate()` bricks permanently on
  `EmptyRaise` (this is the same class `MIN_RAISE_WEI` guards, caught earlier and with a clearer error); and
- an **absurd** valuation, where the ETH needed to graduate is unreachable and the pad is dead on arrival.

It is **not** a claim about what a coin is worth, and it does not make a launch good. A creator can still pick
a silly-but-in-band valuation, and nothing here changes the trade taxes, the floor, or graduation.

## Scope: the CURVE path only

`PadFactory` (the ETH-seeded seed-LP pad) and `StockPadFactory` are deliberately untouched. Those callers pass
`sqrtPriceX96` directly and back it with a real ETH seed, so the launcher is already pricing their own launch
with their own capital — there is no governed price for a per-launch override to override, and no free launch
for a dust valuation to brick. The FDV band applies where the launch is free and the price is governed: the
curve.

## Migration notes

- `LaunchConfig` gained a field, so **every caller must be updated** — ethers rejects a struct with a missing
  member. Pass `startTickMag: 0` to keep the previous behaviour exactly.
- `RobinV4FeeConfig.Defaults` gained `minFdvWei` / `maxFdvWei`, and `setDefaults` rejects a zero floor or an
  inverted band (`BadParam`). Existing test fixtures pass an OPEN band (`1` .. `type(uint128).max`) on
  purpose: they exercise curve mechanics over toy supplies, not the product's valuation policy, which is
  tested in exactly one place.
- `PresaleVault.snapStartTickMag` now snapshots the **resolved** start tick. A presale that pins its own launch
  price is no longer bricked by an unrelated retune of the global default; one that inherits the default still
  tracks it, so the M-12 guarantee is unchanged.
- **The live v3 (`../launchpad/`) cannot do any of this.** `CurvePool` hardcodes
  `TOTAL_SUPPLY = 1_000_000_000 ether`, and the factory's `bondDeployer` is immutable, so creator-chosen
  supply on v3 needs a new factory — the same redeploy the v3 floor fix needs.
