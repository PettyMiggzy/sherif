# Robin V4 — go-live runbook

Deploy order matters (contracts have immutable cross-references). Everything is legacy **type-0** gas
(Robinhood Chain has no EIP-1559). Do this only after the audit is clean and `npm test` + `npm run test:sim`
pass, and after a `npm run test:fork` against the live chain.

## 0. Preflight
```bash
cd pad-v4 && npm install && npm test && npm run test:sim   # green
FORK_RPC=<rpc> npm run test:fork                            # 2 passing vs live 0x8366
```
Set env (never commit): `PRIVATE_KEY` (deployer), `ROBINHOOD_RPC`, `PLATFORM_WALLET` (multisig),
optionally `STAKING_CLAIM_FEE_BPS` (default 500 = 5%).

## 1. Bootstrap the platform stack (once)
```bash
npx hardhat run scripts/deploy.js --network robinhood
```
Deploys, in order: `DeterministicDeployer → RobinStateView → FeeWalletRegistry → LockVault →
PadFactory → (lockVault.setFactory) → StakingFactory`. Writes `deploy.local.json`.

Then, out of band:
- **Verify all** on Blockscout (`npx hardhat verify --network robinhood <addr> <ctor args>`).
- **Transfer `FeeWalletRegistry` ownership** to the platform multisig (`Ownable2Step`: `transferOwnership`
  then the multisig `acceptOwnership`). This is the only mutable knob in the system; it must be multisig-held.

## 2. Launch a pad + wire it (per coin)
```bash
NAME="Troll Cat" SYMBOL=TROLL SUPPLY=1000000 LP_TOKENS=500000 SEED_ETH=1 \
  npx hardhat run scripts/launch.js --network robinhood
```
This atomically launches the pad (token + hook@0x…C4 + pool + locked seed LP), then deploys and wires the
`RobinFloorVault` (`hook.setFloorRecipient`, one-shot) and a `DualStaking` pool via `StakingFactory`, and
points the LockVault token-leg fee at the reward keeper. Record is appended to `deploy.local.json`.

Follow-ups (platform multisig):
- `acceptOwnership()` on the new staking pool.
- On the staking pool, `listReward(TOKEN, <token>, <duration>)` and `setRewarder(<keeper>, true)` so the
  keeper can stream the token-leg LP fee to stakers.
- Verify token + hook + floor vault on Blockscout.

## 3. Run the revenue keeper (continuous)
```bash
# on the droplet, via pm2/cron, as the reward-keeper key:
PRIVATE_KEY=<keeper> ROBINHOOD_RPC=<rpc> npx hardhat run scripts/keeper.js --network robinhood
```
Sweeps every pad: collect LP fees → route quote→platform / token→staking, claim the 0.2% floor carve →
deploy into the wall → collect the wall's fees. **The keeper can only move already-owed funds to their
immutable destinations — it can never redirect or steal.** A compromised keeper key is a liveness risk, not
a theft risk.

## Money model (per pad)
| | BUY (quote→token) | SELL (token→quote) |
|---|---|---|
| LP fee (locked seed LP) | → platform | → staking pool |
| 1% trade tax (hook) | → platform | → creator 0.8% + floor 0.2% |

- Holders earn by **staking** (no lock; 5% platform claim fee). Any ERC20 can get a pool via `StakingFactory`.
- The floor is a **permanent, add-only** quote buy-wall — no remove path exists.
- The only mutable knob system-wide is `FeeWalletRegistry.platformFeeWallet` (Ownable2Step + 2-day timelock).

## Ground truth (Robinhood Chain, chainId 4663)
```
POOL_MANAGER     0x8366a39CC670B4001A1121B8F6A443A643e40951
POSITION_MANAGER 0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA
PERMIT2          0x000000000022D473030F116dDEE9F6B43aC78BA3
WETH             0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG (6dec)      0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```
Native quote = `address(0)` (always currency0). solc 0.8.26 / viaIR / runs 1 / cancun.
