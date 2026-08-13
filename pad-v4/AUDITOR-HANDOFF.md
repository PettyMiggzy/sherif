# Robin V4 — auditor hand-off: what needs fixing

**This is a findings register, not a cover note.** It is the output of a deep, adversarial, report-only audit
pass over `pad-v4/`. **Nothing was fixed** — every item below is written for whoever picks up the remediation.

For the scope map, the invariant list, the economic model and the accepted design decisions, read
[`AUDIT-SCOPE.md`](./AUDIT-SCOPE.md) first; this document assumes it. (The previous contents of this file were
a condensed restatement of `AUDIT-SCOPE.md`; it is preserved in git history.)

| | |
|---|---|
| **Scope** | `pad-v4/contracts/**` — all subsystems, including the stock pad that `AUDIT-SCOPE.md` §2 marks informational |
| **Branch** | `claude/ultra-audit-handoff-g6lxrw` |
| **Build** | solc 0.8.26, `viaIR`, optimizer runs 1, EVM cancun — compiles clean |
| **Baseline** | `npx hardhat test test/unit/*.js test/sim/*.js` → **130 passing**, before and after |
| **Changed by this pass** | this file only |
| **Method** | manual review of all 5,335 lines of `contracts/`, plus an adversarial finder/skeptic gauntlet looped to consecutive clean rounds |

`PROVEN` on a finding means a runnable test or an exact numerical evaluation in this pass produced the stated
numbers. §6 has the repro recipes; §4 lists what was checked and found clean, so the next pass doesn't
re-derive it.

---

## 1. Summary

| severity | count | of which measured |
|---|---|---|
| **CRITICAL** | 1 | 1 |
| **HIGH** | 4 | 2 |
| **MEDIUM** | 19 | 7 |
| **LOW** | 8 | 3 |
| **INFO** | 10 (9 bundled as I-1, plus I-2) | 1 |
| **total** | **42** | **15** |

§3 records a further set of plausible defects that were chased and did **not** survive verification, with the
disproof for each, so the next pass does not re-spend budget on them.

---

## 2. The pattern worth reading first

Individually these contracts are careful. The money-conservation core is sound — buy books balance their
ERC-6909 claims exactly, sell books balance their `take`s exactly, and the v4 delta plumbing is correct in
both directions (§4). The exposure is not in the arithmetic. It is in the seams:

> **Almost every high-impact item here is a wiring or parameter defect that is silent at launch and only
> becomes visible after a pad has taken real money.** `LockVault.setFactory`, `RobinFloorVault`'s `anchorTick`,
> `RobinCurveV4.setStaking`, `RobinFeeHook.setFloorRecipient`, `StockPadFactory`'s `adapter` and `guardWindow`,
> and `RobinV4FeeConfig`'s geometry bounds are all one-shot or immutable, all accept values no contract
> validates, and all fail *late*.

Every one of those parameters is hand-typed in an out-of-band deploy step with no script and no on-chain
assertion (L-7). That single root cause is cheaper to fix once — scripted deployment plus a handful of
`require`s at launch — than five times downstream.

---

## 3. Findings

### C-1 · CRITICAL · Three wei arms a trap that takes 100% of a pad's staking reservoir — 9.7% of total supply  `PROVEN (×3)`

**Where** `contracts/pads/RobinLockStaking.sol:222-231` (`_startDrip`), `:135-139` (the empty-pool pause guard
in `withdraw`), `:114-118` (`stake`'s pending flush), `:205` (`_accrueReward`'s park branch).

**What is wrong — two defects that compose.**

*(a) The drip compresses.* `_startDrip`'s mid-window branch deliberately holds `periodFinish` fixed:

```solidity
} else {
    uint256 remaining = periodFinish - block.timestamp;
    uint256 leftover  = remaining * rewardRate;
    rewardRate = (amount + leftover) / remaining; // drip over the remaining window; periodFinish unchanged
}
```

The `[audit]` comment above it explains this stops dust-funding from stretching the window forever. Sound —
but as `block.timestamp` approaches `periodFinish`, `remaining` → 1, so **any tranche credited near the end of
a window is paid out within one second**.

*(b) The empty-pool pause cannot clear a zero-rate window.* `withdraw`'s guard is

```solidity
if (totalStaked == 0 && rewardRate > 0 && periodFinish > block.timestamp) { ...bank and pause... }
```

`rewardRate` is `amount / rewardsDuration`, which **truncates to 0** for any tranche below `rewardsDuration`
(2,592,000 wei at the 30-day default). So a 2-wei funding creates a live 30-day `periodFinish` with
`rewardRate == 0`, and because the guard requires `rewardRate > 0`, emptying the pool does **not** clear it.
The window survives as a zombie, with an expiry the attacker chose.

**The attack.** Total cost: **3 wei and gas.** Armed at pad launch, before any honest user exists.

1. `fund(2)` — pool is empty, so it parks in `pendingRewards`.
2. `stake(1)` — flushes it through `_startDrip(2)`: fresh window, `rewardRate = 2 / 2592000 = 0`,
   `periodFinish = now + 30 days`.
3. `withdraw(1)` — pool empties. The pause guard is skipped (`rewardRate == 0`), so `periodFinish` stays
   30 days out. **Walk away.**
4. Over the next 30 days the pad funds real holder rewards. With the pool empty they all park in
   `pendingRewards` (`_accrueReward`'s `totalStaked == 0` branch) — the whole reservoir, untouched.
5. At `periodFinish - 2`, `stake(1)`. `stake` flushes `pendingRewards` through `_startDrip`, which takes the
   **mid-window** branch because `block.timestamp < periodFinish` — with `remaining == 2`.
6. One second later, claim.

**Measured at real production geometry** — startTickMag 201600 / curveWidth 23000 / ts 100, 1B supply at
730M curve + 270M reserve, buy/sell tax 100 bps, waterfall 10/10/5 — driven through the actual
`CurvePadFactoryV4` + `RobinFeeHook` + `LockVault` stack, not a toy harness:

| | |
|---|---|
| attacker's capital | **0.001 ETH** of dust-buy (557,164 tokens) **+ 3 wei** to arm |
| reservoir at stake — the graduation leftover streamed to staking | **96,978,138 tokens = 9.70% of the entire 1B supply** |
| after `fund(1)` | `rewardRate` 0, `periodFinish` = now + 2,592,000 |
| after `withdraw(1)` | `totalStaked` 0, `rewardRate` 0, `periodFinish − now` = 2,591,999 — **pause skipped** |
| attacker `stake(1)` in the tail | `rewardRate` **48,489,069 tokens/sec**, `remaining` 2 s |
| **attacker claimed** | **96,978,138 tokens — 100.00% of the reservoir** |
| honest staker (500 tokens, staked 10 days later) | **0.000000** |
| `balanceOf == totalStaked + rewardsBalance` | holds throughout — the accounting invariant never trips |

That reservoir is not incidental. The reserve is 270M and the permanent LP absorbs only ~173M of it, because
the ETH leg binds by construction (see §4), so a large surplus is **structural and predictable on every pad**.
The sell-side token LP-fee stream then keeps feeding the same reservoir and parking in the same
`pendingRewards` while the pool is empty, so the take *grows* with time-to-first-staker.

**The landing zone is wide, not a single block.** Any position in the tail pays out the full reservoir over
`remaining` seconds — at `remaining = 600` the whole reservoir lands in ten minutes — so the attacker
schedules it rather than sniping it. Overshooting is not even a failure mode: past `periodFinish` the fresh
branch simply drips 100% of the parked reservoir to the same sole 1-wei staker over 30 days, still to the
exclusion of everyone who stakes later.

**Precondition, stated plainly.** The attacker must be the **first staker after arming** — the pool must stay
unstaked from the arm (pre-graduation) through the tail of the zombie window. That is a real narrowing, and it
does not reduce the severity, for two reasons. First, arming costs 3 wei plus gas and can be done on *every*
pad the launchpad produces, so the attacker only needs the subset that sit unstaked — and a fresh per-pad pool
is empty by construction until graduation. Second, **in the branch where an honest staker arrives first, the
bug still fires**: whoever stakes first inside the zombie window captures a compressed drip of the entire
reservoir, and every later staker earns exactly zero. The holder-staking product is broken regardless of who
wins the race, and the contract's headline guarantee at `:14-15` — *"a whale can never drain the pool in one
block and the reservoir lasts"* — is false in both branches.

**Root cause, precisely.** Three lines, each individually defensible: `_startDrip`'s fresh branch (`:224-225`)
sets a live `periodFinish` while `rewardRate` truncates to 0 for any tranche below `rewardsDuration` wei; the
pause at `:135` conditions on `rewardRate > 0` rather than on `periodFinish > block.timestamp` alone, so that
window survives an empty pool; and `stake`'s flush (`:113-117`) then routes the parked reservoir through
`_startDrip`'s mid-window compression instead of a fresh full window.

**A second, independent path to the same compression** (no zombie window needed): wait for any legitimate
window's end, stake large, and credit a tranche yourself. Every step is permissionless, and the attacker can
manufacture the tranche out of the pad's own LP fees —
`LockVault.collectFees(tokenId)` (`core/LockVault.sol:107`, permissionless) books the locked graduation LP's
token-side fees, then `LockVault.claimStaking(tokenId, 1)` (`:143`, permissionless) forwards them to the
staking pool with a plain `_payout` ERC-20 transfer and **no `fundTokenPushed` poke**, leaving an uncredited
pile the attacker credits at a moment of its choosing. (`RobinCurveV4._fundStaking` and
`RobinAmbushVault._forwardStaking` both poke; `LockVault` is the one push path that does not.) Measured at
1000× the honest pool: whale earns 499,500.5 of a 500,000 tranche, pays the 100,000 penalty, nets
**+399,500 tokens in ~2 blocks**.

Both contradict the contract's own guarantee (`:14-15`: *"rewards stream out of a finite reservoir at a
bounded `rewardRate` (Synthetix drip), so a whale can never drain the pool in one block"*) and
`AUDIT-SCOPE.md` §3.

**The sibling contract already gets the important half right.** `DualStaking` has the same zero-rate hole in
its pause guard (`pads/DualStaking.sol:206` — `if (r.rewardRate > 0 && r.periodFinish > r.lastUpdateTime)`),
but its *stake* path is safe: `stake` → `_kickstartPending` → `_applyReward(side, asset, amt, true)`
(`:233`), and `extend == true` takes the fresh-window branch, so parked rewards always get a full
`duration` no matter what state the old window was in. `RobinLockStaking.stake` (`:112-117`) instead calls
`_startDrip(p)` directly, which falls into the mid-window branch whenever a stale `periodFinish` is still
live. That one difference is the whole exploit.

**Fix direction.** All four are worth doing; the first two are the actual fix.
- **Floor the drip window.** Never let a tranche pay out faster than a minimum duration: cap
  `rewardRate` at `undrippedReservoir / MIN_DRIP_WINDOW`, or run two parallel schedules so a late top-up gets
  its own full window without extending the existing one (this keeps the anti-dust property the `[audit]`
  comment was protecting).
- **Fix the pause guard.** Drop the `rewardRate > 0` condition — pause whenever
  `totalStaked == 0 && periodFinish > block.timestamp`, so a zero-rate window cannot survive an empty pool.
- **Reject sub-rate tranches.** Require `amount >= rewardsDuration` in `_startDrip`'s fresh-window branch (or
  carry the remainder), so a tranche can never truncate to `rewardRate == 0` in the first place. This also
  fixes the dust-stranding in I-1(5).
- **Close the easiest setup:** have `LockVault.claimStaking` poke `fundTokenPushed` at transfer time, exactly
  as the curve and ambush vault already do.

---

### H-1 · HIGH · Any seller can waive the sell tax entirely — and it is *cheaper* than paying it  `PROVEN (×3)`

