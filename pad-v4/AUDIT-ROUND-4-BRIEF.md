# Robin V4 — Audit Round 4: scope brief for the external auditor

**One-page kickoff.** Everything you need to start is here; deeper detail is in the linked docs. Round 3
(`AUDIT-ROUND-3-BRIEF.md`, `AUDIT-ROUND-3-FINDINGS.md`, `AUDIT-ROUND-3-REMEDIATION-REAUDIT.md`) is CLOSED and
not reopened here — this covers only what's new since.

| | |
|---|---|
| **Repo / branch** | `Robinlabz/Labs` (canonical) · working branch `claude/robinhood-chain-website-8loxcm` |
| **Commit** | `881eec1` (auction feature) through `4c3d44b` (branch tip at handoff time) — `76f654c`/`4c3d44b` are the v3 + v4 auction UI frontends and local test tooling, no contract changes, listed for completeness only |
| **Compiler** | solc **0.8.26**, `viaIR: true`, optimizer **runs 1**, evmVersion **cancun** (unchanged from round 3) |
| **Build / test** | `cd pad-v4 && npm i && npx hardhat compile && npx hardhat test` → **343 passing / 6 pending / 8 failing** as one combined run — see the caveat immediately below before reading that `8` as a red flag |
| **Chain** | Robinhood Chain (chainId 4663) + **Arc** (Circle L1, mainnet chainId 1243 / testnet 5042002) — see focus area 3. NOT yet deployed to either. |

**Test-count caveat (please read before the `8 failing`):** this repo's full suite runs many independent test
files in one Hardhat process sharing Hardhat's default-funded signers. Two of the 8 are genuinely pre-existing
and unrelated to any pad-v4 work, this round or earlier (`test/sim/economics.sim.test.js` — an unrecognized
custom error from `PoolManager.afterInitialize`, and a plain `ReferenceError: factory is not defined` — a
scoping bug in that test file itself; neither references `LaunchConfig`/`auctionDays`/`lpFee` anywhere). The
other 6 are a SINGLE root cause: one signer runs low on ETH after the full suite's cumulative spend
(`RobinCurveV4.noPoolForever.test.js`'s two `describe` blocks and `RobinDividendPool.test.js` all draw down the
same account), which cascades into 6 numbered failures across those files. **Confirmed NOT a regression**: run
in isolation (`npx hardhat test test/unit/RobinCurveV4.noPoolForever.test.js test/unit/RobinDividendPool.test.js
test/sim/economics.sim.test.js`), all 6 pass cleanly and only the same 2 pre-existing `economics.sim.test.js`
failures remain (18 passing / 2 failing). The exact split between passing-outright and cascading-from-balance-
exhaustion in a full combined run is sensitive to gas/ordering and isn't itself a security finding — but is
worth fixing in the test harness (dedicated funded signers, or a higher `hardhat.config.js` account balance)
so a future full run doesn't need this caveat re-derived. **Every file this round actually added or touched**
(`test/unit/CurvePadFactoryV4.dailyAuction.test.js`, `test/unit/CurvePadFactoryV4.lpFeeChoice.test.js`, and
every file the constructor-arg ripple fix touched) passes 100% clean, both standalone and inside the full run.

## 1. What this is

Same product as round 3 (`AUDIT-SCOPE.md §1-3`) — this brief covers only the delta.

## 2. What changed since Round 3 (this is what Round 4 covers)

- **Daily auction (`pads/DailyAuctionVaultV4.sol`, `core/AuctionV4Deployers.sol`, `pads/RobinStaking.sol`, new)**
  — an optional 0-4 day pre-launch batch auction, ported from the already-shipped, already-deployed v3 sibling
  (`launchpad/contracts/DailyAuctionVault.sol`) to v4's `PoolManager.unlock()`/`unlockCallback` swap pattern.
  `CurvePadFactoryV4.LaunchConfig` gained `auctionDays` (appended last, ABI-compatible) and the factory gained
  a constructor-immutable `auctionVaultDeployer` (`address(0)` = feature off). See `ROBIN-AUCTION-PAD-SPEC.md`
  for the mechanism and `§3 below` for what's genuinely new about the v4 port vs. just copying v3.
