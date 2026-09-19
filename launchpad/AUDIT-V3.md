# Robin Labs Pad (v3, Uniswap v3) — Audit V3: scope brief for the external auditor

**One-page kickoff for the LIVE stack.** This is the deployed v3 launchpad. It is a **different codebase**
from the v4 rewrite — if you were pointed here alongside `pad-v4/AUDIT-ROUND-4-BRIEF.md`, read that one for
v4 and this one for what is on mainnet today.

| | |
|---|---|
| **Repo / branch** | `Robinlabz/Labs` (canonical) · `main` · directory `launchpad/` |
| **Compiler** | solc **0.8.24**, `viaIR: true`, optimizer **runs 1**, evmVersion **paris** |
| **Build** | `cd launchpad && npm ci && npx hardhat compile` |
| **Test** | `npx hardhat test` → **170 passing / 34 pending / 0 failing** (the 34 are fork-gated, see §2) |
| **Fork test** | `FORK_RPC=https://rpc.mainnet.chain.robinhood.com npx hardhat test test/fork/<file>` → **20 passing** across the 9 fork files |
| **Chain** | Robinhood Chain (Arbitrum Orbit L2, chainId **4663**). Uniswap **v3**. **DEPLOYED AND LIVE.** |
| **Live since** | factory deploy block **17752965** (2026-07-24), stack version **v2.1** |

---

## 1. Live addresses, and the fact that matters most about them

From `launchpad/deploy.json` / `LIVE_DEPLOYMENT.md`:

| Contract | Address | Role |
|---|---|---|
| `CurvePadFactory` | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` | one-call launch entrypoint |
| `PadRouter` | `0xA6BaAB820809C7fC8350311776627298f91F07eC` | the swap desk — every buy/sell |
| `FeeConfig` | `0x064D977B66FCC29256510dBCD8cC0C51bBb2De14` | owner-governed fee dial |
| `RewardVault` | `0x03d5d26E492B288e62D897E7dde91af3CceB4347` | trader/holder reward legs |
| `FloorCoopFactory` | `0x564EDF561Bed46C972d5D44D84f5FAc9C5118668` | locked-liquidity staking vaults |
| `PlatformFeeSplitter` | `0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a` | dormant $ROBIN seam on the platform leg |
| `TokenVestingLock` | `0x7453856c3E5f6832dc660e48c7Daa6f46f3355DF` | creator vesting |
| `LaunchTokenDeployer` / `CurvePoolDeployer` / `BondDeployer` | `0xb374…83d` / `0x0205…80C` / `0x8B04…AD3` | per-launch CREATE helpers |

**The deployed code matches this repo's source.** Verified this round against the live chain, not asserted:

```
cd launchpad && node scripts/audit-live.js
✅ AUDIT PASSED — 8 passed, 0 failed
```

That script checks router/factory cross-wiring, the platform sink, the Ownable2Step state on both (both
**accepted** by the cold wallet — no pending transfer), and the **executable bytecode identity** of the live
`CurvePoolDeployer` against a local compile. The live and local runtime bytecode differ only in solc's two
CBOR metadata blobs (the deployer's own trailer and the `CurvePool` creation code it embeds); with those
masked the executable code is **byte-identical**. That comparison bug was found and fixed this round — see
§4 — so treat a `❌` from this script as a real drift signal now.

---

## 2. How to run the suite, and what the 34 "pending" are

`npx hardhat test` runs everything, and this round fixed two reasons it could not previously complete:

- **The faucet.** Every file runs against ONE in-process chain, so signer balances carry across files. The
  sim/trace suites move 100–200 ETH per case and drained hardhat's default 10,000 ETH faucet part-way
  through, failing the remaining **51 of 172** tests with `Sender doesn't have enough funds`.
  `hardhat.config.js` now sets `accountsBalance` to 10,000,000 ETH per signer.
- **Three unguarded fork-only suites.** `sim-grad-grief`, `trace-curve` and `trace-devbuy` need the REAL
  Uniswap v3 factory and WETH (live mainnet addresses, which have no code on a bare hardhat chain) but
  lacked the `const suite = process.env.FORK_RPC ? describe : describe.skip` guard that every other
  fork-dependent file here carries. They now have it.

