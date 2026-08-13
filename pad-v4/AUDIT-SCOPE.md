# Robin V4 curve suite — external audit scope

Free single-sided bonding-curve launchpad ("pad of pads") on **Uniswap v4**, for **Robinhood Chain**
(mainnet chainId 4663, testnet 46630). This document is the entry point for an external security review.

Companion docs: [`ROBIN-V4-ARCHITECTURE.md`](./ROBIN-V4-ARCHITECTURE.md) · [`ROBIN-V4-CURVE-ECON.md`](./ROBIN-V4-CURVE-ECON.md) · [`ROBIN-V4-CURVE-SPEC.md`](./ROBIN-V4-CURVE-SPEC.md) · [`DEPLOY.md`](./DEPLOY.md)

---

## 1. In scope

| Area | Contracts |
|---|---|
| **Fee hook** | `hooks/RobinFeeHook.sol`, `hooks/BaseHook.sol` |
| **Curve controller** | `pads/RobinCurveV4.sol`, `core/CurveV4Deployer.sol` |
| **Launch + governance** | `core/CurvePadFactoryV4.sol`, `core/RobinV4FeeConfig.sol`, `core/PadFactory.sol`, `core/FeeWalletRegistry.sol`, `core/DeterministicDeployer.sol`, `core/RobinStateView.sol` |
| **LP locking / user LP** | `core/LockVault.sol`, `pads/RobinLpVault.sol` |
| **Support vaults** | `pads/RobinFloorVault.sol`, `pads/RobinAmbushVault.sol` |
| **Staking** | `pads/RobinLockStaking.sol`, `pads/DualStaking.sol`, `pads/StakingFactory.sol` |
| **Presale add-on** | `presale/PresaleVault.sol`, `presale/PresaleVaultFactory.sol` |
| **Token** | `pads/PadToken.sol` |

Toolchain: solc **0.8.26**, `viaIR`, EVM **cancun**. OZ ReentrancyGuard/SafeERC20/Clones/Math. Uniswap v4-core + v4-periphery.

## 2. Out of scope / needs its own review

- **Stock pads** (`core/StockPadFactory.sol`, `adapters/StockQuoteAdapter.sol`, `quoteIsStock` paths). Mechanically
  tested against a `MockStock`, but a stock launch still needs a fork test against a **real** Robinhood stock beacon
  and its own **securities/legal** review before going live. Treat as informational for this engagement.
- Uniswap v4 core/periphery itself (audited upstream); we rely on `PoolManager 0x8366…0951` and the v4
  `PositionManager` as trusted.
- Off-chain infra (indexer, launch bot, front end).

## 3. The economic model (one screen)

Money side = **currency0** (native ETH on curve pads; the stock ERC20 on stock pads). Coin = currency1.

- **Buy 1%** — taken **fee-on-input** in `beforeSwap` as an **ERC-6909 claim** via `poolManager.mint` (pure
  accounting: never fronts the singleton's reserves, can't revert on a cold pool), redeemed to real currency at
  claim time. Split: **0.2% buffer** (held by the curve → platform at graduation) + **0.2% referrer** (25% of the
  platform cut, only when a ref link is in `hookData`) + **platform** (remainder).
- **Sell 1%** — taken from the money-side **output** in `afterSwap`: **0.2% floor** + **0.8% creator**.
- **No dev mint**: `supply == curveSupply + reserveSupply` exactly; creator buys from the curve like anyone else.
- **Graduation** (permissionless, when spot ≤ gradTick): keeper bounty off the top, then a %-waterfall on the raise
  (platform 10% / creator 10% / ambush 5% / **LP = ~75% remainder**), mint the **PERMANENT LOCKED** 2-sided LP
  (NFT → `LockVault`), stream leftover reserve → staking, sweep floor + ambush shares, sweep unbooked ETH (buffer +
  donations) → platform, pay the bounty last.
- **Geometry**: startTickMag 201600, curveWidth 23000 (~10×), ts 100, 1B supply @ 73% curve / 27% reserve →
  start ~$3.34k / grad ~$33.3k / ~4.1 ETH pool-principal raise.
- **Staking**: 30-day lock; Synthetix drip from a **finite** reservoir (rewardRate = reservoir/duration, NOT 1:1);
  10% early-exit penalty recycled.

## 4. Key invariants (what to try to break)

1. **Money conservation** — across any tape of buys/sells/claims/graduation, no wei is created or lost; every fee
   booked is claimable exactly once; dust is conserved into platform/creator, never negative, never double-paid.
2. **Split-backing solvency** — buy books (platform/buffer/referral) ≤ the hook's ERC-6909 claim balance; sell books
   (creator/floor) ≤ its real money-side balance; redeeming a buy claim never dips into sell ETH.
3. **Non-bricking** — a reverting/blocklisted currency, malformed `hookData`, a hostile referrer, or a reverting
   recipient can never brick a swap, a claim, or graduation. All payouts are accrue-and-pull + retriable.
