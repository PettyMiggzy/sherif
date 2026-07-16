# Sheriff's Pad — internal security audit

Self-audit of the launch + trade + tax contracts before deploy. Scope: the money
paths a user's funds actually flow through — `PadRouter` (swap desk + project
tax), `CurvePadFactory` (launch + dev buy), `CurvePool` (bonding curve →
graduation), `Bond` (the floor), `LaunchToken` (the anti-snipe guard).

Method: manual review + an adversarial test suite that tries to break each path
(`test/padrouter.adversarial.test.js`), plus the exact-math unit tests
(`test/padrouter.test.js`) and the on-fork end-to-end tests (`test/fork/*`).

Status: all findings below resolved. Unit + adversarial + fuzz suites pass
locally, and **all 7 fork tests now pass against real Uniswap v3 on Robinhood
Chain mainnet** (archive RPC in the gitignored `.env`) — the swap desk (buy +
sell), the one-call launch + dev-buy, the curve, graduation, and the Bond
(Sherwood/Bounty/Ambush + poke) are all verified end-to-end on the live chain,
not just mocks. The `SIMS=300` randomized battery (below) passes clean.

## Findings & resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | Med | `PadRouter.uniswapV3SwapCallback` only checked `_swapping`, not that the caller was the pool we're swapping with (Bond/CurvePool already check `msg.sender == pool`). A stray/forged callback during the window could pay out `tokenIn`. | Added `_activePool` and require `msg.sender == _activePool`. Same hardening applied to `CurvePadFactory`'s dev-buy callback. Test: `swap callback can't be invoked out of band`. |
| F2 | Low | If `flushBurn`'s buy-and-burn swap partially filled, leftover WETH sat in the router; a later `buy`'s leftover refund (which returns the whole WETH balance) would hand it to an unrelated buyer. | `flushBurn` now unwraps any residual WETH and re-credits it to `burnEscrow`. The router never holds stray WETH between calls. Test: `burn flush … re-credits any residual`. |
| F3 | Low | Front-end `quoteMinOut` returned `0` on any read failure → a buy/sell could go out with **no slippage floor** (sandwich bait). | It now throws a friendly "couldn't price this trade" instead of ever returning 0. A trade never signs without a real min-out. |
| F4 | Info | `withdrawPlatform` was the one state-changer without `nonReentrant`; a seller's payout hook could re-enter it. Harmless (CEI, funds only ever go to `owner()`), but it broke the clean "any re-entry reverts" invariant. | Added `nonReentrant`. Now every fund-moving entrypoint is guarded. Test: `reentrancy … cannot double-dip` (mode 2). |

## Deep pre-production audit (second pass)

