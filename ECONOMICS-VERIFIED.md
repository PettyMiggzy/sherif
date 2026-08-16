# Robin Labs — Verified Economics Reference (single source of truth)

Every value below was extracted directly from the committed contracts and adversarially re-verified
(18-agent `econ-truth-reconcile` pass, 2026-08-15). **Where any other doc disagrees with this file, this file
wins.** Citations are `file:line`. Public repo of record: `https://github.com/Robinlabz/Labs`.

**Configurability legend**
- **[FIXED]** — protocol-fixed compile-time `constant`; cannot change without redeploy.
- **[OWNER]** — owner-tunable at runtime via an Ownable2Step config/setter; no redeploy.
- **[LAUNCH]** — chosen per launch by the dev (launch params), bounded by on-chain caps.
- **[LAUNCH→FROZEN]** (v4) — stamped immutably onto the pad at launch from config defaults; the owner can retune
  the *defaults* for *future* launches only.
- **[FACTORY]** — immutable per factory deployment (TEST vs PROD), not per launch.

Two distinct swap desks exist and must never be conflated: **PadRouter** (per-launch pad coins) and **RobinSwap**
(external tokens, `RobinSwapFeeConfig`). All pad taxes are swap-DESK fees escrowed and paid out by permissionless
flush/withdraw calls **outside** the trade path — they never revert a trade and are **not** ERC-20 fee-on-transfer.

---

## PART 1 — v3 LIVE (`launchpad/contracts/`)

### 1.1 Supply allocation (per launch)
- Total supply **1,000,000,000 ×1e18** [FIXED] — `CurvePadFactory.sol:60`
- **Ambush (Bond) reserve 25%** (AMBUSH_BPS=2500) / **curve seed 75%** [FIXED] — `CurvePadFactory.sol:42,148-149`
- Treasury/platform supply cut: **0** (entire supply → curve deployer) [FIXED] — `CurvePadFactory.sol:171-176`
- Dev opening buy: uncapped by supply, bounded by the graduation ceiling tick + ETH sent (excess refunded) — `CurvePadFactory.sol:200-202`
- Curve geometry (START_TICK_MAG / CURVE_WIDTH / MIN_GRAD_WIDTH): per-factory immutable [FACTORY]

### 1.2 LaunchToken — transfer tax & anti-snipe
> **Product stance: anti-snipe is being RETIRED ("bots are traders too" — fair launch, no guards). v4 already has
> NONE (`PadToken` is a plain immutable ERC20). The window below is what the deployed v3 factory bakes in; it stays
> on existing v3 coins (immutable) and is dropped for new v3 launches by zeroing the params + redeploying the factory.**
- **Transfer tax = 0.** No mint, no sell-blacklist, no pausable transfers — `LaunchToken.sol:8-10`
- Anti-snipe = auto-expiring, **buy-side-only, revert-based** guard [FIXED] — `CurvePadFactory.sol:151-160`, enforced `LaunchToken.sol:170-181`:
  - dead window `deadSecs=2s` (buys revert) · phase1 `60s`: maxTx **0.5%** / maxWallet **1%** / 2s cooldown ·
    phase2 until `300s`: maxTx **1%** / maxWallet **2%** · then permanently normal. Blocklist add-only, buy-side, frozen after the window.
  - NOTE: it is a **%-of-supply maxTx/maxWallet schedule**, NOT an ETH-denominated per-buy cap.

### 1.3 PadRouter per-launch trade tax — band & caps
- Per-side **hard cap 4%** (MAX_TAX_BPS=400) and **minimum floor 1%** (DEFAULT_FEE_BPS=100) [FIXED] — `PadRouter.sol:54-55`
- `buyBps`/`sellBps` must be ≥100 and ≤400 (one check gates both) [FIXED rule] — `PadRouter.sol:201-203`
- The chosen buyBps/sellBps are **[LAUNCH]** — `CurvePadFactory.sol:83,184-186`

