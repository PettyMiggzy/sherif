# v3 pad — creation fee, LP-fee choice, daily auction: pre-audit self-review

**Scope.** New surface added on top of the already-live, already-deployed v2 factory (see `AUDIT-V2.md` — that
finding set is CLOSED and not reopened here): the mandatory 0.001 ETH creation fee, creator-chosen LP fee tier
({500, 10000}), and the optional 0-4 day daily batch auction with unsold-day-to-staking fallback.

| | |
|---|---|
| **Repo / branch** | `Robinlabz/Labs` (canonical) · working branch `claude/robinhood-chain-website-8loxcm` |
| **Commit** | `b2cc104` (auction fixes) through `43c9bf7` (branch tip at self-review time) |
| **Files, new** | `contracts/DailyAuctionVault.sol`, `contracts/RobinStaking.sol` |
| **Files, modified** | `contracts/CurvePool.sol`, `contracts/Bond.sol` (immutable `poolFee`/`SPACING`), `contracts/CurvePadFactory.sol` (`CREATION_FEE`, `poolFee` validation, auction carve-out, `auctionVaultDeployer`), `contracts/deployers/CurveDeployers.sol` (`RobinStakingDeployer`, `DailyAuctionVaultDeployer`), `scripts/deploy-v2.js` |
| **Build / test** | `cd launchpad && npx hardhat compile && npx hardhat test` → **360 passing / 0 failing / 41 pending** (pending = fork-only suites gated on `FORK_RPC`, no live-chain access in this environment — expected, not a gap in local coverage) |
| **Method** | Source review + full local suite + a genuine local-devnet integration proof (`scripts/verify-v2-deploy-e2e.js`, run against a real `npx hardhat node`, not `hardhat test`'s in-process network) exercising the fixed deploy script end to end: real launch, real bid day, real zero-bid day, real claim, real graduation with creator+platform reward confirmed via WETH balance deltas. |

**Verdict: no open blockers.** One real, self-found HIGH finding (V3-1) is fixed and regression-tested. One
MEDIUM operational gap (V3-2) is fixed and live-proven. Everything else is either accepted/documented design or
INFO.

| id | sev | area | status |
|---|---|---|---|
| V3-1 | **HIGH** | `DailyAuctionVault` — no `receive()`, stranded funds | **FIXED** |
| V3-2 | MED (operational) | `deploy-v2.js` never wired the auction feature | **FIXED** |
| V3-3 | INFO | LP fee tier restricted to {500, 10000} (no 3000) | by design — see below |
| V3-4 | INFO | auction proceeds reach creator/platform only at graduation, not per-day | by design — see below |
| V3-5 | INFO | dual-chain address-matching proof is local-only | not yet run against funded real chains — see below |

---

## V3-1 — HIGH. `DailyAuctionVault` had no `receive()`; a bid day's leftover-ETH refund reverted forever, stranding that day's bidders. **FIXED.**

`_burnBuy(value)` swaps a bid day's post-platform-cut ETH against the curve's live Uniswap v3 position, capped at
`gradSqrtPriceX96()` so it can never push price past the graduation ceiling. If the swap doesn't consume the
whole input (price hit the ceiling first — plausible on any 2+ day auction, since carving more days out of the
curve's own supply thins it materially), the leftover is refunded:

```solidity
IWETH9(WETH).withdraw(leftWeth);               // WETH9 sends native ETH to msg.sender — the vault itself
(bool ok,) = platform.call{value: leftWeth}(""); // then forwarded on
require(ok, "refund");
```

`DailyAuctionVault` had **no `receive()`/`fallback()`**, so it could not accept the ETH `WETH.withdraw()` sends
back to it. On the deployed mock (`require`-checked `withdraw`) the `withdraw()` call itself reverts; on real
canonical WETH9 (unchecked `.call`) it silently no-ops and the following `require(ok, "refund")` reverts anyway
— same practical outcome either way. Because `closed[day] = true` is set *before* `_burnBuy()` runs, the whole
transaction — including that flag and the platform's already-computed cut — rolls back. **The condition is
deterministic and does not change on retry: that day can never be closed, so its bidders can never `claim()`
(gated on `closed[day]`), and the platform never receives that day's cut either.**

Found by building a genuine local-devnet integration proof, not by static review: a 2-day auction (`auctionDays:
2`, carving 20% of the curve's share out before seeding) with two ordinary bids (1 ETH + 3 ETH, nothing
adversarial) reproducibly pushed the curve to its ceiling and reverted `closeDay(1)` with `"eth send"`
(`MockWETH9.withdraw`'s internal check). `test/daily-auction.test.js`'s existing coverage never exercised the
leftover-refund branch at all — its one bid-day test uses a 1-day auction with the same bid sizes, which stays
just under that thinner curve's threshold.

**Fix:** `receive() external payable {}`, matching the identical pattern already used for this exact call shape
elsewhere in this codebase (`CurvePadFactory.sol:279`, `PadRouter.sol:167`, `RobinStaking.sol:374`). Added a
regression test (`test/daily-auction.test.js`, "a bid day whose burn-buy overshoots the graduation ceiling...")
that reproduces the exact overshoot and asserts `closeDay()` now succeeds and the leftover correctly reaches the
platform. Full suite re-run green (360/0/41) after the fix.

## V3-2 — MEDIUM (operational). `scripts/deploy-v2.js` never deployed the auction thin-deployers or called the owner-settable `setAuctionVaultDeployer`. **FIXED.**

`CurvePadFactory.auctionVaultDeployer` is **owner-settable, not a constructor argument** — deliberately, so
every existing call site that constructs the factory (dozens of tests/scripts) keeps working unchanged when the
feature was added. That also means nothing wires it on by default, and nothing in this repo's real deploy path
ever called the setter: a genuine mainnet deployment run through the unpatched `deploy-v2.js` would have
`auctionDays > 0` revert `BadValue` on every launch, forever — exactly the state the live (pre-this-session) v1
factory is in today.

**Fix:** `deploy-v2.js` now deploys `RobinStakingDeployer` + `DailyAuctionVaultDeployer` and calls
`factory.setAuctionVaultDeployer(...)` when the deploying key is the factory's owner. When the real owner is a
separate treasury key the script holds no signature for, it prints an explicit, loud instruction (exact address,
exact call) instead of silently leaving the feature off. Both new addresses are recorded in the script's
`deploy.v2.json` output.

**Live-proven, not just read:** ran the fixed script against a fresh `npx hardhat node`, then
`scripts/verify-v2-deploy-e2e.js` (new file, kept — not throwaway) against that same live deployment: 43/43
checks passed, including a real `poolFee=500, auctionDays=2` launch (token address ends in `1ab5`, matches the
off-chain mined prediction), a real bid day (platform paid exactly 10%, burn-buy moved the pool's tick, `DEAD`
balance moved by exactly `tokensBurned`), a real zero-bid day (lazily deploys + funds a `RobinStaking` pool), a
real pro-rata claim, and a real graduation — **creator's WETH balance increased by exactly `GRAD_REWARD` = 0.5
ETH; platform's WETH balance increased by 0.5 ETH plus swept LP fees**, both measured via `WETH.balanceOf()`
deltas.

## V3-3 — INFO. LP fee tier restricted to {500, 10000}; 3000 (0.3%) is not offered. By design.

Uniswap v3's real factory couples fee tier to tick spacing at the protocol level (500→10, 3000→60, 10000→200).
The Bond's wall geometry (`AMBUSH_NEAR=9000`, `AMBUSH_FAR=15600`, `TICK_BOUND=11000`, `BOUNTY_NEAR=32000`,
`BOUNTY_FAR=887200`) divides evenly by spacings 10 and 200 but not by 60, so a 0.3% pool would silently
misalign every wall band. Both `CurvePool.sol` and `Bond.sol` validate `poolFee_ == 500 || poolFee_ == 10000`
in their constructors — not a governance knob, a structural constraint. Verified via a real graduation on the
500 tier (`test/creation-fee-and-pool-fee.test.js`).

## V3-4 — INFO. The auction's ETH reaches creator + platform only at graduation, not per bid-day. By design.

`closeDay()`'s only immediate payout is the platform's flat 10% vig. The remaining 90% is spent as an ordinary
buy against the curve's own live position — no different from any trader's buy — so it becomes part of
`raisedWeth`, which `graduate()` already splits via the existing, previously-audited `GRAD_REWARD` mechanism
(up to 0.5 ETH each to creator and platform, capped at raise/4 apiece) before the remainder funds the Bond. This
was specifically verified live end-to-end by V3-2's E2E proof (creator + platform WETH balances both moved by
the expected amount after an auction-funded raise reached graduation) — not inferred from source alone.

## V3-5 — INFO. Arc+Robinhood dual-chain address-matching is proven locally only.

`scripts/prove-dualchain-address-match.js` proves the claim against two independent local Hardhat devnets with
freshly-deployed real `@uniswap/v3-core` bytecode at *different* addresses on each — confirming the underlying
mechanism (plain-CREATE infra addresses are `f(sender, nonce)` only, so a shared deployer key + identical deploy
sequence lands every infra contract, including the factory, at the same address regardless of the real chain's
own Uniswap infra addresses). Not yet run against real funded wallets on both real chains — that step needs a
funded deployer key on each chain and is explicitly a real-deployment action, not a code question. See
`DUAL-CHAIN-LAUNCH.md`.

## Before this surface goes live

1. Real deployment must run the now-fixed `deploy-v2.js` (or hand-execute the equivalent
   `setAuctionVaultDeployer` call from the owner key) — otherwise the auction feature stays silently off,
   same as it always has been on the live v1 factory.
2. `scripts/verify-v2-deploy-e2e.js` should be run once against whatever network actually receives the real
   deployment, as a live smoke check (it's parameterized by `DEPLOY_V2_JSON`, so it works against any real
   `deploy.v2.json`, not just the local proof run).
3. Everything else in this file is closed or accepted; no code changes are pending.
