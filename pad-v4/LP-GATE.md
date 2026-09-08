# LP-1 — the curve-phase liquidity gate

## What was wrong

`REQUIRED_FLAGS` was `0x20CC`. Decoded against the v4 permission bits that is exactly
`BEFORE_INITIALIZE | BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA`
— **no liquidity permission of any kind.** The PoolManager therefore never asked the hook about
`modifyLiquidity`, and `PadToken` is a plain ERC-20 with no transfer hook. Two things followed, both
live on every v4 pad.

**(a) LP-through was a tax-free exit.** The sell tax fires only in `afterSwap` on a `oneForZero` swap
(`RobinFeeHook.sol:348-363`). Mint a token-only range, let buyers walk down through it, then *remove*
the position — you are now holding the money side. Removing liquidity is not a swap, so it paid no
sell tax and no floor carve. The creator's sell stream and the permanent floor's funding were both
avoidable by any patient holder.

**(b) Buy-flow interception starved graduation.** Liquidity planted in `[gradTick, startTick]` — the
same shape as the curve's own position — splits every buy pro-rata by L between the curve and the
interloper. The curve never sells out, `ready()` never flips, the permanent locked LP is never minted,
staking is never funded. The repo already handled planted liquidity in the *below-the-ceiling
overshoot* variant (`restoreCeiling`, the C-2 note, `RobinCurveV4.grief.test.js`). In-range
interception was neither tested nor handled.

L-25 closed the tax-free venue in a **sibling** pool and left this one open **inside the pad's own
pool**. The "unbypassable tax" claim was still not true.

## The fix

`REQUIRED_FLAGS = 0x28CC` — `BEFORE_ADD_LIQUIDITY` (0x800) added — and:

```solidity
function beforeAddLiquidity(address sender, PoolKey calldata key, ...) external view override {
    if (msg.sender != address(poolManager)) revert NotPoolManager();
    PoolConfig storage c = config[key.toId()];
    if (c.registered && !c.graduated && c.bufferRecipient != address(0)) {
        if (sender != c.bufferRecipient && sender != c.floorRecipient) revert LiquidityLocked();
    }
    return IHooks.beforeAddLiquidity.selector;
}
```

The gate is deliberately narrow. It binds only while a curve is wired and unfinished:

| Pool state | Gated? | Why |
|---|---|---|
| Not registered, or no curve (`bufferRecipient == 0`) | **No** | Instant-LP pads from `PadFactory` / `StockPadFactory` mint through the PositionManager at launch and have no curve phase to protect |
| Curve wired, not graduated | **Yes** | Only the curve (`bufferRecipient`) and the floor vault (`floorRecipient`) |
| Graduated | **No** | An ordinary v4 pool again — depth, routing and aggregator support all need third-party LPs |

The **PositionManager is deliberately not admitted** during the curve phase; it is the route every
third party would use. The one legitimate PositionManager mint — the permanent locked LP — happens
after `onGraduated` has already opened the gate, inside the same graduation transaction.

`onGraduated(PoolId)` is reachable only by the pool's wired curve. `bufferRecipient` is set exactly
once by the factory in the launch tx and frozen thereafter, so no other address can reach it. It is
idempotent rather than reverting on a repeat, and the curve's call is `try`/`catch`-ed behind a
code-length check, so a pad whose `bufferRecipient` was never wired — which is not gated in the first
place — cannot brick on it.

## Ordering inside `graduate()`

```
1)  GRADUATE_PULL          curve unwinds its own position     sender = curve      admitted
3b) hook.onGraduated(id)   lifts the lock                     msg.sender = curve
4)  _mintPermanentLp       PositionManager mints the locked LP                    gate now open
```

Step 1 is the curve's own `modifyLiquidity`, so it passes the gate before the lock lifts. Step 4 goes
through the PositionManager, so the lock must already be lifted. All one transaction.

## Honest scope

**The LP-through exit is closed for the curve phase only, not forever.** Post-graduation a holder can
still mint a range, let buyers walk through it, and withdraw the money side without paying the sell
tax — at the cost of the position not filling. Closing it there would mean permanently banning
third-party liquidity from every graduated pad, which costs more in depth, routing and aggregator
support than the 1% it protects.

The curve phase is the part that had to be shut, because there the whole float is the curve's and
interception does not merely avoid a fee — it stops the pad graduating at all.

## Why it had to be now

Hook permissions live in the hook's **address** (`BaseHook.sol:60`, cross-checked by all three
factories). A hook mined without `0x800` keeps the hole for the life of every pool it serves. v4 is on
testnet `46630`; mainnet is `4663` and has no v4 pads, so this cost one constant and one branch. After
the first mainnet launch it would have been unfixable for that pad forever.

## Blast radius

`REQUIRED_FLAGS` `0x20CC → 0x28CC` in `BaseHook`, `HOOK_FLAGS` in all three factories, the salt miner
(`scripts/mine.js`), the launch runbook, the staging config generator (which was additionally stale at
`0xcc`), and every test that mines a hook address. Both lab hooks (`H5ObsHook`, `H5ObsHookMin`) gained
a permissive `beforeAddLiquidity` override — the flag is on for them too, so the PoolManager now calls
it, and BaseHook's stub reverts by default.

Pinned by `test/regression/LP1.liquidity-gate.test.js`.
