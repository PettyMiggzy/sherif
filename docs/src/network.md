# Network & Addresses

## Robinhood Chain

| Key | Value |
|-----|-------|
| Chain | Robinhood Chain (Arbitrum Orbit L2, EVM) |
| Chain ID | `4663` (`0x1237`) |
| Currency | ETH (18 decimals) |
| Public RPC | `https://robinhoodchain.blockscout.com/api/eth-rpc` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Per-tx gas cap | `16,777,216` (2²⁴) — relevant if you batch calls |

## Contract addresses (live)

| Contract | Address | Role |
|----------|---------|------|
| `CurvePadFactory` | `0x7E9E3BC24013e6f607e89c52E619B6FD77334DC2` | One-call launch entrypoint |
| `PadRouter` | `0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F` | The swap desk — every buy/sell goes through it |
| `RewardVault` | `0x0F07dC315e332084129c1D00bEbADAb05edf79Dc` | Custodies the 0.25% trader/holder [reward](rewards.md) legs; pays capped Merkle claims |
| `FloorCoopFactory` | `0x26aBF8443C30AA2913b9f94B89787d38146C825b` | Deploys the per-coin [FloorCoop](floorcoop.md) LP vaults |
| `PlatformFeeSplitter` | `0xAc918cd2BF3affFEc81A4f55238539d7eBFd156f` | Routes the platform's cut (the $ROBIN buy-back split) |
| `WETH` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Canonical wrapped ETH |
| `UniswapV3Factory` | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | The real v3 factory each pool is created on |

The whole stack is **live and source-verified** on the [explorer](https://robinhoodchain.blockscout.com/address/0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F) (and on [Sourcify](https://sourcify.dev/#/lookup/0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F) for chain `4663`) — so you can read every ABI straight from Blockscout, or use the typed exports in the [SDK](sdk.md). `CurvePool`, `Bond` and `FloorCoop` addresses are **per-coin**: get `CurvePool`/`Bond` from the factory's `Launched` event or `recordOf(token)` and `router.bondOf(token)`, and a coin's `FloorCoop` from `FloorCoopFactory.coopOf(token)`.

The three stateless deployer helpers (reused across launches) are also verified: `LaunchTokenDeployer` `0xAcaeB153312CFf7B82C33a5a43604c566dbbe8c3`, `CurvePoolDeployer` `0x441bA3270B9EF2f15C603D384609D1a6Ef98e428`, `BondDeployer` `0x5049f2CCa88E62990515155c745e814a53cfb862`.

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| Total supply | `1,000,000,000` | Fixed for every coin (18 decimals) |
| Pool fee tier | `10000` | 1% — the base fee, collected as Uniswap LP fees |
| Base fee | `100` bps | Mandatory 1% per side |
| Max fee per side | `400` bps | A creator may raise a side up to 4% |
| Max opening dev buy | `200` bps | 2% of supply, anti-snipe |
| Graduation reward | `0.5 ETH` | paid to the creator AND the platform at graduation (capped at raise/4 each) |
| Reward leg per side | `25` bps | 0.25% buy → [traders](rewards.md), 0.25% sell → holders (additive) |
| Reward epoch | `7 days` | `finalityDelay` 1d · `challengeWindow` 2d · `claimWindow` 30d |
