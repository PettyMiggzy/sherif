# Robin V4 — "pad of pads"

An immutable, multi-pad launchpad on **Uniswap V4** for Robinhood Chain (chainId 4663).
Sibling to the untouched v3 pad in `../launchpad`. Full design: `ROBIN-V4-ARCHITECTURE.md`
(the single source of truth; every red-team finding is resolved inline).

> **Honest novelty (not "first V4/hook/launchpad" — those exist here already):** the first
> platform on this chain to combine a **3-way** afterSwap fee split (platform / creator /
> holders, where holders get an O(1) bucket — HookPadFeeLocker only does 2-way), "earn-the-other"
> dual staking, a USDG-yield ERC-4626 locked floor, and a tokenized-stock pad, all under one
> immutable factory.

## Status — Features 1–3 ✅ built & tested (47 unit tests + 2 live-fork tests passing)

### Fee model (per pad)
| | On a **BUY** (quote→token) | On a **SELL** (token→quote) |
|---|---|---|
| **LP fee** (pool's own, from the locked seed LP) | → Platform | → Project staking pool |
| **1% trade tax** (the hook) | → Platform | → Creator **0.8%** + Floor **0.2%** |

Holders are rewarded by **staking** (stake the coin → earn stocks/ETH via DualStaking), funded by the
sell-side LP fee. The floor carve comes out of the creator's sell tax and builds a permanent, un-ruggable
USDG buy-wall under the price. All numbers are per-pool config.

Coverage includes adversarial cases: unregistered-pool inertness, the D2 guarded-take (a blocklisted
fee currency skips the skim instead of bricking the swap), buy→platform / sell→creator+floor routing,
the beforeSwap stock curb, bad-config rejection, and — on staking — partial unstake, empty-pool
pause→kickstart, forfeiture-without-window-reset (anti-grief), and rewarder gating.

**Feature 1 — the spine**
| Contract | Role |
|---|---|
| `hooks/RobinFeeHook.sol` | **The heart.** afterSwap directional trade tax — buy→platform, sell→creator+floor carve (exact-input only, additional not carved). beforeSwap stock curb. Flags `0x00C4`, self-asserted. |
| `hooks/BaseHook.sol` | Flag self-assert + PM-only guards + transient reentrancy guard. |
| `core/DeterministicDeployer.sol` | Minimal CREATE2 factory (pin its address; hook salts mine off it). |
| `core/FeeWalletRegistry.sol` | The **only** mutable knob: platform wallet, Ownable2Step + 2-day timelock. |
| `core/LockVault.sol` | Holds every seed-LP NFT forever; collect-only, no decrease/burn/transfer selector. |
| `core/RobinStateView.sol` | `extsload` lens bound to our PoolManager. |
| `core/PadFactory.sol` | Immutable one-tx launch orchestrator (ETH pad). |
| `pads/PadToken.sol` | Fixed-supply ERC20, no owner/mint/pause after ctor. |

**Feature 2 — dual staking**
| Contract | Role |
|---|---|
| `pads/DualStaking.sol` | Two-book "earn the other" streaming staking. Stake token **or** stock; each side streams a reward basket (ETH, the other asset, extra tokens). Audited RobinStaking engine per side (forfeit-to-stayers, empty-pool pause, measured-delta) + optional anti-JIT hold + bounded boost (≤4x, oracle try/catch) + `fundTokenPushed`. **No lock** by default — JIT is stopped by streaming + forfeit-to-stayers. **Platform revenue** = a configurable claim fee (default 5%, capped 10%) skimmed off rewards on claim, accrue-and-pull to the platform treasury. Single-book mode (`stock == 0`) works for **any ERC20**. |
| `pads/StakingFactory.sol` | One call spins up a staking pool for any token (single- or two-book), with the 5% claim fee + no lock baked in and ownership handed to the platform multisig. Every existing Robin coin can get stake-to-earn, not just V4 pads. |

**Feature 3 — the floor**
| Contract | Role |
|---|---|
| `pads/RobinFloorVault.sol` | Fee-funded, **permanent** single-sided QUOTE buy-wall placed just below the token price. Fed by the 0.2% sell-tax carve; **add-only, no remove/withdraw selector** — the wall can only deepen ("can't rug to zero"). No shares, no depositors, no trapped USDG — it just turns fee revenue into un-pullable price support. Manages raw V4 liquidity in its own `unlock` callback (ADD + COLLECT ops only); parks the carve when spot is inside the band. |
| `adapters/EthQuoteAdapter.sol`, `interfaces/IQuoteAdapter.sol` | The quote seam (ETH clean case; USDG/stock yield adapters plug in here). |

**Next:** Feature 4 RobinBlue (tokenized-stock pad) + wiring the launch flow end-to-end (staking pool per pad, floor recipient = the vault).

## The A3 gate (P0)

No live hook on this chain skims via `afterSwapReturnDelta`, so the idiom was unverified.
`test/unit/RobinFeeHook.skim.test.js` proves it against a **real, locally-deployed PoolManager**
(identical source/compiler to the live `0x8366`): an exact-input skim swap closes the unlock with
zero residual delta, the hook holds exactly the skim, the 3-way split is exact, and exact-output is
skim-free. `test/fork/A3.skim.fork.test.js` re-runs the same assertions against the live `0x8366`.

## Build & test

```bash
npm install                     # postinstall links solmate/forge-std/permit2 for Hardhat
npm run build                   # solc 0.8.26, viaIR, runs 1, cancun (matches live PoolManager)
npm test                        # local unit + A3 suite (no RPC needed) — 13 passing
FORK_RPC=<robinhood rpc> npm run test:fork   # A3 against live 0x8366
```

## Ground-truth addresses (Robinhood Chain, verified on-chain)

```
POOL_MANAGER     0x8366a39CC670B4001A1121B8F6A443A643e40951
POSITION_MANAGER 0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA
V4_QUOTER        0x62C3D19d112A82643D418f2d7ef67e5d8a207d59
PERMIT2          0x000000000022D473030F116dDEE9F6B43aC78BA3
WETH             0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG (6dec)      0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```
Native coin sentinel = `address(0)` (always `currency0`). No EIP-1559: deploy with legacy
type-0 txs + explicit `gasPrice`.