**Where** `contracts/hooks/RobinFeeHook.sol:297-302` (`afterSwap`'s guarded `take`).

**What is wrong.** The sell fee is collected by physically taking the just-produced output, and the take is
try/caught so a blocklisted or paused fee currency cannot brick trading:

```solidity
try poolManager.take(key.currency0, address(this), fee) {}
catch {
    emit SkimSkipped(id, 0, fee);
    return (IHooks.afterSwap.selector, int128(0));
}
```

On the catch path nothing is booked and `int128(0)` is returned, so the seller keeps the **full** output. The
fee is not deferred — it is **permanently waived**. And the failure is not something only a hostile token can
cause: for native ETH, `PoolManager.take` ends in `Currency.transfer`, which does a raw `call` of `amount` wei
and reverts `NativeTransferFailed` if the singleton does not hold it
(`v4-core/src/types/Currency.sol`, `PoolManager.sol`'s `take`).

**Anyone can starve the singleton for free**, because v4's flash accounting lets a caller take a currency with
no collateral as long as they settle before the unlock closes. It is enough to leave the PoolManager holding
**less native than `fee`** — a full drain is not required:

1. `poolManager.unlock(...)`; inside the callback:
2. `poolManager.take(Currency.wrap(address(0)), self, <enough to drop the singleton below `fee`>)` — free,
   creates a matching negative delta.
3. `poolManager.swap(padKey, {zeroForOne: false, amountSpecified: -tokenAmount, ...})` — the sell. In
   `afterSwap` the hook's `take` of `fee` wei now reverts (the singleton holds ~0 ETH) → caught →
   `SkimSkipped` → `int128(0)` → **no tax**.
4. `poolManager.settle{value: X}()` returning the borrowed ETH, then take the untaxed swap output.

Net effect: the entire `sellTaxBps` — **0.8% creator + 0.2% floor** at production settings — is evaded, on
every sell, at will, by anyone.

**It costs less than paying the tax.** Measured: the attack path consumes **194,842 gas against 201,788 for
the honest sell — 6,946 gas *cheaper*** — because the catch path skips the two cold `SSTORE`s to
`creatorOwed`/`floorOwed` and the ETH transfer into the hook, and those exceed the extra `take` + `settle`.
So there is no minimum profitable trade size and no gas or slippage threshold that makes this negative-EV.

**And it does not stay a per-attacker trick.** The drain and the swap only need to share one `unlock`, so a
third-party router can wrap the flash-take around *every* user's sell and truthfully advertise "0% sell tax".
That turns an expert-only evasion into a protocol-wide defunding of the creator's income and the floor, with
no sophistication required from the traders themselves. The expected loss is the whole sell-tax revenue line,
curve phase and post-graduation alike — not a fraction of it.

**Severity note.** This is fee evasion, not theft: the singleton is left solvent (its ETH balance is identical
after honest and attack runs, and the unlock closes clean), nothing is drained from the pool, from user
principal, or from other pads. That is why it is HIGH rather than CRITICAL. Three independent reproductions
against a real local v4 `PoolManager` agree on the mechanism and the severity.

**Why this is worse than the `[D2]` disclosure it hides behind.** The NatSpec (`:40-42`) frames the try/catch
as *"a blocklisted/paused stock fee currency skips or defers, never bricks trading"*, and `AUDIT-SCOPE.md` §4.1 (`:55-56`)
asserts *"every fee booked is claimable exactly once."* Neither holds: the fee is never booked, it is
attacker-triggerable on the ordinary ETH path, and the creator's entire income stream plus the floor's funding
can be zeroed by any trader who routes through their own unlock. The buy side is unaffected — `beforeSwap`
uses `poolManager.mint`, which is pure accounting and cannot be starved, exactly as its comment claims.

**Fix direction — the buy side already shows the answer.** `beforeSwap` collects its fee with
`poolManager.mint` (`:215`), pure ERC-6909 accounting that cannot be starved by singleton depth, and redeems
it later through `_pullClaimsAndPay` / `unlockCallback` (`:448-462`), machinery that already handles a failing
physical take retriably. Give the sell side the same treatment: `mint` the fee as a claim and return the
`+fee` delta unconditionally. If the physical `take` is kept instead, the catch **must** book the fee to a
pending ledger rather than dropping it — silently returning `int128(0)` is what converts a deferral into a
waiver.

---

### H-2 · HIGH · A `StockPadFactory` launcher ships a pad it can freeze at will, and the securities gate is self-certified  `PROVEN`

**Where** `contracts/core/StockPadFactory.sol:69` (`adapter`, caller-supplied), `:68` (`guardWindow`,
caller-supplied, unbounded `uint32`), `:172`/`:176` (both stamped immutably into the hook), enforced at
`contracts/hooks/RobinFeeHook.sol:190-197`.

**What is wrong.** The corporate-action curb sits at the very top of `beforeSwap` — above the direction check
and above the `sender == address(this)` exemption:

```solidity
if (c.guardWindow > 0 && c.quoteIsStock && c.guardAdapter != address(0)) {
    uint256 ea = _scheduledEffectiveAt(c.guardAdapter);
    if (ea != 0) {
        uint256 diff = nowTs > ea ? nowTs - ea : ea - nowTs;
        if (diff <= c.guardWindow) revert CorporateActionCurb();
    }
}
```

So it freezes **buys and sells alike**, and both of its inputs are chosen by whoever calls `launch()`. A
launcher therefore ships a pad it can freeze and unfreeze at will: trade normally, dump the `tokenRemainder`
that `launch` sends to `cfg.creator` (`:187-188`), then schedule an "effective at" on its own adapter and no
holder can ever exit. `guardWindow` is a `uint32` with no ceiling — one call freezes the pad for up to ~136
years. The freeze semantics are already established by the repo's own test,
`test/unit/RobinFeeHook.adversarial.test.js:163-186`, using `MockGuardAdapter` — a 22-line contract that is
exactly what an attacker would deploy.

**The gate this is supposed to rest on does not hold.** `StockPadFactory.sol:32-35` states: *"SECURITIES /
LEGAL GATE: the StockQuoteAdapter's ctor already requires the stock's registry to match the platform's known
STOCK_REGISTRY, so only registry-governed stocks can be paired."* Two links are missing:

1. `StockQuoteAdapter`'s constructor takes `expectedRegistry` **as an argument**
   (`adapters/StockQuoteAdapter.sol:60-70`). It proves only that the stock and the registry agree with each
   other — not that the registry is the platform's. The adapter's deployer names both sides.
2. `StockPadFactory` has **no registry immutable and no adapter allow-list at all**. Grepping `contracts/` for
   `expectedRegistry` / `ACCESS_CONTROLLED_REGISTRY` / `isAdapter` outside `adapters/StockQuoteAdapter.sol`
   returns only `test/MockStock.sol`. `launch()` checks `cfg.adapter != address(0)` and then simply calls
   `.stock()` on whatever it was handed (`:124-126`).

**PROVEN:** deploying `MockStockRegistry` → `MockStock(thatRegistry)` → `StockQuoteAdapter(thatStock,
thatRegistry)` from an attacker account **succeeds**, and `adapter.registry()` returns the attacker's own
registry. The resulting pad carries `quoteIsStock == true` and is on-chain indistinguishable from a genuine
one.

`AUDIT-SCOPE.md` §2 defers the stock pad as "informational", but this is not a stock-market risk — it is a
rug primitive in shipped, in-scope code, reachable by anyone.

**Fix direction.** Pin the registry as an immutable on `StockPadFactory` and require
`StockQuoteAdapter(cfg.adapter).registry() == STOCK_REGISTRY`, or keep a platform-curated
`mapping(address => bool) approvedAdapter`. The guard adapter should not be launcher-chosen at all — derive it
from the approved adapter for that stock. Give `guardWindow` a hard ceiling: a corporate-action window is
hours, not years.

---

### H-3 · HIGH · `cfg.creator` is outside both CREATE2 pre-images, so copied launch calldata steals a pad's creator revenue  `VERIFIED`

**Where** `contracts/core/CurvePadFactoryV4.sol:143-151` (the token and hook init-codes), `:180-197`
(`registerPool` stamps `cfg.creator`).

The two addresses that make a launch unique are derived from init-code that **does not contain the creator**:

```solidity
type(PadToken).creationCode,  abi.encode(cfg.name, cfg.symbol, cfg.decimals, cfg.supply, address(this))
type(RobinFeeHook).creationCode, abi.encode(poolManager, address(this), feeRegistry, token)
```

So for a given `(cfg, tokenSalt, hookSalt)` the token and hook land at the same addresses **whoever** calls
`launch()` and **whatever** `creator` they name. `launch` is permissionless, and `cfg.creator` is stamped
straight into the hook's immutable `PoolFeeConfig`.

**The attack is copy-paste.** Take a pending `launch()` calldata, change one field — `creator: V → A` — and
land first. The attacker's transaction deploys the token and hook at exactly the addresses the victim
intended, registers the pool with **itself** as creator, and thereby takes the pad's entire creator economics:
the 0.8% sell-tax stream (`RobinFeeHook.creatorOwed` → `claimCreator`) and the 10% creator share of the raise
at graduation (`RobinCurveV4.creatorEthOwed`). The victim's transaction then reverts — `registerPool` throws
`AlreadyRegistered`, and the factory no longer holds the supply — so the victim loses the launch as well as
the revenue. Note the *curve* address does depend on `cfg.creator` (it is a constructor argument at `:213`),
which is why the collision surfaces at `registerPool` rather than earlier; it does not help the victim.

**Chain-dependent reachability, and the codebase already reasons about this class.**
`PresaleVault.sol:180-192` explicitly handles the mirror case — *"on Robinhood Chain's single-sequencer FCFS
ordering this is not reachable; it exists so a public-mempool / decentralized-sequencer deployment can never
brick the vault"* — and fails **safe**, refunding contributors. Here there is no equivalent handling at all,
and the failure is not safe: it transfers the creator's revenue to the attacker. A launchpad that has already
written down "assume a public mempool might exist" for its presale add-on should not leave its primary launch
path undefended against the same ordering assumption.

**Fix direction.** Bind the creator to the deployment. Simplest: include `cfg.creator` in the token's
constructor arguments (it is already an immutable-style stamp elsewhere) or in the hook's, so a different
creator produces a different CREATE2 address and a copied calldata cannot collide. Alternatively require
`cfg.creator == msg.sender` on the curve path, or commit-reveal the launch the way `PresaleVaultFactory`
already does for presales.

---

### H-4 · HIGH · The floor can only deepen while the price is *above* it, so a drawdown freezes the carve permanently  `VERIFIED`

**Where** `contracts/pads/RobinFloorVault.sol:110-116` (`addFloor`'s band guard), with the add-only design at
`:24-30`.

```solidity
(, int24 tick,,) = stateView.getSlot0(_poolId());
if (tick >= floorTickLower) { parkedQuote = amt; emit FloorSkipped(tick, amt); return 0; }
```

A single-sided currency0 add requires spot to sit **below** the range, so the vault can only deploy carve
while the token trades *above* the top of its own wall. The moment spot enters the band — the moment the price
falls to where the floor is supposed to start working — every subsequent carve delivery parks instead of
deploying, and keeps parking for as long as the token stays there.

**With the shipped parameters that window is tiny.** `scripts/launch.js:24` sets `FLOOR_BAND_SPACINGS = 20`
with `TS = 60` and `anchorTick` = the launch tick, giving a band of `[60, 1260]` — roughly 0.6% to 12% below
the launch price. So the carve deploys only while the token is within ~0.6% of where it launched. A 2.95%
drawdown puts spot at tick 299, **inside** the band with the wall barely touched, and from that point on every
sell-tax floor carve the pad ever earns parks in the vault and does nothing.

**This falsifies the guarantee, not just the tuning.** `AUDIT-SCOPE.md` §4.4 and the vault's own header state
the floor is *"ADD-ONLY — there is deliberately NO remove/withdraw path, so the wall can only ever deepen.
That absence IS the 'can't rug to zero' guarantee."* The wall can only ever deepen **while the price is above
it**. In the regime the floor exists for — a token trading down — it is frozen at whatever depth it happened
to reach before the first drawdown, while fee revenue earmarked for it accumulates unusable. Nothing is stolen
and nothing is unrecoverable (a price recovery above the band un-parks it, and `addFloor` is permissionless
and balance-driven), but the advertised mechanism does not operate in the state it was built for.

**Fix direction.** The band must be able to follow the price down, which a single fixed range cannot do.
Options: (a) let `addFloor` place *new* liquidity in a fresh band below current spot when the anchor band is
unreachable — every band stays add-only, so the "can't rug" property is preserved, since no remove path is
added, only more ranges; (b) accept the limitation and restate the guarantee honestly as "a fixed buy wall at
the launch price, funded while the token trades above it"; (c) at minimum surface the parked amount so
"wall is deep" and "carve is stuck" are distinguishable. Note (c) is cosmetic on its own — and per I-1(8)
`parkedQuote` is assigned rather than accumulated, so it does not even report the parked total correctly.

---

### M-1 · MEDIUM · A presale pays buy tax on the whole target even when the curve fills a fraction of it  `PROVEN`

**Where** `contracts/presale/PresaleVault.sol:211` and `:225` (`finalize` → `unlockCallback`), against
`contracts/hooks/RobinFeeHook.sol:205-213`.

**What is wrong.** The pooled buy is one exact-input swap for the entire raise, price-limited at the
graduation ceiling. `RobinFeeHook` computes the buy fee on the **requested** input, and v4 charges the caller
the full `hookDeltaSpecified` regardless of how much executed (`v4-core/src/libraries/Hooks.sol` —
`amountToSwap += hookDeltaSpecified` in `beforeSwap`, then `swapDelta = swapDelta - hookDelta` in
`afterSwap`). When `target` exceeds curve capacity, contributors pay `buyTaxBps × target` while only a
fraction is swapped.

**Why this is not accepted design item (b).** `AUDIT-SCOPE.md` §5 accepts partial-fill over-taxing because it
is *"buyer-controlled, by design"* — the buyer chose a tight `sqrtPriceLimit`. Here the limit is the
protocol's own `gradTick`, no contributor chooses it, and the loss is socialised pro-rata. The justification
does not transfer.

**Measured.** START 6000 / GRAD 3000 / ts 60, buyTax 1%, `curveSupply` 0.2 token, `target` 3 ETH:

| | |
|---|---|
| `totalRaised` | 3.0 ETH |
| `pooledEthSpent` | 0.158817 ETH |
| buy tax booked by the hook | **0.03 ETH** — 1% of the full target |
| ETH actually swapped | 0.128817 ETH |
| honest 1% on the filled leg | 0.001288 ETH |
| **over-tax borne by contributors** | **0.028712 ETH** — 0.96% of the entire raise |
| effective rate on the filled leg | **23.29%** |

As `target / capacity` grows the effective rate is unbounded and the loss converges on the full
`buyTaxBps × target`. `test/sim/presale.sim.test.js:90` deliberately uses a *"deep-curve config"* so no
existing test reaches this state.

**Fix direction.** Have `finalize()` derive the absorbable input from `stateView.getSlot0` plus the immutable
curve geometry and swap `min(totalRaised, capacity)`, letting the remainder flow into the existing pro-rata
ETH-back. Validating `target` at `createPresale` is weaker — the FeeConfig geometry can be retuned between
create and finalize.

---

### M-2 · MEDIUM · `LockVault` has one registrar slot but three factories register launches  `PROVEN`

**Where** `contracts/core/LockVault.sol:71` (`setFactory`, one-shot), `:84` (`registerLaunch` gate). Callers:
`core/PadFactory.sol:187`, `core/StockPadFactory.sol` (launch step 4), and `pads/RobinCurveV4.sol:360` →
`core/CurvePadFactoryV4.sol:243`.

**What is wrong.** One `LockVault` can serve exactly **one** of the three factories, and nothing on-chain
detects a mismatch — not in any constructor (the factory↔vault cycle makes that impossible) and not in
`launch()`, where it would be trivial.

The failure modes are asymmetric, and that is the whole problem. `PadFactory` / `StockPadFactory` call
`registerLaunch` **inside** `launch()`, so a miswire reverts the launch: loud, immediate, harmless.
`CurvePadFactoryV4` calls it only at **graduation**, via `RobinCurveV4.graduate()` step 5, **not** wrapped in
try/catch. A miswire is invisible for the pad's entire life and then bricks it permanently, after it has
collected a real raise.

**Measured.** Point a shared `LockVault` at a `PadFactory` (`setFactory` then reverts `FactoryAlreadySet` for
the curve factory — there is no second chance). Launch a curve pad: **succeeds, no warning**. Let traders buy
the curve out. `curve.ready()` returns `true`; `curve.graduate()` reverts `NotFactory` for every caller,
forever. The raise is still inside the curve's Uniswap position — only `_graduatePull` can remove it, and it
is reachable *solely* from `graduate()` — and the reserve tokens sit on the curve with no exit
(`flushStaking` is gated on `graduated`). Both unrecoverable. No admin path, no rescue, no migration.

**Mitigating:** `scripts/deploy.js` and `scripts/deploy-curve.js` each deploy their own `LockVault`, so the
shipped happy path is correct today. This is a one-wrong-address failure with an unbounded blast radius and no
on-chain guard.

**Fix direction.** Any one closes it; the first is two lines:
- `if (lockVault.factory() != address(this)) revert NotRegistrar();` at the top of `CurvePadFactoryV4.launch`
  (and the other two).
- Make `LockVault` multi-registrar: `mapping(address => bool) isFactory`, managed by `initializer`.
- Wrap `onGraduated` in try/catch **plus** a permissionless deferred-registration path — the try/catch alone
  is not enough, or the locked LP's fee stream is stranded instead of the raise.

---

### M-3 · MEDIUM · `PadFactory` lets the launcher set their own taxes and point every revenue stream at themselves

**Where** `contracts/core/PadFactory.sol:56-61` (`LaunchConfig`), `:116-118` (the only validation),
`:171-175` and `:187` (values passed straight into `registerPool` / `registerLaunch`).

`PadFactory.launch` validates the dynamic-fee flag, a non-zero creator, a non-zero supply and
`lpTokenAmount <= supply`. It validates **nothing** about `buyTaxBps`, `sellTaxBps`, `sellFloorShareBps`,
`floorRecipient` or `stakingRecipient` — all five are caller-supplied and stamped immutably. The only ceiling
is the hook's own `MAX_TAX_BPS = 300` (`RobinFeeHook.sol:49`) and `sellFloorShareBps <= BPS` (`:142`).

A pad launched through `PadFactory` can therefore carry **3% buy + 3% sell**, with **100% of the sell tax
routed to an address the launcher chose** — labelled, in the hook's own storage and in every doc, as "the
floor" — and with the locked LP's token-side fee stream (`stakingRecipient`) pointed anywhere as well.

This is the opposite of the trust model the suite is sold on. `CurvePadFactoryV4.sol:29-33` states: *"every
economic parameter … is read from `feeConfig.defaults()` and stamped immutably here — NEVER taken from the
caller. So a launcher can never set their own tax."* True of `CurvePadFactoryV4`, false of `PadFactory`, and
both are in scope in the same repo behind the same brand. `RobinV4FeeConfig`'s caps (`MAX_TAX_BPS = 200`,
`MAX_FLOOR_SHARE_BPS = 5000`) — the caps the governance story rests on — are simply not on this path.

**Fix direction.** Decide what `PadFactory` is. If it is a governed launchpad, read its taxes from
`RobinV4FeeConfig` like the curve factory does. If it is a permissionless primitive, say so explicitly in
`AUDIT-SCOPE.md` and in the front end, and at minimum bound `sellFloorShareBps` so the "floor" label cannot be
100% launcher revenue.

---

### M-4 · MEDIUM · `RobinFloorVault`'s band anchor is an unverifiable deploy parameter, and the band is permanent

**Where** `contracts/pads/RobinFloorVault.sol:77` (ctor `anchorTick`), `:95`
(`_alignUp(anchorTick + 1, tickSpacing_)`).

The floor band is derived from an `anchorTick` a human types in. The constructor validates only that the
resulting band lands inside the usable tick range. It never checks that the anchor relates to the pool it is
*also* handed (`currency0/currency1/fee/tickSpacing/hooks`), nor that that `PoolKey` corresponds to an
initialised pool at all. Because the vault is **add-only by design** — no remove, withdraw or burn path
exists, and that absence *is* the "can't rug to zero" guarantee — a wrong anchor is permanent. Every carve
routed there is deployed into a band that can never be moved, reclaimed or turned off. The anchor also
determines what "floor" economically *means* for that pad (at the launch price it is ~10× below the graduation
price at production geometry; near `gradTick` it overlaps the ambush band), and nothing records the intent.

**The sibling was already hardened against exactly this.** `RobinAmbushVault.sol:108` carries an `[H1]` note —
*"Anchor to the curve's IMMUTABLE `gradTick()` read on-chain — never a passed hint, never a live spot"* — and
its constructor takes `curve_` and reads it. `RobinFloorVault` never received the same treatment. The deploy
runbook even reassures the reader that the ambush reads its anchor on-chain
(`scripts/deploy-curve.js:121`) while saying nothing about the floor's, which is the one a human must get
right.

**Compounding.** `RobinFeeHook.setFloorRecipient` (`:383-391`) is platform-only and one-shot and — unlike
`RobinCurveV4.setStaking` / `setFloor` / `setAmbush` (`:447` / `:457` / `:467`) — does **not** require the
recipient to have code. The sell-tax floor carve can be permanently pointed at an EOA or a wrong-pool vault in
one transaction, with no undo. `ROBIN-V4-CURVE-ECON.md:62` tells the reader these setters' *"targets must be
contracts"*. Not true of `setFloorRecipient`.

**Fix direction.** Give `RobinFloorVault` the ambush treatment — take the curve (or another on-chain source of
the pad's launch tick) and read the anchor on-chain — and assert the pool is initialised via
`stateView.getSlot0` in the constructor. Add the `code.length != 0` check to `setFloorRecipient`.

---

### M-5 · MEDIUM · `DualStaking`'s owner can reach existing stakers' principal and already-accrued rewards  `PROVEN`

**Where** `contracts/pads/DualStaking.sol:471` (`setAntiJitDelay`), `:477` (`setPlatformClaimFee`), `:466`
(`setBoostOracle`); enforced at `:307` (`unstake` reads the **current** `antiJitDelay` against a `stakedAt`
recorded earlier) and `:343` (`claim` applies the **current** fee to the whole accrued balance).

Both setters are retroactive, and `StakingFactory.createPool` hands ownership to `platformOwner`
(`StakingFactory.sol:59`) with `antiJitDelay` documented as *"no lock by default"* (`:12-13`).

**Measured.**
- Deploy with `antiJitDelay = 0`. Alice stakes 1,000 and unstakes freely, as advertised. The owner calls
  `setAntiJitDelay(7 days)` → Alice's *already-staked* principal reverts `Locked` for seven days.
- Alice stakes 1,000; the owner funds 10 ETH while `platformClaimFeeBps == 0`; the full 7-day window elapses;
  Alice has earned **9.9999999999996768 ETH**. The owner then calls `setPlatformClaimFee(1000)`. Alice's claim
  pays **8.9999999999997091** — **0.9999999999999677 ETH** taken from rewards that accrued entirely under a 0%
  promise.
- Not tested but plain from the code: `setBoostOracle` can point at an oracle returning `MAX_BOOST_BPS` (4×)
  for a chosen address, and `sync(side, user)` is permissionless, so the owner can quadruple its own weight and
  dilute every honest staker's share by up to 4×.

**Why it matters beyond "the owner is trusted".** `AUDIT-SCOPE.md:66` and `ROBIN-V4-CURVE-ECON.md:62` both
tell the auditor that *"a compromised platform wallet can mis-route only the platform's OWN cut, never user
principal."* `pads/DualStaking.sol` and `pads/StakingFactory.sol` are in scope, and on that path a compromised
owner can freeze user principal for up to 7 days, take up to 10% of rewards earned under a 0% promise, and
dilute the stream 4×. Direct theft of principal is **not** possible — `_payout` is reachable only from
`claim` / `claimPlatformFees`, and principal moves only in `unstake` to `msg.sender` — so a bound exists, but
it is not the bound the docs state.

**Fix direction.** Snapshot `antiJitDelay` into the position at stake time (or apply a raise only to later
stakes); snapshot `platformClaimFeeBps` at accrual rather than at claim; timelock `setBoostOracle`. And
correct `AUDIT-SCOPE.md` §6 to describe these powers.

---

### M-6 · MEDIUM · The architecture doc handed to the external auditor describes a materially different system

**Where** `ROBIN-V4-ARCHITECTURE.md` (30 KB), listed as required reading by `AUDIT-SCOPE.md:6`.

| Doc claims | Shipped code |
|---|---|
| *"a platform/creator/holder **3-way** afterSwap fee split"* + *"the **holder O(1) bucket**"* (`:33`, `:51`, `:99`) | `RobinFeeHook` has no holder bucket. It is directional: buy taxed fee-on-input in `beforeSwap`, sell taxed from output in `afterSwap`; books are platform / buffer / referral / creator / floor. |
| *"a **USDG-yield ERC-4626** locked floor"* with `totalAssets`, `convertToShares`, `availableRewardsOf`, and a resolved first-depositor inflation attack (`:187`, marked `[RESOLVES C3]`) | `RobinFloorVault.sol:25`: *"Not a vault-with-shares: nobody deposits, nobody redeems, no USDG is ever trapped."* None of those functions exist. |

Symbol counts against `contracts/`: `convertToShares` 1 doc / **0** code; `availableRewardsOf` 3 / **0**;
`totalAssets` 4 / 1 (a stale comment, `RobinStateView.sol:10`); `USDG` 20 / 4 (all four stale comments).

**This is a live code artifact, not only a doc problem.** `DualStaking` still carries the wiring for that
removed hook: `IHookWeightSink` (`:16`), `hook`/`poolId`/`weightedSide`/`hookWired` (`:61-64`), and
`hook.onWeightChange(...)` in `_reweigh` (`:271-273`), with NatSpec (`:35-38`) telling integrators *"this
contract reports that side's boosted weight to the hook so the hook's 3-way holder cut streams to those
stakers."* `onWeightChange` is implemented **only by `contracts/test/MockWeightSource.sol`** — `RobinFeeHook`
does not have the selector. `StakingFactory.createPool` always passes `hook_ = address(0)`
(`StakingFactory.sol:51`), so the path is inert in the shipped flow, but `DualStaking`'s constructor is public
and the machinery advertises a reward stream this suite cannot deliver.

**Why MEDIUM rather than informational.** An auditor briefed on a 3-way holder-accumulator hook and an
ERC-4626 share vault will hunt for share-inflation and accumulator bugs in code that does not exist, and will
not look hard at the fee-on-input ERC-6909 claim path that actually holds the money. A misdirected audit is
worse than none.

**Fix direction.** Rewrite or retire `ROBIN-V4-ARCHITECTURE.md` before the package goes out —
`ROBIN-V4-CURVE-ECON.md` is accurate and can be the basis. Delete the dead `IHookWeightSink` wiring from
`DualStaking`, or implement it. Fix `RobinStateView.sol:10` and `DualStaking.sol:35-38`.

---

### M-7 · MEDIUM · The curve-pad runbook never wires the hook's floor recipient, so the sell-tax floor carve accrues to nobody

**Where** `contracts/core/CurvePadFactoryV4.sol:187` (registers `floorRecipient: address(0)`, by design — the
vault does not exist yet), `contracts/hooks/RobinFeeHook.sol:383` (`setFloorRecipient`, the only way to point
it anywhere), `scripts/deploy-curve.js:119-122` (the shipped post-launch runbook).

Step 3 of that runbook lists `curve.setStaking(staking) / curve.setFloor(floor) / curve.setAmbush(ambush)` —
and **not** `hook.setFloorRecipient(...)`. Nothing else in `scripts/` or `DEPLOY.md` calls it on the curve path
(`scripts/launch.js:90` does, but that is the `PadFactory` path).

Follow the runbook exactly and every curve pad accrues its `sellFloorShareBps` carve into
`hook.floorOwed[id][0]` indefinitely, with `claimFloor` reverting `NoFloorRecipient` (`:342`). The funds are
not lost — a later `setFloorRecipient` makes the parked balance claimable — but the pad's advertised floor is
unfunded from the sell side for as long as it is missed, and the miss is silent.

This is also the second of the two independent floor wirings: `curve.setFloor` (buy-side LP carve) is in the
runbook, `hook.setFloorRecipient` (sell-tax carve) is not, nothing requires them to name the same address, and
both are one-shot. The same shape recurs for staking: `RobinCurveV4.setStaking` and
`LockVault.setStakingRecipient` are separate one-shot platform calls for one concept, each silently defaulting
to "platform gets it" if missed.

**Fix direction.** Add `hook.setFloorRecipient` to the runbook and to a scripted post-launch wiring step that
asserts all of the one-shots are set together and consistently.

---

### M-8 · MEDIUM · The entire `StockPadFactory` launch path has zero executed local coverage  `PROVEN`

**Where** `contracts/test/MockPositionManagerV4.sol:48-54` vs `contracts/core/StockPadFactory.sol:218`.

The mock unconditionally decodes `params[2]`, because it was written against the 3-action batch
`MINT_POSITION, SETTLE_PAIR, SWEEP` that `PadFactory` (`:228`) and `RobinCurveV4` (`:639`) emit.
`StockPadFactory._mintSeedLp` emits only **two** actions, so the mock dies on `panic 0x32` (array
out-of-bounds) before doing anything:

```
panic code 0x32 … at MockPositionManagerV4.modifyLiquidities (contracts/test/MockPositionManagerV4.sol:54)
                  at StockPadFactory._mintSeedLp (contracts/core/StockPadFactory.sol:226)
```

`StockPadFactory` therefore cannot be exercised at all in the default suite, and its only test
(`test/fork/StockPadFactory.launch.fork.test.js`) calls `this.skip()` unless `FORK_RPC` is set. The 130-test
baseline executes **no** stock-pad launch — so H-2 is untested in both directions: nothing confirms the path
works either.

Related and worth flagging in the hand-off: the mock also **ignores `amount0Max` / `amount1Max` entirely** (it
decodes those fields as `,,`), so the real `PositionManager`'s slippage caps are unexercised outside the fork
suite. §4 has the numerical check that closes that specific risk.

**Fix direction.** Make the mock decode by action byte rather than by fixed index, and add a local
`StockPadFactory` launch test.

---

### M-9 · MEDIUM · The creator repoint covers the hook's book but not the curve's

**Where** `contracts/hooks/RobinFeeHook.sol:406-420` (2-step repoint) vs
`contracts/pads/RobinCurveV4.sol:106` (`address public immutable creator`) and `:250-260` (`claimCreator`).

The hook gives the creator a proper 2-step repoint, so the sell-tax stream can always be redirected. The
curve's creator is `immutable`, and `claimCreator` pays it unconditionally:

```solidity
(bool ok,) = payable(creator).call{value: c}("");
if (!ok) { creatorEthOwed = c; revert EthSendFailed(); }
```

There is no repoint, no `claimCreatorTo`, and no other exit — `sweepToPlatform` explicitly subtracts
`creatorEthOwed` (`:285`), so the balance stays reserved forever. If the creator address is a contract that
reverts on ETH receive, a multisig later retired, or a lost key, the creator's **10% share of the raise is
permanently trapped** while the sell-tax stream keeps flowing to the repointed address.

`AUDIT-SCOPE.md:69` lists *"creator repoint is 2-step"* among the access-control invariants without noting it
covers only the hook's book.

**Fix direction.** Have `RobinCurveV4.claimCreator` read the creator from the hook
(`RobinFeeHook.config(poolId).creator`) so one repoint governs both — the curve already knows the hook and the
pool id. Failing that, add `claimCreatorTo(address)` callable by the current creator, and correct the
invariant text.

---

---

### M-10 · MEDIUM · The 2% tax cap is cosmetic: `lpFee` is capped only at Uniswap's 100%, and routes mostly to the platform

**Where** `contracts/core/RobinV4FeeConfig.sol:22` (`MAX_LP_FEE = 1_000_000`), `:101` (`_validate`'s only
`lpFee` check), consumed at `contracts/core/CurvePadFactoryV4.sol:166` (`fee: uint24(d.lpFee)` in the
`PoolKey`).

`_validate` enforces `buyTaxBps`/`sellTaxBps` ≤ `MAX_TAX_BPS = 200` — the 2%-per-side ceiling the trust story
rests on — and then permits `lpFee` up to **1,000,000 = 100%**, checking only that the dynamic-fee flag is
clear. But the pool's LP fee is not neutral revenue on a Robin pad: it accrues to positions the protocol
itself owns.

- **Curve phase:** the only in-range liquidity is the curve's own single-sided position, so the whole LP fee
  lands there. `RobinCurveV4._takeFeesToBook` (`:603-620`) splits the money-side leg
  `buyLpFloorShareBps` → floor, remainder → `platformEthOwed` (80/20 at production settings), and keeps the
  token leg for staking.
- **Post-graduation:** the permanent LP is owned by `LockVault`, whose `collectFees` books currency0 to
  `platformOwed` and currency1 to `stakingOwed` (`core/LockVault.sol:124-125`).

So `lpFee` is a second, uncapped tax on exactly the same trades, and its money-side share is predominantly
platform revenue. A FeeConfig owner can launch pads carrying an effective double-digit or higher levy while
`AUDIT-SCOPE.md` §3 and `RobinV4FeeConfig`'s own header advertise a ≤2%-per-side ceiling.

Reachability is owner-only and forward-only — live pads keep the fee they were born with, the change emits
`DefaultsUpdated`, and the pool fee is publicly readable in the `PoolKey` — so this is observable, not
stealthy, and it is not theft from existing holders. It is reported above a plain "the owner can set a fee"
note for three reasons:

1. **The contract leans on the false claim to justify having no timelock.** `RobinV4FeeConfig.sol:12-14`:
   *"Hard caps below bound what any future launch can carry, so even a compromised/fat-fingered owner cannot
   push a new pad's tax past the ceiling … so there is no timelock."* The caps do not bound `lpFee`, so the
   premise of the no-timelock argument is wrong.
2. **`DEPLOY.md:60` repeats the error at the system level** — *"The only mutable knob system-wide is
   `FeeWalletRegistry.platformFeeWallet` (Ownable2Step + 2-day timelock)."* `RobinV4FeeConfig.setDefaults` is
   a second mutable knob, `onlyOwner` with **no** timelock, and it governs both the fee and the geometry (see
   L-1). Same misstatement as L-6.
3. **`CurvePadFactoryV4.launch` is permissionless**, so between a bad retune and anyone noticing, unrelated
   third parties can launch pads that permanently carry the new fee.

**Fix direction.** Add a real ceiling: `MAX_LP_FEE` should be a Robin policy number (e.g. 10,000 = 1%), not
Uniswap's structural maximum. If a high `lpFee` is ever intended, state the *combined* effective take in
`AUDIT-SCOPE.md` §3 rather than the hook taxes alone.

### M-11 · MEDIUM · The locked LP's holder fees default to the platform, and on the curve path nothing ever wires them away  `PROVEN`

**Where** `contracts/core/LockVault.sol:81-89` (`registerLaunch` stores `stakingRecipient` verbatim, no zero
check), `:107` (`collectFees`, permissionless), `:143-153` (`claimStaking`, permissionless), specifically
`:149`:

```solidity
address to = lk.stakingRecipient == address(0) ? feeRegistry.platformFeeWallet() : lk.stakingRecipient;
```

**Reachability is the shipped default, not an edge case.** `RobinCurveV4.graduate()` registers the lock with
whatever `curve.staking` holds at that instant (`pads/RobinCurveV4.sol:360`), and `deploy-curve.js:121` tells
the operator to call `curve.setStaking(...)` *"at/near graduation"* — so registering with
`stakingRecipient == address(0)` is the normal outcome. Wiring it afterwards requires
`LockVault.setStakingRecipient`, a **second, separate** platform one-shot which appears **zero times in
`scripts/deploy-curve.js` and zero times in `DEPLOY.md`**. On the curve path — the flagship product — nothing
ever tells anyone to make that call. The default is therefore permanent, and every `claimStaking(tokenId, 1)`
routes the locked LP's token-side (sell) fees, an advertised holder reward stream, to the platform treasury
forever.

The `PadFactory` path is better documented but still has a window: `scripts/launch.js:52` passes
`stakingRecipient: ZeroAddress` into `launch()`, and `setStakingRecipient` only happens at `:102`, three
transactions later.

**The likely trigger is the project's own keeper, not a griefer.** `scripts/keeper.js:53` calls
`lockVault.claimStaking(L.lpTokenId, 1)` unconditionally in its sweep loop, and every step is wrapped in
`tryStep` (`:24-32`), which catches, prints a tick, and moves on. So an unwired pad is swept silently, the
operator sees `✓ staking LP (token) -> keeper`, and the fees are irreversibly at the treasury instead.

**Two corrections to the obvious framing.**

1. **It is misrouting, not theft, and the caller gains nothing.** Funds always land at
   `feeRegistry.platformFeeWallet()` — the 2-day-timelocked treasury. A griefer would pay gas to enrich the
   platform, and the platform gains nothing it did not already have, since it holds the one-shot
   `setStakingRecipient` and could simply point it at itself. The harm is that an outsider (or an honest bot)
   can pre-empt the platform's intent to route those fees to stakers, irreversibly.
2. **`collectFees` alone is safe.** It only credits `stakingOwed[tokenId][1]`; nothing leaves the vault. If
   nobody calls `claimStaking` during the unwired window, the whole accrual survives `setStakingRecipient`
   and pays the real recipient in full. The exposure is exactly the balance owed at the moment someone calls
   `claimStaking` — which is why the keeper matters more than the griefer.

Note the intended design: `stakingRecipient` is a *reward-keeper EOA*, not the pool. `launch.js:102` points it
at `rewardKeeper`, and `keeper.js:56-59` has that keeper forward the tokens on via `pool.fundToken(...)`.

**Fix direction.** Make the unwired case *park* rather than pay: revert `claimStaking` (or accrue) while
`stakingRecipient == address(0)`, exactly as `RobinFeeHook.claimFloor` already does with `NoFloorRecipient`
(`hooks/RobinFeeHook.sol:342`). That one change removes the silent-misroute hazard entirely and makes the
missing runbook step fail loudly instead of expensively. Independently, add `LockVault.setStakingRecipient` to
the curve runbook and to `DEPLOY.md` — see M-7 for the identical omission on the floor side.

---

### M-12 · MEDIUM · A presale's launch geometry is read at finalize, so an in-cap retune can leave the coin permanently un-graduatable  `PROVEN`

**Where** `contracts/presale/PresaleVault.sol:196-206` (`finalize` re-reads
`RobinV4FeeConfig(curvePadFactory.feeConfig()).defaults()`), `contracts/core/CurvePadFactoryV4.sol:118-122`
(`launch` derives `startTick`/`gradTick` from the same live struct), against
`contracts/core/RobinV4FeeConfig.sol:76` (`setDefaults`, `onlyOwner`, no timelock).

**What is wrong.** A presale commits its `LaunchConfig` at `createPresale` — but that struct
(`interfaces/ICurvePadFactoryV4.sol:8-17`) carries only name/symbol/decimals/supply/curveSupply/
reserveSupply/tickSpacing/creator. **No geometry.** `startTickMag`, `curveWidth` and `lpFee` — the values that
set the launch price — are read live at finalize, and `saltCommitment` covers only the three CREATE2 salts.
`PresaleVaultFactory.sol:12` states the deferral as a design choice (*"Heavy geometry/reserve validation is
deferred to `CurvePadFactoryV4.launch()` at finalize"*) without noting that it defers the price with it.

Nothing catches the change. `finalize`'s `KeyMismatch` guard (`:204`) **structurally cannot fire** — it
rebuilds the key from the same live struct `launch` just used, in the same transaction. There is no
min-tokens-out, no expected-geometry argument, and only `ZeroBought` (`:215`) as a sanity check. Contributors
have no exit they control: no withdraw function, and once `totalRaised == target`, `fail()` reverts
`TargetMet` (`:282`) until deadline + grace.

**The impact is not the pro-rata repricing — that part is nearly harmless.** The retune is *homothetic*: it
rescales the whole curve, so contributors buy the same slice of curve progress in a different denomination.
Measured realizable value destruction (claim, then instantly round-trip back into the same curve) is **3.44%
at baseline versus 3.60% after a −6,600-tick retune — an incremental 0.16pp, ~0.006 ETH on a 4.05 ETH raise**.
The 3–4% floor is the unavoidable fee stack, present either way. A "contributors lost N%" framing would be
wrong, because the token count falls and the unit price rises together.

**The real harm is that the reachable range is enormous, and one end of it kills the coin.** The only binding
constraints are `_validate` (`startTickMag > 0`, `curveWidth > minGradWidth > 0`),
`CurvePadFactoryV4.sol:120` (tick-spacing alignment), `:131` (tick bounds), and `:140`
(`reserveSupply·ss·100 >= curveSupply·sg·105`) — **and that last check constrains `curveWidth` only, never
`startTickMag`.** Measured at production geometry (201600 / 23000 / ts 100, 1B supply at 730M + 270M, 2 ETH
deposited):

| `startTickMag` at finalize | tokens the presale receives | outcome |
|---|---|---|
| 201600 (baseline) | 545,546,800 (74.73% of the curve) | normal |
| 195000 | 374,333,692 (51.27%) | −31% token count, ~unchanged ETH value |
| **100** (lowest that still passes every check) | **1.979899 tokens** (−99.9999996%) | graduation raise becomes ~5.6×10⁸ × 4.05 ETH — **the coin can never graduate** |
| 400000 | 99.99% of the curve for 0.020 ETH | harm runs the *other* way: the pad graduates on a 0.02 ETH raise |

Every case finalized cleanly — no revert, `KeyMismatch` never tripped, `state() == 1`, `claim()` paid at the
new price. At the low end the pad is permanently dead: contributor ETH has been spent into a curve that can
never sell out, so there is no locked LP, no staking stream and no graduation waterfall, ever. At the high end
the curve is given away for almost nothing.

**This is a centralization and operational footgun, not an attack.** The owner is negative-EV in the harmful
direction — forfeiting a ~0.405 ETH graduation cut to collect ~0.032 ETH of buy tax — so the realistic trigger
is an *honest, in-cap retune landing while presales are open*: precisely the operation
`CurvePadFactoryV4.sol:29-32` advertises as safe. And `RobinV4FeeConfig.sol:13-14`'s justification for having
no timelock — *"forward-only and can never touch an existing coin"* — is simply false about ETH already
sitting in a presale vault. That sentence is the defect being documented.

**Fix direction.** Snapshot `startTickMag` / `curveWidth` / `lpFee` into the vault at `initialize` and pass
them to `finalize` as expected values, reverting on mismatch — or fold them into `saltCommitment` so any
change is detectable. Correct `RobinV4FeeConfig.sol:13-14` regardless. Note that `DefaultsUpdated` *is*
emitted, so the change is observable on-chain; what is missing is any contract that acts on it, and any way
for a contributor to react before their ETH is spent (a preimage-holder can withhold `finalize` and let
`fail()` reason 2 open refunds after deadline + grace, but contributors cannot force that).

---

### M-13 · MEDIUM · Permissionless `flushStaking()` launders a dust poke through `DualStaking`'s rewarder gate and stalls the drip  `VERIFIED`

**Where** `contracts/pads/RobinCurveV4.sol:395-403` (`flushStaking`, permissionless) →
`contracts/pads/DualStaking.sol:428-440` (`fundTokenPushed`, rewarder-gated) → `:246-252` (`_applyReward`
with `extend = true`).

`DualStaking` gates `fundTokenPushed` on `isRewarder[msg.sender]` precisely so that funding cannot be spammed.
But the pad's curve **is** registered as a rewarder in practice — `scripts/testnet-e2e-graduate.js:95` does
`ds.setRewarder(curveAddr, true)`, as do `test/fork/CurveGraduation.fork.test.js:83`,
`test/fork/MainnetSwarm.fork.test.js:147`, `test/unit/RobinCurveV4.graduation.test.js:65` and three more. And
`RobinCurveV4.flushStaking()` is **permissionless**, forwarding straight into that gated call.

The curve is therefore a confused deputy: anyone can call `flushStaking()` and have the rewarder gate treat it
as an authorised funding. And `_applyReward` on the `extend = true` path resets the window —
`r.periodFinish = uint64(block.timestamp + dur)` — so each poke pushes the finish line out by a full duration
and re-divides the remaining reservoir over it. A griefer holding dust pokes it repeatedly and the holder
reward stream is stretched indefinitely, arbitrarily slowing every staker's accrual.

This is exactly the grief `RobinLockStaking._startDrip`'s `[audit]` comment was written to prevent — *"if a
top-up reset the window a griefer could dust-fund (1 wei) repeatedly to re-stretch the undripped reservoir
over a fresh full duration each time"* — and `DualStaking` is exposed to it through a relay the note did not
consider.

**Note the tension with L-2.** L-2 records that a curve *not* wired as a rewarder cannot credit its
graduation stream at all and that `flushStaking()` reverts `NotRewarder` for everyone. The operational fix for
L-2 — `setRewarder(curve, true)`, which the testnet script already does — is precisely what opens this. The
two must be fixed together.

**Fix direction.** Either gate `flushStaking()` (platform- or creator-only; it is a recovery path, not a hot
path), or have it call a non-extending variant, or make `DualStaking._applyReward`'s pushed path behave like
`RobinLockStaking._startDrip`'s mid-window branch and leave `periodFinish` fixed. The last is the most
consistent with the rest of the suite.

---

### M-14 · MEDIUM · The idempotent-init try/catch reports every `initialize` failure as `PoolAlreadyInit`, and `tickSpacing` is unbounded  `VERIFIED`

**Where** `contracts/core/CurvePadFactoryV4.sol:120` (the only `tickSpacing` check) and `:170-175` (the
idempotent-init try/catch); same shape in `core/PadFactory.sol` and `core/StockPadFactory.sol`.

Two defects that compound.

**The bound is missing.** v4 requires `1 <= tickSpacing <= 32767`
(`v4-core/src/PoolManager.sol:119-120`, `MAX_TICK_SPACING = type(int16).max`). The factory checks only
`ts <= 0`:

```solidity
if (ts <= 0 || d.startTickMag % ts != 0 || d.curveWidth % ts != 0) revert BadGeometry();
```

So a `tickSpacing` of, say, 40000 passes every factory check — positive, and it divides both governed geometry
values — and then reverts inside `poolManager.initialize` with `TickSpacingTooLarge`.

**The diagnosis is then destroyed.** That revert lands in the `[MEDIUM-3]` idempotent-init catch, which
re-reads `getSlot0` and reverts `PoolAlreadyInit` unless the price matches. For a pool that was never
initialised `sqrtPriceX96` is 0, which never matches, so the launch fails with **`PoolAlreadyInit` — an error
saying someone front-ran you, when in fact your own config is invalid.** The catch is not selective: *any*
`initialize` failure (bad tick spacing, bad fee, hook-validation failure) surfaces under the same wrong error.
An operator has no way to tell a genuine front-run from a malformed launch.

**It reaches contributor funds through the presale.** `PresaleVaultFactory` explicitly defers *"heavy
geometry/reserve validation … to `CurvePadFactoryV4.launch()` at finalize"* (`:12`), and `cfg.tickSpacing` is
caller-chosen at `createPresale` with no validation. A presale opened with an out-of-range spacing takes
deposits normally and can never finalize: `launch` reverts, `finalize`'s snipe catch-all marks it `Failed(3)`,
and per L-9 that is irreversible. Contributors are refunded, but the launch is dead and the stated cause is
wrong twice over.

**Fix direction.** Bound `tickSpacing` to `[1, 32767]` at `:120` — it is a one-line check against a constant
v4 already exports. Separately, make the catch selective: only treat the failure as a pre-init if
`getSlot0` shows a *non-zero* price, and otherwise bubble the original revert so the real cause survives.

---

### M-15 · MEDIUM · `DeterministicDeployer` silently confiscates `msg.value` on the adopt path  `VERIFIED`

**Where** `contracts/core/DeterministicDeployer.sol:31-33`.

```solidity
function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address addr) {
    address predicted = addressOf(salt, keccak256(initCode));
    if (predicted.code.length != 0) return predicted;   // msg.value is kept, not refunded
```

The function is `payable` and the adopt path returns without refunding. The contract has **no `withdraw`, no
`receive`, no owner and no sweep**, so anything sent on that path is permanently destroyed. The NatSpec is
aware of the gap and stops short of closing it: *"(No value is forwarded on adoption; our callers deploy
value-free.)"*

That parenthetical is true of Robin's own callers, which is why no protocol funds are at risk. But the same
NatSpec designates this contract as ecosystem infrastructure — *"its address is then pinned as a constant
everywhere hook-address mining happens"* — and `deploy` is permissionless, so third-party integrators are an
expected user. An integrator deploying a payable contract that funds itself in its constructor
(`deployer.deploy{value: 1 ether}(salt, initCode)`) can be front-run by anyone who calls `deploy` with the
same `initCode` first: the victim's call then takes the adopt branch and the 1 ether is gone, with the
attacker spending only gas.

**Fix direction.** Refund on the adopt path (`if (msg.value > 0) msg.sender.call{value: msg.value}("")`), or
simply make `deploy` non-payable and add a separate `deployWithValue` for callers that need it. Either way the
NatSpec should state the hazard rather than note the assumption.

---

### M-16 · MEDIUM · `platformFeeWallet` is the protocol's root admin key, not merely a payout address

**Where** `contracts/core/FeeWalletRegistry.sol` (the wallet), used as the **authorization** check in
`contracts/pads/RobinCurveV4.sol:447` / `:457` / `:467` (`setStaking` / `setFloor` / `setAmbush`),
`contracts/hooks/RobinFeeHook.sol:383` (`setFloorRecipient`) and `contracts/core/LockVault.sol:92`
(`setStakingRecipient`).

Every document describes this address as a destination. `FeeWalletRegistry`'s own header calls it *"THE ONLY
mutable knob in the entire Robin V4 system … only this one address"* and stresses *"no fee-rate change, no
pause, no fund movement, no LP path here."* `DEPLOY.md:60` repeats it. But the same address is also the
**capability** that binds, one-shot and irreversibly, every one of a pad's value sinks: where the sell-tax
floor carve goes, where the buy-LP floor carve goes, where the ambush share goes, where the staking stream
goes, and where the locked LP's token-leg fees go.

At launch all five are `address(0)` — the runbook wires them afterwards (`scripts/deploy-curve.js:119-122`) —
so whoever controls `platformFeeWallet` in that window permanently determines each one, with no undo and no
timelock on the *use* of the capability. (The 2-day timelock in `FeeWalletRegistry` governs *changing* the
wallet, not what the wallet can do.) Combined with M-4 — `setFloorRecipient` does not even require the target
to be a contract — a single transaction from that key can permanently point a pad's floor at an EOA.

This is the unifying statement behind M-4, M-7 and M-11, and it matters because it changes what an auditor
must assume about key management: the platform fee wallet needs the operational security of a root admin key,
not of a treasury receiving address.

**Fix direction.** Separate the roles — an `admin` (or the existing `Ownable2Step` owner) for the one-shot
wiring, and `platformFeeWallet` purely as a destination. If they must stay unified, say so plainly in
`AUDIT-SCOPE.md` §6 and `DEPLOY.md`, and drop the "only this one address / no fund movement" framing.

---

### M-17 · MEDIUM · `RobinFloorVault` pins the platform wallet as an immutable, defeating the registry's rotation, and pays it inline under the pool lock  `VERIFIED`

**Where** `contracts/pads/RobinFloorVault.sol:45` (`address public immutable feeRecipient`), `:169-170`
(`_collect` takes straight to it).

**It cannot be rotated.** `feeRegistry` / `platformFeeWallet` appear **zero times** in this contract — it is
handed a raw address at deploy (`scripts/launch.js:85` passes `platform`) and stores it `immutable`. That
defeats the mechanism `FeeWalletRegistry` exists to provide; its NatSpec is explicit: *"The hook reads
`platformFeeWallet()` at accrual/claim time (forward-only), so a repoint only affects fees claimed after it
commits."* Every other consumer in the suite reads it live. So if the platform multisig is compromised and the
registry is rotated through its 2-day timelock, every floor vault ever deployed keeps paying its LP fees to
the **old** address permanently — no setter, and no redeploy path, since the vault is add-only and holds a
live position.

**It pays inline under the pool lock.** `_collect` calls `poolManager.take(currency, feeRecipient, …)`
directly, sending to an external address inside the `unlock` callback. The rest of the suite is deliberately
accrue-and-pull for exactly this reason — `RobinFeeHook`'s header: *"nothing is pushed to an external wallet
inside a swap, so a reverting recipient can never block trading."* Here a recipient that reverts on receive
bricks `collectFloorFees()` for that pad, with no isolation and no fallback book.

**Fix direction.** Read `feeRegistry.platformFeeWallet()` at collect time like every other contract in the
suite, and book the fees to an owed ledger paid by a separate `claim` rather than taking to an external
address under the lock.

---

### M-18 · MEDIUM · `finalize()`'s blanket catch makes *any* failure — including an under-gassed call — a permanent, irreversible kill  `PROVEN`

**Where** `contracts/core/RobinV4FeeConfig.sol:102-105` (`_validate` bounds only signs and ordering),
`contracts/core/CurvePadFactoryV4.sol:120` / `:131` / `:140` (the launch-time geometry and reserve checks),
`contracts/presale/PresaleVault.sol:180-192` (`finalize`'s blanket `catch`).

If an owner retune leaves the *committed* `LaunchConfig` unlaunchable under the *new* geometry — a
`startTickMag`/`curveWidth` that no longer divides the presale's `cfg.tickSpacing`, or an aligned-but-narrower
`curveWidth` that trips the `reserveSupply·ss·100 >= curveSupply·sg·105` check — then
`CurvePadFactoryV4.launch` reverts. `PresaleVault.finalize` wraps that call in a catch-all written for a
different scenario (a sniped launch), so it treats the revert as a front-run and marks the presale
`Failed(3)`.

**PROVEN:** `setDefaults({...D0, startTickMag: 6030})` is accepted by `_validate`; `launch` then reverts
`BadGeometry` at `CurvePadFactoryV4.sol:120` for a presale committed with `tickSpacing = 60`; `finalize`
swallows it, sets `finalized = false` / `failed = true`, emits `Failed(3)`, and `state()` becomes 2.
**The transition is irreversible:** a retry reverts `NotOpen` even after the owner repairs the config in the
very next block. There is no un-fail path.

**Bounded, and funds are safe.** Contributors recover 100% via `refund()` / `refundTo()`, so this is an
availability failure, not a loss. The blast radius is narrower than it first appears: `cfg.tickSpacing` is
caller-chosen, so any spacing that still divides both new values launches fine — a retune is not a
launchpad-wide halt. Only presales whose committed spacing no longer divides the geometry are killed.

**The trigger set is far broader than a retune.** The handler is a bare `catch { }` (`:180-192`) with no
error-selector matching, so it absorbs *every* revert reason while its comment reasons only about a snipe. In
particular, under EIP-150's 63/64 rule an under-gassed `finalize` lets the inner `launch` run out of gas while
the outer frame survives — so an **honest caller who merely under-estimates gas permanently kills a fully
funded presale**. There is no retry: `state()` is 2 and every path reverts `NotOpen`. The same applies to any
future revert in `launch` that nobody anticipated.

Calling `finalize` requires the salt preimages, so this is not open to the public — but it is open to every
preimage-holder, and the realistic case is not malice. It is a wallet's gas estimate, or a launch that grew
gas-heavier than the estimator expected, converting a recoverable condition into an irreversible one.

**Fix direction.** Three independent improvements. (1) Match the error — treat only the specific
already-launched signatures (`AlreadyRegistered`, and the drained-factory transfer failure) as a snipe, and
let everything else bubble so the caller can retry. (2) Require a gas floor before the sub-call
(`require(gasleft() > N)`), the standard defence against a 63/64 griefing catch. (3) Make the transition
recoverable: `Failed(3)` should be re-openable while the deadline has not passed, since unlike reasons 1 and 2
it asserts a fact about the outside world that may simply be false. The geometry snapshot in M-12 removes the
retune trigger specifically, but not the class.

---

---

### M-19 · MEDIUM · The escape hatch is anchored to `deadline`, not to when the raise closed, locking contributors for up to 37 days  `VERIFIED`

**Where** `contracts/presale/PresaleVault.sol:278-291` (`fail`), against `:104-113` (`initialize`'s bounds:
`MAX_DURATION` 30 days, `GRACE_MAX` 7 days).

```solidity
if (block.timestamp <= deadline) revert BeforeDeadline();
```

`fail()` cannot fire before `deadline` under any circumstances, and `finalize()` has **no upper time bound**.
But a presale stops accepting deposits the moment `totalRaised == target` — `deposit` reverts `TargetMet`
(`:150`). So the raise can close in its first minute while the escape hatch stays shut for the full term.

At the permitted maximums — `deadline = now + 30 days`, `finalizeGrace = 7 days` — a presale that fills 60
seconds after creation leaves contributors with **no exit for ~37 days**: they cannot deposit, cannot refund
(`refund` requires `failed`), cannot claim (`claim` requires `finalized`), and cannot force the issue
(`fail` reverts `BeforeDeadline`, then `TargetMet` until deadline + grace). Meanwhile the creator holds a free
37-day option: finalize whenever the market suits, or let it lapse into reason 2.

Nothing is stolen and the refund path is intact at the end. But "trustless, refundable" is doing less work
than it appears: the refund is guaranteed *eventually*, on a clock the contributor does not control and which
is not anchored to anything they can observe.

**Fix direction.** Anchor the hatch to the raise closing, not the calendar: record `filledAt` when
`totalRaised` first reaches `target`, and let `fail()` fire at `min(deadline, filledAt) + finalizeGrace`. That
preserves the grace window's purpose — giving a preimage-holder time to finalize — while removing the dead
time between a full raise and an arbitrary deadline.

---

---

### L-1 · LOW · `RobinV4FeeConfig` accepts curve geometries whose raise floors to zero  `PROVEN (numerically)`

**Where** `contracts/core/RobinV4FeeConfig.sol:102-103` (`_validate`), with
`contracts/core/CurvePadFactoryV4.sol:120-132`.

`_validate` bounds only signs and ordering. The factory's `[D-2]`/`[D-3]` guards bound the ticks against
`minUsableTick` and `maxUsableTick - 80000` — those protect the permanent LP's token-leg pairing, not the
raise. At high start ticks the token is so cheap in ETH that the whole curve integral truncates to zero wei.

Computed with the real integer `TickMath` / `LiquidityAmounts` math (ts 100, `curveSupply` 730M,
`curveWidth` 23000):

| `startTickMag` | full-curve raise |
|---|---|
| 201600 (production) | 4.053195282705641405 ETH |
| 300000 | 216,049,609,281,871 wei |
| 400000 | 9,813,542,304 wei |
| 500000 | 445,756 wei |
| 600000 | **20 wei** |
| 700000 | **0 wei** |
| 807200 (highest `gradTick` the factory accepts) | **0 wei** |

From ~600000 up, `graduate()` reverts `EmptyRaise` (`RobinCurveV4.sol:339` or `:353`) or `BadLiquidity` in
`_mintPermanentLp` — permanently, for every caller — and the reserve has no exit either, because
`flushStaking` is gated on `graduated`. Owner-only reachability (the config is `Ownable2Step`, no timelock,
deliberately forward-only), but there is no floor and no warning, and every pad launched between the mistake
and its discovery is unrecoverable.

**Same root cause as M-12's worst case.** M-12 reaches an un-graduatable pad by moving `startTickMag` *down*
(the token becomes so expensive the curve can never sell out); this finding reaches one by moving it *up* (the
token becomes so cheap the curve sells out for 0 wei). Both are the same missing bound, and one check closes
both ends.

**Fix direction.** Bound `startTickMag` in `_validate`, or — better, because it is the property you actually
care about — have `CurvePadFactoryV4.launch` compute the curve's ETH integral for the requested `curveSupply`
and revert below a minimum. Consider a rescue path for a curve that can provably never satisfy `graduate()`.

---

### L-2 · LOW · `RobinCurveV4` and `DualStaking` disagree on who may call `fundTokenPushed`, and the documented recovery cannot work

**Where** `contracts/pads/RobinCurveV4.sol:654-663` (`_fundStaking`) and `:395-403` (`flushStaking`), against
`contracts/pads/DualStaking.sol:428-433` vs `contracts/pads/RobinLockStaking.sol:190`.

The curve calls `IStakingFund(s).fundTokenPushed(0, token)` through a shared interface whose two
implementations have opposite authorisation: `RobinLockStaking`'s is permissionless; `DualStaking`'s requires
`isRewarder[msg.sender]`, and `StakingFactory.createPool` (`:52-57`) only ever grants that to `platformOwner`
and an optional `extraRewarder` — it cannot grant it to a curve that does not exist at pool-creation time.
`RobinCurveV4.setStaking` (`:447`) accepts any contract and cannot tell them apart.

If a curve is pointed at a `DualStaking` pool, `_fundStaking` transfers the whole leftover reserve in and then
swallows the `NotRewarder` revert in its try/catch, so the tokens land uncredited. The advertised recovery
also fails: `flushStaking()` is **not** try/caught and reverts `NotRewarder` for every caller, so
*"flushStaking() completes later"* is false on this path. Recovery needs the platform to call
`DualStaking.fundTokenPushed` from an authorised rewarder — a step that appears nowhere in `DEPLOY.md`.

**Correction to the obvious fix.** `setRewarder(curve, true)` *is* the operational answer, and
`scripts/testnet-e2e-graduate.js:95` already does it — but it appears nowhere in `DEPLOY.md`, and performing
it opens **M-13** (the curve then becomes a permissionless relay through `DualStaking`'s rewarder gate). The
two findings are a pair: the wiring that makes crediting work is the wiring that makes the drip griefable.

**Fix direction.** Fix both at once. Make `DualStaking.fundTokenPushed` permissionless like its sibling (it is
measured-delta accounting, so the gate buys little), *and* stop the pushed path from resetting `periodFinish`,
per M-13. Document whichever wiring you settle on in `DEPLOY.md`; today it exists only in a testnet script.

---

### L-3 · LOW · Leftover reserve tokens have exactly one exit, gated on a platform action nothing forces

**Where** `contracts/pads/RobinCurveV4.sol:654-657`, `:395-398`, `:447-453`.

If the platform never wires `staking`, the leftover reserve at graduation parks on the curve forever — at
production geometry roughly 270M − 173M ≈ **97M tokens**, plus every token-side LP fee the curve realised.
`sweepToPlatform` (`:283`) handles only ETH. No deadline, no fallback recipient, no creator- or
holder-triggered path.

**Fix direction.** Require `staking != address(0)` before `graduate()` can run, or give `flushStaking` a
fallback sink after a grace period.

---

### L-4 · LOW · `_decodeReferrer` treats any 32-byte `hookData` as a referrer, permanently stranding the carve

**Where** `contracts/hooks/RobinFeeHook.sol:428-435`, used at `:241`.

The decoder takes the low 20 bytes of the first calldata word whenever `hookData.length >= 32` — no length
equality check, no discriminator, no magic prefix. Any router or aggregator that uses `hookData` for its own
payload silently names a pseudo-random referrer. `referralOwed[thatAddress][quote]` then holds value only that
address can claim (`claimReferral` pays `msg.sender` and nobody else, `:367`), so it is permanently stranded —
and the matching ERC-6909 claim stays minted on the hook forever, so its claim balance never fully drains.

Bounded to the platform's own cut, so no user funds are at risk; it is a silent revenue leak plus a
permanently un-reconcilable book, which matters because "the hook's ERC-6909 balance backs the buy books
exactly" is an invariant you want to be able to assert cleanly.

**Fix direction.** Require `hookData.length == 32`, or a 4-byte magic prefix followed by the address.
Optionally add a platform sweep for referral balances untouched for N days.

---

### L-5 · LOW · Buy-tax "buffer" NatSpec says LP/staking in three places; the code routes it to the platform

**Where** `contracts/core/RobinV4FeeConfig.sol:26` (*"a slice of the BUY tax stays in the curve as a liquidity
buffer (softens price impact + deepens the permanent LP)"*), `contracts/core/CurvePadFactoryV4.sol:226`
(*"hardens the LP-binding reserve + deepens staking"*), `contracts/hooks/RobinFeeHook.sol:74` (*"the curve → permanent LP"*).

`graduate()` pulls the buffer **before** the `donatedBefore` snapshot (`RobinCurveV4.sol:319-327`), which
deliberately **excludes** it from the measured raise, and step 9 (`:381`) sweeps it into `platformEthOwed`.
The buffer never enters the permanent LP, never deepens staking, never hardens the reserve — and while held it
sits as an idle balance on the curve contract, not in any pool position, so it provides no price support
either. `AUDIT-SCOPE.md` §3 and `ROBIN-V4-CURVE-ECON.md:28`/`:31` state the correct behaviour, so only the
in-code NatSpec is wrong — but that is what an auditor and an integrator read first, and it is the difference
between a user-side liquidity feature and platform revenue.

**Also stale, same category:** `contracts/interfaces/IRobinInterfaces.sol:24` and
`contracts/core/PadFactory.sol:56` both describe the buy tax as *"bps of the token output"*. It has been
money-side fee-on-input since the rebuild — and `IRobinInterfaces.sol` contradicts itself four lines later,
where the struct field comment gets it right.

---

### L-6 · LOW · Deploy scripts leave the governed config on the hot key, and the riskiest transfer is only a `console.log`

`scripts/deploy-curve.js:59` — `const platform = process.env.PLATFORM_WALLET || deployer.address;`. If
`PLATFORM_WALLET` is unset the platform fee wallet **silently becomes the hot deploy key**, with no guard.
Undoing it costs `FeeWalletRegistry.TIMELOCK` = 2 days.

`:67` — `RobinV4FeeConfig` is deployed with `deployer.address` as owner, and the transfer is out-of-band.
`DEPLOY.md:24-25` spells out transferring **`FeeWalletRegistry`** ownership and calls it *"the only mutable
knob in the system"*; it never names `RobinV4FeeConfig` in that section, which appears only in a `console.log`
at `scripts/deploy-curve.js:117`. Given L-1, that framing is wrong: the FeeConfig sets the curve geometry, and
a bad value there permanently bricks every pad launched under it.

**Fix direction.** `revert` rather than default when `PLATFORM_WALLET` is missing; describe `RobinV4FeeConfig`
as multisig-critical alongside the registry.

---

### L-7 · LOW · Several in-scope contracts have no deploy path; the ones that do rely on hand-typed constructor args

- **`pads/RobinLpVault.sol` (317 lines) is referenced nowhere** except `AUDIT-SCOPE.md:17`, this file's
  previous contents, and its own unit test. No deployer, no factory, no script, no wiring — pure audit surface
  with no deployment path. An auditor will spend time on it for nothing, or assume it is live.
- **`pads/RobinLockStaking.sol` has no deploy script** — the contract carrying H-1. `deploy-curve.js:119`
  instructs a human to deploy `RobinLockStaking(token, 30d, 30d)` by hand, per pad.
- **`pads/RobinFloorVault.sol` and `pads/RobinAmbushVault.sol`** are likewise hand-deployed (`:120`).
- `core/StockPadFactory.sol`, `adapters/StockQuoteAdapter.sol`, `adapters/EthQuoteAdapter.sol` — no deploy
  script, though all three are in the audit scope.

This is the root cause behind M-2, M-4, L-1 and M-5's durations, and it is fixable once — scripted deployment
plus on-chain assertions at launch — rather than five times.

---

---

### L-8 · LOW · The ceiling nudge counts swap proceeds from third-party liquidity as raise

**Where** `contracts/pads/RobinCurveV4.sol:327` (the `donatedBefore` window opens), `:540-556` (the nudge swap
and its `_resolve(currency0, sd.amount0())`), `:337` (the raise is measured), against
`:631` (`_mintPermanentLp`'s reserve check).

`graduate()` snapshots `donatedBefore` to keep a hostile `receive()` donation out of the measured raise —
the `[AUDIT-HIGH]` fix. But the anti-grief nudge swap runs **inside** that window, and its ETH proceeds are
taken by `_resolve` at `:552` and therefore counted as raise at `:337`. Those proceeds do not come from
buyers; they come from whatever liquidity the nudge crosses. A third party can mint a pure-currency0 band
below `gradTick` (the hook's flags are `0x00CC` — no `beforeAddLiquidity` permission, so anyone may add
liquidity to a pad's pool), push spot into it, and have their own ETH booked as raise.

Because the band sits far below the ceiling, the token there is cheap in ETH terms, so the nudge's `reserve/100`
budget is **not** the binding constraint: measured at production geometry (startTick 201600 / gradTick 178600 /
ts 100, 730M curve / 270M reserve, waterfall 1000/1000/500), parking **~2.2–2.3 ETH against a 4.053 ETH honest
raise** inflates `lpEth` until `_mintPermanentLp`'s check fails and `graduate()` reverts `InsufficientReserve`.

**Impact is a temporary, self-healing DoS, not a brick.** It is the same class as the planted-liquidity grief
`restoreCeiling` was built for and `test/unit/RobinCurveV4.grief.test.js` already covers, with the same
permissionless recovery — and the recovery is enormously over-incentivised, because `restoreCeiling` pays the
caller the griefer's entire parked ETH (one skeptic measured 1.2 token buying back 401 ETH). The attacker must
park 0.17–0.56× the raise at a 14–48× mispricing that the first arbitrageur takes in full, to achieve a denial
the already-accepted `CeilingNotRestored` variant achieves for ~0.06 ETH. Strictly dominated.

**Two things are nonetheless worth fixing.**
1. **`AUDIT-SCOPE.md` §4.5 is imprecise.** It asserts *"a donation can't inflate `lpEth` past the reserve's
   pairing capacity (brick)"*. That holds for `receive()` donations only — not for swap-sourced ETH, which is
   exactly what the nudge takes. An auditor relying on §4.5 would not look here.
2. **The failure is misdiagnosed.** An operator hitting this sees `InsufficientReserve` — an error the docs
   (`ROBIN-V4-CURVE-ECON.md:53`) and the launch-time guard (`CurvePadFactoryV4.sol:140`) both attribute to a
   launch-time misconfiguration. It reads as "this pad was configured wrong", not "someone is griefing you,
   call `restoreCeiling`".

**Fix direction.** Measure the nudge's proceeds separately and exclude them from `raisedEth` (the nudge exists
to move price, not to raise capital), or re-snapshot `donatedBefore` after the nudge. Independently, give the
revert a distinct error so the recovery path is obvious, and correct §4.5 to say "a donation or swap-sourced
ETH".

---

### I-1 · INFO · Recorded so the next pass does not re-derive them

1. **`PresaleVault`'s implementation is never initialised.** `PresaleVaultFactory.createPresale` clones and
   initialises atomically (`:42-45`), but the template is left open — anyone can `initialize()` it and run a
   presale on it. It will not appear in `isPresale`, so a front end that checks the registry is safe.
2. **`PadFactory.launch` sends the factory's entire ETH balance to `cfg.creator`** as "dust"; `StockPadFactory`
   does the same with its entire stock balance. Both are plain recipients, so anything donated or stranded goes
   to whoever launches next.
3. **`StakingFactory.createPool` is fully permissionless with a caller-chosen `extraRewarder`**, and
   `poolsOf[token]` is a public registry. Anyone can squat a plausible-looking pool for any token, with
   themselves as a rewarder.
4. **`LockVault.collectFees` uses whole-contract balance deltas** over currencies shared by every launch it
   holds. The delta arithmetic is correct, but a direct ETH donation to the vault is credited to whichever
   launch is collected next.
5. **`RobinLockStaking._startDrip` truncation** (`amount / rewardsDuration`) permanently strands up to
   `rewardsDuration - 1` wei per tranche in `rewardsBalance` — never dripped, never claimable. Dust-scale, but
   `rewardsBalance` and `reservoir()` slowly drift from what is actually payable.
6. **`RobinCurveV4.restoreCeiling` is a tax-exempt sell route** — the curve is `sender == bufferRecipient` and
   so is exempted in `RobinFeeHook.afterSwap` (`:284`). It is bounded by the gap between spot and `gradTick`
   and is the intended anti-grief incentive, but the sell tax *can* be legally avoided on that leg, and that
   should be stated rather than discovered.
7. **`RobinFeeHook.claimReferral` NatSpec** (`:366`) says one call *"aggregates across every ETH pad you
   referred, so one call sweeps them all."* Each pad gets its own hook contract (the token is in the hook's
   init-code, `CurvePadFactoryV4.sol:151`), so a referrer must claim on every pad's hook separately.
8. **`PresaleVault.launchConfig()` does not exist.** The field comment at `:51` reads *"exposed via
   `launchConfig()` (explicit getter → returns string members cleanly)"* — but no such function was ever
   written, and `cfg` is `internal`. So a depositor evaluating a live presale can read `target`, `deadline`,
   `totalRaised`, `perWalletCap`, `minContribution`, `saltCommitment` and `state()`, but **not** `supply`,
   `curveSupply`, `reserveSupply`, `tickSpacing`, `name` or `symbol` — the values that decide how many tokens
   their wei buys. Combined with M-12 (the geometry is not committed either), a contributor can verify almost
   nothing on chain about what they are funding.
9. **`RobinFloorVault.parkedQuote`** is assigned (`=`, not `+=`) and is purely cosmetic — `addFloor` always
   re-reads the live balance. Harmless, but it reads like accounting and is not.

---

### I-2 · INFO · `graduate()` does not poke `seedAmbush()`, so a ~0.015 ETH back-run can defer the band's arming  `PROVEN`

**Where** `contracts/pads/RobinCurveV4.sol:685-696` (`_fundAmbush` sends the ETH and stops), against its own
sibling `_fundFloor` at `:668-680`, which *does* poke (`try IFloorVault(f).addFloor() {} catch {}`). Seeding
guard at `contracts/pads/RobinAmbushVault.sol:127-134`.

Step 8b of the waterfall (`:375`) runs with `tick == gradTick` — the one moment the band is guaranteed to be a
clean single-sided ETH add — and does not take it. **PROVEN at production geometry** (startTick 201600 /
gradTick 178600 / ts 100): `ambushTickLower = 178700`, exactly 100 ticks (**1.005%**) below the graduation
price, and a 900,000-token dump (≈ **0.0146 ETH** of notional) moves tick to 178703, after which
`seedAmbush()` emits `AmbushParked` and adds nothing.

**Filed as INFO because every part of the harm claim fails on inspection:**

- **Not trapped.** `seedAmbush()` is `external nonReentrant` with no auth, and sizes itself from
  `currency0.balanceOfSelf() - pendingFloorEth` — not from the stale `parkedEth` bookkeeping variable
  (`RobinAmbushVault.sol:128`). Any unprivileged caller re-seeds the entire balance atomically:
  buy-with-price-limit → `seedAmbush()` → sell back, measured at a net **0.0000938 ETH + ~374k gas**, roughly
  0.2% of the seed once the 1%/1% hook taxes are counted.
- **Self-healing.** It arms with no rescue at all as soon as spot returns within 1.005% of the graduation
  price.
- **Small.** The exposed amount at production geometry is **0.2023 ETH** — 5% of a ~4.05 ETH raise.
- **Seeding at graduation would not have preserved the ETH anyway.** The first dip would have converted it to
  token inside the same add-only vault. The band doing its job and the band being unarmed are only
  distinguishable for that one dip.

So the entire residual harm is: one dip goes undefended, and 5% of the raise sits idle until somebody notices.
Worth fixing as hardening — add the same try/catch poke `_fundFloor` already uses — but it is not a fund
defect, and it is recorded here mainly so a future pass does not re-litigate it.

---

---

## 4. Checked and clean

Recorded so the next pass spends its budget elsewhere. Each was a plausible bug that did not survive
verification.

- **Graduation LP mint vs `amount0Max`.** `_mintPermanentLp` sizes `L` from `lpEth` and passes `lpEth` as
  `amount0Max`; v4 rounds the required `amount0` **up**, so an off-by-one would revert the real
  `PositionManager` with `MaximumAmountExceeded` and brick graduation deterministically. Checked against the
  real integer math (`getLiquidityForAmount0`'s double-floor vs `getAmount0Delta(roundUp: true)`) over
  **20,009 sampled `lpEth` values: `amount0Required` never exceeds `amount0Max`, worst-case delta 0.** The
  double-flooring leaves enough slack. This matters precisely because no local test could have caught it —
  see M-8 on the mock ignoring both caps.
- **Factory reserve guard vs the real token leg.** At production geometry the guard
  (`CurvePadFactoryV4.sol:140`) demands ≥ 242,716,039 tokens; a 100%-to-LP graduation — the worst case the
  FeeConfig permits — needs 231,158,132. **11.5M margin**, and it holds at the guard's exact boundary.
- **Hook split-backing / money conservation.** Buy books (`platformOwed + bufferOwed + referralOwed`) sum
  exactly to each minted ERC-6909 claim; sell books (`creatorOwed + floorOwed`) sum exactly to each `take`;
  `_pullClaimsAndPay` burns then takes the exact amount before `_payout`, so redeeming a buy claim never draws
  on sell-side ETH. Dust falls to the platform on buys and the creator on sells, never negative, never
  double-paid.
- **v4 delta sign conventions.** `beforeSwap`'s positive specified delta and `afterSwap`'s `int128` return were
  traced through `v4-core/src/PoolManager.sol` and `libraries/Hooks.sol` in both directions; the hook's own
  delta nets to zero against its `mint` / `take` in each case.
- **Graduation waterfall underflow.** Step 9's
  `platformEthOwed = balance - floorEthOwed - creatorEthOwed - ambushEthOwed - bounty` cannot underflow: after
  the LP mint the balance always dominates the still-owed books plus the bounty, in both the
  `_fundFloor`/`_fundAmbush` success and re-park branches.
- **Sandwiching `RobinLpVault.withdraw`** (which has no `minOut`, unlike `deposit`'s `minMinted`). For a
  constant-product full-range position the withdrawn bundle's value *at the honest price* is minimised at the
  honest price, so a price-manipulating sandwich hands the withdrawer **more** value, not less, while the
  attacker pays fees both ways. Not exploitable.
- **Curve seeding front-run.** `seed()` seeds the curve's whole token balance, but the token does not exist
  until the same transaction and its entire supply mints to the factory, so no third party can hold tokens to
  inflate the seed — including via a `DeterministicDeployer` pre-deploy, which mints to the factory anyway.
- **`DeterministicDeployer` adopt-on-collision.** Safe: the CREATE2 address binds `keccak256(initCode)`, and
  all three init-codes in use (`PadToken`, `RobinFeeHook`, `RobinCurveV4`) have constructors whose emitted
  runtime code is a pure function of their arguments.
- **`_alignUp` on negative ticks** (`RobinFloorVault.sol:190`, `RobinAmbushVault.sol:251`) — correct ceiling in both
  signs under Solidity's truncate-toward-zero division. Absurd `bandWidthSpacings` / `gapSpacings` fail closed
  on checked `int24` multiplication rather than wrapping.
- **The anti-grief nudge in `_graduatePull`.** Budgeted to ≤1% of the reserve, floors to 1 wei rather than 0,
  compares sqrt price (not tick) so a buy capped exactly at the ceiling is not re-nudged into
  `PriceLimitAlreadyExceeded`, and fails closed with `CeilingNotRestored` rather than bleeding the reserve.

---

## 5. What this pass did **not** cover

- **No fork run.** `test/fork/*.js` needs `FORK_RPC`, which this environment does not have. Everything
  involving the *real* v4 `PositionManager` — `amount0Max`/`amount1Max` enforcement, real Permit2, real
  `nextTokenId` — is argued from source and arithmetic, not executed. M-2's proof used the mock position
  manager; the LP mint (`graduate()` step 4) *succeeds* under it and the revert comes at step 5,
  `onGraduated` → `LockVault.registerLaunch`, which touches no PositionManager state. A real
  `PositionManager` therefore reaches the same revert — just after a real mint that is rolled back with the
  rest of the transaction.
- **No economic simulation of the ambush/floor bands** under adversarial order flow beyond the round-trip
  argument in `AUDIT-SCOPE.md` §4.4, which holds: round-tripping a passive add-only LP costs the attacker the
  spread plus two lots of LP fee.
- **Securities/legal review of the stock pad** remains out of scope per `AUDIT-SCOPE.md` §2. The disclosed
  `[D1]` (a paused or blocklisted stock hard-freezes that pad) and `[D3]` (`adminBurn` can burn the pool's
  reserve) remain accurate and unfixable on-chain. H-2 is a separate, on-chain-fixable defect.
- **Off-chain infra** (indexer, launch bot, front end) was not reviewed.

---

## 6. Reproducing the measured findings

Reproductions were run as throwaway Hardhat tests against a real local Uniswap v4 `PoolManager`. **They were
deleted before commit — this repository is unmodified apart from this document.**

```bash
cd pad-v4 && npm ci && npx hardhat compile
```

**H-1** — deploy `TestERC20` + `RobinLockStaking(token, 30d, 30d)`. Alice stakes 1,000; `fund(1,000)`; record
`periodFinish`. `time.increaseTo(periodFinish - 3)`; whale stakes 1,000,000; credit a 500,000 tranche (either
`fund(500_000)`, or — the realistic path — transfer tokens in and call the permissionless
`fundTokenPushed(0, token)`). `time.increaseTo(periodFinish)`; read `earned(whale)` → **499,500.5**. Then
`getReward()` + `withdraw(1e6)` → net **+399,500**.

**H-2** — deploy `MockStockRegistry`, then `MockStock(thatRegistry)`, then
`StockQuoteAdapter(thatStock, thatRegistry)` from a non-platform account: it deploys, and `adapter.registry()`
is the attacker's. Pass it as `cfg.adapter` with any `guardWindow > 0`. The freeze half is already covered by
`test/unit/RobinFeeHook.adversarial.test.js:163-186`. Note that an end-to-end local `StockPadFactory.launch`
is currently impossible — see M-8.

**M-1** — build the `deployStack` from `test/sim/presale.sim.test.js` verbatim, but with
`curveSupply = reserveSupply = 2e17` instead of the deep-curve default. Open a presale with `target = 3 ETH`,
fill it, `finalize(...)`, then compare `vault.pooledEthSpent()` against
`hook.platformOwed(poolId, 0) + hook.bufferOwed(poolId)`.

**M-2** — build the curve `deployStack` from `test/sim/curve.e2e.sim.test.js`, but call
`lockVault.setFactory(<any other address>)` instead of the curve factory (a `PadFactory` makes the point).
Use a shallow curve — `curveSupply = reserveSupply = 1000e18` at START 6000 / GRAD 3000 — so the buy-out fits
inside a default Hardhat account's 10,000 ETH. Launch (succeeds, silently), buy the curve out with
`PoolSwapTest`, assert `curve.ready() == true`, then assert `curve.graduate()` reverts `NotFactory` — for
every caller, permanently.

**M-5** — deploy `DualStaking(tok, stk, owner, antiJitDelay = 0, …)`. Alice stakes, unstakes freely, then
`setAntiJitDelay(7 days)` → her existing position reverts `Locked`. Separately: stake, `fundETH(10)` at 0% fee,
advance 7 days, read `earned`, then `setPlatformClaimFee(1000)` and claim — the payout is 10% short.

**L-1** — evaluate `getLiquidityForAmount1(√grad, √start, curveSupply)` then
`getAmount0Delta(√grad, √start, L, false)` in exact integer arithmetic across `startTickMag`, holding
`curveWidth = 23000`, `ts = 100`, `curveSupply = 730M`. The raise hits 0 wei at ~700000, inside what
`CurvePadFactoryV4` accepts.

---

## 7. Suggested remediation order

1. **C-1** — the only finding that takes 100% of a user-facing pot, for 3 wei, permissionlessly. Fix the
   drip-rate floor *and* the pause guard; the sub-rate-tranche check closes the arming step and the dust
   stranding in I-1(5) at the same time.
2. **H-1** — no minimum trade size, cheaper than paying the tax, and a router can hand it to every user. It
   defunds the creator's entire income and the floor. The buy side already shows the fix.
3. **M-2 and M-4** — one-shot wiring defects with permanent, unrecoverable failure modes, both cheap to close
   (an assertion at launch; an on-chain anchor read).
4. **H-2** — before any stock pad exists. It is a rug primitive, and M-8 means it is currently untestable
   locally, so fix the mock in the same pass.
5. **M-11** — holder fees routed to the platform by the ordinary post-graduation flow, with no attacker
   required. One line, and the right shape already exists in the same file (`claimFloor`'s
   `NoFloorRecipient`). Fold in **I-2**'s `seedAmbush()` poke while you are there — same pattern, same file.
6. **M-1**, then **L-1** and **M-10** — real value loss and two permanent bricks, all gated on configuration
   that is easy to get wrong and currently unbounded.
7. **M-6** before the package goes to the external auditor. Auditing from a stale architecture document is the
   most expensive mistake on this list, because it wastes the engagement rather than the code.
8. **M-3, M-5 and M-12** are product decisions as much as code ones: decide what `PadFactory` is, which owner
   powers you are willing to defend, and whether a presale's terms may move under its contributors. Then make
   the code and the docs agree.
9. **M-7, M-9, L-2, L-3, L-6, L-7** — the wiring/runbook cluster. Fix them together, as one scripted
   post-launch wiring step that asserts every one-shot is set and consistent.
10. The rest as cleanup, with **L-4**, **L-5** and **L-8**'s doc corrections folded into whichever PR touches
    those files. Note that L-8 and M-10 each falsify a specific sentence an auditor is told to rely on
    (`AUDIT-SCOPE.md` §4.5 and `RobinV4FeeConfig`'s no-timelock justification) — those sentences should be
    corrected even if the underlying code is left as is.