The **34 pending** are exactly the fork-gated suites. All of them pass against the live chain — run them
**one file at a time**:

```
FORK_RPC=https://rpc.mainnet.chain.robinhood.com npx hardhat test test/fork/bond.fork.test.js
```

> The public RPC is **not an archive node**. Forking the whole suite in one process outlives its state
> retention window and aborts mid-run with `historical state ... is not available`. Either run file by file,
> or pin a recent block with `FORK_BLOCK=<n>` (support added this round), or point `FORK_RPC` at an archive
> node.

---

## 3. Priority focus areas

### 1. [TOP] `FloorCoop` — LIVE, and its own header says the audit is still pending

`contracts/FloorCoop.sol` (586 lines) and `FloorCoopFactory.sol` are **deployed** (`0x564E…8668`), and the
contract's own NatSpec says: *"STILL PENDING the full external audit + sims."* It is the most complex live
component and the only one that **swaps** — it pairs single-sided ETH into full-range v3 LP, so it carries
real AMM-manipulation surface that the rest of the stack does not. Its own disclosed limitations, which we
are restating rather than burying:

- standard ERC-20 only — fee-on-transfer and rebasing tokens revert;
- a token that pauses/blacklists transfers **to the vault** after deposits land will **freeze that vault's
  principal** (harvest and withdraw both need `pool.collect`) — no theft, no cross-vault effect, but user
  funds can be stranded;
- it binds to **one** pool chosen at construction (the deepest WETH pool with `>0` liquidity); a
  permissionless first-mover could pin it to a thinly-seeded pool. Mitigated by `MIN_POOL_WETH` (0.1 WETH)
  and the adaptive-TWAP minimum-history guard;
- the zap swap is **bounded** to a TWAP-derived price limit (~`MAX_DEV` = 3%) plus a fee-aware min-out
  floor — a sandwich is *bounded*, not eliminated;
- first-deposit share inflation is `minSharesOut`-gated and unprofitable (10% open fee + tiered penalties);
  a virtual-shares offset is a candidate hardening;
- `TWAP_WINDOW`/cardinality, `MAX_DEV`/`SWAP_BOUND` and the min-out tolerance are economic parameters that
  have **not** been tuned in simulation.

Its only test is fork-gated (`test/fork/floorcoop-sim.fork.test.js`, 1 passing against the live chain).
**This is where we would spend an external auditor's first day.**

### 2. The graduation path has never fired in production

`LIVE_DEPLOYMENT.md` (verified on-chain 2026-08-15): **9 coins, ~46k trades, ~115 ETH all-time volume,
0 graduated.** No coin has reached the 4.2 ETH ceiling (furthest ≈49%). So the live `CurvePool.graduate()`
→ `Bond` path — the one that posts the floor — is exercised only by fork tests, never by production.

Compounding that, and worth an auditor's attention as a **design** issue rather than a bug: on the live v3,
`graduate()` is permissionless but pays **no caller bounty** (only 0.5 ETH creator + 0.5 ETH platform), and
there is no auto-graduation in the buy tx (that exists only in the non-deployed `BondingCurve`). **No third
party is incentivized to graduate a coin.** Without the operator keeper (`scripts/grad-keeper.js`), a coin
that hits the ceiling sits tradeable-but-capped with its Bond floor unposted, indefinitely. The v4 curve
fixes this with a real bounty (`GRAD_BOUNTY` = 0.2%, capped 0.02 ETH); v3 does not.

### 3. `FeeConfig` is a live, un-timelocked owner dial

`FeeConfig` (`0x064D…De14`) is owned directly by the cold wallet and retunes the LP creator split and the
swap platform/creator/floor split **with no redeploy and no timelock**. Defaults are 10/90 LP and 45/45/10
swap. The router is written to fall through to all-platform if the config call reverts (tested:
*"PadRouter with a BROKEN feeConfig never reverts a trade"*), so it cannot brick trading — but please price
what the owner key can do with it, and compare against the trust model you applied to v4's
`RobinV4FeeConfig`.

---

## 4. What changed in this directory this round

This was an **audit** round, not a feature round. Every change here is a fix to something that was broken or
misleading:

