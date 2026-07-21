# Lock Liquidity (FloorCoop)

**FloorCoop** lets anyone stake ETH into a coin's *real* Uniswap v3 liquidity, locked for a term of their choosing, and earn a share of **every trade's fee**. It deepens the market and — because it's locked — can't be yanked out from under the coin. There is one vault per token, created on demand, and it works for **any** token with a live WETH pool (a Robin Labs coin or not).

> One vault per token · permissionless to create · your stake is real LP, so it earns the pool's 1% trade fee pro-rata and rebalances with price like any LP position.

## How you earn

The vault holds a concentrated Uniswap v3 position. When people trade the coin, the pool's **1% fee** accrues to in-range liquidity — including the vault's — and is split across stakers by share. You keep **95%**; the protocol keeps **5%**. Realized fees show up as `pending(user) → (wethOwed, tokenOwed)` and are paid out on `claim()`; `compound()` (permissionless keeper) folds them back into the position to grow everyone's NAV.

## Lock terms

Longer locks earn a bigger reward weight. Pick one at deposit:

| Term | Reward multiplier |
|------|-------------------|
| 30 days | 1.0× |
| 60 days | 1.25× |
| 90 days | 1.5× |
| 1 year | 2× |
| Forever | 3× |

## Deposit

```solidity
function deposit(uint256 lockDays, uint256 minSharesOut) external payable returns (uint256 sharesMinted);
```

- **`lockDays`** ∈ `{30, 60, 90, 365, 0}` (0 = forever). **`minSharesOut`** is your slippage floor (0 to skip).
- A **10% open fee** is taken when you open a position; the rest becomes your stake.
- Half your ETH is zapped to the token so you provide two-sided liquidity; the swap is TWAP-bounded.
- First-ever deposit to a vault must be ≥ **0.001 ETH** (`MIN_FIRST_DEPOSIT`).

**Manipulation guard.** The deposit reverts if the pool's spot price is more than ~**3%** off its TWAP (`Manipulated`) or if the oracle isn't warm — at least ~30 s of history across ≥2 observations (`StaleTwap`). This protects depositors from being sandwiched into a skewed price. In practice you deposit when the market is calm; a freshly graduated or freshly traded pool may need a moment for its oracle to warm.

## Withdraw

```solidity
function withdraw(uint256 shareAmt, uint256 minWethOut, uint256 minTokenOut)
    external returns (uint256 wethOut, uint256 tokenOut);
```

- **After your lock ends:** withdraw with no penalty.
- **Before it ends:** a **15% early-exit penalty** applies (scaled up by your lock tier — the longer the term you chose, the more early exit costs). The penalty stays in the vault for the remaining stakers.
- Like any LP, your position **rebalances with price** — if the price moved since you deposited you'll come out with a different ETH/token mix (impermanent loss).

## Claim & compound

```solidity
function claim() external;                 // pay your accrued fees to your wallet
function pending(address) external view returns (uint256 wethOwed, uint256 tokenOwed);
function compound() external;              // permissionless: fold collected fees back into the position
function totalNav() external view returns (uint256);   // vault value in WETH, at TWAP
```

## Per-token vaults

```solidity
// FloorCoopFactory
function coopOf(address token) external view returns (address);   // 0x0 if none yet
function createCoop(address token) external returns (address coop);
```

`createCoop` is permissionless and one-per-token. It reverts (`NoPool`) unless the token already has a live WETH v3 pool holding at least **0.1 WETH** — so a coin is stake-ready once it has real liquidity (after graduation, the Bond's Sherwood LP guarantees this).

## From the pad SDK (`assets/wallet.js`)

```js
import * as Pad from "./assets/wallet.js";

// stake 0.25 ETH, locked 90 days (creates the vault on first use)
await (await Pad.floorDeposit(token, "0.25", 90)).wait();

// read your position + the vault
const info = await Pad.floorInfo(token, myAddress);
// → { coop, tvlEth, mineEth, earnedEth, feesPaidEth }

await (await Pad.floorClaim(token)).wait();      // collect your fee share
await (await Pad.floorWithdraw(token)).wait();   // pull your whole stake (penalty if still locked)
```

## Risk

FloorCoop is real LP: you take **impermanent loss** if price moves, and **early exit is penalized**. It custodies user funds and is the most complex contract in the stack — it has internal adversarial-audit passes and simulation coverage, but treat large deposits with the caution you'd give any new LP venue until an external audit is complete.
