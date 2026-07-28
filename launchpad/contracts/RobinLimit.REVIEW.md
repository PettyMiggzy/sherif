# RobinLimit — review before you deploy

This contract moves user funds, so it is **staged, not deployed**. Read this, review
`RobinLimit.sol`, and ideally get an outside audit before it touches mainnet. Nothing about
limit orders / DCA goes live until you deploy it and point the keeper at it.

## What it is

Non-custodial limit orders and DCA for Robin Labs coins, executed through `RobinSwap`.

- The maker signs an **EIP-712 order** and grants `RobinLimit` an **ERC20 allowance** on the
  token they're selling (WETH to buy a coin, the coin to sell for WETH).
- A **keeper** (anyone) calls `execute(order, signature)` when the order can fill. One slice is
  pulled from the maker, swapped through RobinSwap, and the proceeds are sent to the maker — all
  in **one atomic transaction**. The contract **never holds a balance between transactions**.
- **Limit order** = 1 slice. **DCA** = N slices on an interval.

## Why it's safe by construction

- **No escrow / no custody.** Funds live in the maker's wallet until the instant of a fill. The
  contract only ever holds tokens transiently inside `execute()`. There is no balance for anyone
  (owner, keeper, attacker) to withdraw. `receive()` rejects ETH from anyone but WETH/RobinSwap.
- **Maker sets the price.** Every fill must clear `makerOut >= minOut` (the signed limit), checked
  in RobinLimit itself, after the keeper fee. The underlying swap runs at market with the price
  enforced here; since it's one atomic tx, a price move (even a same-block sandwich) just makes the
  fill revert — nothing settles below the signed price. Two hardening rules back this: `minOut` must
  be `> 0` (a zero floor would disable protection entirely — rejected on-chain AND in the app/store),
  and `minOut` is checked against what the maker ACTUALLY receives, measured across the final transfer,
  so a fee-on-transfer buyToken can't deliver less than the signed minimum.
- **Can't over-fill or replay.** `filledSlices[hash]` caps fills at `slices`; `expiry` kills stale
  orders; `cancel()` (maker-only) stops the rest. The EIP-712 domain binds signatures to this
  contract + chain id (recomputed on a fork).
- **Keeper fee is bounded.** `keeperFeeBps <= MAX_KEEPER_BPS` (1%), taken from output *after* the
  maker's minOut, so the maker always nets at least the price they signed.
- **DCA cadence.** `interval` is enforced between consecutive fills; a bad-price slice simply
  reverts and is retried later — it never partially settles.

## What to review specifically

1. The direction/pair check: exactly one leg must be WETH (an ETH-quoted venue). Confirm this
   matches how you want coins routed.
2. The RobinSwap integration: `buy{value}` and `sell` — confirm proceeds land in RobinLimit and are
   forwarded in full (minus the capped fee). If RobinSwap's fee model changes, re-check `out`.
3. `forceApprove` on the sell path (approve exactly the slice each time; no lingering allowance).
4. Reentrancy: `nonReentrant` + effects-before-interactions. Confirm no external call precedes the
   `filledSlices`/`lastFillTs` writes.
5. The keeper is permissionless. Confirm that's intended (it decentralizes execution but invites
   MEV competition, which only benefits the maker via the price floor).

## Routing venue: padRouter (live) or RobinSwap

`RobinLimit`'s `IRobinSwap` interface (`buy(token,minOut) payable`, `sell(token,amountIn,minOut)`) is
byte-for-byte the same as the LIVE **PadRouter** (`0xA6BaAB820809C7fC8350311776627298f91F07eC`). So the
`robinSwap` constructor arg can be **padRouter**, and limit orders / DCA work on pad coins with just this
one contract deployed — no RobinSwap needed. RobinLimit only ever *calls* padRouter as a normal user;
it never modifies padRouter, the curves, any coin, or the $ROBIN token. padRouter refunds unspent ETH on
a near-graduation partial-fill buy; RobinLimit now sweeps that refund back to the maker as WETH (verified
by the "sweeps a venue's ETH refund" test), so nothing is stranded. Alternatively, point it at RobinSwap
once that is deployed to cover external top coins too.

## Deploy + wiring (only after review)

1. `constructor(WETH, venue, owner)` — WETH + the routing venue (padRouter for pad coins, or RobinSwap),
   owner = the cold wallet.
2. Optionally `setKeeperFeeBps(bps)` (default 20 = 0.20%).
3. Run the keeper (`indexer/keeper` once built) with the deployed address; it watches stored orders
   and calls `execute()` when they clear.
4. The pad's profile "Automations" panel lets makers sign/cancel orders; it needs the deployed
   address in `pad/assets/config.js`.

Tests: `npx hardhat test test/fn-robinlimit.test.js` (8 cases: limit buy/sell, DCA cadence + no
over-fill, cancel, expiry, bad-sig, fee cap, pair guard).