| Fix | Why it mattered |
|---|---|
| `hardhat.config.js` — `accountsBalance` 10,000,000 ETH | 51 of 172 tests could not run (faucet drained mid-suite). |
| `hardhat.config.js` — `FORK_BLOCK` support | the documented fork command dies on the non-archive public RPC. |
| `hardhat.config.js` — `robinhood` network RPC default | pointed at the Blockscout proxy, which is **Cloudflare-challenged and answers 403** to programmatic clients (verified). A deploy from a fresh clone could not connect. Now the canonical chain RPC. |
| `sim-grad-grief` / `trace-curve` / `trace-devbuy` — fork guards | three suites failed on any non-fork run for want of the guard every sibling file carries. |
| `scripts/audit-live.js` — `.env` made optional | the script read a **gitignored** `.env` unconditionally and died with `ENOENT` before printing a single check. An auditor with a fresh clone could not run it at all. |
| `scripts/audit-live.js` — mask solc metadata before comparing bytecode | it compared raw runtime bytecode, so it printed **`❌ AUDIT FAILED`** on a correctly-deployed stack every time a source **comment** changed. `CurvePoolDeployer` embeds `type(CurvePool).creationCode`, so there are **two** metadata blobs, not one. A check that always fails is a check nobody reads. |

Repo-wide (affects this directory's integrators too): the Blockscout `api/eth-rpc` endpoint was the default
in the **indexer config (primary *and* fallback — so the fallback was not a fallback)**, the **SDK**, the
**pad front end's wallet RPC**, the **auto-verifier** and the **public docs**. All now default to
`https://rpc.mainnet.chain.robinhood.com`.

---

## 5. Contracts in this directory that are NOT deployed

Present in the tree, tested, but **not on mainnet** — so they are out of the live-risk scope, though a
pre-deploy review is welcome:

`RobinLimit` (staged deliberately — see `contracts/RobinLimit.REVIEW.md`: multi-lens audit run,
GO-WITH-FIXES, all findings fixed, an outside review still recommended), `RobinSwap`, `RobinStockSwap`,
`RobinZap`, `RobinSwapFeeConfig`, `SheriffStaking`, `StakingFactory`, `RobinStaking`, `RewardConverter`,
`Disperse`, `MilestoneVault`, `LaunchpadFactory`, `AthVault`, `OtcVault`, `BondingCurve`,
`CurveLaunchFactory`, `FeeRouter`.

Note `BondingCurve` in particular: it carries the auto-graduation logic the **live** `CurvePool` does not.

---

## 6. Prior internal audit record

`launchpad/AUDIT.md` holds three prior internal passes with findings and resolutions:

- **Third pass** (pre-mainnet, "let it ride" + creator economics) — R-1 **High**: `buy()` inferred the
  consumed amount from `balanceOf(WETH)`, so a WETH donation to the router bought **fee-free**; fixed by
  driving fee + re-credit off the pool's own consumed-input delta. Plus R-2/R-3 (dust, latent mis-config).
- **Second pass** (deep pre-production) — F1 **Med**: `uniswapV3SwapCallback` checked only `_swapping`, not
  that the caller was the pool being swapped with; fixed with `_activePool`. F2: `flushBurn` residual WETH
  re-credited to `burnEscrow`.
- Standing invariants, the fee model, the 300-run fuzz battery and the graduation battery are all recorded
  there.

Treat `AUDIT.md` as the finding ledger and this file as the entry point.

---

## 7. Reading order

1. **This file.**
2. `AUDIT.md` — the three internal passes, findings and resolutions.
3. `SPEC.md` — the economic model. `STAKING.md` — the staking/coop model.
4. `contracts/FloorCoop.sol` (focus area 1) · `contracts/CurvePool.sol` · `contracts/PadRouter.sol` ·
   `contracts/Bond.sol` · `contracts/LaunchToken.sol`.
5. `DEPLOY.md` and `../LIVE_DEPLOYMENT.md` — the live wiring, the keeper requirement, and the operational
   state.
6. `contracts/RobinLimit.REVIEW.md` — if you are reviewing the staged, not-yet-deployed limit-order stack.
