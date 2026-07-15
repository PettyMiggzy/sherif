# $SHERIFF Launchpad — Specification

A fair-launch **launchpad-for-many** on **Robinhood Chain** (Arbitrum Orbit L2, chainId 4663).
Any team launches a token that is **tradeable on Uniswap v3 + DexScreener-indexed day one**, with a
rule-bound treasury, automatic buy-and-burn, a 1% platform fee, and launch-time anti-snipe guards.

> ⚠️ **Not audited.** This is a reference implementation. Get a professional audit before mainnet
> value. Nothing here is financial or legal advice.

## Confirmed on-chain facts (verified this session)
| Thing | Value |
|---|---|
| Chain | Arbitrum Orbit L2, chainId **4663** |
| Mempool | **private, FCFS** → mempool sandwiching impossible; residual = latency snipers + Timeboost |
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` (blockscout-verified) — the factory DexScreener's `uniswap` dexId maps to |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Fee tier | **10000 (1%)**, tickSpacing **200** (what ape.store uses; parity = routers/DS already recognize it) |
| Periphery | **None usable.** Every SwapRouter/NonfungiblePositionManager found points to a *different* forked factory. → the launchpad depends on the factory + pool **only**, via callbacks. |
| DexScreener "Paid" | `GET api.dexscreener.com/orders/v1/robinhood/{token}` → `{type:"tokenProfile",status:"approved"}` |

## Design pillars
1. **Zero periphery dependency.** LP is added via direct `pool.mint()` (factory implements `uniswapV3MintCallback`); all swaps via direct `pool.swap()` (implement `uniswapV3SwapCallback`, validate `msg.sender == factory.getPool(...)`). No NonfungiblePositionManager, no SwapRouter — none exist for our factory.
2. **No TickMath / FullMath.** Milestone triggers use **tick-offset arithmetic** (a price multiple = a fixed tick delta, since `price = 1.0001^tick`). `launchTick` is read from `pool.slot0().tick` right after `initialize()`. Slippage bounds derive from `slot0.sqrtPriceX96` × constant tolerance. Only OZ `Math.mulDiv` / `Math.sqrt` are needed.
3. **Atomic launch.** Deploy token → create+init pool → grow oracle cardinality → mint+lock LP → fund vault → enable trading, all in one tx. No window to snipe, no separate "enable" tx.
4. **Clean ERC20.** No transfer tax (v3 forbids fee-on-transfer), no mint, no blacklist, no pausable transfers. The only token-level logic is an **auto-expiring, buy-side-only, revert-based** anti-snipe guard.
5. **Anti-rug by construction.** The 30% vault has **no** withdraw/sweep/owner-drain/setter. Sells are permissionless + TWAP-gated + tiny + capped. Buyback output is hard-wired to the burn address. LP is permanently locked (collect-only).

## Contracts
| Contract | Role |
|---|---|
| `LaunchpadFactory` | Factory-for-many. `launch()` does the atomic sequence; owns the LP mint callback; holds global config + 1% fee wiring; deploys per-launch `MilestoneVault`. |
| `LaunchToken` | Per-launch clean ERC20 + auto-expiring anti-snipe guard in `_update`. |
| `MilestoneVault` | Per-launch. Holds 30%. TWAP-gated tranche sells at 2x/3x/… Splits proceeds 50% dev / 50% buyback. Permissionless buy-and-burn. |
| `LiquidityLocker` | Immutable owner of every launch's v3 LP position. `collect`-only, **no** burn/decrease → liquidity locked forever, swap fees claimable to a fixed beneficiary. |
| `FeeRouter` | The **only** place the 1% platform fee exists. UI routes swaps here; skims 1% on the WETH leg. `pool.swap()` direct + callback validation. Immutable `FEE_BPS=100`, `MAX_FEE_BPS=100` (can never be raised). |

## Launch sequence — `LaunchpadFactory.launch(params) payable`
Reverts as a unit; partial launch impossible.
1. `token = new LaunchToken{salt}(...)` — full supply minted to the factory. (Per-call secret salt so the CREATE2 address isn't known ahead of time → no pre-init griefing.)
2. `treasury = supply*3000/10000`; `lpAmount = supply - treasury` (remainder-to-LP; 100% accounted).
3. `IWETH9(WETH).deposit{value: msg.value}()` (require `msg.value == params.seedEth`).
4. Order `(token0,token1,amt0,amt1)` by address; `sqrtPriceX96 = sqrt(mulDiv(amt1, 2**192, amt0))`.
5. `require(factory.getPool(token,WETH,10000) == 0)`; `pool = factory.createPool(...)`; `pool.initialize(sqrtPriceX96)`; `require(pool.slot0().sqrtPriceX96 == sqrtPriceX96)` (prove we set the price).
6. `launchTick = pool.slot0().tick` (anchor for milestones).
7. `pool.increaseObservationCardinalityNext(cardinalityNext)` (arm TWAP day one).
8. Deploy `MilestoneVault`; `token.transfer(vault, treasury)`; `vault.initialize(pool, launchTick, tokenIsToken0, multiples[], tranches[])`.
9. `L = getLiquidityForAmounts(sqrtPriceX96, MIN_SQRT_RATIO, MAX_SQRT_RATIO, amt0, amt1)`; `pool.mint(locker, MIN_TICK, MAX_TICK, L, cbData)` — factory's `uniswapV3MintCallback` pays owed token+WETH; position owned by `locker`; `locker.register(pool, feeBeneficiary)`.
9. Sweep dust: leftover token → vault, leftover WETH → dev.
10. `token.enableTrading(pool, block.timestamp)` — one-way latch; arms the anti-snipe window.

## MilestoneVault
- `launchTick`, `tokenIsToken0` fixed at init. Milestone `k` fires when the **arithmetic-mean TWAP tick** (window ≥ `MIN_TWAP_WINDOW` = 600s) crosses `launchTick ± tickOffset[k]` (`+` if `tokenIsToken0`, else `−`). `tickOffset` for a multiple `m` = `round(ln(m)/ln(1.0001))` — e.g. **2x=6932, 3x=10987, 4x=13864, 5x=16095, 10x=23027**.
- `poke()` — permissionless. Sequential (`nextMilestone++`), one per `COOLDOWN`, one-shot per k. Reads `observe()`; if the TWAP tick isn't past the threshold → no-op (fail-closed). **Then requires `|spotTick − meanTick| ≤ MAX_SPOT_DEVIATION_TICKS` (≈5%)** — this blocks an attacker who craters/pumps spot in-tx to sell the tranche off the manipulation-resistant TWAP price (audit H-1). The sell's `amountOutMinimum` is anchored to the **spot price** (now proven within 5% of the TWAP), not the stale launch price, and the `sqrtPriceLimitX96` is clamped inside the pool's absolute bounds. The swap must **fully fill** or it reverts (so `totalSold` can't overcount).
- `_splitProceeds(weth)` — `half = weth/2`; `WETH.transfer(dev, half)`; `buybackReserve += weth - half` (odd wei → burn side).
- `buyback(maxWeth, minTokensOut)` — **dev-gated** (the project dev triggers it, honoring the "dev can buy or burn" intent); spends ≤ `buybackReserve`, ≤ `BUYBACK_MAX_BPS` (25%) per call, ≥ `BUYBACK_COOLDOWN` (6h) apart; same spot-vs-TWAP deviation gate; `pool.swap()` WETH→token with `recipient = 0x…dEaD`. Tokens are **burned atomically**; reserve WETH can **never** reach an EOA (no withdraw path). Trade-off: a lost dev key means the reserve can only ever be burned by that key — an accepted consequence of dev-controlled buyback (can be made permissionless if preferred).
- **No** `withdraw`, `sweep`, `setThreshold`, `setTranche`, owner drain. Their absence is the anti-rug proof.
- Invariants: I1 each k once · I2 `totalSold ≤ allocation` · I3 sequential+monotone · I4 ≤1 per cooldown · I5 `wethBalance ≥ buybackReserve` · I6 reserve only exits via burn.

## Anti-snipe (LaunchToken `_update`)
Orbit note: uses **`block.timestamp`** (block.number tracks the parent L1 block on Orbit). All windows immutable, auto-expiring, **no owner extend**, **sells never blocked** (anti-honeypot).
- Exempt set: pool, factory, vault, locker (so LP add / treasury hold / routing never revert).
- Pre-enable: only exempt addresses can move tokens.
- `DEAD_SECS` (~2s): all **buys** revert.
- Phase 1 (→60s): `maxTx=0.5%`, `maxWallet=1%`, `cooldown=2s`/wallet (buys only).
- Phase 2 (→300s): `maxTx=1%`, `maxWallet=2%`, no cooldown.
- After `ANTISNIPE_SECS` (~300s): cheap short-circuit, permanently normal ERC20.
- `blocklist`: add-only, buy-side only, frozen after the window.
- All limits + expiry exposed via public views for scanners/UI.
- If Timeboost is enabled on 4663, the operator can additionally submit `launch()` via the express lane for the launch round; the dead window already makes winning the lane worthless.

## FeeRouter (1% platform fee)
- The launched token is tax-free; the fee lives **only** here. `FEE_BPS=100`, `MAX_FEE_BPS=100` immutable — no `setFee` exists.
- `buyExactInETH`: wrap msg.value, `fee = in*1%` (WETH), swap `(in-fee)` WETH→token, `require out ≥ minOut`, send token to user.
- `sellExactIn`: pull token, swap→WETH gross, `fee = gross*1%`, `net = gross-fee`, `require net ≥ minNet`, unwrap→ETH if asked.
- Fee is always on the **WETH leg**, never the token → v3 never breaks, "not a transfer tax" true by construction.
- `uniswapV3SwapCallback`: `require(msg.sender == factory.getPool(token0,token1,fee))` before paying — the core defense against fake-pool drains.
- `withdrawFees` → timelock/multisig (pull-over-push). Honest limit: raw-DEX/aggregator swaps pay 0% (unenforceable without breaking v3); capture = route all UI volume + vault sells + buybacks here.

## Roles / trust
- Immutable: fee rate, supply, 30% split, tranche sizes, milestone thresholds, TWAP window, locker (no-burn).
- Timelocked (48h) + evented: `feeRecipient`, narrow admin pause (admin/withdraw/new-launch **only** — never user trading).
- `Ownable2Step` + `AccessControl` (OPERATOR global, DEV per-token = buyback trigger only).
- UI must surface: LP-locked ✅, mint-renounced ✅, no-blacklist ✅, no-transfer-tax ✅, vault-rules-onchain ✅, DexScreener Paid ✅.

## BondingCurve + graduation event (`BondingCurve.sol`)
An optional **ape.store/pump.fun-style** front-end to the launchpad: price discovery on a simple
constant-product curve, then a **graduation event** into the locked-LP + (optional) milestone-vault
machinery above. Use this when you want a curve + graduation instead of DEX-day-one.

**Curve math.** Virtual reserves, constant product `K = VIRT_ETH * CURVE_SUPPLY`.
- Buy: `newReserveEth = reserveEth + net; newReserveToken = K / newReserveEth` (floor); `tokensOut = reserveToken - newReserveToken`.
- Sell: `newReserveToken = reserveToken + tokensIn; newReserveEth = ceilDiv(K, newReserveToken)` (ceil); `grossOut = reserveEth - newReserveEth`.
- 1% platform fee on both sides (**pull-over-push** via `withdrawFees` — a reverting platform can't brick trading). `raised() = reserveEth - VIRT_ETH`.
- **Load-bearing invariant J:** `reserveEth ≤ ceilDiv(K, reserveToken)` after every op → no round-trip/sequence profit, curve always solvent.

**Graduation event.** When `raised() ≥ GRAD_TARGET`: seed a Uniswap v3 pool at the curve's **exact final
marginal price** (`tokensToLp = raised·reserveToken/reserveEth`, so `ethToLp/tokensToLp = reserveEth/reserveToken`),
**burn** the unsold remainder (deflationary; no below-price dump), permanently **lock the LP** in a
LiquidityLocker the curve owns, and disable curve trading. Price is **continuous by construction** (no step).

**Simulations (`npm run sim`).** A BigInt reference model mirrors the contract exactly; a Hardhat test
asserts the deployed bytecode equals the model op-for-op. Latest run:
- ~240,000 randomized ops across 4,000 curves · 20,000 round-trip trials · 3,000 graduations — **0 invariant violations**.
- Graduation price step: **median/best/worst = 100%** (perfectly continuous).
- Verified: no value leak, no round-trip profit, `balance == raised`, supply conserved, one-shot graduation.

**Curve audit (3 lenses) — findings fixed:**
- **Graduation brick via pre-initialized pool (HIGH):** `initialize` guarded; if the pool is pre-inited we
  require it match our price (prevents minting into a manipulated pool = theft). A wrong-price pre-init
  reverts graduation (griefing DoS, **funds stay exitable via `sell()`**). ⚠️ **Production must deploy
  token+curve atomically** (fresh token ⇒ fresh pool, no pre-init window) to close the DoS — like the
  atomic `LaunchpadFactory`.
- **Graduation brick via force-fed ETH (HIGH):** LP is seeded from `raised()` (accounting), not
  `address(this).balance`, + a `Math.min` clamp → force-donated ETH can't underflow the burn.
- **Malicious-platform trading DoS (MED):** fees are pull-over-push (`feesEth` + `withdrawFees`).
- **`sell` zero-output / oversell (LOW):** revert on `grossOut==0`; `require(reserveToken+tokensIn ≤ CURVE_SUPPLY)`.
- **Anti-snipe is weak (LOW, documented):** the per-tx `maxBuyWei` cap is easily split across txs/wallets on
  an FCFS chain — it is NOT strong sniper protection. The strong path is the **atomic `LaunchpadFactory`**.

## Curve launchpad tokenomics (`CurveLaunchFactory` + `OtcVault`)
The productized bonding-curve flow the platform launches other tokens through.

**Fixed, oracle-free pad terms (identical for every launch — projects only pick name / ticker / dev):**
| Term | Value |
|---|---|
| Total supply | **1,000,000,000** (fixed) |
| Split | **80% bonding curve · 20% OTC vault** |
| Start price | `VIRT_ETH = 0.8 ETH` → **start MC = 1 ETH (~$3k)**, no oracle |
| Graduation | when the curve collects **4 ETH** |
| Anti-snipe | 0.1-ETH per-buy cap for the first 5 min |
| OTC price | fixed at **~$10k MC** (`otcPrice = 3.33e9` WETH-wei / 1e18 token), oracle-free |
| OTC access | **burn $SHERIFF** → per-wallet cap = `burned × 100` tokens |

Trajectory (assume ETH=$3k): launch $3k → graduates at 4 ETH raised. `CurveLaunchFactory.launch({name,
symbol, dev})` is the whole interface.

**Per launch, the supply splits:** **20% → `OtcVault`** (platform OTC desk) · **80% → `BondingCurve`**.
The curve trades + charts day one and **graduates** to a locked Uniswap pool (see above). The 80% is
sold along the curve / seeded into the LP; the 20% is the platform's OTC allocation.

**`OtcVault` — burn-$SHERIFF-for-access OTC desk (activates after graduation):**
- Holds the 20%. After graduation, `activate()` (permissionless) binds the curve's own graduated pool.
- The window **opens** once the pool's **30-min TWAP price** reaches the fixed OTC price (~$10k MC) — a
  tick-space check, so **no oracle / no price feed**. Once open, buyers get the token **at that fixed $10k
  price no matter how high the market has actually run** — a real discount when the token has mooned.
- **Access is earned by burning $SHERIFF.** `buyOtc(sheriffBurn, tokenAmount)` sends `sheriffBurn` $SHERIFF
  to `0x…dEaD` and unlocks a per-wallet allowance of `burned × burnRatio` tokens (`burnRatio = 100` tokens
  per $SHERIFF, tunable). Bigger burn → bigger cap. The buyer pays `tokenAmount × otcPrice` in ETH; **100%
  of that ETH goes straight to the platform wallet**; overpay is refunded.
- **Two jobs at once:** a discretionary platform revenue stream *and* a permanent **$SHERIFF burn sink** that
  every OTC buyer is forced through — deflationary for $SHERIFF, which benefits every holder.
- **Anti-rug:** no path to withdraw the 20% token allocation for ETH into an EOA other than the OTC sale
  itself, and OTC ETH is hard-wired to the platform wallet. No owner drain / setter.

**Economics (`sim/otc-sim.mjs`):** full sell-out of the 20% at the $10k OTC price = **0.666 ETH/project
(~$2k)** to the platform. Across a portfolio (grad ~55%, of those ~70% open, partial clear) it averages
**~0.16 ETH/launch** — e.g. **~159 ETH (~$476k) over 1,000 launches**, plus ~0.5B $SHERIFF burned. OTC is
the *upside* stream; the steady revenue is the **1% buy fee** (0.9% streamed live) **+ LP swap fees**, which
scale with volume on every launch, graduated or not.

**Curve-launchpad audit (2 lenses) — findings fixed:**
- **Graduation brick via pool pre-init (HIGH):** the curve now **creates + initializes its Uniswap pool at
  launch** (at the deterministic graduation price), so no third party can pre-initialize it during the
  bonding phase to brick graduation. A griefer can't `createPool` (it exists) or re-`initialize` it.
- **Graduation price continuity (kept 100%):** the graduating buy is **capped to land exactly on
  `GRAD_TARGET`** (excess refunded), so graduation seeds the pool at exactly the committed price — sim
  confirms **100% continuous** (median/best/worst). The TWAP is armed (`increaseObservationCardinalityNext`)
  at graduation, which the OtcVault's open-trigger reads.
- **`OtcVault.activate()` binding (MEDIUM):** closed by the above — the pool bound is always the curve's own
  correctly-priced graduated pool (validated: exists + initialized). Activating before graduation reverts
  (`NoPool`); the window itself only opens once the TWAP clears the OTC price.
- **OTC open-trigger manipulation (defended):** the open gate is a **30-min TWAP** tick check
  (`PoolMath.twapPriceWethPerToken`), not spot — a flash pump can't force the window open at the fixed price.
- **Fixed-price ETH accounting:** `cost = tokenAmount × otcPrice / 1e18` (OZ `mulDiv`), ETH pushed to the
  platform via `.call` with an overpay refund; `nonReentrant` on `buyOtc`; per-wallet allowance is
  monotonic (`purchased` only grows) so the burn→allowance→buy path can't be replayed for free.
- Confirmed sound: allowance math (`burned × burnRatio − purchased`, no underflow), $SHERIFF burn is a real
  transfer to `0x…dEaD`, no path to withdraw the 20% token allocation except the OTC sale, OTC ETH is
  hard-wired to the platform wallet, `tokenIsToken0` direction correct both orderings.

## Internal adversarial review (not a substitute for a professional audit)
A 5-lens adversarial audit (reentrancy/callbacks, oracle/economics, access-control/rug, v3-integration,
arithmetic) was run against this code. The **core anti-rug guarantees were confirmed to hold** (no drain
path for the vault, reserve, LP, or fees; burn-proof locker; honeypot-immune token; correct v3 directions
and tick math). Findings addressed:
- **H-1 (high):** milestone sells were bounded by a stale launch price + manipulable spot → an attacker
  could crater spot in-tx, pass the lagging TWAP gate, and buy the tranche cheap. **Fixed** with a
  spot-vs-TWAP deviation gate (`MAX_SPOT_DEVIATION_TICKS`) + spot-anchored `minOut` + full-fill check.
- **M-1:** no minimum observation cardinality → TWAP could degrade toward spot. **Fixed** with
  `MIN_CARDINALITY` at launch + `MIN_TWAP_WINDOW` in the vault (size cardinality for real block time).
- **Arithmetic:** `quoteWethPerToken` could overflow (high price) or round to 0 (cheap meme) → **Fixed**
  (staged mulDiv, no full-square) + `launchPrice != 0` guard.
- **v3:** exact TickMath sqrt-ratio constants; price-range guard tightened to the position bounds; swap
  price limits clamped inside `MIN/MAX_SQRT_RATIO`.
- **FeeRouter:** refund WETH unspent on a partial-fill buy.
- **F5:** `seedBlocklist` now reachable via `LaunchpadFactory.blocklistBots` (operator-only, window-gated).

## Must-confirm before mainnet deploy
- Timeboost enabled on 4663? (sizes the launch-window params; if yes atomic launch is mandatory).
- `factory.feeAmountTickSpacing(10000) == 200` enabled (ape.store implies yes — assert at deploy).
- Robinhood Chain block time (sizes cardinality for a real 30-min TWAP window).
- Native gas token is ETH and `IWETH9(WETH).deposit` is the correct wrap (standard for Orbit-with-ETH).
- Owner sign-off: milestone schedule + tranche sizes, the dev/project payout address, feeRecipient custodian (multisig→timelock), whether `buyback()` is permissionless or DEV-gated.
