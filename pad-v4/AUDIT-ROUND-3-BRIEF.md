# Robin V4 — Audit Round 3: scope brief for the external auditor

**One-page kickoff.** Everything you need to start is here; deeper detail is in the linked docs.

| | |
|---|---|
| **Repo / branch** | `Robinlabz/Labs` (canonical) · working branch `claude/robinhood-chain-website-8loxcm` |
| **Commit** | branch tip (round-3 findings F1/F2/F3 + re-audit items N1/N2 all closed — see `AUDIT-ROUND-3-FINDINGS.md` banner + `AUDIT-ROUND-3-REMEDIATION-REAUDIT.md` response) |
| **Compiler** | solc **0.8.26**, `viaIR: true`, optimizer **runs 1**, evmVersion **cancun** |
| **Build / test** | `cd pad-v4 && npm i && npx hardhat compile && npx hardhat test` → **233 passing / 6 pending / 0 failing** |
| **Chain** | Robinhood Chain (Arbitrum Orbit L2, EVM, chainId **4663**). Uniswap **v4** hooks. NOT yet deployed. |

## 1. What this is
A single-sided bonding-curve launchpad on Uniswap V4 ("pad of pads"): one-tx launch → curve → ceiling-only
graduation into a **permanently-locked** 2-sided LP → holder staking + an add-only price floor. Platform takes
**ETH only, never a pad token** (system-wide invariant). This is the V4 rewrite of the live v3 (`launchpad/`, already
deployed) — the v3 is **not** in this scope.

## 2. What changed since your last review (this is what Round 3 covers)
Your original report + our round-1 remediation are the ledger baseline (`AUDITOR-HANDOFF.md §0`). The following was
added/changed **after** that and has **not** been externally reviewed — cross-referenced in the ledger:
- **§0b round-2 remediation** — 20 mechanical/doc fixes + a self-audit gauntlet (L-2, L-21, H-5 interim, M-3/M-5/M-10/M-12/H-2 driven).
- **§0c fee-model round 2** — platform is ETH-only; ETH buy-LP fee → **100% platform** (`buyLpFloorShareBps` default 0); token LP fee → new **`RobinTokenTreasury`** (70% staking / 30% creator-burn to `0x…dEaD`; **path-scoped** — the curve-path locked-LP sell-leg + reservoir go 100% to staking instead, see `ECON §5` [R3-F3]); the `RobinFloorVault` platform-token leak was closed.
- **§0d Arrow** — a NEW migration launcher (`contracts/arrow/`) + its 25-agent internal audit (2 fund-safety fixes applied).
- **`ECONOMICS-VERIFIED.md`** — a contract-verified reference for every fee/split/cap (v3-live + v4), produced this round.

## 3. Priority focus areas (please weight your effort here)
1. **[TOP] Floor H-5 forced-fill — needs your design review before it ships.** `RobinFloorVault`'s park→commit dwell
   is poke-observed, not duration-enforced; a bounded slice can still be force-committed off a ≤1h-stale `belowSince`.
   Interim hardening is shipped; the structural fix (TWAP-gated commit, or add-only bands below spot) is a **product
   decision we deliberately did not ship** — **four prior attempts on this surface were refuted** (M-7 mid-curve build,
   M-15 live-slot0 gate, H-5 dwell, the "place below spot" redesign). See `FLOOR-REDESIGN.md`. Do not treat the floor
   as un-manipulable until this is closed.
2. **Arrow launcher (newest surface, `contracts/arrow/`).** A composer over the audited curve/factory (modifies none of
   it): 0.5 ETH off top → full-curve buyout landing exactly at `gradSqrt` → `graduate()` → merkle airdrop. Review the
   **3 sequential unlock legs / atomicity**, the price-limited over-input swap, the instant-graduation coupling, and
   the **L1/L2 mempool front-run / identity-hijack** we documented but did **not** fix (salt-binding hardening
   proposed; not reachable on FCFS). See `ARROW.md` + `AUDITOR-HANDOFF.md §0d`.
3. **Fee-model round 2.** Confirm the platform-ETH-only invariant holds across every currency1 path
   (`RobinTokenTreasury`, `RobinFloorVault.tokenSink`, `RobinAmbushVault`, `LockVault` sell leg, curve sell-LP fee);
   confirm the 100%-platform ETH-LP flip and the 70/30 split + creator-burn. See `ROBIN-V4-CURVE-ECON.md`.

