# ROBIN V4 — MASTER ARCHITECTURE DOCUMENT
### "Pad of Pads" multi-pad launchpad on Uniswap V4 · Robinhood Chain (chainId 4663 / 0x1237)
**Status:** single source of truth for implementation. Every red-team finding (A1–A4, B1–B2, C1–C3, D1–D4, E1, F1–F3, G1–G2, H1) is resolved inline and tagged `[RESOLVES Xn]`. Where a risk is inherent and unfixable on-chain, it is stated as a disclosure, not papered over.

---


> ## ⚠ STATUS: DESIGN-TIME DOCUMENT — THE CODE IS GROUND TRUTH
>
> **[M-6]** This is the architecture written *before and during* the build. Several of its designs were
> changed or dropped, and it was never updated. It is listed as required reading by `AUDIT-SCOPE.md`, so an
> auditor reading it as a description of the shipped system will hunt for bugs in code that does not exist and
> will not look hard at the code that actually holds the money. **Where this document and `contracts/`
> disagree, `contracts/` is correct.** `ROBIN-V4-CURVE-ECON.md` is accurate and is the better starting point.
>
> The specific divergences, each marked inline below where it occurs:
>
> | this document says | what shipped |
> |---|---|
> | `REQUIRED_FLAGS = 0x00C4` (§3.1) | **`0x00CC`** — `BaseHook.sol:30`. `BEFORE_SWAP_RETURNS_DELTA` was added when the buy tax became fee-on-input. |
> | A **3-way** platform/creator/holder fee split, skimmed in `afterSwap` (§3.2) | A **directional** tax. BUY is taxed fee-on-**input** in `beforeSwap`; SELL is taxed from the money-side **output** in `afterSwap`. Books are platform / curve-buffer / referral / creator / floor. |
> | An **O(1) holder accumulator** with `rewardPerTokenStored`, `unallocated`, `claimHolder` (§3.3) | **Does not exist.** There is no holder bucket in `RobinFeeHook`. Holder rewards are a separate product: `RobinLockStaking` / `DualStaking`. |
> | `RobinFloorVault` is an **ERC-4626 USDG vault** with `totalAssets`, `convertToShares`, a seeded first-deposit defence (FEATURE 3) | **Not a vault-with-shares.** Nobody deposits, nobody redeems, no USDG anywhere. It is a single-sided currency0 band above spot, add-only, fed by the fee carve. `convertToShares` / `availableRewardsOf` appear **0 times** in `contracts/`. |
> | A `UsdgYieldAdapter` contract (FEATURE 3) | **Does not exist.** `contracts/adapters/` holds `EthQuoteAdapter` and `StockQuoteAdapter` only. |
> | Both taxes collected by `POOL_MANAGER.take` (§3.2) | Both are minted as **ERC-6909 claims** and redeemed at claim time — see H-1 in `AUDITOR-HANDOFF.md`. |
>
> Also stale, and corrected at the source rather than here: `RobinStateView.sol`'s `totalAssets` comment, and
> `DualStaking`'s `IHookWeightSink` NatSpec, which advertised a reward stream to the removed holder bucket.
>
> **This banner is a stop-gap, not the fix.** The document should be rewritten or retired before the package
> goes to an external reviewer; that is a judgement call about what the architecture narrative should now say,
> which is the operator's to make. Until then, read it as history.


## 1. GROUND TRUTH

### 1.1 The exact V4 stack to build on (pin these; verified on-chain)
```
POOL_MANAGER      = 0x8366a39CC670B4001A1121B8F6A443A643e40951   # verified v4-core, ~4786 ETH TVL, used by all live GlueHooks
POSITION_MANAGER  = 0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA   # verified, ctor-bound to POOL_MANAGER + PERMIT2
V4_QUOTER         = 0x62C3D19d112A82643D418f2d7ef67e5d8a207d59   # verified, bound to POOL_MANAGER
UNIVERSAL_ROUTER  = 0x8876789976dEcBfCbBbe364623C63652db8C0904   # swap entrypoint ONLY (its internal NPM ref differs — do not use for LP)
PERMIT2           = 0x000000000022D473030F116dDEE9F6B43aC78BA3   # present + used by periphery
WETH (proxy)      = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG              = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168   # 6 dec, diamond proxy — always call the proxy
USDG_CLAIMSOURCE  = 0x5b01773138f17b38d1987558e576fa193db71a00
STOCK_IMPL        = 0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2   # 18 dec beacon impl (brief's …900d6f… is malformed)
STOCK_REGISTRY    = 0xe10b6f6b275de231345c20d14ab812db62151b00   # blocklist + global pause authority
STATEVIEW         = <WE DEPLOY OUR OWN>   # none on-chain pairs with 0x8366; one-file extsload wrapper
CREATE2_DEPLOYER  = <WE DEPLOY OUR OWN>   # do NOT assume 0x4e59… exists on this Orbit chain
```
- Native coin sentinel = `address(0)`, always sorts as `currency0`.
- Canonical mainnet PoolManager `0x0000…08A90` is **empty** here — do not target it.
- Gas: **no EIP-1559.** Legacy type-0 tx, explicit `gasPrice` (~30.18 Mwei ≈ 0.0302 gwei, bump 10–20%), explicit `gasLimit`. Never `maxFeePerGas`.
- Solidity **0.8.26**, `viaIR: true`, optimizer runs 1, OZ 5. Matches the live PoolManager compiler.

