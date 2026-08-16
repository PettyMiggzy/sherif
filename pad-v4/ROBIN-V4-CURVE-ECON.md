# Robin V4 curve pad — economics & invariants (audit brief)

A free, single-sided bonding-curve launchpad ("pad of pads") on Uniswap v4 for Robinhood Chain
(chainId 4663 mainnet / 46630 testnet). One launch tx, **no ETH seed**, **no dev mint**. This brief maps the
money flows and the invariant each contract upholds, for an external audit. solc 0.8.26 (checked arithmetic,
viaIR, cancun); OZ ReentrancyGuard / SafeERC20 / Clones / Math.mulDiv; Uniswap v4 (PoolManager singleton, unlock
callback, BalanceDelta). currency0 = native ETH (address 0); currency1 = the pad token.

## 1. Contracts & roles

| Contract | Role |
|---|---|
| `RobinV4FeeConfig` | Governed DEFAULT launch params, stamped IMMUTABLY per-pad at launch. Owner (Ownable2Step, renounce-disabled) can retune FUTURE launches only; hard caps bound any retune. |
| `CurvePadFactoryV4` | One-tx launch: deploy token (supply → factory), mine+deploy the fee hook, init the pool at the curve top, stamp the immutable per-pad fee config, deploy the per-pad `RobinCurveV4`, seed the single-sided curve. Enforces **no-dev-mint** and the reserve invariant. |
| `RobinCurveV4` | Per-pad curve controller. Holds the sellable curve position + the held-back reserve; runs graduation. |
| `RobinFeeHook` | Directional trade-tax engine + buy-tax buffer split. Accrue-and-pull books. |
| `RobinLockStaking` | Holder staking: monthly lock, drip rewards from a finite reservoir, 10% self-filling early-exit penalty. |
| `RobinAmbushVault` | Two-sided passive ETH-seeded support band (buys dips / sells rips), armed at graduation with 5% of the raise. |
| `RobinFloorVault` | Permanent, add-only ETH price floor, fed by the sell-tax floor slice + ambush ETH LP fees (the buy-LP carve is 0). Token-side fees park in-vault → forwarded to the token treasury. |
| `RobinTokenTreasury` | Per-pad token-fee sink: splits every TOKEN-side LP fee 70% staking / 30% public burn reserve; the creator burns the reserve to `0x…dEaD` when they choose. No withdraw path — keeps the platform ETH-only. |
| `PresaleVault` / `PresaleVaultFactory` | Optional trustless refundable presale (clone-per-presale). Consumes only the factory's public interface — changes nothing in the audited curve suite. |
| `LockVault` | Holds the permanent graduation LP NFT forever (sole registrar = the factory). |

## 2. Economic parameters (governed defaults)