### 1.4 PadRouter — LEGACY default split (active only while `feeConfig == address(0)`)
- **Base 1% — BUY side is the PLATFORM's:** 0.9% immediate → platformEscrow, 0.1% deferred → deferredEscrow, released to platform at graduation [FIXED] — `PadRouter.sol:56-57,418-422`
- **Base 1% — SELL side is the CREATOR's:** → devEscrow → projectWallet (withdrawDev) [FIXED rule] — `PadRouter.sol:413-416,468`
- **Above-1% excess → 25% platform buy-back cut** (EXCESS_PLATFORM_BPS=2500, both sides) → platformCutEscrow → owner(); **remaining 75% is the project's**, split wallet/floor/burn [FIXED] — `PadRouter.sol:58,431-437`
  - walletBps → devEscrow → projectWallet (or creator-only `burnDev` buy-and-burns) [LAUNCH] — `PadRouter.sol:435-438`
  - floorBps → floorEscrow → `flushFloor` deposits WETH into the coin's Bond as Bounty depth (no-op pre-grad) [LAUNCH] — `PadRouter.sol:437,440,504-506`
  - burnBps → burnEscrow → **`flushBurn` buys the token with the escrowed ETH and sends the bought tokens to `0x…dEaD`** (a buy-and-burn, not a token skim) [LAUNCH] — `PadRouter.sol:436,439,560-561`
  - walletBps + floorBps + burnBps must == 10000; projectWallet != 0 [FIXED rule] — `PadRouter.sol:204-206`
  - Burn address `0x…dEaD` [FIXED] — `PadRouter.sol:66,485,561`

### 1.5 PadRouter — CONFIGURABLE swap-desk split (active when owner wires `setFeeConfig`)
When `feeConfig` is set, **every** trade splits per FeeConfig.swapSplit() and the per-launch wallet/floor/burn is **ignored** (`PadRouter.sol:380-402`):
- **swapPlatformBps 4500 (45%) / swapCreatorBps 4500 (45%) / swapFloorBps 1000 (10%)** [OWNER], must sum to 10000 — `FeeConfig.sol:23-25,32-34,46`

### 1.6 PadRouter — additive reward legs (on top of the tax)
- **+0.25% buy** (REWARD_BUY_BPS=25) → RewardVault trader pool; **+0.25% sell** (REWARD_SELL_BPS=25) → holder pool [FIXED] — `PadRouter.sol:62-63,217`
- OFF entirely until `rewardVault` is set; on vault failure falls back to floorEscrow, never reverts the trade [OWNER toggle]

### 1.7 LP-fee split (Uniswap 1% tier, from FeeConfig)
- **lpCreatorBps default 1000 → 10% creator / 90% platform** [OWNER]; hard cap LP_CREATOR_MAX=5000 (platform always ≥50%) [FIXED cap] — `FeeConfig.sol:19-20,31,39`; payout `CurvePool.sol:226,228,236-238`

### 1.8 Graduation payout + Bond seeding (CurvePool / Bond)
- **Trigger: ceiling-only** — `ready()` true when pool tick reaches gradTick; no timeout, no early grad, no creator target [FIXED] — `CurvePool.sol:248-252`; gradTarget pinned to gradTick, no setter — `:137,143`
- Approx raise at graduation **~4.2 ETH** (full ceiling) — `CurvePool.sol:64-66`
- Above-ceiling anti-grief: if spot > gradTick + GRAD_MAX_DEV (50 ticks), graduate() sells back to the ceiling first; else revert NotReady — `CurvePool.sol:266-288`
- **Graduation reward: 0.5 WETH EACH to creator AND platform** (GRAD_REWARD=0.5 ether), each capped at `raisedWeth/4`, so together ≤ half the raise; the Bond floor keeps ≥50% [FIXED] — `CurvePool.sol:66,314-319`
- Bond seeding of the post-reward raise:
  - **Sherwood (full-range LP): 60%** WETH (SHERWOOD_WETH_BPS=6000), paired with pool token; principal never withdrawn [FIXED] — `CurvePool.sol:62,325,334,352`, `Bond.sol:114-120`
  - **Bounty (WETH buy wall): remaining 40%** single-sided just below price (~0% to −49%) [FIXED] — `CurvePool.sol:326`, `Bond.sol:35-36,125,180-193`
  - **Ambush (token sell wall):** whole leftover token balance, single-sided high above price (~3× to ~24.5×) [FIXED] — `CurvePool.sol:331,340,352`, `Bond.sol:37-38,126,195-205`
  - Unsold curve tokens roll INTO the Bond (not burned); WETH dust → platform; token dust only inflates the Ambush wall — `CurvePool.sol:305-307,327-331,351,354-356`
