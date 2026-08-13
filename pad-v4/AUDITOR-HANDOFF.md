# Robin V4 Curve Suite — Security Audit Hand-off

**What it is:** A free single-sided bonding-curve launchpad ("pad of pads") on **Uniswap v4**, for **Robinhood
Chain** (mainnet chainId 4663, testnet 46630). Users launch a token against a single-sided curve; it trades with a
directional ETH-native fee model and, once it sells out, graduates into a permanently-locked 2-sided LP.

## Where the code is

- **Folder in scope:** `pad-v4/` (this directory) — the **only** thing in scope.
- **Start here:** [`AUDIT-SCOPE.md`](./AUDIT-SCOPE.md) — the full scope map: invariants, accepted design decisions,
  and the internal validation record. This hand-off is the short version.
- Companion docs: [`ROBIN-V4-ARCHITECTURE.md`](./ROBIN-V4-ARCHITECTURE.md) ·
  [`ROBIN-V4-CURVE-ECON.md`](./ROBIN-V4-CURVE-ECON.md) · [`ROBIN-V4-CURVE-SPEC.md`](./ROBIN-V4-CURVE-SPEC.md)

## In scope (`pad-v4/contracts/`)

- **Fee hook:** `hooks/RobinFeeHook.sol`, `hooks/BaseHook.sol`
- **Curve controller:** `pads/RobinCurveV4.sol`, `core/CurveV4Deployer.sol`
- **Launch + governance:** `core/CurvePadFactoryV4.sol`, `core/RobinV4FeeConfig.sol`, `core/PadFactory.sol`,
  `core/FeeWalletRegistry.sol`, `core/DeterministicDeployer.sol`, `core/RobinStateView.sol`
- **LP locking / user LP:** `core/LockVault.sol`, `pads/RobinLpVault.sol`
- **Support vaults:** `pads/RobinFloorVault.sol`, `pads/RobinAmbushVault.sol`
- **Staking:** `pads/RobinLockStaking.sol`, `pads/DualStaking.sol`, `pads/StakingFactory.sol`
- **Presale:** `presale/PresaleVault.sol`, `presale/PresaleVaultFactory.sol`
- **Token:** `pads/PadToken.sol`

## Out of scope

- **Stock pads** (`core/StockPadFactory.sol`, `adapters/StockQuoteAdapter.sol`, `quoteIsStock` paths) — needs its own
  fork test vs a real stock beacon + securities/legal review before a stock launch. Informational for this engagement.
- Uniswap v4 core/periphery (trusted, audited upstream). Off-chain infra (indexer / bot / frontend).

## Toolchain & build

solc **0.8.26**, `viaIR`, EVM **cancun**. OZ ReentrancyGuard/SafeERC20/Clones/Math. Uniswap v4-core + v4-periphery.

```bash
cd pad-v4
npm ci
npx hardhat compile
npx hardhat test test/unit/*.js test/sim/*.js        # 129 unit + economic sims
# real-v4 fork suite (deploys the suite fresh against the live mainnet v4 stack):
FORK_RPC=https://rpc.mainnet.chain.robinhood.com FORK_CHAINID=4663 npx hardhat test test/fork/*.js
```

## The model in one paragraph

Money side = **currency0** (native ETH on curve pads; a stock ERC20 on stock pads). Coin = currency1. **Buy 1%** is
taken **fee-on-input** in `beforeSwap` as an **ERC-6909 claim** via `poolManager.mint` (pure accounting — never
fronts the singleton's reserves), redeemed to real currency at claim time; split into 0.2% buffer (→ platform at
graduation) + 0.2% referrer (of the platform cut, only when a ref link is passed) + platform. **Sell 1%** is taken
from the money-side **output** in `afterSwap`: 0.2% floor + 0.8% creator. **No dev mint**
(`supply == curveSupply + reserveSupply`). At **graduation** (permissionless, spot ≤ gradTick): keeper bounty, then a
%-waterfall on the raise (platform 10% / creator 10% / ambush 5% / **LP = ~75%**), mint the **permanent LOCKED**
2-sided LP (NFT → `LockVault`), stream leftover reserve → staking, sweep floor + ambush shares, sweep unbooked ETH →
platform. Geometry: startTickMag 201600, curveWidth 23000 (~10×), ts 100, 1B supply @ 73% curve / 27% reserve →
start ~$3.34k / grad ~$33.3k / ~4.1 ETH raise. Staking: 30-day lock, Synthetix drip from a **finite** reservoir
(NOT 1:1), 10% early-exit penalty recycled.