### 1.2 What we are actually first at `[RESOLVES H1]`
GlueHook (buyback/burn + auto-compound), HookPadFeeLocker (permanent LP lock + creator/platform split), Hookr.fun, ROBINHOOK all predate us on this chain. We are **NOT** the first V4 hook, first launchpad, or first fee-locker here. **Drop all "first V4 / first hook" language.**

The **honest, defensible novelty** is one specific combination not present in any live contract on this chain:
> **A platform/creator/holder _3-way_ afterSwap fee split (HookPadFeeLocker only does 2-way) + "earn-the-other" dual staking + a USDG-yield ERC-4626 locked floor + a tokenized-stock pad, all under one immutable factory.** The defensible delta over HookPadFeeLocker is specifically the **holder O(1) bucket** and the **dual-asset yield/stock pads.** Claim only that.

---

## 2. SYSTEM ARCHITECTURE

### 2.1 Contract set (new; sibling to the untouched v3 pad at `/home/user/sherif/launchpad`)
Ship in `/home/user/sherif/pad-v4/`.

```
core/
  DeterministicDeployer.sol   # minimal CREATE2 factory; deploy FIRST, pin address as constant
  StateView.sol               # one-file extsload wrapper bound to POOL_MANAGER (read-only, no trust surface)
  FeeWalletRegistry.sol       # THE ONLY mutable surface: platform fee wallet, Ownable2Step + 2-day timelock
  LockVault.sol               # immutable; holds every seed-LP NFT; NO decrease/burn/transfer selector
  PadFactory.sol              # immutable registry + one-tx launch orchestrator; owner power = none over funds
hooks/
  BaseHook.sol                # flag self-assert, PM-only guards, transient reentrancy guard, settle/take idioms
  RobinFeeHook.sol            # THE hook. afterSwap 3-way skim + O(1) holder accumulator + beforeSwap stock-curb
pads/
  PadToken.sol                # fixed-supply ERC20, no owner/mint/pause after ctor; CREATE2-mined to sort as currency1
  RobinFloorVault.sol         # ERC-4626 quote floor; add-only V4 position; realized-only totalAssets
  DualStaking.sol             # two-book Synthetix engine (ported from RobinStaking + SheriffStaking)
adapters/
  IQuoteAdapter.sol           # the single seam that makes USDG vs Stock vs ETH uniform
  EthQuoteAdapter.sol         # trivial: never-pausable native; the clean case
  UsdgYieldAdapter.sol        # F3: Design-A vault-as-claimer; best-effort harvest; freeze/deregister detect
  StockQuoteAdapter.sol       # F4: blocklist/pause-tolerant transfers; uiMultiplier display + curb signal
```

### 2.2 How the pieces fit
```
PadFactory.launch(padType, cfg)  ── one atomic legacy type-0 tx ──►
  1. PadToken           via CREATE2 (salt mined so token address > quote  ⇒ pad = currency1)
  2. RobinFeeHook       via CREATE2 (salt mined so low-14-bits == 0xCC;  ctor SELF-ASSERTS or reverts)
  3. POOL_MANAGER.initialize(key)      # key.fee = STATIC fee (NOT dynamic flag) — see §3.1 / RESOLVES A2
  4. factory.registerPool(poolId, cfg) # binds immutable FeeConfig atomically, same tx, before any swap
  5. POSITION_MANAGER.mint(seed LP)  →  recipient = LockVault   (NFT never touches a withdraw-capable address)
  6. LockVault.register(tokenId, key, creator)
  7. if USDG/STOCK pad: deploy RobinFloorVault + adapter, wire floor
  8. if staking: deploy DualStaking, authorize hook holder-bucket as rewarder
  9. emit PadLaunched(...)

Runtime data flow:
  swap → PoolManager → RobinFeeHook.afterSwap
        └─ skim (additional, exact-input only) → take fee to hook
           ├─ platformOwed[id][cur] += pCut      (accrue-and-pull)
           ├─ creatorOwed[id][cur]  += cCut      (accrue-and-pull)
           └─ holder bucket: rewardPerTokenStored[id][cur] += hCut*RAY/totalWeight   (O(1), never loops)
  DualStaking ← holder bucket funded via fundETH / fundTokenPushed (hook push, inside/after swap)
  RobinFloorVault ← quote deepening (add-only) + best-effort adapter.harvest() yield
  LockVault → collectFees only (0-liquidity modify) → immutable creator beneficiary
```