- graduate() is permissionless; recipients (dev/platform/bond) immutable, caller cannot redirect. Bond has no owner/setter/drain — nothing leaves it to a wallet after posting.
- Fixed grad constants: GRAD_REWARD=0.5 ether, SHERWOOD_WETH_BPS=6000, GRAD_MAX_DEV=50, POOL_FEE=10000 (1% tier), SPACING=200; Bond TWAP 15s / MAX_DEV=300.

### 1.9 FloorCoop staking (all-FIXED, not per-launch, not owner-tunable)
- Deposit (open) fee **10%** (OPEN_FEE_BPS=1000) → protocolWeth — `FloorCoop.sol:51,215-217`
- Protocol cut of trading fees **5%** (FEE_CUT_BPS=500); remaining 95% to stakers by weight — `:52,411-414`
- Lock terms **30/60/90/365 days or forever**; reward-weight **1.0× / 1.25× / 1.5× / 2× / 3×** — `:562-568`
- Early-exit penalty base **15%** (EARLY_PENALTY_BPS=1500) **scaled by lock multiplier** → 15% / 18.75% / 22.5% / 30% / 45% → protocol; none after unlock — `:53,304-308`
- Zap: net single-side WETH → swap half to token (TWAP-bounded) → mint full-range; NAV shares. Guards MAX_DEV=300, TWAP 300s/30s. Permissionless, one vault/token, binds deepest WETH pool — `FloorCoopFactory.sol:50-55`, `FloorCoop.sol:170-186`

### 1.10 RewardVault
- Funded by the two +0.25% legs (buy→trader pot, sell→holder pot), raw ETH per (coin,epoch) — `RewardVault.sol:16-18,139-147`
- Per-(coin,epoch,side) uint128 cap; claims can never exceed accrued; no cross-coin/side/protocol theft [FIXED] — `:210-217`
- Claim by Merkle (one root/epoch; leaf binds epoch,coin,side,user,amount); unclaimed remainder swept to the coin's own Bond floor via `router.donateFloor`, never protocol — `:190-203,249-252`

### 1.11 PlatformFeeSplitter (built but DORMANT)
- `robinShareBps` ships **0** (no diversion → 100% platformTreasury); setter cap ≤10000, wraps only the PLATFORM leg — `PlatformFeeSplitter.sol:15,40-41,60`

### 1.12 RobinSwap external-token desk — SEPARATE from the pad tax
- Per-side total default **1.25%** (buy=sell=125), hard cap 4% [OWNER / FIXED cap] — `RobinSwapFeeConfig.sol:11,14-15,37`
- Split default platform 40% / Robin-LP 20% / rewards 40% (⇒ 0.5% / 0.25% / 0.5% per side) [OWNER] — `RobinSwapFeeConfig.sol:19-20`

---

## PART 2 — v4 TARGET (`pad-v4/`, NOT deployed)

Money-side taxes are **ETH** (currency0). Per-pad params are stamped immutably at launch from `RobinV4FeeConfig`
defaults [LAUNCH→FROZEN]; the owner (multisig/timelock) can retune defaults for *future* launches only. Production
defaults from `pad-v4/scripts/deploy-curve.js` (env-overridable).

### 2.1 Trade taxes (RobinFeeHook)
- BUY tax default **1%** of ETH input (fee-on-input, beforeSwap, ERC-6909 claim) / SELL tax default **1%** of ETH output (afterSwap) [LAUNCH→FROZEN] — `deploy-curve.js:34-35`, `RobinFeeHook.sol:217,317`
- Hook per-direction ceiling MAX_TAX_BPS=300 (3%); config cap for future launches MAX_TAX_BPS=200 (2%) [FIXED] — `RobinFeeHook.sol:50`, `RobinV4FeeConfig.sol:24`

