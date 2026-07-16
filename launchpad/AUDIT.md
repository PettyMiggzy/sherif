# Sheriff's Pad — internal security audit

Self-audit of the launch + trade + tax contracts before deploy. Scope: the money
paths a user's funds actually flow through — `PadRouter` (swap desk + project
tax), `CurvePadFactory` (launch + dev buy), `CurvePool` (bonding curve →
graduation), `Bond` (the floor), `LaunchToken` (the anti-snipe guard).

Method: manual review + an adversarial test suite that tries to break each path
(`test/padrouter.adversarial.test.js`), plus the exact-math unit tests
(`test/padrouter.test.js`) and the on-fork end-to-end tests (`test/fork/*`).

Status: all findings below resolved. Unit + adversarial + fuzz suites pass
locally; 7 fork tests gated on a real archive RPC. The `SIMS=300` randomized
battery (below) passes clean.

## Findings & resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | Med | `PadRouter.uniswapV3SwapCallback` only checked `_swapping`, not that the caller was the pool we're swapping with (Bond/CurvePool already check `msg.sender == pool`). A stray/forged callback during the window could pay out `tokenIn`. | Added `_activePool` and require `msg.sender == _activePool`. Same hardening applied to `CurvePadFactory`'s dev-buy callback. Test: `swap callback can't be invoked out of band`. |
| F2 | Low | If `flushBurn`'s buy-and-burn swap partially filled, leftover WETH sat in the router; a later `buy`'s leftover refund (which returns the whole WETH balance) would hand it to an unrelated buyer. | `flushBurn` now unwraps any residual WETH and re-credits it to `burnEscrow`. The router never holds stray WETH between calls. Test: `burn flush … re-credits any residual`. |
| F3 | Low | Front-end `quoteMinOut` returned `0` on any read failure → a buy/sell could go out with **no slippage floor** (sandwich bait). | It now throws a friendly "couldn't price this trade" instead of ever returning 0. A trade never signs without a real min-out. |
| F4 | Info | `withdrawPlatform` was the one state-changer without `nonReentrant`; a seller's payout hook could re-enter it. Harmless (CEI, funds only ever go to `owner()`), but it broke the clean "any re-entry reverts" invariant. | Added `nonReentrant`. Now every fund-moving entrypoint is guarded. Test: `reentrancy … cannot double-dip` (mode 2). |

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

## Fee model (as of the $SHERIFF flywheel update)

Every coin pays a swap-desk fee of **1%–4% per side** (1% floor, 4% cap, enforced
at registration):
- The **default 1%** is the platform's — **0.9% immediate**, **0.1% held until the
  coin graduates** then released to the platform (`claimDeferred`).
- Anything **above 1%** splits **25% → the platform's $SHERIFF cut** (accrued
  separately in `sheriffCutEscrow`, paid to the platform via `withdrawSheriffCut`,
  which buys/burns $SHERIFF off-chain) and **75% → the project** (wallet / Bond
  floor / auto-burn).

Rounding is exact: the platform's immediate cut absorbs the remainder, so the
pieces sum to the fee **to the wei** (verified in the unit + 300-sim tests). All
shares still accrue as escrow and pay out via separate permissionless flushers,
so the split can never revert a trade. Re-audited: unit + adversarial + the
`SIMS=300` battery all pass under the new model.

## Standing invariants (by construction, not just tests)

- **Token stays clean** — no transfer tax, no mint, no blacklist over sells, no pause, no owner. The anti-snipe guard is buy-side-only, auto-expiring, and immutable (`LaunchToken`).
- **The Bond can't be rugged** — no function sends its WETH/tokens to an arbitrary address; Sherwood principal is never withdrawn; only Sherwood fees leave, to the fixed platform (`Bond`).
- **Tax is a swap-desk fee, not a fee-on-transfer token** — so it can't break Uniswap v3 or read as a honeypot, and the split happens as escrow, never as extra transfers inside the signed trade.

## Deploy-time notes (not code bugs, but must be set right)

- The `PadRouter` **owner** (receives the platform's tax cut) and the factory
  **platform** (receives LP/graduation fees) should be the **same** platform
  wallet/multisig. `owner()` uses `Ownable2Step`.
- Re-run `test/fork/*` against the deployed addresses with a real archive
  `FORK_RPC` before flipping the front-end gates live.
- The floor share of a coin that **never graduates** stays escrowed in the router
  (safe, but idle). Acceptable; noted so it isn't a surprise.