## 4. Scope inventory
**NEW this round:** `arrow/ArrowLauncher.sol`, `arrow/ArrowDistributor.sol`, `pads/RobinTokenTreasury.sol`,
`core/PadBrand.sol` (**brand suffix** — every pad token address must end in `faf0`; enforced in all three
factories' `launch`, so callers must mine `tokenSalt`. Pure mask+compare, reverts before any state write).
**MODIFIED this round:** `pads/RobinFloorVault.sol` (token-leak fix + `tokenSink`/`sweepTokenFees`), `pads/RobinCurveV4.sol`
(buy-LP routing default), `core/RobinV4FeeConfig.sol` (M-10 lpFee cap), `core/PadFactory.sol` (M-3 caps),
`core/CurvePadFactoryV4.sol` (L-1 min-raise), `pads/DualStaking.sol` (M-5), `presale/PresaleVault.sol` (M-12),
`adapters/StockQuoteAdapter.sol` (H-2), `core/LockVault.sol` (M-11 doc).
**Core suite (context, reviewed before):** `hooks/RobinFeeHook.sol`, `pads/RobinCurveV4.sol`, `core/CurvePadFactoryV4.sol`,
`core/CurveV4Deployer.sol`, `core/DeterministicDeployer.sol`, `core/FeeWalletRegistry.sol`, `core/LockVault.sol`,
`pads/RobinAmbushVault.sol`, `pads/RobinLockStaking.sol`, `pads/DualStaking.sol`, `pads/StakingFactory.sol`,
`pads/PadToken.sol`, `presale/PresaleVault.sol`, `presale/PresaleVaultFactory.sol`.

## 5. Out of scope
- **Stock pad** (`core/StockPadFactory.sol`, `adapters/StockQuoteAdapter.sol`) — **disabled / fail-closed** (H-2: no live
  Robinhood stock registry). No live stock path today; review only if a registry is being wired.
- **The live v3** (`../launchpad/`) — separately deployed; not this audit.
- `pads/RobinLpVault.sol` — not on the shipped launch path.

## 6. Key invariants to verify
- **Platform is ETH-only** — the platform key holds no pad token (currency1). **Contract-enforced for the pad
  token** (round-3 finding F1, structurally fixed): all token sinks route to the treasury/staking, and
  `DualStaking.claim()` (`:392`) exempts the pad token from the platform claim fee unconditionally
  (`fee = asset == address(tokenAsset) ? 0 : amount*bps/BPS`) — so no owner setting of `platformClaimFeeBps`, and no
  matter which side lists the token, can skim a pad token to the platform key (which `deploy.js` conflates with the
  staking `platformTreasury`). The constructor rejects `tokenAsset == address(0)` and ETH is a distinct sentinel, so
  the exemption can only ever match the pad token; money-side (ETH/stock) rewards still carry the fee, and the
  shipped deploy also defaults the fee to 0. The earlier governance caveat (a nonzero token claim fee re-opened the
  skim) **no longer exists**. Tested end-to-end (`R3F1` 3 cases + `DualStaking [F1]` 3 cases, including fee-500
  unbypassability and the narrow money-side exemption).
- **No dev mint** — `supply == curveSupply + reserveSupply`; creator premine 0.
- **LP locked forever** — graduation LP NFT → `LockVault`, no remove/decrease/burn/transfer selector.
- **Add-only floor + ambush** — no remove/withdraw path; principal leaves only by trading at the AMM's marginal price.
- **Immutable per-pad economics** — every param stamped at launch; a live pad's fee/geometry can never change; retuning
  `RobinV4FeeConfig` affects future launches only.
- **Graduation is CEI + unbrickable** — `graduated=true` before any external call; every fund-out retriable/parked.

## 7. Reading order
1. `AUDITOR-HANDOFF.md` (start §0 → §0b → §0c → §0d) — the full remediation + self-audit ledger.
2. `AUDIT-SCOPE.md` — scope, trust model, and the open-items list (§5 flags the floor H-5).
3. `ECONOMICS-VERIFIED.md` — every fee/split/cap with `file:line`.
4. `ARROW.md` (Arrow) · `FLOOR-REDESIGN.md` (floor H-5) · `ROBIN-V4-CURVE-ECON.md` (full economics) · `DEPLOY.md`.

## 8. Known open items (documented — no need to re-derive)
- **Floor H-5 TWAP** (focus area 1) — structural fix pending your review.
- **Arrow L1/L2** — mempool front-run/hijack, not reachable on FCFS. Salt-binding was proposed and is NOT built —
  and per the external auditor it is only a copycat deterrent anyway (the factory `launch` is permissionless and
  takes raw salts, so `ArrowLauncher` is bypassable; the merkle root isn't bound to the pad address). Commit-reveal
  is the real fix if Arrow ever ships to a public mempool. See `ARROW.md`.
- **Arrow dev-sybil honesty** — "no dev holds the bag" = no single dev wallet + transparent immutable distribution, NOT
  sybil-resistance (a dev can commit a root over their own addresses). Pitch precisely.
- **Deferred LOW mechanicals** — L-3, L-14, L-25, L-32 (see `AUDITOR-HANDOFF.md §0b "Still open"`).

Deploy to mainnet is gated on this round closing focus areas 1–2.