### 2.2 BUY tax split
- Curve **buffer 20%** of buy tax (0.2% of trade), parked as ETH, **swept to PLATFORM at graduation** [LAUNCH→FROZEN] — `RobinFeeHook.sol:245-247`; cap 5000 [FIXED]
- **Referral 25% of the platform cut** (0.2% of trade) if a ref link is in hookData; rest → platform [LAUNCH→FROZEN] — `RobinFeeHook.sol:252,260`; cap 5000
- Platform remainder → platformOwed (ETH only) → claimPlatform (timelocked wallet). At defaults: buffer 0.2%, referral 0.2%, platform net ≈0.6% (≈0.8% once the buffer lands at grad).

### 2.3 SELL tax split
- **Floor 20%** of sell tax (0.2% of trade) → permanent floor vault [LAUNCH→FROZEN]; **creator 80%** (0.8% of trade) — `RobinFeeHook.sol:331-334`; cap 5000

### 2.4 Static pool LP fee (second take)
- lpFee default **1%** (10000 pips) [LAUNCH→FROZEN] — `deploy-curve.js:47`; cap MAX_LP_FEE=10000, dynamic-fee flag rejected [FIXED] — `RobinV4FeeConfig.sol:32,112`

### 2.5 Curve-phase LP-fee routing
- **ETH (buy) leg — `buyLpFloorShareBps` production default 0 → 100% ETH LP fee to platform** (0% floor) [LAUNCH→FROZEN] — `deploy-curve.js:41`, `RobinCurveV4.sol:722-724`
- TOKEN (sell) leg — 100% held on the controller, streamed to DualStaking at graduation; platform gets no token [FIXED] — `RobinCurveV4.sol:726-728,135`

### 2.6 Graduation waterfall
- Keeper bounty GRAD_BOUNTY_BPS=20 (0.2% of raise), off the top, capped 0.02 ETH, to msg.sender [FIXED] — `RobinCurveV4.sol:96-97,402-404`
- Of the distributable: **platform 10% / creator 10% / ambush 5% / permanent locked LP ≈75%** [LAUNCH→FROZEN defaults] — `deploy-curve.js:44-46`, `RobinCurveV4.sol:405-409,413`; per-bucket cap 2500, sum<10000 [FIXED]
- Locked LP: full-range 2-sided, NFT locked in LockVault; surplus reserve tokens → staking

### 2.7 RobinTokenTreasury — token-fee split
- **70% → DualStaking** (TO_STAKING_BPS=7000, `distribute()` permissionless+idempotent); **30% retained as burnReserve** [FIXED] — `RobinTokenTreasury.sol:32,64-66`
- **`burn()` creator-only** → entire burnReserve to `0x…dEaD`; no withdraw/rescue/owner path [FIXED] — `:30,74-80`

### 2.8 Vault LP-fee routing
- RobinFloorVault: ETH leg → platform (live from timelocked registry); TOKEN leg NEVER to platform — parks in-vault, `sweepTokenFees()` → tokenSink; add-only — `RobinFloorVault.sol:41-46,119`
- RobinAmbushVault: ETH → floor vault, token → staking; add-only, token never to platform — `RobinAmbushVault.sol:80,164,202-209`

### 2.9 Platform-ETH-only invariant (system-wide)
Platform receives ETH (currency0) only, never holds pad tokens. Every currency1 stream terminates at staking or the
RobinTokenTreasury (70/30). The one indirect path — the DualStaking claim fee on the pad-token reward — is
**contract-exempted** (round-3 F1): `DualStaking.claim()` charges `fee = asset == address(tokenAsset) ? 0 : …`, so
no `platformClaimFeeBps` setting can skim a pad token to the platform key (money-side rewards still carry the fee).
— `RobinTokenTreasury.sol:9-11`, `RobinCurveV4.sol:135,263`, `RobinFloorVault.sol:46`, `DualStaking.sol:392`

---

*Provenance: `econ-truth-reconcile` workflow (`wf_5ac9cbd0-68f`), 18 agents, adversarially verified. Corrections
applied to source the same day: `launchpad/SPEC.md` (platform-take, anti-snipe), `RobinCurveV4.sol:72` + `pad-v4/pad/config.js:48` (stale buyLpFloorShareBps 2000→0).*
