# Robin V4 — Audit Round 4: scope brief for the external auditor

**One-page kickoff.** Everything you need to start is here; deeper detail is in the linked docs. Round 3
(`AUDIT-ROUND-3-BRIEF.md`, `AUDIT-ROUND-3-FINDINGS.md`, `AUDIT-ROUND-3-REMEDIATION-REAUDIT.md`) is CLOSED and
not reopened here — this covers only what's new since.

| | |
|---|---|
| **Repo / branch** | `Robinlabz/Labs` (canonical) · working branch `claude/robinhood-chain-website-8loxcm` |
| **Commit** | `881eec1` (auction feature) through the branch tip. Everything after `43c9bf7` is non-contract: `76f654c`/`4c3d44b` are the v3 + v4 auction UI frontends and local test tooling, `6d254a8` disables both launch buttons pending this audit, and `941b892` fixes `launchpad/scripts/audit-live.js`. Listed for completeness — **no contract changes in any of them**. |
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
4. **Floor H-5 forced-fill — SAFETY IS CLOSED AND MERGED. LIVENESS IS NOT, and we are disclosing that
   rather than claiming a closure.** Please read this split carefully; an earlier draft of this brief
   overclaimed it as simply "closed", and correcting that is the single most important change here.

   **What IS closed (merged, measured, reproducible).** The structural closure from
   `Robinlabz/Labs @ claude/laughing-goodall-qxrmq1` (`cb49dbe`) is merged into this branch: the hook's
   swap-witnessed `aboveLowerTs` watermark plus a non-refilling, episode-scoped allowance, with a 128-slot
   observation ring / `consultTick` TWAP as a conjunct. The forced-fill attack is dead:

   | scenario | result |
   |---|---|
   | pre-fix attack | **+8.7340 ETH**, carve eaten 17.8525/20 |
   | the round-3 auditor's `COMMIT_COOLDOWN > MIN_DWELL` fix | +8.7340 — **inert**, confirmed |
   | shipped gate, round-trip loop | **−1.1106 ETH**, carve consumed **0.0000**/20 |
   | carve vs no-carve PnL delta | **exactly 0** — no longer extraction |
   | `[N-A]` sustained hold | **−1.1042 ETH**, one ~1bp slice |

   These were reproduced bit-identically before and after the merge.

   **What is NOT closed.** The floor does not redeploy a carve that was banked during a crash. The
   allowance is `cap + (amt - episodeStartQuote)`, and `episodeStartQuote` snapshots the *whole* banked
   carve when an episode opens (`RobinFloorVault.sol` ~`:259`/`:326`), so after a crash the inflow term is
   0 and the allowance is the bare cap — permanently, until the pad crashes again. The vault's own comment
   at ~`:166` states the favourable branch outright: *"a healthy pad never touches the band, so it keeps
   `episodeStartQuote == 0` and an inflow-equal allowance."* At the shipped
   `episodeBaseWei = seedEth / 10_000` (1e14 wei with the default 1 ETH seed) that is ~0.0001 ETH released
   per crash-recovery cycle against a carve that may be orders of magnitude larger. **The carve is parked,
   not lost** — the vault is add-only with no withdraw/decrease selector — but it does not come back.

   **Please weigh two things specifically:**
   - Is a floor that is provably safe but effectively inert after a crash worth shipping, or does the
     episode-pin need redesigning so a recovered pad can rebuild its wall?
   - The TWAP/oracle conjunct. That branch's own comments call it *"provably implied by P1"* — i.e. no new
     guarantee — and it costs a 128-slot ring written on the swap hot path (the pad-v4 suite went from ~26
     to ~41 minutes with it in). We kept it because it is the artifact that was reviewed, not because we
     can justify the surface. Should it ship?

   **Coverage we had to restore, and why it matters to you.** The merge deleted
   `7. [R3-EXT-2] THE BASE BIND` and `5. [R3-EXT-2 CORRECTED]` (slot 7 was reused for a different case) and,
   *in the same commit*, raised `scripts/launch.js` from `0n` to `seedEth / 10_000n` — the exact change the
   deleted comment said not to make without re-running case 7. Afterwards nothing in the tree varied
   `EPISODE_BASE_WEI` at all, so the shipped constant was bound by no test. We have added
   `8. [SAFETY / DEEP DUMP]` (the cap is pinned to *launch* depth while attacker cost scales with *live*
   depth — nothing else in the suite dumps past tick 12000) and `9. [LIVENESS / DISCLOSED LIMITATION]`
   (pins the post-crash behaviour at the **shipped** constant, not the lab's depth-derived default).
   Note also that `test/helpers/h5-lab.js` derives its base from `provider.getBalance()` — a chain read —
   directly beneath a comment asserting it is *"never from a chain read"*; the lab and production values
   differ by ~95x. See `FLOOR-REDESIGN.md` and `FLOOR-H5-CLOSURE-SPEC.md` for the prior refutations.

   A **separate branch** — `Robinlabz/Labs` @ `claude/laughing-goodall-qxrmq1`, commit `cb49dbe` — carries a
   candidate closure developed in parallel. We have run its suite and **reproduced its numbers exactly**
   (18/18 passing): the pre-fix attack nets **+8.7340 ETH** eating 17.85/20 of the carve; the auditor's
   recommended `COMMIT_COOLDOWN > MIN_DWELL` fix is confirmed **inert** (identical +8.7340); against the gated
   vault the round-trip loop nets **−1.1106 ETH** and commits **0.0000/20**, with the carve-vs-no-carve PnL
   delta at **exactly 0** (so it is no longer extraction); the `[N-A]` sustained hold buys one ~1bp slice at
   **−1.1042 ETH**; and the honest path still deploys **14.7571 of 20 ETH** over 40 pokes.

   Two things we want you to weigh, because we do not think they are equally well-founded:
   - **The substantive change is the cap formula.** That branch DELETES the band-proportional term and ships a
     flat `EPISODE_BASE_WEI = D/10_000`, on the argument that the band term *inverts* — it turns
     attacker-profitable once the band holds more than ~1.58x the pool's ETH depth. If that argument is
     correct it is a finding against the vault ON THIS BRANCH, which still carries that term. Please confirm
     or refute the inversion independently.
   - **The TWAP/oracle conjunct may not be earning its surface.** That branch also adds a 128-slot observation
     ring to `RobinFeeHook` plus a `consultTick` TWAP read, touched by every swap. Its own code comments
     describe this conjunct as *"provably implied by P1"* — i.e. contributing no new security guarantee — and
     this brief's authors agree on that reading. We would rather ship less hook surface and less per-swap gas
     than defense-in-depth we cannot justify, so: does P4 buy anything P1 does not already give?

   The closure is **NOT merged here**: it forks from a ~200-commit-old base and merges with 45 conflicts,
   including `RobinFeeHook.sol`, `RobinFloorVault.sol` and `IRobinInterfaces.sol`. We deliberately did not
   hand-resolve security-critical conflicts under time pressure — review it as the discrete, self-consistent
   change it is on its own branch, and we will merge whichever shape you endorse.

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

- **Floor H-5 forced-fill** — still the top standing item across both rounds ON THIS BRANCH. A candidate
  closure exists on `Robinlabz/Labs` @ `claude/laughing-goodall-qxrmq1` (`cb49dbe`), independently re-run and
  reproduced here (18/18), but deliberately not merged: see focus area 4, which also flags the two parts of it
  we want judged separately (the cap-formula change, which we believe is the real content, and the TWAP/oracle
  conjunct, which that branch's own comments call "provably implied by P1").
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
