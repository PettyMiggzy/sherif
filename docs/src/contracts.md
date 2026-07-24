# Contracts & ABI

All ABIs below are human-readable (ethers.js parses them directly).

## CurvePadFactory

The launch entrypoint. `launch()` is **payable** — any ETH you send is the creator's own opening buy, executed atomically before public trading opens. It's **uncapped by supply**: it climbs the curve up to the graduation ceiling, and any ETH beyond what fills the curve is refunded.

```solidity
// The launch params tuple. tax.projectWallet receives the creator's sell fee.
function launch(
  (string name, string symbol, address dev,
   (uint16 buyBps, uint16 sellBps, uint16 walletBps,
    uint16 floorBps, uint16 burnBps, address projectWallet) tax) p
) payable returns (address token, address curve, address pool)

function tokenCount() view returns (uint256)
function allTokens(uint256 index) view returns (address)
function recordOf(address token) view returns (address token, address curve, address dev, uint256 at)

event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)
```

> **Fee caps (enforced on-chain).** Each side (`buyBps`/`sellBps`) is 1%–4% (`100–400` bps). The baseline 1% is mandatory. The opening dev buy is **uncapped by supply** — it fills the curve up to the graduation ceiling and refunds any excess ETH. Total supply is fixed at `1,000,000,000`.

## PadRouter

Every trade goes through the router. Buys send native ETH (no approval); sells need one exact-amount approval to the router. The fee split happens inside — no side transfers.

```solidity
function buy(address token, uint256 minOut) payable returns (uint256 tokensOut)
function sell(address token, uint256 amountIn, uint256 minOutEth) returns (uint256 ethOut)

// reads
function configOf(address token) view returns (
  (address pool, address curve, address projectWallet,
   uint16 buyBps, uint16 sellBps, uint16 walletBps,
   uint16 floorBps, uint16 burnBps, bool set) )
function devEscrow(address token) view returns (uint256)   // creator's uncollected sell fees (wei)
function bondOf(address token) view returns (address)

// creator-only fee controls (projectWallet)
function withdrawDev(address token)   // collect escrowed sell fees to the wallet
function burnDev(address token)       // buy + burn with them instead

event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut)
event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut)
event FeeSplit(address indexed token, uint256 platform, uint256 deferred, uint256 platformCut, uint256 dev, uint256 floor, uint256 burn)
```

The router reads its swap-fee split live from `FeeConfig` (see below). An unset or invalid config safely
routes the whole fee to the platform — a bad split can never brick a swap.

## FeeConfig

The single owner-governed fee dial (`Ownable2Step`). It holds only ratios — never funds. `CurvePool` reads
the LP creator split; `PadRouter` reads the swap split. Retune with a setter, no redeploy.

```solidity
// LP fee (the in-protocol 1%) — creator's share of collected LP fees
function lpCreatorBps() view returns (uint16)        // default 1000 (10%); rest to platform
function LP_CREATOR_MAX() view returns (uint16)      // 5000 — hard cap (50%)
function setLpCreatorBps(uint16 bps)                 // owner only, bps <= 5000

// router swap-fee split — the three shares sum to exactly 10000
function swapSplit() view returns (uint16 platformBps, uint16 creatorBps, uint16 floorBps)  // default 4500/4500/1000
function setSwapSplit(uint16 platformBps, uint16 creatorBps, uint16 floorBps)   // owner only, must sum to 10000

event LpSplitChanged(uint16 creatorBps)
event SwapSplitChanged(uint16 platformBps, uint16 creatorBps, uint16 floorBps)
```

## CurvePool

The bonding curve and graduation. Read it for progress; call `graduate()` (permissionless) to post the Bond once the curve reaches its ceiling.

```solidity
function pool() view returns (address)     // the Uniswap v3 pool
function dev() view returns (address)
function bond() view returns (address)     // zero until graduated
function seeded() view returns (bool)
function graduated() view returns (bool)
function ready() view returns (bool)       // true only once the tick reaches gradTick

// geometry — ticks along the curve (price rises left to right)
function startTick() view returns (int24)      // curve start (~$3.4k FDV)
function gradTick() view returns (int24)       // the ceiling (~$34k FDV) — the only price that graduates

function graduate()                        // permissionless once ready()

// sweep the accrued in-protocol 1% LP fees and split them platform/creator per FeeConfig.lpCreatorBps
function collectFees()                     // permissionless; principal is never touched

event Seeded(int24 curveLo, int24 curveHi, uint128 liquidity)
event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken)
event FeesCollected(address indexed by, uint256 wethFees, uint256 tokenFees, uint16 creatorBps)
```

> Graduation is **ceiling-only**: a coin graduates at exactly one point, the top of the curve. There's no creator-settable target, no minimum, and no timeout. (`gradTarget`/`minGradTick`/`seedTime` remain on the contract as vestigial storage but no longer gate graduation — don't treat them as controls.)

## Bond

The floor, posted once at graduation and locked forever. Anyone can call `poke()` to sweep the Sherwood LP's accrued Uniswap fees and compound them back into the locked position — fees never leave to a wallet.

```solidity
function poke()   // permissionless: compound Sherwood LP fees back into the floor

event Posted(uint128 sherwoodL, uint128 bountyL, uint128 ambushL)
event Poked(int24 tick, uint128 bountyL, uint128 ambushL, uint256 sherwoodFees0, uint256 sherwoodFees1)
```

## FloorCoopFactory & FloorCoop

One [FloorCoop](floorcoop.md) vault per token, created on demand. Stake ETH into the coin's real, locked Uniswap v3 liquidity and earn a share of every trade's fee.

```solidity
// FloorCoopFactory — one vault per token
function coopOf(address token) view returns (address)   // 0x0 if none yet
function createCoop(address token) returns (address coop)

// FloorCoop — the per-token vault
function deposit(uint256 lockDays, uint256 minSharesOut) payable returns (uint256 sharesMinted)
function withdraw(uint256 shareAmt, uint256 minWethOut, uint256 minTokenOut) returns (uint256 wethOut, uint256 tokenOut)
function claim()                                        // pay accrued fees to your wallet
function compound()                                     // permissionless: fold fees back into the position
function pending(address user) view returns (uint256 wethOwed, uint256 tokenOwed)
function totalShares() view returns (uint256)
function shares(address) view returns (uint256)
function totalNav() view returns (uint256)              // vault value in WETH, at TWAP
```

## PlatformFeeSplitter

Routes the platform's cut — the $ROBIN buy-back split. Standalone; the admin panel reads/sets the split.

```solidity
function robinShareBps() view returns (uint16)          // portion routed to the $ROBIN sink
function robinSink() view returns (address)
function platformTreasury() view returns (address)
function setRobinShareBps(uint16 bps)                    // owner only
function setRobinSink(address sink)                      // owner only
function setPlatformTreasury(address t)                  // owner only
```

## Events reference

These are everything the [indexer](api.md) consumes — enough to reconstruct the full state of the pad.

| Event | Emitter | Meaning |
|-------|---------|---------|
| `Launched` | Factory | New coin: token, curve, pool, dev, opening buy |
| `Bought` | Router | A buy: ETH in, fee, tokens out |
| `Sold` | Router | A sell: tokens in, fee, ETH out |
| `FeeSplit` | Router | Exact fee routing per trade (platform/deferred/cut/dev/floor/burn) |
| `Graduated` | Curve | Graduation at the ceiling: raised WETH, the Bond address |
| `Posted` / `Poked` | Bond | Floor posted / fees compounded |
