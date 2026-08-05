# Robin Labs — Staking (stake $ROBIN, earn ETH + real stocks)

Stake a token (`$ROBIN`, or any launched coin) and earn a **streaming basket** of reward assets — native
ETH and/or real **Robinhood Stock Tokens** (AAPL, NVDA, SGOV, …). Two rules, by design:

1. **No lock.** Principal is withdrawable at any instant. `unstake` can never be blocked — not by a time lock
   (there is none) and not by a paused/blocked reward token (unstake never *transfers* a reward asset, it only
   does internal math). Your staked capital is always yours to pull.
2. **Leave early → forfeit pending.** Unstaking (any amount) forfeits **all** your unclaimed rewards, across
   every asset. The forfeiture is **re-streamed to the stakers who stayed** — paper hands fund diamond hands.
   `claim()` first if you want to keep them (claiming never forfeits).

## Why it's unique
Robinhood Chain natively hosts tokenized equities/ETFs + a native T-bill token (SGOV) — verified as standard
ERC-20s with a **blocklist + pause** model (like USDC), **not** a KYC allowlist. So any wallet can hold and
receive them, which is exactly what lets a pool stream them as rewards. "Stake our memecoin, earn real Apple
shares / T-bills" is a combo no pump.fun-style pad on another chain can offer.

## Contracts
| Contract | Role |
|---|---|
| `RobinStaking.sol` | The pool. One stake token, up to 8 reward assets, Synthetix `rewardPerToken` accumulator per asset. No lock, forfeit-to-stayers, streaming. |
| `StakingFactory.sol` | One pool per stake token; creator-curated reward basket; single admin surface (factory owns every pool). |
| `RewardConverter.sol` | Turns pad fee **ETH → stock** via the Uniswap-V3 SwapRouter (minOut + deadline + optional price-limit), streams it in. `fundToken`/`fundEth` for pre-funded / plain-ETH rewards. |

## How rewards are funded
- **ETH** — send ETH to a pool (from an authorized rewarder) → streams over the window. Zero stock purchases.
- **Liquid stocks (AAPL/NVDA/TSLA/SPY)** — the `RewardConverter` auto-swaps fee ETH → stock through the
  token/WETH V3 pool (these have real liquidity) and streams it. Keeper-gated, `minOut`-protected.
- **Illiquid stocks (SGOV today — the T-bill)** — no liquid WETH pool yet, so **pre-fund**: the treasury
  buys SGOV and `fundToken`s it into the pool. Switches to auto-convert if/when SGOV gets liquidity.

Pool fee tiers with verified on-chain liquidity live in `pad/assets/config.js` → `STOCKS` (`wethFee: 0` = pre-fund).

## Anti-abuse (why streaming, not lumps)
JIT reward-capture — stake right before a reward drop, grab a slice, leave — is defeated **without a lock** by
streaming every reward (and every forfeiture) linearly over the window (default 7 days). A flash-staker accrues
~0. Forfeitures **recycle into the remaining window** (they don't reset it), so a griefer can't stake / accrue
a crumb / unstake / repeat to dilute the rate.

## Security model (3 adversarial audit rounds)
- **Principal safety is absolute:** `stake`/`unstake` only ever move the stake token. A paused, blocked, or
  malicious reward asset cannot block your exit. `claim(asset)` is single-asset so a paused stock only blocks
  its own claim, never the others or the principal.
- Fee-on-transfer safe on **both** sides: `stake` and `notifyReward` credit the measured balance delta, so a
  launched coin that taxes transfers can't make the pool insolvent.
- `nonReentrant` on every state-mutating entrypoint; CEI (accrued zeroed before payout, principal transfer last).
- Funding gated to authorized rewarders; pools owned by the factory (a platform multisig).
- Reward assets are curated (owner-listed), capped at 8 for bounded gas.
- Accepted, documented tradeoffs: streaming rounding dust (all reward assets are 18-dp → negligible) and no
  owner sweep (trustless by design — no owner path to user funds).

## Deploy
```bash
cd launchpad
ROBINHOOD_RPC=<write RPC> PRIVATE_KEY=<funded deployer> \
  SWAP_ROUTER=<Uniswap SwapRouter02 on 4663> [KEEPER=<addr>] \
  node scripts/deploy-staking.js
```
Deploys `RewardConverter` + `StakingFactory` + the flagship `$ROBIN` pool (ETH + SGOV + NVDA), prints the three
addresses for `pad/assets/config.js` (`stakingFactory` / `robinStaking` / `rewardConverter`). The staking UI
(`pad/stake.html`, linked as **Tools → Stake**) gates on `isDeployed('stakingFactory')` until then. Verify all
three on `robinhoodchain.blockscout.com`.

## Tests
`test/robin-staking.test.js` (21) + `test/reward-converter.test.js` (6) — streaming, forfeit + redistribute,
partial-unstake, JIT & same-block-snipe resistance, paused-token safety, single-asset isolation, fee-on-transfer
solvency, factory e2e, converter swap/slippage/deadline/keeper. Run with `FORK_RPC= npx hardhat test test/robin-staking.test.js test/reward-converter.test.js`.
