# Fee Model

Robin Labs runs two fee streams, both governed by the on-chain [`FeeConfig`](network.md) dial. The owner
retunes the splits with a setter: **no redeploy, no per-coin migration**. Curves and the router read the
ratios live.

## 1. LP fee: the in-protocol 1%

Every coin trades in a real Uniswap v3 pool at the **1% fee tier**. That 1% is collected *in-protocol* as
Uniswap LP fees on the curve's own position, never as an extra transfer bolted onto the user's tx. When
`CurvePool.collectFees()` sweeps those accrued fees, `FeeConfig.lpCreatorBps` decides the split:

| Share | Default | Detail |
|-------|---------|--------|
| Platform | **90%** | The pad's platform wallet |
| Creator | **10%** | The coin's own dev, `lpCreatorBps = 1000` |

The owner may raise the creator's cut up to **50%** (`LP_CREATOR_MAX = 5000`); it can never exceed that.

## 2. Swap-desk fee: the router's cut

Trades placed through the pad UI route through `PadRouter`, which takes its own swap fee and splits it three
ways per `FeeConfig.swapSplit()`. The three shares must always sum to exactly **100%** (10000 bps):

| Share | Default | Goes to |
|-------|---------|---------|
| Platform | **45%** | `swapPlatformBps = 4500` |
| Creator | **45%** | `swapCreatorBps = 4500`, the coin's dev |
| Floor | **10%** | `swapFloorBps = 1000`, deepens the coin's Bond floor |

If `FeeConfig` is unset (or ever returns an invalid split), the router safely routes the whole fee to the
platform: a bad config can never brick a swap.

## 3. Graduation

Graduation is **ceiling-only at 4.2 ETH raised**. At graduation the creator and the platform each receive
**0.5 ETH** (capped at a quarter of the raise each); the remaining reserve seeds the locked Bond floor.
Pending LP fees are swept and split first, then the principal migrates.

> **Creator income** = a 10% share of the 1% LP fee + a 45% share of the swap-desk fee + a 0.5 ETH
> graduation reward. Every share is escrowed and paid by permissionless flushers, so a trade can never revert
> on a payout. Accounting is exact to the wei.

## Retuning (owner only)

From `admin.html` → **Fee dials** (visible only to the owner wallet):

- `setLpCreatorBps(uint16)`: the creator's share of the LP fee (≤ 5000).
- `setSwapSplit(uint16 platform, uint16 creator, uint16 floor)`: must sum to 10000.

## FloorCoop economics

[Lock Liquidity (FloorCoop)](floorcoop.md) is opt-in staking into a coin's real, locked LP:

| Flow | Detail |
|------|--------|
| Open fee | **10%** taken when you open a position; the rest becomes your stake |
| LP fees earned | The pool's 1% trade fee accrues to the vault pro-rata: **you keep 95%, the protocol keeps 5%** |
| Early-exit penalty | Withdrawing before your lock ends costs a penalty (from 15%, scaled by lock tier) that stays with the remaining stakers |

## 4. Rewards program: two additive legs

On top of the two fee streams above, every trade carves **two additive 0.25% legs** in real ETH into the
[`RewardVault`](network.md), one for **net-volume traders**, one for **diamond-hand holders** of the coin:

| Leg | Funded by | Scored on |
|-----|-----------|-----------|
| Traders | **0.25% of each buy** | Net ETH accumulation over the epoch (buy-then-dump nets to zero) |
| Holders | **0.25% of each sell** | Balance-seconds held, above a 0.02%-of-supply minimum |

These legs are **additive**, carved on top of a trade, not skimmed out of the base fee. The chain custodies
and caps the ETH; a daily-ish epoch settles into a Merkle root and wallets claim their leaf on-site in one
clean tx and keep the ETH. Protocol addresses (the token, curve, pool, Bond, router, vault, factory,
vesting-lock and dead address) are excluded so rewards flow only to real users. Rewards are **variable, not
guaranteed, and not a security**.

See the full mechanics (scoring, the minimum-holding threshold, the epoch lifecycle, capped Merkle claims and
the guardian veto) in **[Holder & Trader Rewards](rewards.md)**.

> The reward system is **gated until the `RewardVault` is deployed** and verified in
> [config](network.md). Until then no leg is carved and every reward path is a no-op.

## Why fees ride the protocol

The base 1% *is* the Uniswap v3 pool's fee tier, collected in-protocol as LP fees, not as an extra transfer
bolted onto the user's transaction. This keeps every trade a clean, single-recipient swap: no fan-out, no
side transfers, nothing for a wallet's transaction scanner to flag.