4. **Permanent lock** — the graduation LP NFT is owned by `LockVault` and can never be withdrawn/unlocked; floor +
   ambush principal can only ever leave by trading at the AMM marginal price (add-only, sandwich-proof).
5. **Raise integrity** — a donation can't inflate `lpEth` past the reserve's pairing capacity (brick), the buffer is
   excluded from the measured raise, and graduation nudges spot to the honest ceiling before seeding.
6. **Governance** — per-pad config is immutable once stamped; `RobinV4FeeConfig` is forward-only (retuning affects
   only future launches); a compromised platform wallet can mis-route only the platform's OWN cut, never user
   principal, the locked LP, or the add-only floor/ambush.
7. **Access control** — `registerPool` / `setBufferRecipient` are factory-only & one-shot; `setFloorRecipient` is
   platform-only & one-shot; creator repoint is 2-step; claims are permissionless but pay only registered destinations.

## 5. Known & accepted design decisions (not bugs)

- **Self-referral** — the referral carve pays whoever `hookData` names, including the buyer or a Sybil alt-wallet.
  On-chain attribution of a *genuine external* referrer is impossible (the hook sees the router as `sender`), so
  there is intentionally no `referrer != sender` guard. It is an at-most-`referralShareBps` **rebate on the
  platform's own cut** — never touches buffer/creator/traders/raise. Priced by `test/unit/RobinFeeHook.referral.test.js`.
  Strict external-only attribution would need off-chain platform-signed codes (a deliberate future change).
- **Buy fee on requested input** — computed on the requested exact-input, so a partial-fill on a tight price limit
  over-taxes the buyer (settlement-safe, buyer-controlled, by design).

## 6. Validation performed (internal)

- **Unit + economic sims**: 129 passing (`test/unit/*`, `test/sim/*`) against a real local v4 `PoolManager`.
- **Adversarial audit gauntlet** (parallel finders per lens → independent skeptic refutation): **3 consecutive clean
  passes** on the ETH-native fee rebuild; full-scope pass — see §8.
- **Economic sim gauntlet**: **3 consecutive clean passes**.
- **Real-v4 fork tests** (`test/fork/*`): skim, launch, **graduation** (LP locked), stock launch, and a full
  **swarm** (same-block buys, buy→sell round-trip, external + self referral, airdrop sells, post-grad buffer sweep)
  — all green against the live mainnet v4 stack. Run: `FORK_RPC=<rpc> FORK_CHAINID=4663 npx hardhat test test/fork/*.js`.
- **Live testnet** (Robinhood 46630): production-geometry pad with exact on-chain fee routing, and a full
  **launch → sellout → graduate → locked-LP → post-grad sweep** lifecycle (via a mock PositionManager, since testnet
  has no v4 posm). Scripts: `scripts/testnet-bot.js`, `scripts/testnet-e2e-graduate.js`.

## 7. Build & run

```bash
cd pad-v4
npm ci
npx hardhat compile
npx hardhat test test/unit/*.js test/sim/*.js          # 129 unit + economic sims
FORK_RPC=https://rpc.mainnet.chain.robinhood.com FORK_CHAINID=4663 \
  npx hardhat test test/fork/*.js                       # real-v4 fork suite
```

## 8. Internal full-scope audit status

Pre-external-audit adversarial gauntlet: **7 subsystems** (hook, curve, factory/config, lock/LP, vaults, staking,
presale), parallel finders → independent skeptic refutation, looped to consecutive clean rounds. **Result: 2
consecutive clean rounds, 0 confirmed findings** on the current code.

Issues found and fixed during this gauntlet (all with tests; suite stays 129 green):

| # | Severity | Area | Fix |
|---|---|---|---|
| 1 | LOW | `PadFactory` / `StockPadFactory` | Added the idempotent pool-init guard (adopt byte-identical pre-init, revert on any other price) the curve factory already had — closes a launch-griefing DoS. |
| 2 | LOW | `RobinFloorVault` | `_add` now routes realized token-side (currency1) LP fees to `feeRecipient` instead of stranding them in the vault. |
| 3 | HIGH | `PresaleVault` | `finalize()` try/catches the launch; on a snipe/front-run it fails the presale (reason 3 → immediate 100% refunds) instead of reverting/bricking/locking. Fund is never stolen or trapped. The "un-front-runnable" claim was corrected to state the real guarantee (relies on the single-sequencer FCFS ordering; fail-safe on a public-mempool chain). |
| 4 | MEDIUM | `RobinLockStaking` | A mid-window reward top-up now drips over the remaining window and leaves `periodFinish` fixed, so permissionless dust-funding can no longer perpetually stretch the drip. |

This is internal assurance, not a substitute for the external review — it is meant to hand the auditors clean code
and a clear map of the invariants (§4) and the accepted design decisions (§5).
