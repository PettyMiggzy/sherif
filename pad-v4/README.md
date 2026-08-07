# Robin V4 — "pad of pads"

An immutable, multi-pad launchpad on **Uniswap V4** for Robinhood Chain (chainId 4663).
Sibling to the untouched v3 pad in `../launchpad`. Full design: `ROBIN-V4-ARCHITECTURE.md`
(the single source of truth; every red-team finding is resolved inline).

> **Honest novelty (not "first V4/hook/launchpad" — those exist here already):** the first
> platform on this chain to combine a **3-way** afterSwap fee split (platform / creator /
> holders, where holders get an O(1) bucket — HookPadFeeLocker only does 2-way), "earn-the-other"
> dual staking, a USDG-yield ERC-4626 locked floor, and a tokenized-stock pad, all under one
> immutable factory.

## Status — Feature 1 (the spine) ✅ built & tested

| Contract | Role |
|---|---|
| `hooks/RobinFeeHook.sol` | **The heart.** afterSwap 3-way skim (exact-input only, additional not carved), O(1) holder accumulator, beforeSwap stock curb. Flags `0x00C4`, self-asserted. |
| `hooks/BaseHook.sol` | Flag self-assert + PM-only guards + transient reentrancy guard. |
| `core/DeterministicDeployer.sol` | Minimal CREATE2 factory (pin its address; hook salts mine off it). |
| `core/FeeWalletRegistry.sol` | The **only** mutable knob: platform wallet, Ownable2Step + 2-day timelock. |
| `core/LockVault.sol` | Holds every seed-LP NFT forever; collect-only, no decrease/burn/transfer selector. |
| `core/RobinStateView.sol` | `extsload` lens bound to our PoolManager. |
| `core/PadFactory.sol` | Immutable one-tx launch orchestrator (ETH pad). |
| `pads/PadToken.sol` | Fixed-supply ERC20, no owner/mint/pause after ctor. |

**Next:** Feature 2 dual staking → Feature 3 RobinVault (USDG floor) → Feature 4 RobinBlue (stock pad).

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