### 2.3 Shared immutability & security model (applies to every contract)
- **Immutable / no proxies / no upgrade.** All params are constructor-`immutable` or written once into per-pool config at `registerPool`, then frozen.
- **The single mutable knob in the entire system** is `FeeWalletRegistry.platformFeeWallet`, moved only via `Ownable2Step` owner + **2-day timelock** (propose → wait → commit). The hook reads it at accrual time (forward-only). Creator payout address is 2-step repointable by the current creator only, over their own slot. Nothing else is mutable — no fee-rate change, no pause-trading, no recipient free-for-all, no LP path, no sweep.
- **All payouts accrue-and-pull.** Platform/creator/holder shares are booked to storage; recipients `claim()` (pull, may revert on their own send — isolated to their own claim). There is **no per-swap push** to any external wallet, so a reverting recipient can never block a swap.
- **Reentrancy:** transient-storage (`tstore`/`tload`) guard at a fixed slot on every state-bearing entry **including `afterSwap` and the claim/send phase**. Cheaper than SSTORE, re-entry-during-send safe.
- **CEI everywhere;** measured `balanceOf`-delta crediting for every ERC-20 pull (fee-on-transfer / stock safe).
- **`msg.sender != POOL_MANAGER` guard** on every hook callback. Never a nested `unlock()` — operate on live deltas.

---

## 3. PER-FEATURE SPECS (corrections applied)

### FEATURE 1 — 3-way fee hook (`RobinFeeHook`) — THE HEART

#### 3.1 Flags, fee model, and the decisions that kill A1/A2/G1/G2

> **[M-6/L-15] Corrected to what shipped.** `REQUIRED_FLAGS` is **`0x00CC`** (`BaseHook.sol:30`); `BEFORE_SWAP_RETURNS_DELTA (0x08)` was added when the buy tax became a fee-on-input. The static-fee, no-`beforeInitialize` and always-additional decisions below are accurate and did ship.

- **One hook bytecode, one salt family. `REQUIRED_FLAGS = 0x00CC`** = `BEFORE_SWAP (0x80) | AFTER_SWAP (0x40) | BEFORE_SWAP_RETURNS_DELTA (0x08) | AFTER_SWAP_RETURNS_DELTA (0x04)` (the authority is the `BaseHook.REQUIRED_FLAGS` constant). `[RESOLVES G1]` — this exact word is the miner target, the ctor self-assert, and a public `REQUIRED_FLAGS` constant the factory cross-checks. No 0x44 vs 0x2044 disagreement remains.
- **No `beforeInitialize`.** `[RESOLVES G2]` — config is bound by `factory.registerPool(poolId, cfg)` in the same launch tx; an unregistered pool has `feeBps==0` and the hook is inert for it. Dropping `beforeInitialize` also removes the "which `sender` calls initialize" ambiguity entirely. Factory calls `POOL_MANAGER.initialize` **directly** (no separate PoolInitializer contract).
- **The skim is ALWAYS ADDITIONAL, never "carved."** `[RESOLVES A1]` The hook holds no LP position (seed LP is in LockVault, floor is in RobinFloorVault), so there is nothing to carve from. The trader pays `LP fee + skim`. Delete every "carved / no extra cost" claim.
- **The pool uses a STATIC LP fee, NOT the dynamic-fee flag.** `[RESOLVES A2]` A static fee means the locked seed LP and the floor actually accrue fees (their only return). We do **not** set `0x800000` and we do **not** call `updateDynamicLPFee`. `beforeSwap` exists solely for the stock guard-window curb (§3.4), never to set a fee. Anti-JIT at the pool layer is intentionally forgone; anti-JIT lives in DualStaking. `[RESOLVES B2]`
- **`beforeSwap` is a cheap no-op for ETH/USDG pads** (checks `cfg.guardWindow == 0` → returns immediately), so one bytecode serves all three pad types.

#### 3.2 The skim (afterSwap) — exact rules that kill A4/B1/D2

> **[M-6] SUPERSEDED.** The shipped hook does not skim a single 3-way fee in `afterSwap`. It taxes
> **directionally**: BUY fee-on-input in `beforeSwap`, SELL from the money-side output in `afterSwap`, both
> minted as ERC-6909 claims (not `take`n — see H-1). Read `contracts/hooks/RobinFeeHook.sol` instead.