- **Geometry (V3-ported, proven):** `startTickMag 201600`, `curveWidth 23000` (≈10× chart), `minGradWidth 22800`, tickSpacing **100**. 1B supply @ **73% curve / 27% reserve** → start MC ~$3.34k, graduate MC ~$33.3k, **~4.1 ETH raised** (see `test/sim/curve.calibration.sim.test.js`, measured on the V4 curve).
- **No dev mint:** `supply == curveSupply + reserveSupply` EXACTLY (factory reverts `BadConfig` otherwise). The creator receives **zero** tokens at launch — they buy from the curve like everyone else. No premine, no pre-bought bag.
- **Both taxes are MONEY-SIDE (currency0: ETH on a curve/ETH pad, the stock ERC20 on a stock pad) — never the pad coin.**
- **Buy tax 1%** taken **FEE-ON-INPUT** in `beforeSwap` (a slice of the ETH the buyer spends, before the pool swaps the rest): `buyBufferShareBps` = 20% → **0.2% curve buffer** (held as ETH by the curve through the curve phase → **platform at graduation**); `referralShareBps` = 25% of the platform cut → **0.2% referrer** (only when a ref link is passed in swap `hookData`; carved from the platform, never the trader); remainder → **platform** (0.8%, or 0.6% when a referral is present).
- **Sell tax 1%** (of the ETH output leg) in `afterSwap`: `sellFloorShareBps` = 20% → **0.2% floor** / remainder → **0.8% creator**. This sell-tax floor slice (+ the ambush vault's forwarded ETH LP fees) is now the deep floor's ONLY funding, since the buy-LP carve to the floor is 0 (see LP fee below).
- **Pool LP fee:** 1% static. **[fee-model] ETH (buy) LP fee → 100% platform** (`buyLpFloorShareBps = 0` default): the platform keeps all ETH-side LP fees. **TOKEN (sell) LP fee → `RobinTokenTreasury` (70% staking / 30% creator-burn)** — `distribute()` forwards 70% to the staking pool and retains 30% as a public burn reserve the **creator** burns (to `0x…dEaD`). **[F3] Scope: the 70/30 applies to POST-GRADUATION token LP fees only** — the `LockVault` sell-leg + `RobinFloorVault` + `RobinAmbushVault` route to the treasury. The **curve-phase** token fees are small, held on the curve, and swept **with the reserve to 100% staking at graduation** (`curve.staking` **must** be the pool — `setStaking` reverts `StakingAssetMismatch` on a non-pool sink, so it can never be the treasury). They do NOT go through the 70/30 split. The platform holds no pad token on any of these paths.
- **Graduation waterfall** (bps of the raise, after the keeper bounty): platform **10%** / creator **10%** / ambush **5%** / **LP = the ~75% remainder** (config enforces platform+creator+ambush < 100% ⇒ LP strictly positive). The ETH buffer accrued over the curve phase is added to the platform book at graduation (on top of the 10% platform waterfall slice) and is excluded from the measured raise.
- **Auto-graduation keeper bounty:** `min(0.2% of raise, 0.02 ETH)`, carved OFF THE TOP, paid to whoever triggers `graduate()` — so graduation is automatic (any keeper is incentivized) with the gas paid from the curve ETH. Flat bps (not `tx.gasprice`-based ⇒ not gameable); paid LAST; `gasBountyOwed`/`claimGasBounty` on send-failure.
- **Staking:** 30-day lock; rewards drip over a 30-day window at a bounded rate (Synthetix `rewardRate`); 10% early-exit penalty recycled into the reservoir. Hard caps: MAX_TAX_BPS 200, MAX_FLOOR_SHARE_BPS 5000, MAX_BUFFER_SHARE_BPS 5000, MAX_GRAD_SHARE_BPS 2500.

## 3. Lifecycle

1. **Launch** (`factory.launch`): token minted to factory; hook mined (flags 0x00CC) + deployed; pool initialized at `startTick` (100% token, no ETH); immutable fee config stamped on the hook; curve deployed; `curveSupply` transferred + `seed()` (single-sided token-only range `[gradTick, startTick]`); `reserveSupply` transferred to the curve (held, never sellable); hook buffer recipient wired to the curve. Factory holds 0 token after (no remainder).
2. **Curve phase:** buyers (`zeroForOne`, ETH-in) walk the tick DOWN from `startTick` toward `gradTick`; ETH accrues as the raise. Hook takes the buy tax **fee-on-input (ETH)** → buffer + referral + platform books; sell tax (ETH output) → creator + floor books; pool LP fees realized by `collectFees` → curve books (buy ETH fee **100% platform** by default, `buyLpFloorShareBps=0`; sell token fee → held for staking). `restoreCeiling` recovers from a griefer planting liquidity below `gradTick`.
3. **Graduation** (`graduate()`, permissionless; `ready()` when spot ≤ `gradTick`): pull the ETH buffer from the hook **before** the raise is measured (so it is excluded from the raise and later swept to the platform book); nudge spot back to the exact ceiling if a buy overshot; pull the raise; carve the keeper bounty; run the waterfall on the remainder; mint the PERMANENT LOCKED full-range LP from (lpEth + reserve) → `LockVault`; stream leftover reserve tokens → staking (`fundTokenPushed`); sweep floor + ambush shares; sweep all remaining unbooked ETH (buffer + donations) → platform; pay the bounty last.
4. **Post-graduation:** the ambush vault is seeded (single-sided ETH band above `gradTick`); lock-staking drips the streamed reserve to stakers; the permanent LP + floor + ambush provide liquidity/support forever.

## 4. Accounting (accrue-and-pull books — never inline-send, so a bad recipient can't brick trading/graduation)

- **Hook:** `platformOwed[id][cur]`, `creatorOwed[id][cur]`, `floorOwed[id][cur]`, `bufferOwed[id]`, `referralOwed[referrer][quote]`. All live entries are money-side (`cur == 0`). Conservation: every taxed leg books to exactly these with sub-splits summing to the take (subtraction conserves dust into the platform/creator cut).
- **Curve:** `platformEthOwed`, `floorEthOwed`, `creatorEthOwed`, `ambushEthOwed`, `gasBountyOwed[keeper]`. Graduation step-9 sweeps unbooked ETH to platform *minus* the reserved bounty; each book is claimable/flushable + retriable (re-parks on a failed send).
- **Staking:** invariant `token.balanceOf(this) == totalStaked + rewardsBalance`, upheld across stake / withdraw / getReward / exit / fund / fundTokenPushed / penalty-recycle. Total earned across all stakers ≤ funded (bounded drip). Rewards funded while nobody is staked are parked (`pendingRewards`), never wasted.
- **Presale:** `address(this).balance == totalRaised` until finalize spends `pooledEthSpent`; refunds/claims never exceed it; ETH leaves only as the pooled curve buy or a refund/claim to the depositor (never to the creator).

## 5. Key invariants

- **No-mint:** factory holds 0 token post-launch; creator premine = 0.
- **Platform is ETH-only — never holds pad tokens:** every platform inflow is money-side (currency0/ETH). Buy tax, buffer, referral, the graduation waterfall, and 100% of the ETH LP fee are all ETH. Token-side (currency1) LP fees route to the per-pad `RobinTokenTreasury`, which splits them **70% staking / 30% creator-burn** — never the platform treasury key. Sources into it: `LockVault`'s token leg (parks in `stakingOwed`, reverts rather than falling back to platform per [M-11], recipient = treasury); the `RobinFloorVault` position (holds token once spot trades into its band; parks its token-side fees in-vault and forwards via `sweepTokenFees()` to `tokenSink` = treasury); the ambush vault's token leg. The graduation leftover-reserve dump stays 100% staking (unsold supply → holder rewards, not an LP fee). Invariant tests: `RobinFloorVault.test.js` asserts the treasury key's token balance is *exactly* unchanged across a fee collection; `RobinTokenTreasury.test.js` asserts the 70/30 split, creator-only burn, and no-withdraw shape.
- **LP never starved:** waterfall shares < 100% ⇒ `lpEth > 0`; the permanent LP NFT → `LockVault`, no remove path.
- **Reserve suffices:** launch-time check `reserveSupply·√start·100 ≥ curveSupply·√grad·105` ⇒ the ETH leg binds at graduation (no `InsufficientReserve` brick, no ETH leak to the platform book).
- **Graduation is CEI + unbrickable:** `graduated=true` before any external interaction; every fund-out is retriable/parked; a hostile ETH donation is snapshotted out of the raise.
- **Add-only support:** floor + ambush have NO remove/withdraw/burn path — their principal can only ever leave by TRADING at the AMM's marginal price (round-tripping is a loss to an attacker ⇒ sandwich-proof, un-drainable). Ambush anchor read from `curve.gradTick()` on-chain (never a deploy param / live spot).
- **Immutable per-pad economics:** every param stamped at launch from the governed defaults; a live pad's fee/geometry can never change. Retuning `RobinV4FeeConfig` affects FUTURE launches only.
- **Trustless presale:** commit-reveal salts make the freshly-launched pool un-front-runnable; `FINALIZE_GRACE` escape hatch guarantees ETH is never trapped; `claimTo`/`refundTo` mirror each other so a no-receive contract contributor is always made whole.

## 6. Privileged actions (trust model)

- **FeeConfig owner** (platform multisig, Ownable2Step): retune FUTURE-launch defaults within hard caps. Cannot touch live pads.
- **Platform fee wallet** (registry, 2-day timelock): one-shot `setStaking` / `setFloor` / `setAmbush` per curve, and `setFloorRecipient` on the hook. These choose WHERE a cut is routed, never whether funds can be extracted; targets must be contracts. `setBufferRecipient` is factory-only (launch tx). A compromised platform wallet can mis-route the platform's OWN cut, but cannot pull user principal, the locked LP, or the add-only floor/ambush.
- **Everything else is permissionless:** buy/sell/airdrop, `graduate`, `collectFees`, `claim*`/`flush*`, `stake`/`withdraw`/`getReward`, `seedAmbush`, presale `deposit`/`finalize`/`fail`/`refund`/`claim`.

## 7. Accepted risks / non-goals

- Ambush impermanent loss in a sustained downtrend (by design — softens dips, not a guaranteed floor; the hard floor is `RobinFloorVault`).
- Post-graduation the hook keeps taxing buys: the platform cut stays claimable via `hook.claimPlatform` and the referral cut via `hook.claimReferral`; the small buffer share (`bufferOwed`) continues to accrue in ETH and is swept to the curve by `claimBuffer` (a benign, non-security surplus).
- Stock-quoted pads (ERC20 quote) are out of scope for this ETH-native iteration.
- Tokenized-stock (RWA) rewards are regulated securities — opt-in, geo/KYC-gated, non-US only (a separate, legally-gated path; not part of this curve suite).

## 8. Test coverage (hardhat, all green)

Unit: FeeConfig caps, curve seed/buy/collect/graduation-waterfall/bounty/grief-recovery/capped-grad, hook skim/buffer split, lock-staking drip/lock/penalty/anti-drain, ambush geometry/seed/park/dip-rip/non-bricking, presale bounds/deposit/finalize/claim/refund/escape-hatch/refundTo.
Sims: full lifecycle no-bot-protection + no-crazy-slippage + graduation conservation + fee conservation + RWA-staking; lock-staking fed by graduation; presale launch+pooled-buy; **production-geometry calibration** (start ~$3.4k / grad ~$34k / 4.2 ETH / 10×).
Fork (needs FORK_RPC): launch → sellout → graduate against the live v4 PoolManager + PositionManager.