- **Creator-chosen LP fee (`ICurvePadFactoryV4.LaunchConfig.lpFee`, appended before `auctionDays`)** — the ONE
  deliberate exception to "every economic parameter comes from `feeConfig`, never the caller" (see
  `CurvePadFactoryV4.sol`'s own GOVERNANCE doc comment for why this doesn't weaken that rule): a creator picks
  their pool's static LP fee anywhere in `[0, feeConfig.MAX_LP_FEE()]` (1% ceiling), rejected if it carries
  Uniswap's dynamic-fee flag. Unlike v3 (whose real Uniswap v3 factory only has 500/3000/10000 registered and
  couples fee to tick spacing), v4 pools specify `fee` and `tickSpacing` independently in `PoolKey` at init —
  no tier-registration constraint — so the full range is offered, not a discrete set.
- **Arc + Robinhood dual-chain matching-address launch, proven locally.** No new Solidity: every infra contract
  in this factory's own bootstrap sequence (`DeterministicDeployer`, `RobinStateView`, `FeeWalletRegistry`,
  `LockVault`, `CurveV4Deployer`, `RobinV4FeeConfig`, `CurvePadFactoryV4`, and now the two new auction
  deployers) deploys via plain CREATE, whose address is `f(sender, nonce)` only — constructor args (including
  the genuinely-different real Uniswap v4 infra addresses on each chain) never factor in. Proven against two
  independent local devnets with different mock v4 infra per chain: all infra addresses matched, and a single
  mined salt + `LaunchConfig` produced an identical branded token address on both. See `DUAL-CHAIN-LAUNCH.md`.
  **Not yet run against real funded wallets on real Arc + Robinhood Chain** — see §8.

## 3. Priority focus areas (please weight your effort here)

1. **[TOP] `DailyAuctionVaultV4`'s swap/take path — the exact surface where the v3 sibling had a real,
   fund-stranding bug (now fixed — see `../launchpad/AUDIT-V3.md` V3-1).** v3's `_burnBuy` had to measure a
   balance DELTA around its swap (because the vault holds a persistent multi-day token reserve) and round-trip
   a leftover-ETH refund through `WETH.withdraw()`, which turned out to lack a `receive()` and stranded funds
   permanently whenever a bid day overshot the graduation ceiling. **v4's port is a structurally different
   design, not a copy**: it takes the swap's token output DIRECTLY to the dead address via
   `poolManager.take(currency1, DEAD, tokenOut)` using the swap's own exact `BalanceDelta` — the vault's token
   balance is never read or touched by the burn at all — and the leftover-ETH refund is a single outbound
   `platform.call{value: leftover}("")` from ETH the vault already holds natively (from `bid()`, itself
   payable), never a round trip through anything. We wrote a dedicated regression test
   (`test/unit/CurvePadFactoryV4.dailyAuction.test.js`, "overshoots the graduation ceiling...") reproducing the
   exact overshoot condition and confirming both the refund succeeds AND the auction's contribution to the
   raise reaches both creator and platform at graduation (measured via `platformEthOwed`/`creatorEthOwed`
   going non-zero) — please verify our reasoning that the redesign genuinely closes this bug class rather than
   moving it, and look for any OTHER path where this vault could end up needing to receive ETH unexpectedly.
2. **Auction carve-out geometry interaction.** `CurvePadFactoryV4.launch()`'s two pre-existing geometry checks
   (reserve-ratio, `MIN_RAISE_WEI` raise-floor) are now computed against a REDUCED local `curveSupply` (=
   `cfg.curveSupply - auctionAmt`, where `auctionAmt = (curveSupply/10) * auctionDays`) rather than the raw
   `cfg.curveSupply` — `cfg.reserveSupply` and the total-supply conservation check are untouched. Verify this
   carve-out can't be used to bypass either geometry invariant, and that the accounting
   (`curveSupply(reduced) + auctionAmt + reserveSupply == cfg.supply`) holds under every `auctionDays` value
   0-4, including the boundary the geometry test constructs (a reserve ratio that fails at the raw
   `curveSupply` but passes once the carve-out reduces it).