```
afterSwap(sender, key, params, delta, _):
  require msg.sender == POOL_MANAGER
  if sender == address(this) return (selector, 0)          # our own ops never skim
  cfg = config[poolId]; if !cfg.registered || cfg.feeBps==0 return (selector, 0)

  # [RESOLVES A4/B1] SKIM ONLY EXACT-INPUT. Exact-output is skim-free (documented).
  if params.amountSpecified >= 0 return (selector, 0)      # amountSpecified<0 == exact-input
  # unspecified leg == OUTPUT leg, which the PM already holds → take never fronts foreign reserves.
  (a0,a1) = unpack(delta); uc = zeroForOne ? 1 : 0; ucAmt = uc==0 ? a0 : a1
  mag = abs(ucAmt); if mag==0 return (selector,0)

  fee = mag * cfg.feeBps / BPS                              # rounds down (dust §Rounding)
  if fee==0 return (selector,0)
  if fee > uint128 max, fee = uint128 max                  # clamp; skim cap, never revert (GlueHook idiom)

  # [RESOLVES D2] GUARD THE TAKE. A blocklisted/paused stock fee currency must NOT brick the swap.
  ok = try POOL_MANAGER.take(ucAddr, address(this), fee)
  if !ok: emit SkimSkipped(poolId, ucAddr, fee); return (selector, 0)   # skip skim, swap proceeds

  pCut = fee*cfg.platformShareBps/BPS
  cCut = fee*cfg.creatorShareBps /BPS
  hCut = fee - pCut - cCut                                  # subtraction conserves dust into holder bucket
  platformOwed[id][uc]+=pCut; creatorOwed[id][uc]+=cCut; _accrueHolders(id, uc, hCut)
  return (selector, int128(fee))                            # return delta LAST (CEI)
```
- Sign convention: negative delta = hook owes; positive = hook is owed. The `+fee` return nets the `-fee` from `take` to zero → unlock closes clean.
- `receive() external payable {}` required so native `take` lands.

#### 3.3 O(1) holder accumulator — kills F1/F2

> **[M-6] NEVER BUILT.** There is no holder bucket, no `rewardPerTokenStored`, no `unallocated` and no
> `claimHolder` in `RobinFeeHook`. Holder rewards ship as a separate staking product. Do not audit this.

```
_accrueHolders(id, c, amt):
  ts = totalWeight[id]
  if ts==0 { unallocated[id][c] += amt; return }           # [RESOLVES F2] PARK, do NOT route to platform.
  pending = amt + unallocated[id][c]; unallocated[id][c]=0
  inc = pending * RAY / ts; rewardPerTokenStored[id][c] += inc
  unallocated[id][c] += pending - inc*ts/RAY               # carry truncation dust forward
```
- `RAY = 1e27`. `poolId = keccak256(abi.encode(key))`.
- **Holder claims are PER-CURRENCY.** `[RESOLVES F1]` `claimHolder(id, currencyIndex)` settles and pays exactly one leg. A stock leg that blocklists the claimant fails only that leg; the ETH/token leg is untouched. There is no bundled two-currency claim path.
- `_payOut` = native `.call{value:}` / ERC-20 `transfer` via low-level call, reverting only the caller's own pull on failure.
- `[RESOLVES F3]` If a stock reward reserve is `adminBurn`-ed below `Σ owed`, later claimants revert on their own transfer — isolated per-currency, never touches the swap path or other currencies. Documented, accepted.

#### 3.4 `beforeSwap` — the stock corporate-action curb (kills D4)
```
beforeSwap(sender, key, params, _):
  require msg.sender == POOL_MANAGER
  cfg = config[poolId]
  if cfg.guardWindow > 0 && cfg.quoteIsStock:
     ea = adapter.scheduledEffectiveAt()                   # 0 if none
     if ea != 0 && |block.timestamp - ea| <= cfg.guardWindow revert CorporateActionCurb()
  return (selector, 0, 0)                                  # no fee override — static fee
```
`[RESOLVES D4]` On-chain curb is now real (the base hook has `beforeSwap`). Outside the window and for non-stock pads it is a single SLOAD + return.

#### 3.5 The one A3 obligation
`[RESOLVES A3]` No live hook on this chain uses `afterSwapReturnDelta` to skim (GlueHook returns `hookDelta==0`; it collects from its own position and uses `beforeSwapReturnDelta` for its shield). The accounting is sound (traced: take `fee`, return `+fee`, nets hook to 0, swapper receives `fee` less), but it is **unverified against a working example here.** **Mandatory gate:** a fork test against `0x8366` proving an exact-input skim swap closes the unlock with zero residual delta, run before any "verified idiom" claim and before mainnet launch. This is a P0 test, not a nice-to-have.

---

### FEATURE 2 — Dual staking, multi-reward (`DualStaking`) — the strongest piece

Port the **already-audited** streaming engine from `launchpad/contracts/RobinStaking.sol` (do not re-derive) and the `UNSTAKE_DELAY` anti-JIT gate from `SheriffStaking.sol`.

