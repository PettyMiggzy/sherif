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
| `CurvePadFactory` | `0x59A9Fd6Fdb8B5Ed60ABF889b84d2C2fcc8a1dEDe` | One-call launch entrypoint |
| `PadRouter` | `0xeA5b12Cbba5B1790A3b00C5C5884484bb2AABFaa` | The swap desk — every buy/sell goes through it |
| `FeeConfig` | `0x96a7c260E215853c38aC82c891827e5Dbf50efD8` | Owner-governed fee dial — LP creator split + swap platform/creator/floor split, retunable with no redeploy |
| `FloorCoopFactory` | `0x8f33ED14d81D7986A708af4C2DAD7DAEe9778D95` | Deploys the per-coin [FloorCoop](floorcoop.md) LP vaults |
| `PlatformFeeSplitter` | `0xCADAbB14339BE77a2Fc4D4151B1E453b81940653` | Routes the platform's cut (the $ROBIN buy-back split) |
| `WETH` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Canonical wrapped ETH |
| `UniswapV3Factory` | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | The real v3 factory each pool is created on |

The whole stack is **live and source-verified** on the [explorer](https://robinhoodchain.blockscout.com/address/0xeA5b12Cbba5B1790A3b00C5C5884484bb2AABFaa) (and on [Sourcify](https://sourcify.dev/#/lookup/0xeA5b12Cbba5B1790A3b00C5C5884484bb2AABFaa) for chain `4663`) — every core contract's source is readable straight from Blockscout, so you can pull any ABI from the explorer or use the typed exports in the [SDK](sdk.md). `CurvePool`, `Bond` and `FloorCoop` addresses are **per-coin**: get `CurvePool`/`Bond` from the factory's `Launched` event or `recordOf(token)` and `router.bondOf(token)`, and a coin's `FloorCoop` from `FloorCoopFactory.coopOf(token)`. Every launched coin's token, curve and bond **auto-verify** on the explorer too, so any coin's source is readable the moment it lands.

The three stateless deployer helpers (reused across launches) are also verified: `LaunchTokenDeployer` `0xc53f32BCc25351043b95eE4B4D60964C65bB2541`, `CurvePoolDeployer` `0xb28B2CA4D456109E53c985968452d8B23392C777`, `BondDeployer` `0x0925cbB3Af5d632c18cd70524f389e3fa878161C`.

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| Total supply | `1,000,000,000` | Fixed for every coin (18 decimals) |
| Pool fee tier | `10000` | 1% — the base fee, collected as Uniswap LP fees |
| LP creator split | `1000` bps | Creator's share of the 1% LP fee (default 10%; owner cap 5000 = 50%) |
| Swap split | `4500/4500/1000` | Router swap fee → platform / creator / floor (must sum to 10000) |
| Max opening dev buy | `200` bps | 2% of supply, anti-snipe |
| Graduation ceiling | `4.2 ETH` | Ceiling-only graduation trigger |
| Graduation reward | `0.5 ETH` | paid to the creator AND the platform at graduation (capped at raise/4 each) |
| Rewards program | _disabled_ | The additive 0.25% trader/holder [reward](rewards.md) legs and `RewardVault` are not enabled in production |
