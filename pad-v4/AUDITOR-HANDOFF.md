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
| **CRITICAL** | 2 | 2 |
| **HIGH** | 3 | 3 |
| **MEDIUM** | 18 | 10 |
| **LOW** | 18 | 9 |
| **INFO** | 14 (11 bundled as I-1, plus I-2, I-3 and I-4) | 1 |
| **total** | **55** | **25** |

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
> `RobinAmbushVault`'s `stakingRecipient`, and `RobinV4FeeConfig`'s geometry bounds are all one-shot or
> immutable, all accept values no contract validates, and all fail *late*.

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

### C-2 · CRITICAL · 100 wei of dust liquidity pushes `graduate()` *and* `restoreCeiling()` past the block gas cap, trapping the whole raise  `PROVEN`

**Where** `contracts/pads/RobinCurveV4.sol:540-556` (`_graduatePull`'s ceiling nudge) and `:582-590`
(`_restore`). Neither takes a caller-supplied intermediate price limit, so neither can be split across
transactions.

**The setup is the ordinary sellout, not an attack.** A trader buying the curve out with the router-default
`sqrtPriceLimitX96 = MIN_SQRT_PRICE + 1` slides spot all the way to the floor, because below `gradTick` there
is no liquidity and v4's swap loop walks the price for zero input. **Verified independently:** after a normal
sellout the tick is **−887272**, `ready()` is `true`, and the nudge must therefore walk back **890,272 ticks**
to reach `gradTick`. Baseline `graduate()` costs **1,217,937** gas — the empty walk is cheap because v4 skips
uninitialized ticks a bitmap word at a time.

**The attack is to make that walk expensive.** Every *initialized* tick the swap crosses costs real gas, and
initializing one is nearly free when spot is far below it:

| | measured |
|---|---|
| attacker plants 100 positions of `liquidityDelta = 1`, one per 60-tick band below `gradTick` | **1 wei each — 100 wei total** (currency0-only, spot is far below) |
| attacker's gas, spread over 100 unbounded transactions | 16,116,942 total, ~161k each |
| **`graduate()` afterwards** | **33,767,571 gas** — over the 30,000,000 block cap, **reverts forever** |
| **`restoreCeiling(bag)`, the documented recovery** | **31,776,972 gas** — also over the cap |
| trapped | **63.7 ETH of raise** in the v4 position + 100e18 reserve tokens on the curve |
| **attacker's total cost** | **0.000486 ETH** at the repo's own 30,180,000 wei gas hint, plus 100 wei |

The asymmetry is the whole attack: the attacker pays ~80,585 gas per initialized tick **spread over as many
transactions as they like**, and imposes ~162,748 gas per tick on **one** victim transaction that must
complete atomically.

**This is not the grief the suite already handles.** `test/unit/RobinCurveV4.grief.test.js` covers planting
*deep* liquidity so the nudge's 1%-of-reserve token budget runs out — that path fails closed with
`CeilingNotRestored` and `restoreCeiling` recovers it (and is why L-8 is only LOW). Here the positions are
`L = 1`, so essentially no token is consumed and the budget never binds. The swap runs out of **gas**, and
`restoreCeiling` is bricked by the identical mechanism. **The documented recovery is defeated by the thing it
exists to recover from.**

There is no other exit. `poolManager.modifyLiquidity(..., liquidityDelta: -int256(uint256(curveL)) ...)` at
`:568` is the only negative-liquidity call in the file, and `graduate()` is its only caller.

**Fix direction.** Make the walk-back segmentable and bound the gap.
1. Give `restoreCeiling` a caller-supplied `sqrtPriceLimitX96`, requiring
   `current < limit <= getSqrtPriceAtTick(gradTick)`, so anyone can push spot toward the ceiling across as
   many transactions as it takes. This alone converts an unrecoverable brick into a recoverable one.
2. Split `graduate()` so ceiling restoration is a separate, retryable, partial-progress step rather than an
   all-or-nothing swap inside `_graduatePull`.
3. Consider preventing the deep overshoot in the first place — the sellout only reaches the floor because
   nothing stops a buy below `gradTick`.

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

### H-2 · HIGH (gating the stock pad; no live surface today) · A `StockPadFactory` launcher ships a pad it can freeze at will, and the securities gate is self-certified  `PROVEN`

**Where** `contracts/core/StockPadFactory.sol:69` (`adapter`, caller-supplied), `:68` (`guardWindow`,
caller-supplied, unbounded `uint32`), `:172`/`:176` (both stamped immutably into the hook), enforced at
`contracts/hooks/RobinFeeHook.sol:190-197`.

**Scope first, because it decides how to read this.** Nothing deployed today is exposed. The curb only runs
when `quoteIsStock` is true, and only `StockPadFactory` ever sets it — `CurvePadFactoryV4.sol:188/194/195` and
`PadFactory.sol:172/178/179` hardcode `guardAdapter: address(0)`, `guardWindow: 0`, `quoteIsStock: false`, so
the ETH curve pad and the plain ETH pad are **structurally immune**. `StockPadFactory` is deferred as
informational by `AUDIT-SCOPE.md` §2, appears nowhere in `DEPLOY.md`, and per M-8 cannot even be executed
locally. So this is not a live incident — it is a **blocker on shipping the stock pad**, and it is filed HIGH
because that is its severity the day the stock pad launches, not because anything is at risk now.

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
holder can ever exit. `RobinFeeHook.registerPool` (`:135-163`) validates only the tax and share fields — it
never bounds `guardWindow` — and neither does `StockPadFactory`.

Be precise about the duration, because it differs by adapter:

- **With an attacker-supplied adapter** (the case above) the freeze is *unconditional and indefinite*: the
  launcher simply keeps `scheduledEffectiveAt()` returning a value near `block.timestamp`, so the curb holds
  for as long as they choose, and a `uint32` `guardWindow` lets one call cover ~136 years without further
  action.
- **With a genuine `StockQuoteAdapter`** the curb is self-limiting: `scheduledEffectiveAt()` returns non-zero
  only while the stock has a pending `newUIMultiplier` (`adapters/StockQuoteAdapter.sol:86-97`), so an
  oversized window freezes trading for as long as that corporate action stays pending, not unconditionally.
  That is still an unbounded misconfiguration — a legitimate pad can be frozen far past any real
  corporate-action window — but it is not attacker-held.

The freeze semantics are already established by the repo's own test,
`test/unit/RobinFeeHook.adversarial.test.js:163-186`, using `MockGuardAdapter` — a 22-line contract that is
exactly what an attacker would deploy.

**The hook's own safety claim is false here.** `RobinFeeHook.sol:177-178` states *"the adapter read is
try/caught so a broken adapter can't freeze trading."* `_scheduledEffectiveAt` (`:255-261`) does try/catch —
but only a **reverting** adapter, which it reads as "no scheduled action". An adapter that simply *lies*,
returning a plausible non-zero `effectiveAt` forever, passes the try/catch cleanly and freezes trading
exactly as intended. The guard defends against a broken adapter, not a dishonest one, and the NatSpec claims
the latter.

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

### H-3 · HIGH (gating the stock pad) · `try/catch` does not absorb a short return, and `guardAdapter` has no setter  `PROVEN`

**Where** `contracts/hooks/RobinFeeHook.sol:255-261` (`_scheduledEffectiveAt`), reached from the curb at
`:190-197` on **every swap** of a stock pad.

```solidity
try IStockGuardAdapter(adapter).scheduledEffectiveAt() returns (uint256 ea) { return ea; }
catch { return 0; }
```

Solidity's `try/catch` catches reverts. It does **not** catch a failure to decode the return data: that
happens in the *caller's* frame after the call has already succeeded, outside the protected region. A callee
that returns **zero bytes** therefore reverts the whole transaction, uncatchably.

**PROVEN** against the sibling site: a 5-byte contract whose runtime is `PUSH1 0, PUSH1 0, RETURN` — succeeds,
returns nothing, for any selector — was installed as `DualStaking`'s boost oracle. `boostOf` reverted despite
its try/catch and its *"Never reverts"* NatSpec, and `stake`, `unstake` and `claim` all reverted with it. The
same shape applies here.

**On a stock pad the consequence is permanent.** `guardAdapter` is written once in `registerPool` (`:160`) and
there is **no setter anywhere in the contract** — grep returns only the field (`:75`), that write, and the
read. So a stock pad launched with a short-returning adapter has every swap revert forever, with the seed LP
already locked in `LockVault` and no path to change the adapter, unwind the position, or recover the seed.
Reaching it needs only a contract that has code and a working `stock()` — which is all
`StockPadFactory.launch:123` checks (see H-2).

**The suite gets this right almost everywhere else, which is worth stating.** Enumerating every `try` in
`contracts/` (excluding tests), only sites with a `returns (...)` clause decode, and of those only two have an
untrusted callee: this one and `DualStaking.boostOf` (M-17). The `poolManager.initialize` sites and
`PresaleVault`'s `launch` call trust canonical contracts; and every defensive `try` on a hot path —
`poolManager.mint`/`take`, `claimBuffer`, `fundTokenPushed` (both call sites), `addFloor`, `onWeightChange` —
omits the `returns` clause and so never decodes. Those are genuinely safe. The gap is precisely the two sites
that read a value back from an address someone else chose.

**Fix direction.** Use a low-level `staticcall` and check `returndata.length == 32` before decoding, e.g.
`(bool ok, bytes memory d) = adapter.staticcall(...); if (!ok || d.length != 32) return 0;`. Apply the same at
`DualStaking.boostOf`. Independently, `guardAdapter` should be repointable by the platform, since today a
single bad address at launch is unrecoverable.

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
contracts"*. Not true of `setFloorRecipient` — and it is the only one of the four that omits the check.

Two points of precision, both from verification:

- **It can strand the carve entirely, not merely misroute it.** If the recipient cannot receive the money side
  — a contract with no `receive`, or one that reverts — `claimFloor` reverts on every call, and the hook has
  **no rescue path**: its complete external surface is `registerPool`, `beforeSwap`, `afterSwap`,
  `claimPlatform` / `claimCreator` / `claimFloor` / `claimBuffer` / `claimReferral`, `setFloorRecipient`,
  `setBufferRecipient` and the creator repoint. No sweep, no withdraw, no re-point. The accrued
  `floorOwed` is then permanently unreachable.
- **Size it at production parameters, not the caps.** The ceiling
  (`MAX_TAX_BPS` 200 × `MAX_FLOOR_SHARE_BPS` 5000) would make this 1% of sell volume, but the shipped values
  are `sellTaxBps 100` / `sellFloorShareBps 2000` (`scripts/deploy-curve.js:35-36`, `scripts/launch.js:48-49`,
  `ROBIN-V4-CURVE-ECON.md:29`) — **0.2% of the ETH sell leg**. On 1,000 ETH of lifetime sell volume that is
  2 ETH at risk, not 10. This is an operator-error and documentation defect, not an attacker path.

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
as an authorised funding. **And it is not the only relay** — `RobinAmbushVault.flushFees()` (`:151`) is
likewise permissionless and reaches `fundTokenPushed` through `_forwardStaking()` (`:176`), so a pad that
wires its ambush vault as a rewarder exposes a second identical path. And `_applyReward` on the `extend = true` path resets the window —
`r.periodFinish = uint64(block.timestamp + dur)` — so each poke pushes the finish line out by a full duration
and re-divides the remaining reservoir over it. Note the asymmetry with the sibling path: the identical call
in `_fundStaking` (`:654-663`) **is** try/caught and gated behind a balance check; `flushStaking`'s only gates
are `!graduated` and `s == address(0)`, and its `fundTokenPushed` poke runs unconditionally — the `bal > 0`
check guards only the transfer on the line above.

**Sized correctly, this is a delay, not a loss.** Rewards are re-stretched, never burned: the delivered
fraction converges to `1 − e^(−t/duration)` regardless of how often the griefer pokes, so poking harder does
not deepen the harm past that curve. Measured with poking sustained throughout: **63.88% delivered at 7 days,
98.30% at 28 days** on a 7-day window; 99% takes 4.6× the duration (32 days instead of 7) and 99.99% takes
9.2× (64 days). The accurate statement is that the 7-day drip is stretched into a months-long asymptotic tail
for as long as someone keeps paying gas — not that it never pays out. The only permanently lost value is the
`(amount + leftover) / dur` truncation, ≤ 604,799 wei-units of an 18-decimal token per poke, which is dust.

**The codebase already named this exact band — for the other contract.**
`RobinLockStaking.sol:219-221` explains its fixed-`periodFinish` choice by describing precisely this grief:
*"a griefer could dust-fund (1 wei) repeatedly to re-stretch the undripped reservoir over a fresh full
duration each time and push `periodFinish` out forever, slowing honest stakers' rewards ~2.3-4.6x."* That is
the same 2.3–4.6× band measured here. The defence was reasoned through, written down, and applied to
`RobinLockStaking` — and `DualStaking` was left exposed to it through a relay the note did not anticipate.

**Scale it at production geometry.** The reservoir at risk is the graduation leftover streamed to staking —
**96,978,138 tokens, 9.70% of the 1B supply**, the same pot as C-1, roughly **$3.3k at the ~$34k graduation
market cap**. The relative damage (63.88% at 7 days) is geometry-independent.

**And it is mitigable — at the cost of re-opening L-2.** The `DualStaking` owner can stop it immediately with
`setRewarder(curve, false)`, after which the curve can no longer credit its own graduation stream at all.
That is precisely L-2. The pair has no configuration that satisfies both; only a code change does.

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

### M-14 · MEDIUM · `platformFeeWallet` is the protocol's root admin key, not merely a payout address

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
timelock on the *use* of the capability.

**Sized at production geometry, largest first:** the **staking sink is the big one — 96.98M tokens, about
1.0718 ETH realizable per pad**, roughly **5.3×** the ambush share (0.2023 ETH, per I-2). The floor carves and
the locked LP's token leg follow. It is worth stating in that order, because the ambush number is the one that
looks quotable and it is the smallest of them. (The 2-day timelock in `FeeWalletRegistry` governs *changing* the
wallet, not what the wallet can do.) Combined with M-4 — `setFloorRecipient` does not even require the target
to be a contract — a single transaction from that key can permanently point a pad's floor at an EOA.

This is the unifying statement behind M-4, M-7 and M-11, and it matters because it changes what an auditor
must assume about key management: the platform fee wallet needs the operational security of a root admin key,
not of a treasury receiving address.

**Fix direction.** Separate the roles — an `admin` (or the existing `Ownable2Step` owner) for the one-shot
wiring, and `platformFeeWallet` purely as a destination. If they must stay unified, say so plainly in
`AUDIT-SCOPE.md` §6 and `DEPLOY.md`, and drop the "only this one address / no fund movement" framing.

---

### M-15 · MEDIUM · The floor can only deepen while the price is *above* it, so any drawdown idles the carve  `PROVEN`

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
to reach before the first drawdown, while fee revenue earmarked for it accumulates unusable. **It is a conditional lock, not a burn — proven in both directions.** `addFloor()` reads
`currency0.balanceOfSelf()` fresh on every call, so the whole accumulated balance deploys in a *single* call
the instant spot returns below `floorTickLower`. Verified: after buying the price back to tick −33555, one
`addFloor()` emitted `FloorAdded`, minted 172,240,917,046,477,496,316 of liquidity and left the vault holding
**0.0 ETH — all 10 parked ETH recovered**. So `parkedQuote` being an overwrite rather than an accumulator
(I-1(9)) is cosmetic: the real ledger is the balance.

The accurate statement is therefore: **the funding window is one `tickSpacing` wide, so once a pad trades
below its anchor by that much — ~0.6% at `ts = 60` (hook pads, `scripts/launch.js`) or ~1.005% at `ts = 100`
(curve pads) — 100% of incoming floor carve sits idle, with no admin rescue, no re-anchor and no second band,
until the price recovers.** `RobinAmbushVault.seedAmbush` (`:127-137`) has the identical shape, which is why
I-2 exists. Nothing is stolen and nothing is permanently lost, but
the advertised mechanism does not operate in the state it was built for, and for a token that never recovers
its anchor it never operates again.

**Fix direction.** The band must be able to follow the price down, which a single fixed range cannot do.
Options: (a) let `addFloor` place *new* liquidity in a fresh band below current spot when the anchor band is
unreachable — every band stays add-only, so the "can't rug" property is preserved, since no remove path is
added, only more ranges; (b) accept the limitation and restate the guarantee honestly as "a fixed buy wall at
the launch price, funded while the token trades above it"; (c) at minimum surface the parked amount so
"wall is deep" and "carve is stuck" are distinguishable. Note (c) is cosmetic on its own — and per I-1(8)
`parkedQuote` is assigned rather than accumulated, so it does not even report the parked total correctly.

---

---

### M-16 · MEDIUM · `donateETH` promises donations reach holders untouched by the platform cut; `claim` takes it anyway  `PROVEN`

**Where** `contracts/pads/DualStaking.sol:396-401` (the `donateETH` NatSpec) against `:337-352` (`claim`).

The docstring is explicit, and it is aimed at creators:

> *"Permissionless ETH top-up of a side's reward stream — anyone (typically the CREATOR) can deposit ETH
> straight to holders WITHOUT being a rewarder and **WITHOUT touching the platform cut**."*

That is true of the deposit path — `donateETH` charges nothing and needs no rewarder role. It is false of the
money. `claim` applies `platformClaimFeeBps` to the **entire** accrued balance with no provenance tracking:

```solidity
uint256 amount = rewardsAccrued[side][asset][msg.sender];
uint256 fee = (amount * platformClaimFeeBps) / BPS;
```

Donated ETH is indistinguishable from rewarder-funded ETH by the time it is claimed, so the platform takes its
cut of it — up to `MAX_CLAIM_FEE_BPS` = 10%. A creator who donates 50 ETH to their holders on the strength of
that sentence hands up to 5 ETH to the platform instead.

**Measured:** with `platformClaimFeeBps = 0`, a creator donates 50 ETH; the sole staker accrues
`earned = 49.9999999999995936 ETH` over the 7-day window; the owner then calls `setPlatformClaimFee(1000)`
and the claim credits `platformFeesOwed[ETH]` with 10% of it. Note this compounds M-5: the fee is applied at
claim time, so it reaches ETH donated long before the fee existed.

**Fix direction.** Either honour the docstring — track donated principal separately and exempt it from the
claim fee — or correct the sentence to say the exemption applies only to the deposit, not to the payout. The
second is a one-line change and is what the code actually does.

---

### M-17 · MEDIUM · The same short-return gap freezes `DualStaking` principal  `PROVEN`

**Where** `contracts/pads/DualStaking.sol:186-196` (`boostOf`), reached from `_reweigh` on every `stake`,
`unstake` and `sync`.

Same root cause as H-3. `boostOf`'s NatSpec promises *"Never reverts"* and it is wrapped in `try/catch`, but a
boost oracle that returns fewer than 32 bytes makes the decode revert in `boostOf`'s own frame.

**PROVEN.** Deploy a 5-byte contract whose runtime is `60006000F3` (returns empty for any selector), then
`setBoostOracle(thatAddress)`:

| | before | after |
|---|---|---|
| `boostOf` | 10000 | **reverts** |
| `stake` | works | **reverts** |
| `unstake` | works | **reverts — principal frozen** |

`setBoostOracle` (`:466-469`) validates nothing — not zero, not `code.length`, not the interface — and the
reachable bad values are ordinary operational mistakes: an EOA, a CREATE2 address for an oracle not yet
deployed, or a proxy whose implementation slot is momentarily zero.

**It is recoverable, which is why MEDIUM not HIGH.** `setBoostOracle` is a plain assignment with no one-shot
guard, so the owner can point it back at `address(0)` (which short-circuits to `BPS` before any call) or at a
working oracle, and everything resumes. But until they do, every staker's principal is frozen, and the freeze
is invisible until someone tries to unstake.

**Fix direction.** As H-3: low-level `staticcall` with a `returndata.length == 32` check. Also validate the
oracle has code at set time — it does not make the contract safe, but it removes the commonest way in.

---

### M-18 · MEDIUM · The "LOCKED SPEC" describes the ambush as the exact **mirror image** of the ambush that shipped  `VERIFIED`

**Where** `ROBIN-V4-CURVE-SPEC.md:31-39` ("Ambush (held reserve, active from launch)"), against
`contracts/pads/RobinAmbushVault.sol:30-44` (the contract's own header) and
`contracts/pads/RobinCurveV4.sol:685-696` (`_fundAmbush`).

`AUDIT-SCOPE.md:6` lists `ROBIN-V4-CURVE-SPEC.md` as one of four companion documents for the external review,
and the spec's own first lines call it *"the locked reference — build to it."* It is not a stale draft; it is
handed to the auditor as ground truth. On the ambush it is wrong in every structural dimension, and each error
inverts the mechanism rather than blurring it:

| | `ROBIN-V4-CURVE-SPEC.md:31-39` | `RobinAmbushVault` as shipped |
|---|---|---|
| what the band holds | **token** ("single-sided TOKEN sell-wall") | **ETH** ("at/above the graduation price the band holds only ETH") |
| where it sits | ticks ***below*** the graduation tick | `ambushTickLower = _alignUp(gradTick + 1, ts)` — strictly ***above*** `gradTick` (`:108-111`) |
| what it does to price | "**capping pumps**" | "it can **NEVER cap the chart**" (`:35`); it *buys dips* |
| where it is funded from | tokens "**held back** (not sold on the curve)" | `ambushGradBps` (5%) of the **ETH raise**, wired at graduation (`RobinCurveV4.sol:685-696`) |
| when it is live | "**active from launch**" | funded at graduation, then a separate permissionless `seedAmbush()` (see I-2) |
| at graduation | "the remaining ambush tokens **pair the permanent locked LP**" | contributes nothing to the LP; the band is add-only and permanent |

The spec even names the shape it is not: *"implemented in `RobinAmbushVault` as the exact mirror of the audited
`RobinFloorVault`."* The shipped vault is not the floor's mirror — it is a **second buy-wall on the same side**,
one band above it. The spec's money model inherits the error: it lists the floor as fed by "the ambush's pump
sales", a revenue line that cannot exist for a band that never sells into pumps.

This is not a documentation nit, and it is not M-6 again. M-6 is a *stale* architecture document — it describes
an older system that once existed. This is a **currently-authoritative** document describing the sign-flipped
version of a live contract, in the one subsystem where getting the sign wrong changes what the auditor looks
for. An auditor reading §"Ambush" will go hunting for token-side inventory risk, sell-wall exhaustion, and
pump-capping complaints from holders. None of those exist. Meanwhile the real risks of an ETH buy-wall — the
seeding race in I-2, the add-only ETH that cannot be withdrawn, and L-17's stranded token fees — are in a part
of the design space the spec tells them is not there.

It also means the *product* question was never settled on paper. "Held-back tokens that cap pumps and then pair
the LP" and "5% of the raise parked as a permanent dip-buyer" are different products with different token
economics, and the launched supply split (`curveSupply`/`reserveSupply`) reflects only the second.

**Fix direction.** Rewrite §"Ambush" and the ambush line of the money model to describe the shipped vault, or —
if the spec is the intent and the contract is the deviation — say so explicitly and treat the divergence as a
design decision to be re-approved. Either way it must not go to an external auditor in its current state. Do
this together with M-6; the two documents disagree with the code in different directions, so fixing one alone
still leaves the package self-contradictory.

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

**Impact is a temporary, self-healing DoS, not a brick — but see C-2.** The recovery this rests on,
`restoreCeiling`, is itself brickable by gas (C-2), so "self-healing" holds only while nobody has planted dust
ticks. Fixing C-2 restores the assumption this finding depends on. It is the same class as the planted-liquidity grief
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

### L-9 · LOW · `cfg.creator` is in neither CREATE2 pre-image, so a copied launch can burn a victim's launch tx  `VERIFIED — impact refuted`

**Where** `contracts/core/CurvePadFactoryV4.sol:105` (`launch` is permissionless), `:148` (token init-code is
`(name, symbol, decimals, supply, factory)`), `:158` (hook init-code is
`(poolManager, factory, feeRegistry, token)`) — `cfg.creator` appears in neither.

**The mechanism is real.** For a given `(cfg, tokenSalt, hookSalt)` the token and hook land at the same
addresses whoever calls `launch()` and whatever `creator` they name. Copy a pending `launch()` calldata,
change `creator`, land first: the attacker's transaction deploys token and hook at exactly the addresses the
victim intended and registers the pool with itself as creator, after which the victim's transaction reverts
(`registerPool` throws `AlreadyRegistered`, and the factory no longer holds the supply).

**The impact claim does not survive.** This was originally filed HIGH as creator-revenue theft. It is not:
the steal lands at the one instant the pad is worth exactly zero. Reproduced at production geometry against
the real factory stack, the hijacked pad holds **0 wei, `creatorEthOwed` 0, `hook.creatorOwed` 0** — the 10%
graduation share and the 80 bps sell stream only ever exist for whichever pad actually attracts a raise, and
nothing about the attacker's empty shell attracts one. The victim's remedy is a relaunch under a fresh
`tokenSalt` and a re-mined `hookSalt`, which costs off-chain mining and gas but no principal.

The economics run against the attacker: they pay a **full ~6.5M-gas launch per attempt** to burn the victim's
**83k-gas** transaction, gain nothing transferable, and cannot repeat without fresh calldata. That is
negative-EV griefing, not theft.

**Reachability is broader than a mempool race.** The precondition is only *"the attacker learns
`(cfg, tokenSalt, hookSalt)` before inclusion"*, and transaction ordering is one leak among several. Any
launch UI that mines the hook salt server-side and returns the salts to the client leaks everything needed
with no ordering advantage at all. And the repo's own launcher derives the token salt **deterministically from
public data** — `scripts/launch.js:62`:

```js
const tokenSalt = ethers.id(`${cfg.symbol}-${cfg.name}-${d.padFactory}-${process.env.SALT_NONCE || "0"}`);
```

Under that convention an attacker who knows only the announced name and symbol can compute `tokenSalt`, mine
their own `hookSalt`, and pre-empt a launch that has been *announced but not yet sent* — no mempool access
required. That materially raises the likelihood while leaving the payoff unchanged, which is why it stays LOW
rather than rising: the pad is still empty at the moment it is taken.

**Where it would matter, the suite already defends.** The case where a launch address is *pre-committed* — so
an audience is pointed at it before it exists — is the presale, and `PresaleVault` handles exactly this: the
salts are commit-revealed, and a front-run launch makes `finalize` fail the presale into immediate 100%
refunds (`:180-192`). The residual here is confined to direct launches, where the address is not announced in
advance.

**Fix direction.** Bind the creator into the deployment so a replayed calldata lands at a *different* address
instead of colliding: add `cfg.creator` to the token's constructor arguments, or require
`msg.sender == cfg.creator`. Either removes the griefing window entirely for a line of code.

---

### L-10 · LOW · `DeterministicDeployer.deploy` is payable but the adopt branch neither forwards nor refunds  `VERIFIED`

**Where** `contracts/core/DeterministicDeployer.sol:22-32`.

```solidity
function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address addr) {
    address predicted = addressOf(salt, keccak256(initCode));
    if (predicted.code.length != 0) return predicted;   // msg.value neither forwarded nor refunded
```

The contract's **entire external surface is `addressOf` and `deploy`** — verified at runtime: two ABI
fragments, no `receive`, no `fallback`, no owner, no withdraw, no `selfdestruct`, and a plain 1 wei transfer
to it reverts. So anything sent on the adopt branch is permanently locked.

**No protocol funds are exposed, and the original MEDIUM framing was wrong.** All seven in-repo call sites are
value-free — `PadFactory.sol:121,137`, `CurvePadFactoryV4.sol:144,156`, `StockPadFactory.sol:126,139`, and
`CurveV4Deployer.sol:22` (which is itself non-payable). And a value-bearing *fresh* deploy cannot strand
anything either: every in-repo init-code has a non-payable constructor, so `create2` with value reverts and
the whole call reverts with `DeployFailed`. The no-adversary variants originally claimed — racing operators,
a re-broadcast — cannot strand value for the same reason.

What remains is a hardening gap for third parties. The NatSpec designates this contract as pinned ecosystem
infrastructure (*"its address is then pinned as a constant everywhere hook-address mining happens"*) and
`deploy` is permissionless, so an outside integrator deploying a payable, self-funding contract can be
front-run into the adopt branch by anyone submitting the same `initCode` first — and their value is gone.

**Fix direction.** One line: `if (msg.value != 0) revert();` on the adopt branch — or drop `payable`
altogether, since every in-repo init-code has a non-payable constructor and value-bearing deploys already
revert. The NatSpec's *"(No value is forwarded on adoption; our callers deploy value-free.)"* should state the
hazard rather than record the assumption.

---

### L-11 · LOW · `RobinFloorVault` pins the platform wallet as an immutable, so a timelocked rotation never reaches it  `VERIFIED`

**Where** `contracts/pads/RobinFloorVault.sol:45` (`address public immutable feeRecipient`), set once at `:84`.

The vault has **no `IFeeWalletRegistry` import at all** — while every other platform sink in the suite resolves
the wallet live: `RobinFeeHook.sol:323`/`:384`, `LockVault.sol:136`/`:149`, and `RobinCurveV4.claimPlatform`.
`scripts/launch.js:85` hands the vault the platform address directly.

So the compensating control for a compromised platform key does not work here. `FeeWalletRegistry` exists to
rotate that wallet through a 2-day timelock — its NatSpec: *"a repoint only affects fees claimed after it
commits"* — but a rotation silently fails to reach any already-deployed floor vault. The permissionless
`collectFloorFees()` keeps paying that pad's floor-band LP fees to the **retired** address forever, and lets
whoever holds the retired key keep pulling them. There is no setter and no redeploy path: the vault is
add-only and holds a live position.

**One claim I made here is disproved, and the reason is worth knowing.** I wrote that taking inline to
`feeRecipient` under the pool lock lets a reverting recipient brick `collectFloorFees()`. It does not, and not
merely because the recipient is an EOA: **`addFloor()` is a second, permissionless fee-realization path.**
`_add` (`:139-157`) calls `modifyLiquidity` with a positive delta, and v4-core returns
`callerDelta = principalDelta + feesAccrued` — so an *add* realizes exactly the same accrued fees a
zero-delta poke does. The currency0 leg is taken to self at `:150` and compounds into the wall; the currency1
leg leaves by ERC20 `take`, which has no callback. So an ETH-rejecting recipient cannot strand anything.

The inline take still departs from the suite's accrue-and-pull rule, but here that is a style inconsistency,
not a live DoS.

Bounded to one small fee stream per pad and reachable only after a platform-domain event, which is why LOW.

**Fix direction.** Read `feeRegistry.platformFeeWallet()` at collect time, as every other consumer does.

---

### L-12 · LOW · `finalize()`'s bare catch turns an under-gassed call into an irreversible `Failed(3)` — and the tx reports success  `PROVEN`

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

**This is an accident, not an attack — the malicious reading does not hold.** Calling `finalize` requires the
salt preimages, so only a preimage-holder can trigger it, and that actor already has a strictly better way to
kill the raise: simply never call `finalize`. `fail()` (`:278`) then fires `Failed(2)` past deadline + grace
and everyone refunds 100% — the terminal state is identical. The gas trick is in fact *friendlier* to
depositors, because it opens refunds immediately instead of making them wait out the grace window.

What is left is the case that matters: a wallet's gas estimate, or a launch that grew gas-heavier than the
estimator expected, silently converting a recoverable condition into an irreversible one. No malice is
required and none should be assumed.

**And the caller is told it worked.** The transaction returns **status 1** and emits `Failed(3)` —
*"committed launch sniped"* — so the operator sees a successful call and a reason code that is factually wrong
about what happened. This is an availability and observability bug, not a fund-loss or profitable-attack
vector, which is why LOW.

**Fix direction.** Three independent improvements. (1) Match the error — treat only the specific
already-launched signatures (`AlreadyRegistered`, and the drained-factory transfer failure) as a snipe, and
let everything else bubble so the caller can retry. (2) Require a gas floor before the sub-call
(`require(gasleft() > N)`), the standard defence against a 63/64 griefing catch. (3) Make the transition
recoverable: `Failed(3)` should be re-openable while the deadline has not passed, since unlike reasons 1 and 2
it asserts a fact about the outside world that may simply be false. The geometry snapshot in M-12 removes the
retune trigger specifically, but not the class.

---

---

---

### L-13 · LOW · The escape hatch is anchored to `deadline`, not to when the raise closed, locking contributors for up to 37 days  `PROVEN`

**Where** `contracts/presale/PresaleVault.sol:278-291` (`fail`), against `:104-113` (`initialize`'s bounds:
`MAX_DURATION` 30 days, `GRACE_MAX` 7 days).

```solidity
if (block.timestamp <= deadline) revert BeforeDeadline();
```

`fail()` cannot fire before `deadline` under any circumstances, and `finalize()` has **no upper time bound**.
But a presale stops accepting deposits the moment `totalRaised == target` — `deposit` reverts `TargetMet`
(`:150`). So the raise can close in its first minute while the escape hatch stays shut for the full term.

At the permitted maximums — `deadline = now + 30 days`, `finalizeGrace = 7 days` — a presale that fills 60
seconds after creation leaves contributors with **no exit for a measured 36.9999 days**: they cannot deposit, cannot refund
(`refund` requires `failed`), cannot claim (`claim` requires `finalized`), and cannot force the issue
(`fail` reverts `BeforeDeadline`, then `TargetMet` until deadline + grace). Meanwhile the creator holds a free
37-day option: finalize whenever the market suits, or let it lapse into reason 2.

**The lockup is bounded and self-service at the end.** `fail()` is fully permissionless — no modifier, no
`msg.sender` check (`:272`) — so the instant `block.timestamp > deadline + finalizeGrace` any contributor can
flip the vault themselves and pull 100%. Proven: a contributor-initiated `fail()` emits `Failed(2)`, the
subsequent `finalize()` reverts `NotOpen`, and `refund()` returns the full 1 ETH. The exposure is the dead
window, not a permanent trap — which is why LOW.

**Nothing is extractable.** Refunds pay exactly 100%, no party profits from the dead window, and the creator
gains only optionality, not value. One reviewer scored this INFO on that basis and the other LOW; it is
recorded at LOW because it is a fixable design defect touching user funds' availability, not because anything
is at risk.

But "trustless, refundable" is doing less work than it appears: the refund is guaranteed *eventually*, on a clock the contributor does not control and which
is not anchored to anything they can observe.

**Fix direction.** Anchor the hatch to the raise closing, not the calendar: record `filledAt` when
`totalRaised` first reaches `target`, and let `fail()` fire at `min(deadline, filledAt) + finalizeGrace`. That
preserves the grace window's purpose — giving a preimage-holder time to finalize — while removing the dead
time between a full raise and an arbitrary deadline.

---

---

---

### L-14 · LOW · Forfeit-to-stayers is opt-out: `claim()` is not gated by `antiJitDelay`, so only uninformed stakers pay  `PROVEN`

**Where** `contracts/pads/DualStaking.sol:307` — the *only* use of `antiJitDelay`, inside `unstake` — against
`:337` (`claim`, ungated) and `:313-326` (`unstake`'s forfeit loop).

`unstake` confiscates **all** of the caller's unclaimed rewards on that side and re-streams them to whoever
stays:

```solidity
uint256 f = rewardsAccrued[side][asset][msg.sender];
if (f > 0) { rewardsAccrued[side][asset][msg.sender] = 0; _applyReward(side, asset, f, false); }
```

But `claim` carries no hold at all. So the forfeit is trivially avoidable: call `claim` first, *then*
`unstake`, and nothing is forfeited. The mechanism therefore does not deter early exit — it only penalises
users who do not know the order.

**Measured** with the maximum `antiJitDelay = 7 days`, ETH listed on the TOKEN side and fee 0: Alice and Bob
each stake 1,000 tokens, the owner funds 10 ETH, and after 7 days each has accrued
**4.9999999999998384 ETH**. Bob calls `unstake` directly — his ETH balance changes by **−0.000163 ETH (gas
only)** and his `earned` drops to **0**; the full ~5 ETH is confiscated and re-streamed. Alice calls `claim`
first, keeps her ~5 ETH, and then unstakes freely.

The contract's header presents this as one of two anti-JIT defences — *"rewards STREAM over a window (a
flash-staker accrues ≈0), and an `antiJitDelay` hold gates unstake"* — and as `forfeit-to-stayers`. As
implemented it is neither a deterrent nor a redistribution from JIT actors; it is a transfer from
less-sophisticated stakers to more-sophisticated ones.

**Fix direction.** Gate `claim` on the same `stakedAt + antiJitDelay` hold as `unstake`, so the forfeit
applies to anyone exiting early rather than only to those who exit in the wrong order. If the intent is that
rewards should always be claimable, then drop the forfeit — a mechanism that only catches the uninformed is
worse than none.

---

### L-15 · LOW · The architecture doc tells the operator to mine the hook salt to the **wrong flag word**  `VERIFIED`

**Where** `ROBIN-V4-ARCHITECTURE.md:102`, `:245`, `:271` say `0x00C4`; `contracts/hooks/BaseHook.sol:30` and
`contracts/core/CurvePadFactoryV4.sol:46` both say `0x00CC`.

The launch path requires the mined hook address to satisfy `uint160(hook) & 0x3FFF == REQUIRED_FLAGS`, and
`CurvePadFactoryV4` reverts `HookFlagsMismatch` otherwise. The architecture document states that constant three
times — including as a literal instruction, *"MINE `hookSalt` so `CREATE2(...) & 0x3FFF == 0x00C4`"* — and every
one of them is off by the `0x08` bit (`AFTER_SWAP_RETURNS_DELTA`, which the hook genuinely needs: it returns an
`int128` from `afterSwap` to take the sell tax).

`ROBIN-V4-CURVE-ECON.md:37` has the correct value, so the docs disagree with each other as well as with the
code. `scripts/mine.js` reads the flags from the compiled artifact rather than from the doc, so the shipped
tooling is unaffected — this bites the operator who mines by hand, which `DEPLOY.md` and `deploy-curve.js:119-122`
both contemplate. The failure is loud (`HookFlagsMismatch` at launch, before any state is written) and costs a
wasted mining run rather than funds, which is why this is LOW rather than a wiring MEDIUM.

**Fix direction.** Correct all three occurrences to `0x00CC`, and derive the number in the docs from
`BaseHook.REQUIRED_FLAGS` rather than restating it — this is the third place in this report where a hand-copied
constant drifted from the code it describes (see also L-5, L-6).

---

### L-16 · LOW · `graduate()` gates on the **tick**, the anti-grief nudge gates on the **sqrt price**, so the LP can seed above the ceiling  `PROVEN`

**Where** `contracts/pads/RobinCurveV4.sol:297-298` (`ready()`), `:309` (`graduate()`'s gate), against `:531-533`
(the nudge's gate) and `:556` (`CeilingNotRestored`), consumed at `:623-628` (`_mintPermanentLp`).

Three guards, two different notions of "at the ceiling":

```solidity
:298  return tick <= gradTick;                      // ready()
:309  if (tick > gradTick) revert NotReady();       // graduate()
:533  if (curSqrt < gradSqrt) { … nudge … }         // _graduatePull()
:556      if (nowSqrt != gradSqrt) revert CeilingNotRestored();
```

A tick index is a *range* of sqrt prices. The state `tick == gradTick && curSqrt > gradSqrt` — spot strictly
inside tick index `gradTick`, above its lower boundary — satisfies both tick gates and fails the sqrt gate, so
graduation proceeds and **the nudge and its `CeilingNotRestored` check never execute**. That is precisely the
sliver of the curve range that is still unsold, so the pad graduates with the curve *not* fully sold.

It is reached by an ordinary buy that stops a hair short of the ceiling. Measured on a real local v4
`PoolManager` at the top of the window (`sqrtPriceLimitX96 = sqrtAt(gradTick+1) - 1`, geometry START 6000 /
GRAD 3000 / ts 60):

```
gradTick            3000
sqrt(gradTick)      92049301871182272007977902845
sqrt(gradTick+1)    92053904221219956504424993032
spot sqrt AFTER     92053904221219956504424993031   tick 3000
spot > gradSqrt?    true       tick <= gradTick? true
ready() == true  →  graduate() succeeds, nudge SKIPPED
```

Two comments in the file are therefore false as written. `:298`: *"curve fully sold (spot at the ceiling, or
below it if a buy overshot)"*. And `:623`, load-bearing for the LP sizing: *"Spot is guaranteed == gradTick here
(the nudge + `CeilingNotRestored` check), so price at the canonical ceiling."*

**What it costs.** `_mintPermanentLp` sizes `L` from `spGrad` (`:627`) but `PositionManager` binds the position at
the pool's actual price, which is higher, so the mint pulls **less** ETH than `lpEth` and the `SWEEP` action
returns the difference to the curve — where step 9 books it to `platformEthOwed`. That is the leak `[HIGH-2]`
exists to prevent (*"so the WHOLE `lpEth` binds into the locked position — never let the token leg bind and leak
unbound ETH to the platform book"*). Exact v4 integer arithmetic at the worst point in the window:

| `lpEth` | ETH actually bound | unbound → platform book |
|---|---|---|
| 1 ETH | 999950003749687533 | 49,996,250,312,467 wei (0.005000%) |
| 3 ETH | 2999850011249062599 | 149,988,750,937,401 wei (0.005000%) |
| 100 ETH | 99995000374968753283 | 4,999,625,031,246,717 wei (0.005000%) |

Capped at one tick, so ~5 bps of the LP leg — real but small, which is why this is LOW and not a MEDIUM
alongside M-11. The second-order effect deserves a line even so: the `InsufficientReserve` guard at `:630` is
also evaluated at `spGrad`, while the mint's true `amount1` requirement is computed at the higher spot — for
`lpEth = 3 ETH`, 171,101,814,838,709,507,352,469,880 actually required against 171,093,260,389,545,913,825,336,142
checked. The 11.5M-token margin measured in §4 absorbs it comfortably at production geometry, but the check does
not prove what it is written to prove.

**Fix direction.** Make all three guards agree on sqrt price. `ready()` and `graduate()` should compare
`getSlot0`'s `sqrtPriceX96` against `TickMath.getSqrtPriceAtTick(gradTick)`, not the tick — that closes the window
in one line and makes `:623`'s guarantee true. If the tick comparison is kept deliberately (it is cheaper and one
tick of slack is intentional), then `_mintPermanentLp` must size `L` from the **live** `sqrtPriceX96` rather than
`spGrad`, and `:298`/`:623` must stop claiming an equality the code does not enforce.

---

### L-17 · LOW · `RobinAmbushVault.stakingRecipient` is a nullable **immutable** in an add-only vault, so unset means permanently stranded  `VERIFIED`

**Where** `contracts/pads/RobinAmbushVault.sol:57` (`address public immutable stakingRecipient; // may be 0`),
`:94-96` (the constructor's zero-address check, which covers `floorRecipient` but deliberately not this one),
`:176-186` (`_forwardStaking`).

```solidity
:94   if (poolManager_ == address(0) || stateView_ == address(0) || floorRecipient_ == address(0) || curve_ == address(0))
:95       revert ZeroAddress();
…
:177  address s = stakingRecipient;
:178  if (s == address(0)) return 0;
```

The band accrues LP fees on both sides. The ETH side goes to `floorRecipient`, which the constructor requires be
non-zero. The token side goes to `stakingRecipient`, which the constructor explicitly permits to be zero, and the
comment records the intended consequence: *"then token fees stay idle-in-vault"*. `_forwardStaking` duly returns
early, and the token accumulates in the vault.

The problem is that "idle-in-vault" is terminal here, not deferred. `RobinAmbushVault` has **no owner, no
`withdraw`, no `sweep`, no `rescue`, and no setter** — the header states the add-only property as a security
feature (*"there is deliberately NO remove/withdraw/burn path"*), and it applies to the token balance as much as
to the ETH principal. So a vault deployed with `stakingRecipient_ == 0` sends holders' token-side band fees to a
contract from which no party — platform, creator, holders, or a future governance — can ever retrieve them.
`flushFees()` is permissionless, so any caller can move fees from the pool position into that terminal state.

Every other staking sink in the suite is a settable one-shot precisely so this cannot happen:
`RobinCurveV4.setStaking` (`:457`), `LockVault.setStakingRecipient`. The ambush vault is the only one that fixes
it at construction *and* allows it to be null. It is also the only in-scope contract with **no deploy script at
all** — `scripts/deploy-curve.js:120` mentions it solely inside a `console.log` runbook line — so the argument is
hand-typed, by the operator, once, unverifiably (the same L-7 hazard, with a worse failure mode).

Severity is LOW because it is fees rather than principal, it is entirely under the deployer's control at deploy
time, and getting it right costs nothing. It is reported because it is *silent*: nothing reverts, nothing emits,
and the loss is only visible as a token balance that grows and never moves.

**Fix direction.** Cheapest: add `stakingRecipient_` to the `ZeroAddress` check and delete the "may be 0" comment.
Better: make it a one-shot setter like `LockVault.setStakingRecipient`, so the vault can be deployed before the
staking pool exists — which is the actual sequencing constraint that motivated allowing zero — and wired
afterwards, with the accrued token forwarded on the first `flushFees()` after wiring.

---

### L-18 · LOW · Whoever calls first decides where a band's ETH LP fees go — and the diverting call costs 1 wei  `PROVEN`

**Where** `contracts/pads/RobinFloorVault.sol:150` (`_add`'s `_resolve(currency0, delta.amount0(), address(this))`)
against `:161-172` (`_collect`, which takes to `feeRecipient`); the same shape in
`contracts/pads/RobinAmbushVault.sol:210` (`_add`'s `_resolve(currency0, delta.amount0())`, which takes to
`address(this)`) against `:141-148` (`collectFees`, which forwards to the floor).

A positive `modifyLiquidity` in v4 returns `callerDelta = principalDelta + feesAccrued`, so **adding** liquidity
realizes the position's accrued fees as a credit against the principal owed. Both vaults have two permissionless
entry points that realize the same fees to **different destinations**:

| | realized by `collect…()` | realized by `add…()` |
|---|---|---|
| `RobinFloorVault` | `take(currency0, feeRecipient, …)` → the platform (`:170`) | `_resolve(…, address(this))` → stays in the vault, folded into the wall by the next `addFloor()` (`:150`) |
| `RobinAmbushVault` | `_forwardFloor(ethFee)` → the floor vault (`:145`) | `_resolve(…)` → `take` to `address(this)` (`:247`), where `seedAmbush`'s `balanceOfSelf() - pendingFloorEth` (`:128`) turns it into band principal |

Neither vault has a remove path, so once the fees land in principal they are there permanently. And ETH sitting
in the vault's plain balance is **not** recoverable by the fee path: `_forwardFloor` only ever forwards
`fresh + pendingFloorEth`, and `flushFees()` passes `fresh = 0`, so a retained balance can only ever leave as
principal on the next `add`.

`receive()` is open on both vaults (`RobinFloorVault.sol:208`, `RobinAmbushVault.sol:265`), so anyone can create
the `amt > 0` precondition for the `add` path with a dust transfer. Measured — identical tape, identical fees,
only the call order differs:

```
keeper calls collectFloorFees() first:
   ETH to platform         27,199,391,316,139,840        (0.0272 ETH)
   floorLiquidity added    0
anyone donates 1 wei and calls addFloor() first:
   ETH to platform         0
   floorLiquidity added    610,019,229,311,931,910
```

Two things follow. First, the documented revenue line is not a fact about the system: `DEPLOY.md:53` and the
money model both state the wall's LP fees go to the platform, and `scripts/keeper.js` collects on a schedule on
that assumption — but any third party can pre-empt every sweep for 1 wei plus gas, permanently. Second, the
ambush instance **falsifies the contract's own header invariant** (`RobinAmbushVault.sol:42-44`: *"Only accrued
LP fees ever leave (ETH → floor, token → staking)"*). ETH fees can instead be silently absorbed into the band
they came from, so the floor — the protection the whole design is sold on — never receives them.

This is LOW rather than a MEDIUM because **no value leaves the protocol and no attacker gains anything**: both
destinations are permanent, non-withdrawable, protocol-owned positions, and the griefer's only reward is moving
money between two of the platform's own pockets. It is reported because the accounting is genuinely
non-deterministic — you cannot state what a pad earns from either band without knowing the call order — and
because the contract asserts an invariant it does not hold.

Note the contrast that shows this was thought about once and not carried through: `RobinFloorVault._add:152-154`
handles exactly this case for the **token** leg, with a comment explaining that a positive `delta.amount1()` is
realized fees and must go to `feeRecipient` *"(exactly like `_collect`)"* because taking it to the vault would
strand it. The currency0 leg is the same situation with the opposite treatment, and the comment above it
(*"currency0 is the floor's own working capital"*) is true of principal but not of the fees mixed into the same
delta.

**Fix direction.** Split the delta rather than netting it. Call `modifyLiquidity(0)` first to realize fees to the
policy destination, then `modifyLiquidity(+L)` for the principal — two calls, one lock, and the destination stops
depending on which function a stranger called. Failing that, pick one destination per vault and make both paths
use it, and correct `RobinAmbushVault`'s header either way.

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
10. **`RobinLpVault.deposit` refunds the vault's *entire* non-reserve balance to the depositor**
    (`:151` `address(this).balance - feeReserve0`, `:153` `balanceOf(this) - feeReserve1`). `receive()` is open
    (`:316`), the vault has no owner and no rescue path, and nothing in the suite routes value to it, so any ETH
    or token that reaches it outside a deposit is swept by whoever deposits next. The fee reserve and the
    `feeCarry` remainder are correctly excluded, so this can only ever capture a mis-send — but a mis-send here
    has no recovery other than being someone else's refund.
11. **`FeeWalletRegistry` proposals never expire.** `pendingEta` is only cleared by a commit or an explicit
    `cancelProposal`, so a proposal made and abandoned stays committable forever. Given M-14 — this address is
    effectively the protocol's root admin — a stale proposal is a live capability sitting in storage.

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

### I-3 · INFO · The idempotent-init `catch` blames a front-run for every `initialize` failure  `mechanism refuted, diagnostics only`

**Where** `contracts/core/CurvePadFactoryV4.sol:170-175`; same shape in `core/PadFactory.sol` and
`core/StockPadFactory.sol`.

The `[MEDIUM-3]` idempotent-init handler catches **every** `initialize` revert, re-reads `getSlot0`, and
reverts `PoolAlreadyInit` unless the price matches. For a pool that was never initialised `sqrtPriceX96` is 0,
which never matches — so any future `initialize` failure surfaces as *"someone front-ran you"* regardless of
the real cause. Fail-closed and non-exploitable; no funds or state are at risk.

**The `tickSpacing` route into it is refuted.** This was originally filed MEDIUM on the premise that
`tickSpacing` is unbounded because `:120` checks only `ts <= 0`. It is bounded — as a divisibility constraint
rather than a comparison. `:120` also requires `d.curveWidth % ts == 0`, and `RobinV4FeeConfig._validate`
requires `curveWidth > 0`; a positive divisor of a positive `int24` cannot exceed it, so **`ts <= curveWidth`
is structurally enforced**. At the shipped geometry that is `ts <= 23000 < 32767`, and the alignment
constraint is tighter still: `ts` must divide `gcd(startTickMag, curveWidth)` = `gcd(201600, 23000)` = **200**.
The test geometry gives 600. `TickSpacingTooLarge` is arithmetically unreachable, so the catch does not
currently mis-report anything.

The residual is purely diagnostic, and only bites a future geometry retune that pushes some parameter out of
v4's accepted range — at which point a creator-misconfigured launch dies with a misleading `PoolAlreadyInit`
(and, through a presale, an equally misleading `Failed(3)` — see M-15).

**Fix direction.** Distinguish the revert rather than adding a `MAX_TICK_SPACING` check: only blame a
front-run when `getSlot0` returns a **non-zero** price, and otherwise bubble the original error.

---

### I-4 · INFO · The only runbook in the audit package deploys a **different stack** — and following it produces M-2  `VERIFIED`

**Where** `DEPLOY.md` in full, listed by `AUDIT-SCOPE.md:6` as one of four companion documents.

`DEPLOY.md` is the sole operational document in the package, and it is a complete, competent runbook for the
**PadFactory** stack. The curve suite that `AUDIT-SCOPE.md:1` puts in scope has no runbook at all. Neither
`CurvePadFactoryV4`, `RobinV4FeeConfig`, `CurveV4Deployer`, `RobinCurveV4`, nor `RobinAmbushVault` is named
anywhere in the file, and `scripts/deploy-curve.js` — the curve path's actual deploy script — is never mentioned.

Line by line against the suite under audit:

- **§1** deploys `… → LockVault → PadFactory → (lockVault.setFactory) → StakingFactory`. Pointing
  `lockVault.setFactory` at `PadFactory` is exactly **M-2**: `LockVault` has one registrar slot, so the curve
  factory's `registerLaunch` then reverts `NotFactory` at `graduate()` step 5, permanently, for every caller.
  The runbook does not merely fail to prevent M-2 — as written it *instructs* it.
- **§2** runs `scripts/launch.js`, wires `hook.setFloorRecipient` and a `DualStaking` pool. On the curve path
  the launcher is `deploy-curve.js`, and the required wiring is a different and longer list —
  `curve.setStaking`, `curve.setCreator`, `LockVault.setStakingRecipient`, plus the hand-deployed floor and
  ambush vaults. That omission is the wiring cluster in **M-7**, **M-11**, **L-7** and **L-17**.
- **§2** also writes `hook@0x…C4` — a fourth occurrence of **L-15**'s wrong flag word.
- **Money model** is the PadFactory's flat 1% tax with LP fees split platform/staking. The curve's model is the
  directional buy/sell tax plus the graduation waterfall, and the table matches neither.
- **"The only mutable knob system-wide is `FeeWalletRegistry.platformFeeWallet`"** (`:60`, repeated at `:24`) is
  false for both stacks — see **L-6** and **M-10**.

Filed as INFO because the impact is already counted under the findings it produces rather than being additional
loss on top of them. It is recorded separately because those findings share one root cause, and it is not in the
contracts: the curve suite was never given a runbook, so its operator guidance is being read off another
system's. Any fix to M-2, M-7 or M-11 that does not also produce a curve-specific runbook leaves the next
operator following this document again.

**Fix direction.** Write `DEPLOY-CURVE.md` for the stack in scope, generated from `scripts/deploy-curve.js` so
the two cannot drift, with an explicit post-graduation wiring checklist that asserts every one-shot
(`lockVault.setFactory` → `CurvePadFactoryV4`, `hook.setFloorRecipient`, `curve.setStaking`, `curve.setCreator`,
`LockVault.setStakingRecipient`, both vaults' constructor arguments). Retitle `DEPLOY.md` to say which stack it
covers, and remove it from `AUDIT-SCOPE.md:6`'s reading list or mark it out of scope.

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
  The nudge itself is right; **L-16** is that the two gates *upstream* of it compare the tick instead, so it
  can be skipped in a state it should have handled.
- **`BaseHook`'s flag word and both of its guards.** `REQUIRED_FLAGS = 0x00CC` decodes correctly against
  v4-core's `Hooks` constants (`BEFORE_SWAP 0x80 | AFTER_SWAP 0x40 | BEFORE_SWAP_RETURNS_DELTA 0x08 |
  AFTER_SWAP_RETURNS_DELTA 0x04`), the constructor self-assert and the factory's check read that same constant,
  and every unflagged `IHooks` entry point reverts rather than returning a selector. The transient-storage
  `nonReentrant` is sound: EIP-1153 rolls `tstore` back on revert, so a *caught* revert cannot leave the flag
  latched, and the slot is per-address so instances cannot collide. One design consequence is worth knowing
  rather than fixing — the same flag guards `beforeSwap`/`afterSwap` *and* the five user-facing `claim*`
  functions, so no claim can execute inside a swap. That is deliberate, and it is designed around at the one
  place it matters: `RobinCurveV4.graduate()` calls `claimBuffer` before its own `unlock`, not inside it.
- **The hook's claim-redemption path.** `unlockCallback` is gated on `msg.sender == poolManager`, and v4 only
  ever calls back the address that called `unlock`, so no third party can supply its `data`. Burn-then-take is
  ordered correctly, and `_payout` runs after the unlock closes, so a hostile recipient re-entering finds the
  owed slot already zeroed and the lock already released.
- **`FeeWalletRegistry`.** Propose / commit / cancel are internally consistent, `pendingEta == 0` is an
  unambiguous "no proposal" sentinel, and `renounceOwnership` is disabled so the system's only mutable knob
  cannot be frozen at zero. The one nit is not a finding: a proposal never expires, so one made and forgotten
  stays committable indefinitely by whoever holds ownership later. An expiry would be cheap.
- **`RobinLpVault`'s fee accounting.** The MasterChef accumulator, the `feeCarry` remainder, and the
  debt/pending resets are correct across every liquidity change, and `feeReserve0/1` is incremented exactly
  when the contract physically receives a fee and decremented exactly when it pays a claim. Most relevant to
  **L-18**: this vault gets the netting question right. It harvests fees in a *separate* `unlock` before it
  ever adds or removes principal, so `modifyLiquidity`'s `principalDelta + feesAccrued` can never mix the two —
  which is exactly the discipline `RobinFloorVault` and `RobinAmbushVault` lack. `_settleOwed`'s positive branch
  is unreachable for a full-range add once fees are already harvested.

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

**L-16** — build the curve `deployStack` from `test/sim/curve.e2e.sim.test.js` with
`curveSupply = reserveSupply = 1000e18` at START 6000 / GRAD 3000 / ts 60. Buy once through `PoolSwapTest`
with `sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(gradTick + 1) - 1` (any oversized `amountSpecified`; the
limit binds). Read `getSlot0`: `tick == gradTick` while `sqrtPriceX96 > getSqrtPriceAtTick(gradTick)`. Assert
`curve.ready() == true`, then `curve.graduate()` — it succeeds with the nudge and `CeilingNotRestored` both
skipped. The leak column is exact v4 integer arithmetic:
`L = getLiquidityForAmount0(√grad, √maxUsable, lpEth)`, then compare
`getAmount0Delta(√grad, √maxUsable, L, true)` against `getAmount0Delta(√(grad+1) − 1, √maxUsable, L, true)`.

**L-18** — same curve `deployStack`, `curveSupply = reserveSupply = 1000e18` at START 6000 / GRAD 3000 / ts 60.
Buy 200 ETH (tick falls to `t0`), deploy `RobinFloorVault(..., anchorTick = t0 + 300, bandWidthSpacings = 20)` so
the band sits above spot, send it 5 ETH and `addFloor()`. Then run a dip-and-recovery so the band is crossed in
both directions — sell the whole bag (tick up through the band), then buy 200 ETH again (tick back down through
it, which is what accrues **currency0** fees). Now run the same tape twice and change only the last step:
`collectFloorFees()` versus `{ send 1 wei; addFloor(); addFloor(); }`. Compare the platform's balance delta
against `floorLiquidity()`.

**L-1** — evaluate `getLiquidityForAmount1(√grad, √start, curveSupply)` then
`getAmount0Delta(√grad, √start, L, false)` in exact integer arithmetic across `startTickMag`, holding
`curveWidth = 23000`, `ts = 100`, `curveSupply = 730M`. The raise hits 0 wei at ~700000, inside what
`CurvePadFactoryV4` accepts.

---

## 7. Suggested remediation order

1. **C-2** — 100 wei traps the entire raise, and the documented recovery is bricked by the same mechanism.
   Fix (1) alone — a caller-supplied price limit on `restoreCeiling` — converts it from unrecoverable to
   recoverable, which is the single highest-value line in this document.
2. **C-1** — the only finding that takes 100% of a user-facing pot, for 3 wei, permissionlessly. Fix the
   drip-rate floor *and* the pause guard; the sub-rate-tranche check closes the arming step and the dust
   stranding in I-1(5) at the same time.
3. **H-1** — no minimum trade size, cheaper than paying the tax, and a router can hand it to every user. It
   defunds the creator's entire income and the floor. The buy side already shows the fix.
3. **M-15** — the floor only deepens while the price is above it, so the pad's headline protection does not
   operate in the state it exists for. It falsifies an `AUDIT-SCOPE.md` §4.4 invariant rather than mis-tuning
   one, so it needs a design answer, not a parameter change.
4. **M-2 and M-4** — one-shot wiring defects with permanent, unrecoverable failure modes, both cheap to close
   (an assertion at launch; an on-chain anchor read).
5. **H-2 and H-3** — before any stock pad exists. It is a rug primitive, and M-8 means it is currently untestable
   locally, so fix the mock in the same pass.
5. **M-11** — holder fees routed to the platform by the ordinary post-graduation flow, with no attacker
   required. One line, and the right shape already exists in the same file (`claimFloor`'s
   `NoFloorRecipient`). Fold in **I-2**'s `seedAmbush()` poke while you are there — same pattern, same file.
6. **M-1**, then **L-1** and **M-10** — real value loss and two permanent bricks, all gated on configuration
   that is easy to get wrong and currently unbounded.
7. **M-6 and M-18** before the package goes to the external auditor. Auditing from a stale architecture
   document is the most expensive mistake on this list, because it wastes the engagement rather than the code
   — and M-18 is worse than stale: the "locked spec" describes the ambush with every sign reversed, so it
   points the review away from the risks the shipped vault actually has. Fix both together with **I-4**; the
   three documents disagree with the code in three different directions, so correcting any one alone still
   ships a self-contradictory package.
8. **M-3, M-5 and M-12** are product decisions as much as code ones: decide what `PadFactory` is, which owner
   powers you are willing to defend, and whether a presale's terms may move under its contributors. Then make
   the code and the docs agree.
9. **M-7, M-9, L-2, L-3, L-6, L-7, L-17** — the wiring/runbook cluster. Fix them together, as one scripted
    post-launch wiring step that asserts every one-shot is set and consistent, and produce the curve-specific
    runbook **I-4** calls for in the same pass — I-4 is the common root, and without it the next operator
    reaches for the PadFactory runbook again.
10. The rest as cleanup, with **L-4**, **L-5**, **L-8** and **L-15**'s doc corrections folded into whichever PR
    touches those files, **L-16**'s three guards brought onto one comparison while someone is already in
    `RobinCurveV4`, and **L-18**'s netted fee delta split in both vaults at once — it is the same three lines
    in each. Note that L-8 and M-10 each falsify a specific sentence an auditor is told to rely on
    (`AUDIT-SCOPE.md` §4.5 and `RobinV4FeeConfig`'s no-timelock justification), and L-16 falsifies two
    load-bearing comments in the graduation path — those sentences should be corrected even if the underlying
    code is left as is.