A second, adversarial pass (5 parallel reviewers over each money path) before the
production deploy. Every finding below is **fixed and regression-tested**; the
full unit + adversarial + `SIMS=300` + all fork tests pass green after the fixes.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| CP-1 | **Critical** | After the curve is bought out there is **no liquidity past `gradTick`**, so spot can be shoved arbitrarily far past it for ~free. `graduate()` posted the Bond around that spot — an attacker could place the floor at an inflated price and drain it. | `graduate()` now requires spot to sit within `GRAD_MAX_DEV = 50` ticks (~0.5%) of `gradTick` before posting (`CurvePool`). An honest capped buy-out lands within one spacing; a manipulated price reverts `NotReady`. Regression: `graduate() refuses a MANIPULATED post-buyout price (CP-1)` (fork). |
| F-1 | High | The launch token was deployed with plain `CREATE` (nonce-predictable). An attacker could pre-create **and initialize** the token's WETH pool at the next predictable address, making `CurvePool`'s own `initialize()` revert and **permanently bricking** every launch that reuses that address. | Token now deploys via `CREATE2` with a per-launch salt that folds in `block.number`/`block.timestamp`/dev/name/symbol (`LaunchTokenDeployer` + `CurvePadFactory`). The address — and thus the pool — is unpredictable; a griefer would have to win the race for one exact block, and a retry lands a fresh address, so the DoS can't be made permanent. |
| PR-1 | High | `flushBurn`'s buy-and-burn swapped with **no price cap**. Run pre-graduation it could push price past `gradTick` into the empty region and brick graduation — the same overshoot that crashed the live pool. | `flushBurn` now caps the buy at `gradSqrtPriceX96()` while the coin is pre-graduation, exactly like the user-facing `buy()` (`PadRouter`). |
| B-1 | High | The Bond's `poke()` reads a TWAP over `observe(window)`. On Robinhood Chain (~0.1s blocks, ≤1 obs/active block) the pool's observation buffer was too small to span the window, so a busy coin's `poke()` reverts `OLD` under a pump. The naive fix (cardinality 600) **blew Robinhood Chain's 2²⁴ (~16.7M) per-tx gas cap** and bricked `launch()`. | Seed a cap-safe **cardinality 200** (~20s buffer) in `seed()`, size the poke TWAP to **15s** (5s headroom), and expose a permissionless `CurvePool.growOracle(uint16)` passthrough so coins can ramp the buffer higher post-launch in many cheap txs. `launch()` stays comfortably under the per-tx gas cap. |
| PR-3 | Med | A buy that overshot the curve refunded the unconsumed WETH but still charged the swap fee on the **gross** `msg.value`, over-taxing the buyer on ETH that never entered the trade. | The fee is now charged on the **consumed** amount (fee-inclusive refund of the rest) whenever the buy partially fills; a fully-consumed buy is unchanged. Conservation still exact. Regression: `an overshoot buy is taxed only on what the curve absorbed (PR-3)` (fork). |
| B-6 | Med | At an extreme price a Bond band bound could exceed ±887200, reverting `getSqrtRatioAtTick`/`mint` and bricking `poke()`. | Band ticks are clamped to ±887200 via `_clamp` before use (`Bond`). |
| B-7 | Med | An empty/too-small Bounty or Ambush band reverted `"bad L"`, bricking the whole `poke()`. | `PoolMath.singleSidedLiquidityOrZero` returns 0 instead of reverting; `poke()` skips that placement and leaves the funds for the next one (`Bond` / `PoolMath`). |
| PR-6 | Med | `register` could be called again for a token that had already launched, silently overwriting its fee config. | `register` now reverts `AlreadySet` on a second call for the same token (`PadRouter`). Regression: unit test (PR-6). |
| PR-4 | Low | `claimDeferred` lacked `nonReentrant` (it does an external `curve.bond()` read before crediting escrow). Harmless under CEI but broke the "every entrypoint guarded" invariant. | Added `nonReentrant` (`PadRouter`). |
| PR-7 | Low | Ownership is load-bearing — the platform's immediate cut, the deferred 0.1%, and the $SHERIFF cut all pay out to `owner()`. `renounceOwnership()` would strand them forever. | `renounceOwnership()` is overridden to always revert; `Ownable2Step` transfer is still available (`PadRouter`). Regression: unit test (PR-7). |
| F-4 | Low | `LaunchToken.seedBlocklist` was `onlyFactory`, but `CurvePadFactory` exposed **no** way to call it — the anti-snipe sniper blocklist was dead code. | Added owner-only `CurvePadFactory.seedBlocklist(token, bots)` pass-through. Still add-only and auto-frozen when the window ends (can never block a normal holder's sell). |
| F-8 | Info | `DEVBUY_SPAN` comment said "~2%" but 600 ticks is ~6%. | Comment corrected (`CurvePadFactory`). |
| B-3 | Accepted | `poke()` centers bands on **spot** (not the TWAP mean), leaving a marginal within-band spot-manipulation surface. | Accepted and documented: bands never straddle spot, the effect is bounded to the small recycled balance at the 1% fee tier, and the floor-**draining** vector is fully closed by CP-1. Switching to mean-centering would risk band/price straddle given `MAX_DEV > BOUNTY_NEAR`. |

**Chain constraint discovered:** Robinhood Chain enforces a **per-transaction gas
cap of 2²⁴ = 16,777,216**. `launch()` does token + pool + curve seed + register in
one tx, so it must stay under this — the B-1 fix keeps the one-time oracle warm-up
(cardinality) small enough to fit, with `growOracle()` for anything beyond.

## Properties verified by the adversarial suite

- **No spoofed callback** — `uniswapV3SwapCallback` reverts unless mid-swap with the exact pool.
- **No reentrancy** — a hostile seller re-entering `buy`/`withdrawPlatform` on its ETH payout makes the whole trade revert; nothing is double-paid.
- **Exact accounting** — over a mixed run of buys and sells, `platform + dev + floor + burn` escrows equal the tax charged to the **wei** (from the contract's own events), and the platform never exceeds its 25%.
- **Conservation** — the router's ETH balance always equals the sum of what it owes (escrows), before and after burns and payouts. No ETH is created or stranded.
- **Degenerate inputs** — 0-value buy reverts (`Dust`); a fee that rounds to 0 still trades; a sell without approval reverts; an unknown token reverts (`Unknown`).
- **Payouts are safe** — flushers are no-ops when empty, can't double-spend, and the floor share stays escrowed (never lost) until the coin graduates and a Bond exists.
- **The tax is not dodgeable / not weaponizable** — the 4% cap and the platform's 25% are constants with no setter; a project can't crank or re-route the tax after launch.

## Randomized simulation battery (`test/padrouter.fuzz.test.js`)

A seeded, reproducible fuzzer hammers the swap desk + tax from many directions —
random tax rates (0–4%), random allocation splits, random pool prices, trade
sizes from **1 wei to a whole ETH**, random op ordering, interleaved flushers,
and **many coins live at once** — checking the master invariants after **every**
operation.

**Canonical run — `SIMS=300` — passed clean:**
- 300 trade simulations over **175 distinct coins**, **1,592 operations** (790
  buys, 426 sells, 200 flushes, 176 withdraws), **0 unexpected reverts**.
- Plus **400 registration-fuzz cases** (204 valid accepted, 196 correctly
  rejected on cap / allocation violations).
- Invariants asserted continuously:
  - **INV-1 conservation** — router ETH balance == `platformEscrow + sheriffBurnEscrow + Σ(deferred+dev+floor+burn)`, after all 1,592 ops. No wei ever created, leaked, or stranded.
  - **INV-2 exact split** — every trade's `fee == platform+dev+floor+burn` to the wei (from the contract's own events).
  - **INV-3 isolation** — a trade on one coin never moves another coin's escrows.
  - **INV-4 caps** — registration reverts iff tax > 4% or allocation ≠ 100%.

The suite defaults to a light `SIMS=50` for routine runs; the full 300-run is
`SIMS=300 npx hardhat test test/padrouter.fuzz.test.js`.

## Fee model (as of the creator-economics update)

Every coin pays a swap-desk fee of **1%–4% per side** (1% floor, 4% cap, enforced
at registration). The **default 1% base** is split by side:
- **Buy 1% → the platform** — **0.9% immediate**, **0.1% held until the coin
  graduates** then released to the platform (`claimDeferred`).
- **Sell 1% → the creator** — accrues to the project wallet's escrow and pays out
  via `withdrawDev`. (This is why registration now requires a non-zero project
  wallet on every coin — it always receives money.)
- Anything **above 1%** (either side) splits **25% → the platform's $SHERIFF cut**
  (accrued in `sheriffCutEscrow`, paid via `withdrawSheriffCut`, buy/burned
  off-chain) and **75% → the project** (wallet / Bond floor / auto-burn).

Rounding is exact: the default-1% base absorbs the remainder, so the pieces sum to
the fee **to the wei**. All shares accrue as escrow and pay out via separate
permissionless flushers, so the split can never revert a trade. Conservation
(`router ETH balance == Σ escrows`) holds after every op. Re-audited: unit +
adversarial + fuzz all pass under the split-by-side model.

## Perpetual liquidity — Sherwood fees compound forever

The Bond's Sherwood position is full-range locked LP. Its Uniswap **pool fees**
(the 1% fee tier it earns on every trade) are no longer swept out to the platform —
`poke()` now collects them into the Bond and **re-mints them straight back into the
Sherwood position**. The permanent, never-withdrawable liquidity therefore **grows
with every trade, forever**. Fees are usually two-sided (v3 takes the fee from the
input token, so buys and sells accrue opposite sides); any side left over after the
balanced full-range mint falls through to the Bounty/Ambush recenter, so nothing is
stranded. Nothing ever leaves the Bond to any wallet — the anti-rug property is
strengthened, not weakened. Fork-tested: `sherwoodL` strictly increases after
two-sided volume + a poke, and the platform's balances are provably unchanged.

## Graduation — "let it ride" + creator payouts

Graduation is no longer a fixed point — the curve spans start → a **ceiling**, with
a **minimum** graduation price partway up. `graduate()` is permissionless and
unlocks once price reaches the dev's target (default = the minimum); the later it
graduates, the **bigger the raise and thicker the floor**. At graduation the
still-unsold curve tokens are **rolled into the Bond** (Sherwood pairing + Ambush
sell-wall) rather than burned, and the Bond is posted around the **current** price.

Calibrated on the fork (`START_TICK_MAG = 196200`, `CURVE_WIDTH = 25800`,
`MIN_GRAD_WIDTH = 16400`): **minimum** graduation ≈ **$30k FDV / ~4 ETH raise**;
**ceiling** ≈ **$76k FDV / ~8.3 ETH raise** — so the floor is ~3 ETH at the minimum
and up to ~6 ETH if fully ridden. All three widths are deploy-time configurable.

- **Auto-graduate target** — `setGradTarget` lets the **dev** pick the graduation
  price in `[minimum, ceiling]`; a keeper/frontend fires the permissionless
  `graduate()` when price reaches it. A sniper can never graduate before the dev's
  mark; the dev can lower it (never below the minimum) to graduate sooner.
- **Creator reward** — 25% of the raise is paid to the dev at graduation (WETH),
  on top of the ongoing sell-tax.
- **Anti-manipulation (CP-1, evolved)** — instead of pinning graduation to a fixed
  tick, `graduate()` now refuses to post **above the ceiling** (the only unbacked
  zone). Inside the curve range, pushing price up costs real WETH that *joins* the
  floor, so a "high" graduation price is one the attacker funded and cannot drain.
  Fork-tested: shoving spot past the ceiling still reverts `NotReady`.

## Creator fee model + payouts (split by side)

- **Buy 1% → platform**; **Sell 1% → creator** (accrues to the project wallet).
- **Above-1% excess** → 25% platform ($SHERIFF cut) / 75% project (wallet/floor/burn).
- The creator can **collect** their escrow (`withdrawDev`, permissionless) **or burn
  it** (`burnDev`, creator-only — buys the coin and sends it to dead).

## Standing invariants (by construction, not just tests)

- **Token stays clean** — no transfer tax, no mint, no blacklist over sells, no pause, no owner. The anti-snipe guard is buy-side-only, auto-expiring, and immutable (`LaunchToken`).
- **The Bond can't be rugged** — no function sends its WETH/tokens to any address. Sherwood principal is never withdrawn and its fees are compounded back in; **nothing ever leaves the Bond to a wallet** (`Bond`).
- **Tax is a swap-desk fee, not a fee-on-transfer token** — so it can't break Uniswap v3 or read as a honeypot, and the split happens as escrow, never as extra transfers inside the signed trade.

## Deploy-time notes (not code bugs, but must be set right)

- The `PadRouter` **owner** (receives the platform's tax cut) and the factory
  **platform** (receives LP/graduation fees) should be the **same** platform
  wallet/multisig. `owner()` uses `Ownable2Step`.
- Re-run `test/fork/*` against the deployed addresses with a real archive
  `FORK_RPC` before flipping the front-end gates live.
- The floor share of a coin that **never graduates** stays escrowed in the router
  (safe, but idle). Acceptable; noted so it isn't a surprise.