- **Two books in one immutable contract:** `Side.TOKEN` (stake the launched token) and `Side.STOCK` (stake the paired stock). Each side earns the OTHER asset plus a shared basket (ETH, ETH-that-yields/USDG, extra tokens). Each `(side, rewardAsset)` is a standalone Synthetix `rewardPerToken` accumulator.
- **Ported verbatim (per side):** `RewardInfo`, `rewardPerToken`, `earned`, `_updateReward` (incl. empty-pool pause: when `totalWeight==0` capture un-streamed remainder to `pending`, freeze), `_applyReward` (forfeit recycles, never resets), `_kickstartPending`, `_fund`, `_payout`, measured-delta crediting, **single-asset claim isolation.** `ETH=0xEeee…`, `ACC=1e30`, `MAX_REWARD_TOKENS=8`.
- **New code (review hardest):** boosted `weight`/`totalWeight` + `_settleAndReweigh` (settles at OLD weight, then reweighs, then re-checkpoints rpt — no theft), optional `IBoostOracle` (bounded `≤ MAX_BOOST_BPS=4×`; try/catch → never blocks staking), `antiJitDelay` (`≤ 7 days`, default configurable, `0` honors "no lock"), and the hook-push funding surface.
- **Funding surface (accounting-only on the ETH path → cannot revert the hook):** `fundETH(side)` (primary hook path), `fundToken(side, asset, amt)` (converter/creator, holds allowance, measured delta), `fundTokenPushed(side, asset)` (hook `take`s straight into the contract, credits `balanceOf − lastSeen`). All gated to `isRewarder[msg.sender]`.
- **"Earn the other" routing** is wired at pool creation by which assets each side lists — not hardcoded. Token/ETH pool → both sides earn ETH; buyback token slice → stock-stakers earn TOKEN; stock slice → token-stakers earn STOCK.
- **Yield legs (`harvest`)** are best-effort, realized-balance-only, fully isolated (see F3 rules below). Opportunistically called at top of stake/unstake (wrapped, swallowed).
- `[Red-team verdict: SOUND]` Only requirements: keep `claim` strictly per-asset (no `claimMany`-only path for stock), and document that **Side.STOCK principal is locked during a stock pause** (staking a pausable asset carries that asset's pause risk — inherent, disclosed). Principal path moves only the stake asset; a paused/blocked reward leg is fully isolated from unstake.

---

### FEATURE 3 — RobinVault (USDG floor) — `RobinFloorVault` + `UsdgYieldAdapter`

> **[M-6] NEVER BUILT AS DESCRIBED.** `RobinFloorVault` is not ERC-4626 and has no shares, no USDG and no
> yield adapter; `UsdgYieldAdapter` does not exist. What shipped is a single-sided currency0 band placed above
> spot, add-only with no remove path, fed by the sell-tax carve. The share-accounting, first-deposit-inflation
> and `wipeFrozenAddress` analysis below applies to no shipped code. Read `contracts/pads/RobinFloorVault.sol`.


- **ERC-4626, `asset` = USDG (6-dec).** Shares 18-dec internally; `SCALE = 1e12` at deposit/redeem boundaries only.
- **The floor** is a single-tick-range, single-sided **quote** position `[tickFloor, tickFloor+tickSpacing]` just below spot (a standing bid), held as **raw liquidity inside the vault** (not an NFT), managed via direct `POOL_MANAGER.modifyLiquidity` in the vault's own `unlockCallback`. **Opcodes: `OP_ADD_FLOOR`, `OP_COLLECT_FLOOR` — there is deliberately no `OP_REMOVE`.** That absence *is* the "floor locked forever" guarantee. Ticks spacing-aligned (`floor(rawTick/tickSpacing)*tickSpacing`); never hardcode ±887272.
- **`totalAssets()` = quote owed to the floor V4 position (read via our StateView `extsload`) + on-hand collected fees, folded promptly.** Yield/`availableRewardsOf` is **NEVER** in `totalAssets` — USDG `balanceOf` excludes unclaimed rewards, so assets step up only when a claim realizes a gain. `[RESOLVES C3]` First-deposit inflation attack is closed because the factory mints the initial floor shares as a non-bypassable seed (no public `deposit` reachable before the seed); `convertToShares` rounds down and `convertToAssets` rounds down, so redeem can never round up to drain 1 wei/call.

#### The C1/C2 reframe — the honest availability model `[RESOLVES C1, C2, and unifies with D1]`
The old invariant "deposit/withdraw fully function even if USDG paused" is **false and is deleted.** The corrected model:
- **Any operation that moves the QUOTE asset is subject to the quote token's own pause/freeze, inside PoolManager core, unreachable by our try/catch.** That includes floor-deepening deposits, redeems, floor collects — **and swaps themselves** (a swap moves USDG in/out of the PM). Therefore: **while USDG is globally `paused()` (or the vault/adapter is frozen), the USDG-quoted pad cannot trade or move quote at all.** This is inherent, disclosed, and identical in nature to the stock case (D1). Per-pad isolation holds — ETH pads and tradeable-quote pads keep working.
- **Deposits require a fold and either succeed or revert `QuotePaused` — they never park wipeable idle USDG.** `[RESOLVES C2]` Deposit = pull USDG → fold into floor in the same tx → mint shares against the realized position increase. If the fold reverts (USDG paused), the whole deposit reverts. No shares are ever minted against an idle balance that `wipeFrozenAddress` could zero. Redeem is always against the pool-held position (unwipeable relative to idle), so there is no early/late-redeemer haircut and no bank-run dynamic.
- **What IS genuinely isolated and best-effort** (the constraint we actually honor): the **yield harvest.** Not the quote asset's availability.

#### `UsdgYieldAdapter` — Design A (vault-as-claimer)
- One-time Paxos setup: `createPayoutGroupWithRoles(multId, claimer=adapter, manager=adapter, destination=adapter)`; adapter self-proposes + accepts via permissioned wrapper `acceptRegistration(uint32)` → `acceptRegisterRewardAddress(0x8914f736)`; reads offers via `getPendingRegistration(0x660b80c5)`. **Not on the launch critical path** — the pad trades with zero yield if it never completes.
- `harvest(floor)` best-effort, never reverts: if `payoutGroupIdOf(adapter)(0xb04647e9)==0` or `isFrozen(adapter)(0xe5839836)` → return 0. Else `before=balanceOf`; `try claimAll(groupId)(0x72da5bcb) catch {}` (swallow `ClaimSourceNotSet/InsufficientClaimSourceBalance/AddressFrozen/ContractPaused/InactivePayoutGroup`); `gain = balanceOf − before` (**realized delta only; `availableRewardsOf(0xa54c2732)` is UI-only, never accounting**); fold `gain*yieldToFloorWad/1e18` into floor, remainder to holder bucket.
- **Catastrophic tail acknowledged:** `wipeFrozenAddress` can burn idle USDG; `FrozenRewardsLost` on group deletion. Mitigated by folding realized gains into the position promptly (position quote is not a plain wipeable balance) and by surfacing `RewardsFrozen`/`FrozenRewardsLost` to the UI. A wipe just lowers `totalAssets`, which the redeem-against-position math tolerates.

---

### FEATURE 4 — RobinBlue (stock pad) — `StockQuoteAdapter`

- Stock = beacon proxy over impl `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`, 18-dec, `SCALE=1`, shared registry `0xe10b6f6b…1b00`. **No on-chain price — price is the V4 pool.** `harvest` returns 0.
- **Deploy-time allow-list gate.** RobinBlue only pairs a stock whose `ACCESS_CONTROLLED_REGISTRY()(0x50c09be3)` matches `STOCK_REGISTRY` and which is a beacon proxy over the known impl. This is where securities/legal gating attaches.
- `tradeable(parties[])` never reverts: best-effort `paused()(0x5c975abb)`, `registry.paused()`, `registry.isBlocked(p)(0xfbac3951)` over `{pool, hook, floorVault, recipient}`; revert-or-true anywhere → false → UI/router curbs, never bubbles.
- `safePull`/`safePush` never revert: low-level `.call` tolerating `Blocked(address)`/`IsPaused()`, return `(ok, moved)` measured by `balanceOf` delta. `approve` is gated too — prefer `permit(0xd505accf)`, be ready to skip; the hook never depends on holding stock approvals across a pause.
- `displayScalar()=uiMultiplier()(0xa60bf13d)`; reads `newUIMultiplier()(0xdc767007)` + `effectiveAt()(0x97a4064f)` for the §3.4 on-chain curb. UI shows `balanceOfUI`/`totalSupplyUI`, quotes the pool in raw units, divides by `uiMultiplier` for per-share display. `oraclePaused()(0x7706ba52)` is a "market data stale/closed" banner only — does not gate trading.

#### The inherent, disclosed stock risks (cannot be fixed on-chain)
- `[RESOLVES D1]` **A stock `paused()` or `isBlocked(PoolManager/hook)` hard-freezes that pad on-chain.** Every swap moves the stock through `settle`/`take` inside PoolManager core — outside any hook's try/catch. `tradeable()` only helps the router/UI; a direct `PoolManager.swap` still reverts. **Disclosure:** a paused/blocked stock freezes its pad until unpause. Per-pad isolation holds; the "graceful degradation for the affected pad" claim is deleted.
- `[RESOLVES D3]` **`adminBurn` bypasses pause+blocklist** and can burn the PM's stock reserve, unbalancing the AMM so an arbitrageur drains the other side. Not preventable on-chain. **Mitigation = deploy-time allow-list restricted to issuers who contractually won't `adminBurn` pool addresses + hard disclosure.** Treat as counterparty/securities risk, not accounting tolerance.

---

### FEATURE 5 — Extras
- **LockVault (LP locked forever)** `[RESOLVES E1]`: immutable, holds every seed-LP NFT, accepts NFTs **only** from `POSITION_MANAGER 0x174c…2EFA` (`onERC721Received` rejects any other sender — that acceptance IS the lock). **No `decreaseLiquidity`, no `burn`, no `transfer`, no `approve` selector exists.** The **only** outward path is `collectFees(tokenId)`, encoded as exactly a `decreaseLiquidity(tokenId, 0, …)` + `TAKE_PAIR` to the **immutable registered beneficiary** — the contract contains no code path passing a nonzero decrease, and a test must prove any nonzero reverts / is unreachable and that the take recipient is never caller-supplied. `receive() payable {}` for native fee delivery. Creator fee bounded 1%–10% (`MIN/MAX_CREATOR_FEE_BPS`, `BASIS_POINTS=10000`), accrue-and-pull. `registerLaunch` one-shot, `onlyFactory`, same tx as NFT transfer, before any swap. Owner may repoint only `factory`/`platformTreasury` (never creator, never funds) under Ownable2Step + timelock. **Floor collect** (distinct from seed-LP collect) is `modifyLiquidity(0)` directly on PoolManager inside the floor vault's unlock — no periphery ambiguity.
- **StateView**: one-file `extsload` wrapper bound to `0x8366` (none on-chain pairs with it). Read-only, no trust surface.
- **DualStaking boost tiers / graduation**: optional, unlocked at `graduate()` (permissionless, one-shot, quote-TVL threshold; folds fees into floor, never removes liquidity).

---

## 4. RISKS & MITIGATIONS (surviving items)

| # | Risk | Status | Mitigation in this design |
|---|---|---|---|
| A3 | afterSwapReturnDelta skim unverified on this chain | **Open until tested** | P0 fork test vs `0x8366` proving unlock closes with zero residual delta before launch |
| A4/B1 | exact-output skim fronts reserves / shifts currency | **Resolved** | Skim **exact-input only**; exact-output is skim-free (documented, minor) |
| C1/D1 | quote (USDG/stock) pause freezes the whole pad on-chain | **Inherent, disclosed** | Cannot fix (block is inside PM core). Per-pad isolation holds; ETH pads never freeze. "Never block trading" applies to yield/reward ops only |
| C2 | idle-USDG wipe breaks redeem fairness | **Resolved** | Deposits fold-or-revert (no wipeable idle); redeem only against pool-held position |
| D2 | stock fee `take` bricks swaps | **Resolved** | `take` wrapped; on failure skim is skipped, swap proceeds |
| D3 | `adminBurn` drains pool via arb | **Inherent, disclosed** | Deploy-time issuer allow-list + hard disclosure |
| E1 | LockVault collect could hide a decrease path | **Resolved w/ test obligation** | Pin the `decreaseLiquidity(…,0,…)` selector; test proves no negative-delta path, recipient immutable |
| F3 | rebase/`adminBurn` reward currency vs O(1) index | **Isolated, disclosed** | Per-currency claim; a broke leg reverts only its own claim, never the swap |
| — | USDG issuer freeze/deregister/wipe (yield) | **Isolated** | Realized-balance-only accounting; every USDG call try/catch; yield never load-bearing; Design-A minimizes Paxos dependency to one-time setup |
| — | Owner backdoor | **Closed** | Sole mutable = platform fee wallet, Ownable2Step + 2-day timelock; no LP/fund/config/pause power |
| H1 | "first on chain" overclaim | **Resolved** | Claim only the 3-way + earn-the-other + yield-floor + stock-pad combination |

**Load-bearing invariants to assert as tests:**
1. Floor `modifyLiquidity` is only ever called with `ΔL ≥ 0`; `OP_REMOVE` does not exist.
2. Seed-LP NFT in LockVault has no exit selector; any nonzero decrease reverts/absent.
3. `afterSwap` never reverts from a yield/harvest/stock-take failure (every path guarded).
4. `totalAssets()` depends only on realized pool-held quote + on-hand folded fees — never `availableRewardsOf`.
5. Every skim leg `≤ uint128(type(int128).max)` or the hook returns zero delta.
6. `uint160(hook) & 0x3FFF == 0x00CC`, asserted in ctor (deploy-time failure) and cross-checked by factory against `hook.REQUIRED_FLAGS`.
7. Owner can repoint only `platformFeeWallet` (timelocked) and creator only its own slot; no selector moves locked funds/floor liquidity.
8. Holder claim is per-currency; a blocked stock leg never blocks the ETH/token leg.
9. Decimal round-trip deposit→redeem loses ≤1 wei, rounding against the user in both directions.
10. Exact-input skim swap closes the unlock with zero residual delta (the A3 gate).

---

## 5. BUILD PLAN

### 5.1 Order of implementation
1. **Infra & the hook (F1) first** — `DeterministicDeployer`, `StateView`, `FeeWalletRegistry`, `BaseHook`, `RobinFeeHook`, `PadToken`, `LockVault`, `PadFactory`. This is the spine; everything composes onto the hook's holder bucket. **Land the A3 fork test here** — nothing ships until the skim is proven.
2. **Dual staking (F2)** — port `RobinStaking` + `SheriffStaking`, add two-book/boost/hook-push. Reuses the existing 21-test suite per-side; add dual-independence, boost-reweigh, anti-JIT, hook-push funding tests.
3. **RobinVault (F3)** — `RobinFloorVault` + `UsdgYieldAdapter` + `EthQuoteAdapter`. Test the C1/C2 reframe: deposit-fold-or-revert under pause, redeem-against-position, yield-harvest isolation (frozen/paused/deregistered no-ops).
4. **RobinBlue (F4)** — `StockQuoteAdapter`. Test D1/D2/D3/D4: paused-stock pad freeze (isolated), guarded skim-take, `beforeSwap` curb in window, allow-list gate.
5. **Extras** — graduation, boost tiers, indexer wiring.

### 5.2 Hook-mining / deploy runbook (Orbit legacy gas)
**One-time bootstrap (in order):** `DeterministicDeployer` (pin its address as a constant) → `StateView(POOL_MANAGER)` → `FeeWalletRegistry(initialWallet, owner)` → `LockVault(factory=computed)` → `PadFactory(PM, POSMGR, PERMIT2, feeRegistry, lockVault, DEPLOYER)` → verify all on Blockscout → transfer `FeeWalletRegistry` ownership to platform multisig via Ownable2Step.

**Per-launch:**
```
A. Collect LaunchConfig (name, symbol, supply, padType, quote, seedLiquidity, sqrtPriceX96,
   creator, creatorBps 100..1000, platformBps, holderBps, tickSpacing, STATIC fee, guardWindow).
B. Predict PadToken CREATE2 address; ensure it sorts > quote (mine tokenSalt).
C. Build hook init-code = bytecode ++ abi.encode(token, feeRegistry, creator, bps…, quote, adapter).
D. MINE hookSalt so CREATE2(DEPLOYER, salt, initCodeHash) & 0x3FFF == 0x00CC   (~2^14 tries, sub-second).
E. If USDG pad: pre-stage Paxos Design-A group (off critical path).
F. factory.launch(padType, cfg, tokenSalt, hookSalt) as legacy type-0, gasPrice=eth_gasPrice*1.2, gasLimit ~5.5M.
G. Assert receipt: PadLaunched; token & hook == predicted; hook&0x3FFF==0xCC; LockVault owns the NFT.
H. Verify token + hook on Blockscout (ctor args must match exactly).
I. Register poolId with the indexer for the fee-collect keeper + reward accounting.
```
Record `(launchId → tokenSalt, hookSalt, predicted addresses)` **before** broadcast so a dropped tx is re-broadcast (same nonce, bumped gasPrice) without re-mining.

### 5.3 Test / sim strategy
- **Fork-test against real `0x8366`** (repo's existing `FORK_RPC` Hardhat forking, chainId 4663). The A3 skim-closes-clean test and the LockVault no-decrease test are P0 gates.
- Port `robin-staking.test.js` per-side; add the new-code suites (§5.1).
- Adversarial suite: paused/frozen USDG (deposit reverts QuotePaused, redeem works, harvest no-ops), blocklisted stock (pad freezes isolated, other pads trade, skim skipped not reverted), `adminBurn` unbalance (arb bound), exact-output skim-free, whale-fee int128 clamp, reentrancy on afterSwap+claim.

### 5.4 Securities / legal go-live gates (non-blocking to architecture, blocking to launch)
- USDG-yield + tokenized-stock + holder-payout pads are securities-gating concerns. Attach **KYC/geo gating at the UI/funding layer** and the **deploy-time stock allow-list** (issuers who won't `adminBurn` pool addresses). These are launch gates, not contract changes.
- Any external handoff (e.g., Uniswap) links **only** `https://github.com/Robinlabz/Labs` — never `PettyMiggzy/sherif`.

---

**Cached verified sources for the coding agent:** `/tmp/claude-0/-home-user-sherif/01029517-d6a2-53cc-bd34-e38f0a4e7c87/scratchpad/{GlueHook,GluedV4Core,GlueLiquidity,IGlueHook,HookPadFeeLocker}.sol`, `usdg_src/`, `stock_src/`. Reuse targets in-repo: `launchpad/contracts/RobinStaking.sol`, `SheriffStaking.sol`, `LiquidityLocker.sol` (v3 no-withdraw reference), `scripts/deploy-live.mjs` (legacy type-0 broadcast). The v3 pad is untouched.