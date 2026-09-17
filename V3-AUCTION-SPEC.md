# v3 pad — daily auction + fee-tier choice + creation fee (spec)

Durable record of what's being built into the LIVE `launchpad/` pad (v3 — the "current style dex", a
bonding curve that IS a real Uniswap v3 pool, NOT pad-v4's no-pool-forever model). See
`AUCTION-PAD-RESEARCH.md` for the prior-art research pass this design responds to, and `PRESALE-SPEC.md`
for the separate, v4-only, single-window presale (`PresaleVault`) — not reused here; this is a
structurally different, v3-native mechanic.

**The live factory (`CurvePadFactory` v2.1, `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074`) is untouched.**
Every change below needs a new constructor param or a new immutable, so none of it can be hot-patched
onto live, immutable contracts. This ships as a new factory version; the live one keeps running exactly
as it does today until the new one is deployed and the frontend/backend point at it.

## 1. Daily auction (new: `DailyAuctionVault`)

Optional per launch — creator picks `auctionDays` in `[0, 4]`. `0` = skip entirely, behaves exactly like
today's launch. Nothing like this exists anywhere in this codebase today (confirmed against both v3 and
v4 — see `AUCTION-PAD-RESEARCH.md` §3).

- **Supply carve.** Today: `curveAmt = totalSupply - ambushAmt` (75/25). With an auction:
  `auctionAmt = curveAmt * auctionDays * 1000bps / 10000` (10% per day, of the CURVE's share, carved out
  BEFORE the curve is seeded — same pattern as the existing `ambushAmt` carve, just a second one).
  `curveAmt` shrinks by `auctionAmt`; the curve seeds with what's left, unchanged mechanically.
- **Per-day batch.** Each of the `auctionDays` 24h windows is its own sealed-bid batch: bidders send ETH
  during the day; nothing is priced or allocated until the day closes. `dayTranche = auctionAmt / auctionDays`
  tokens are up for that day (fixed supply, so price is discovered by total demand — deliberately NOT
  Uniswap's Continuous Clearing Auction shape from the research doc, which spreads one bid across future
  intervals and ratchets price monotonically; this is a plain batch clearing per day, simpler and cheap
  to reason about).
- **Close.** Permissionless `closeDay(day)`, callable once `block.timestamp` has passed that day's window:
  - Zero bids that day → `dayTranche` tokens are sent to the coin's `RobinStaking` pool via
    `notifyReward(token, dayTranche)` (staking pool must exist — created inline via `StakingFactory` in the
    same launch tx that everything else already goes through). Unsold supply becomes yield instead of
    overhang, matching the research doc's identified differentiator (§3, "nobody listed does this").
  - Nonzero bids → **platform takes a flat 10% of that day's total ETH**, forwarded directly to `platform`.
    The remaining 90% executes a real buy-swap against the (already-seeded) curve position — same
    swap mechanism `CurvePadFactory._devBuy` already uses (WETH deposit, `pool.swap` capped at the curve
    ceiling) — so it advances curve price and genuinely counts toward the raise the same way a real buy
    would. **The tokens that swap buys are burned** (sent to `DEAD`), not handed to anyone — auction
    bidders already got their allocation from the separately-carved `auctionAmt`, so crediting the swap's
    output too would double-allocate. This keeps the auction's fixed-supply/pro-rata fairness completely
    decoupled from the curve's continuous AMM pricing, while still letting the ETH move the graduation
    needle and burning supply as a side effect.
- **Claim.** Each bidder's share of `dayTranche` = `theirBid / dayTotal`, claimable any time after that
  day closes (`claim(day)`, pull-based, standard reentrancy-guarded transfer — no batch payout loop).
- **Sequencing.** The vault only accepts bids for days 1..auctionDays; the underlying `CurvePool` is
  seeded (and open to ordinary trading) immediately at launch, same as today — the auction runs
  *alongside* the live curve, not as a gate in front of it, so there's no dead window where the coin
  isn't tradeable. (Considered gating the curve until the auction finishes; rejected — it would mean a
  multi-day window with zero DexScreener activity, which cuts against this pad's whole "DEX +
  DexScreener from block one" positioning.)

## 2. LP fee tier choice

Two genuinely separate things were bundled in the original ask — worth separating because one is free:

- **The creator/platform SPLIT of the LP fee** (today 10% creator / 90% platform, `FeeConfig.lpCreatorBps`)
  is already owner-governed and already capped at exactly 50% (`LP_CREATOR_MAX = 5000`). Moving it to
  50/50 needs **zero contract changes** — just `FeeConfig.setLpCreatorBps(5000)` on the live, deployed
  `FeeConfig`, and it applies pad-wide immediately (every coin, not per-launch). Not blocked on anything
  else in this spec.
- **The fee TIER itself** (`POOL_FEE`, hardcoded `10000` = 1% today, `CurvePool.sol` L39) is real new
  contract surface: made an immutable set at construction instead of a constant, validated against the
  standard Uniswap v3 tiers `{500, 3000, 10000}` (0.05% / 0.3% / 1%) — not an arbitrary value, so every
  coin only ever mints into a tier with real aggregator/router support. Threaded through
  `CurveDeployers.sol` and a new `poolFee` param on `CurvePadFactory`'s launch entrypoints.

## 3. Creation fee (0.001 ETH, protocol seed buy)

Paid by the creator at launch (separate from, and in addition to, the optional dev-buy `msg.value`).
Executed as a tiny protocol buy-swap against the curve immediately after seeding — same swap mechanism
as the auction's day-close buy and the existing dev buy — with the bought tokens burned. Real WETH lands
inside the curve's Uniswap v3 position before the first outside buyer arrives, and price ticks forward
by a hair off the exact `startTick`, so the very first real buyer isn't trading against a perfectly
virgin, zero-depth position.

## Status

Design locked with the user (see conversation — daily-10%-of-supply tranche confirmed, fee-tier CHOICE
confirmed over the simpler fixed-tier option, WETH-only confirmed (no USDC), creator pays the creation
fee confirmed). All four pieces are now built:

- `CurvePool.sol` / `Bond.sol` / `CurveDeployers.sol` — fee-tier parameterized (`POOL_FEE`/`SPACING`
  immutable, derived live from `v3Factory.feeAmountTickSpacing`), restricted to {500, 10000}.
- `CurvePadFactory.sol` — `CREATION_FEE` (0.001 ETH, mandatory, spent as a burn-buy seed), `LaunchParams`
  gained `poolFee` and `auctionDays` fields, `auctionVaultOf` mapping + `Launched` event carries the vault
  address. `auctionVaultDeployer` is **owner-settable, not a constructor immutable** — deliberately, so
  every existing deploy call site across the test suite that doesn't care about auctions keeps working
  unchanged; the feature is off (`auctionDays > 0` reverts `BadValue`) until an owner opts a deployment in
  via `setAuctionVaultDeployer`.
- `DailyAuctionVault.sol` (new) + `DailyAuctionVaultDeployer` — the daily batch auction itself, deploying
  and owning its own dedicated `RobinStaking` pool (stake-the-coin-earn-the-coin) for zero-bid days, no
  cross-factory registry/authorization dance needed since the vault is that pool's owner from birth.

Verified for real (not just unit-mocked): `test/creation-fee-and-pool-fee.test.js` (7/7 passing, real
@uniswap/v3-core bytecode) — creation-fee-required reverts, the seed buy genuinely moves price and burns
real tokens, dev-buy + creation-fee coexist correctly, 3000 is rejected, 500 launches on a real distinct
pool, and **a 500-tier coin graduates and the Bond posts into that same pool with correctly-aligned wall
geometry** (the whole reason 3000 was excluded — confirms the alignment analysis held). `test/daily-
auction.test.js` covers the vault end to end: exact supply carve-out, window enforcement, a two-bidder
day closing with the platform's flat 10% + a real burn-buy that moves curve price + exact pro-rata claims,
a zero-bid day funding the dedicated staking pool (confirmed as a real streaming reward, not an instant
lump), and late/pull-based claiming.

A background agent fixed the ~32-file test-suite ripple from the `LaunchParams` struct gaining `poolFee`/
`auctionDays` fields and every launch call needing to satisfy the new `CREATION_FEE` minimum — tracked
separately, not yet confirmed green as of this note (in progress).

Not yet done: a dedicated deploy script for a fresh (auction-capable) `CurvePadFactory` instance — the live
v2.1 factory (`0x8aa9...`) is completely untouched by any of this and needs no action; a NEW instance is
only needed if/when this actually ships to mainnet, which is not yet authorized.
