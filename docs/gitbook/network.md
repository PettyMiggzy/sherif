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
| `CurvePadFactory` | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` | One-call launch entrypoint |
| `PadRouter` | `0xA6BaAB820809C7fC8350311776627298f91F07eC` | The swap desk — every buy/sell goes through it |
| `FeeConfig` | `0x064D977B66FCC29256510dBCD8cC0C51bBb2De14` | Owner-governed fee dial — LP creator split + swap platform/creator/floor split, retunable with no redeploy |
| `FloorCoopFactory` | `0x564EDF561Bed46C972d5D44D84f5FAc9C5118668` | Deploys the per-coin [FloorCoop](floorcoop.md) LP vaults |
| `PlatformFeeSplitter` | `0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a` | Routes the platform's cut (the $ROBIN buy-back split) |
| `WETH` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Canonical wrapped ETH |
| `UniswapV3Factory` | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | The real v3 factory each pool is created on |

The whole stack is **live and source-verified** on the [explorer](https://robinhoodchain.blockscout.com/address/0xA6BaAB820809C7fC8350311776627298f91F07eC) (and on [Sourcify](https://sourcify.dev/#/lookup/0xA6BaAB820809C7fC8350311776627298f91F07eC) for chain `4663`) — every core contract's source is readable straight from Blockscout, so you can pull any ABI from the explorer or use the typed exports in the [SDK](sdk.md). `CurvePool`, `Bond` and `FloorCoop` addresses are **per-coin**: get `CurvePool`/`Bond` from the factory's `Launched` event or `recordOf(token)` and `router.bondOf(token)`, and a coin's `FloorCoop` from `FloorCoopFactory.coopOf(token)`. Every launched coin's token, curve and bond **auto-verify** on the explorer too, so any coin's source is readable the moment it lands.

The three stateless deployer helpers (reused across launches) are also verified: `LaunchTokenDeployer` `0xb3748cB6ba4e47b885f8333aCa8C004A4657383d`, `CurvePoolDeployer` `0x020524511aD8B99828b19DA0FD3Bb7BE919A080c`, `BondDeployer` `0x8B04d9e55C904d6D371eA6e81ecb2a0911843AD3`.

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| Total supply | `1,000,000,000` | Fixed for every coin (18 decimals) |
| Pool fee tier | `10000` | 1% — the base fee, collected as Uniswap LP fees |
| LP creator split | `1000` bps | Creator's share of the 1% LP fee (default 10%; owner cap 5000 = 50%) |
| Swap split | `4500/4500/1000` | Router swap fee → platform / creator / floor (must sum to 10000) |
| Opening dev buy | uncapped | Fills the curve up to the graduation ceiling; excess ETH refunded |
| Graduation ceiling | `4.2 ETH` | Ceiling-only graduation trigger |
| Graduation reward | `0.5 ETH` | paid to the creator AND the platform at graduation (capped at raise/4 each) |