3. **Arc as a second target chain.** No new Solidity, but confirm the "constructor args never factor into a
   plain-CREATE address" claim actually holds for every infra contract in the REAL bootstrap sequence
   (`scripts/deploy-curve.js`/`deploy-curve-arc.js`, not just the proof script's own `bootstrap()`), and that
   nothing about Arc's real chain (gas token, block time, any precompile differences from an Arbitrum Orbit L2)
   changes any of this factory's or the curve's on-chain assumptions. `deploy-curve.js` and
   `deploy-curve-arc.js` currently duplicate their bootstrap sequence as two independently-maintained scripts
   with nothing enforcing they stay in lockstep — flagged, not fixed (tooling risk, not a contract risk).
4. **Round 3's still-open item — unchanged, still your call to close.** Floor H-5 forced-fill
   (`FLOOR-REDESIGN.md`) is untouched by this round's work and remains the top standing item from Round 3.

## 4. Scope inventory

**NEW this round:** `pads/DailyAuctionVaultV4.sol`, `pads/RobinStaking.sol` (verbatim port of the v3 sibling —
pure OpenZeppelin, zero v3-specific dependency, not re-reviewed as new logic), `core/AuctionV4Deployers.sol`
(`RobinStakingV4Deployer`, `DailyAuctionVaultV4Deployer` — thin deployers, no economic logic).

**MODIFIED this round:** `core/CurvePadFactoryV4.sol` (`auctionDays`/`lpFee` on `LaunchConfig`,
`auctionVaultDeployer` constructor-immutable, the carve-out arithmetic and its interaction with the two
existing geometry checks, a new `AuctionVaultLaunched` event kept separate from the existing `CurvePadLaunched`
event rather than extending it), `interfaces/ICurvePadFactoryV4.sol` (mirror struct fields), `scripts/deploy-*.js`
(wire the two new thin deployers before the factory deploy; `prove-dualchain-address-match.js`'s `bootstrap()`
does the same, in lockstep across both simulated chains).

**Core suite (context, reviewed at Round 3, unchanged):** everything in `AUDIT-SCOPE.md §1`'s table.

## 5. Out of scope

Same as Round 3 (`AUDIT-SCOPE.md §2`) — stock pads, Uniswap v4 core/periphery itself, off-chain infra.

## 6. Key invariants to verify (new/changed this round)

- **The auction's ETH genuinely reaches BOTH creator and platform**, not just platform's per-day 10% cut — via
  the SAME, previously-audited `platformGradBps`/`creatorGradBps` graduation split every other raise source
  uses. No new split logic was written for this; the auction's `closeDay()` burn-buy is an ordinary curve buy.
  Live-confirmed in the new regression test (focus area 1).
- **`auctionDays: 0` is byte-for-byte the pre-existing behavior** — no vault, `auctionVaultOf[token] ==
  address(0)`, curve seeded with the full `cfg.curveSupply` exactly as before this round. Tested.
- **`auctionVaultDeployer == address(0)` genuinely disables the feature** rather than deploying into a broken
  state — `auctionDays > 0` reverts `BadConfig` before any state write. Tested.
- **The creator's `lpFee` choice is read literally, with no "0 = default" sentinel** — 0 is a real, legitimate
  choice (a coin with no LP fee at all), independent of whatever `feeConfig.defaults().lpFee` happens to be.
  Tested (two coins from the same factory carrying different fees; a 0-fee coin trades and graduates normally).

## 7. Reading order

1. This brief, then `AUDIT-ROUND-3-BRIEF.md` for full round-3 context if you weren't on that engagement.
2. `ROBIN-AUCTION-PAD-SPEC.md` (the auction mechanism, shared design with v3).
3. `../launchpad/AUDIT-V3.md` (the v3 sibling's own self-review of the SAME feature set — read V3-1 in full
   before reviewing `DailyAuctionVaultV4.sol`; it's the bug class to specifically rule out here).
4. `DUAL-CHAIN-LAUNCH.md` (the Arc+Robinhood proof).
5. `test/unit/CurvePadFactoryV4.dailyAuction.test.js` and `test/unit/CurvePadFactoryV4.lpFeeChoice.test.js` —
   both real-`PoolManager`, real-mined-hook, real-`launch()` integration tests, not shortcut unit tests.

## 8. Known open items (documented — no need to re-derive)

- **Floor H-5 TWAP** (Round 3, unchanged, still the top standing item across both rounds).
- **Arrow L1/L2 front-run/hijack** (Round 3, unchanged).
- **Dual-chain proof is local-only** — not yet run against funded wallets on real Arc + Robinhood Chain. That
  step needs a funded deployer key on each chain and is a deployment action, not a code question.
- **`deploy-curve.js`/`deploy-curve-arc.js` drift risk** — two independently-maintained scripts with nothing
  enforcing they stay in lockstep (focus area 3). Flagged, not fixed — a tooling refactor of live deploy
  scripts, not done without sign-off.
- **Test-harness signer-balance exhaustion in a full combined run** (see the caveat at the top of this brief) —
  not a security finding, a test-infra improvement (dedicated funded signers, or bump the Hardhat account
  balance default) worth doing so a future full-suite run doesn't need the caveat re-derived.

Deploy to mainnet (either chain) remains gated on Round 3's floor H-5 closing, same as before this round.