## What to hammer on (invariants — full detail in `AUDIT-SCOPE.md` §4)

1. **Money conservation** across any buy/sell/claim/graduation tape — no wei created/lost, every fee claimable
   exactly once, dust conserved into platform/creator (never negative, never double-paid).
2. **Split-backing solvency** — buy books (platform/buffer/referral) ≤ the hook's ERC-6909 claim balance; sell books
   (creator/floor) ≤ its real money-side balance; redeeming a buy claim never dips into sell ETH.
3. **Non-bricking** — a reverting/blocklisted currency, malformed `hookData`, a hostile referrer, or a reverting
   recipient can never brick a swap, a claim, or graduation. All payouts are accrue-and-pull + retriable.
4. **Permanent lock** — the graduation LP NFT can never leave `LockVault`; floor + ambush principal can only leave by
   trading at the AMM marginal price (add-only, sandwich-proof).
5. **Raise integrity** — a donation can't inflate `lpEth` past the reserve's pairing capacity (brick); the buffer is
   excluded from the measured raise; graduation nudges spot to the honest ceiling before seeding.
6. **Governance / access control** — per-pad config is immutable once stamped; `RobinV4FeeConfig` is forward-only; a
   compromised platform wallet can mis-route only the platform's OWN cut; `registerPool`/`setBufferRecipient` are
   factory-only & one-shot; creator repoint is 2-step; claims are permissionless but pay only registered destinations.

## Accepted design decisions (NOT bugs — see `AUDIT-SCOPE.md` §5)

- **Self-referral** — the referral carve pays whoever `hookData` names (including the buyer / a Sybil alt-wallet). No
  on-chain attribution of a genuine external referrer is possible, so there is intentionally no `referrer != sender`
  guard; it is an at-most-`referralShareBps` **rebate on the platform's own cut** — never touches buffer/creator/
  traders/raise.
- **Buy fee on requested input** — computed on the requested exact-input; a partial-fill on a tight price limit
  over-taxes the buyer (settlement-safe, buyer-controlled, by design).

## Internal assurance already performed (NOT a substitute for your review)

- **129** unit + economic sims green against a real local v4 PoolManager.
- Adversarial **audit gauntlet: 3 consecutive clean passes** on the ETH-native fee rebuild; economic **sim gauntlet:
  3 consecutive clean passes**.
- **Full-scope adversarial gauntlet** over all 7 subsystems → **2 consecutive clean rounds** after fixing 4 findings
  (2 LOW / 1 HIGH / 1 MEDIUM), each with tests (see `AUDIT-SCOPE.md` §8).
- **Real-v4 fork tests** (`test/fork/*`): skim, launch, graduation (LP locked), stock launch, and a full trader
  **swarm** (same-block buys, buy→sell round-trip, external + self referral, airdrop sells, post-grad buffer sweep)
  — green against the live mainnet v4 stack.
- **Live testnet** (Robinhood 46630): production-geometry pad with exact on-chain fee routing, and a full
  launch → sellout → graduate → locked-LP → post-grad-sweep lifecycle (via a mock PositionManager, since testnet has
  no v4 posm; real-v4 graduation is fork-proven).

## Reporting

Please report findings by severity with a concrete failing scenario (inputs/state → wrong outcome). Anything in the
"accepted design decisions" list above is known; flag it only if the stated reasoning is wrong or the impact is worse
than described.
