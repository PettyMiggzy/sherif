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
optionally `STAKING_CLAIM_FEE_BPS` (default **0** — [R3-F1] the platform takes ETH only; a nonzero value would
only charge money-side (ETH/stock) reward claims, since the pad token is contract-exempt from the fee).

## 1. Bootstrap the platform stack (once)
```bash
npx hardhat run scripts/deploy.js --network robinhood
```
Deploys, in order: `DeterministicDeployer → RobinStateView → FeeWalletRegistry → LockVault →
PadFactory → (lockVault.setFactory) → StakingFactory`. Writes `deploy.local.json`.

Then, out of band:
- **Verify all** on Blockscout (`npx hardhat verify --network robinhood <addr> <ctor args>`).
- **Transfer `FeeWalletRegistry` ownership** to the platform multisig (`Ownable2Step`: `transferOwnership`
  then the multisig `acceptOwnership`). It must be multisig-held. Two things to hold with root-key security, not
  treasury-receiver security:
  - **`FeeWalletRegistry.platformFeeWallet` [M-14]** is the protocol ROOT ADMIN key, not just a payout address —
    it is the AUTHORIZATION check for every one-shot per-pad wiring setter (`RobinCurveV4.setStaking/setFloor/
    setAmbush`, `RobinFeeHook.setFloorRecipient`, `LockVault.setStakingRecipient`), so it determines where each
    pad's value sinks route. The 2-day timelock governs CHANGING the wallet, not what it may do.
  - **`RobinV4FeeConfig` ownership [M-10/L-6]** is a SECOND live, un-timelocked knob: `setDefaults` governs fee AND
    geometry for every future launch (a bad geometry bricks every future pad — [L-1]) and can reprice an open
    presale ([M-12]). Transfer it to the multisig too and treat it as timelock-critical.

## 2. Launch a pad + wire it (per coin)
```bash
NAME="Troll Cat" SYMBOL=TROLL SUPPLY=1000000 LP_TOKENS=500000 SEED_ETH=1 \
  npx hardhat run scripts/launch.js --network robinhood
```
**Brand suffix — every pad token CA ends in `1ab5`.** Step 1 mines the token's CREATE2 salt so the deployed
token address ends in `1ab5` (`scripts/mine.js` `mineTokenSalt`; ~65k expected tries, measured ~2s per launch),
then mines the hook salt against that token — order matters, since the hook's init-code embeds the token
address. A Robin coin is therefore recognizable from its contract address alone, which makes impersonation
visible. Tested by `test/unit/VanityCA.test.js`.

> **Enforced ON-CHAIN, not by convention.** `PadBrand.requireBrand` (`contracts/core/PadBrand.sol`) is called by
> `PadFactory.launch`, `CurvePadFactoryV4.launch` (which also covers the Arrow path) and `StockPadFactory.launch`,
> and reverts `BadTokenSuffix(token)` on any unbranded address — before a single pool/LP write, so an unmined salt
> wastes gas but can never half-create a pad. There is no flag to disable it and no privileged bypass, deliberately:
> a tooling-only convention would hold exactly as long as every client remembered to mine, which is the
> "config-enforced, not contract-enforced" weakness round-3 finding **F1** was restructured to eliminate.
>
> **Consequence for any launch client** (our UI, partner bots, direct callers): you MUST mine `tokenSalt` before
> calling `launch`, or the call reverts. Use `mineTokenSalt`; a browser client should use a WASM keccak, since
> plain JS is ~2s. On the **stock** path the mine must satisfy BOTH the suffix and `token > stock`.

This atomically launches the pad (token + hook@0x…CC + pool + locked seed LP), then deploys and wires the
`RobinFloorVault` (`hook.setFloorRecipient`, one-shot), a `DualStaking` pool via `StakingFactory`, and the
per-pad `RobinTokenTreasury` (70% staking / 30% creator-burn) — pointing the LockVault token-leg fee
(`setStakingRecipient`) **and** the floor's token leg (`setTokenSink`) at the treasury, so the platform stays
ETH-only. Record is appended to `deploy.local.json`.

Follow-ups (platform multisig):
- `acceptOwnership()` on the new staking pool.
- On the staking pool, `listReward(TOKEN, <token>, <duration>)` and `setRewarder(<keeper>, true)` so the
  keeper can stream the token-leg LP fee to stakers.
- Verify token + hook + floor vault on Blockscout.

## 2a. Creator-chosen supply + valuation (curve pads)

A curve creator picks **their own supply** — 10,000 tokens or 10,000,000,000, the pad does not care — and
**their own launch price** (`LaunchConfig.startTickMag`; `0` = use the governed default). What the factory
bounds is neither number alone but their product: the implied fully-diluted value at launch, checked against
`RobinV4FeeConfig.minFdvWei/maxFdvWei` and reverted as `MarketCapOutOfRange(fdvWei)` before any state write.

Shipped band (`scripts/deploy-curve.js`, env `MIN_FDV_ETH` / `MAX_FDV_ETH`): **0.05 ETH – 100 ETH**. For
reference the shipped geometry puts a 1B supply at ~1.76 ETH FDV and a ~4.1 ETH raise to graduate at 73%
on the curve.

> **The band is WEI and it is a live governance knob** — this chain has no USD oracle, so the operator retunes
> it as ETH moves. A launch client MUST read `factory.fdvBand()` rather than hardcode it, and can price a
> creator's choice with `factory.quoteFdvWei(supply, startTick)` (the exact value `launch` checks) or the
> `scripts/valuation.js` helper (`startTickForFdv`). `curveWidth` stays global, so every coin still graduates
> at the same multiple of its own launch price no matter what supply or valuation was chosen.

Full rationale, measurements and migration notes: `SUPPLY-AND-VALUATION.md`.

## 2b. Launch a CURVE pad + wire it (per coin)

The curve path (`CurvePadFactoryV4` → `RobinCurveV4` → graduation) is the flagship product and had **no
runbook section here at all**. Its wiring is five separate platform-held **one-shot** calls across three
contracts. None of them requires the others, and every one fails **silently** when missed — the money accrues
somewhere else, or to nobody, and nothing on chain complains.

| call | routes | if missed |
|---|---|---|
| `curve.setStaking(pool)` | graduation reservoir + sell-side LP fee | reservoir parks on the curve (`flushStaking()` retries) |
| `curve.setFloor(vault)` | **buy**-side LP carve | carve stays booked on the curve (`flushFloor()` retries) |
| `curve.setAmbush(vault)` | `ambushGradBps` slice of the raise | slice stays booked on the curve |
| `hook.setFloorRecipient(poolId, vault)` | **sell-tax** carve | **[M-7]** every sell's floor carve accrues to nobody; `claimFloor` reverts `NoFloorRecipient` |
| `lockVault.setStakingRecipient(lpTokenId, …)` | locked LP's token-leg fee | only needed if `setStaking` was missed before `graduate()` — see ordering below |

Two of these deserve their own line because they are the ones that used to be missing:

- **There are TWO independent floor wirings.** `curve.setFloor` routes the buy-side LP carve;
  `hook.setFloorRecipient` routes the sell-tax carve. Both are called "the floor", both are one-shot, and
  nothing on chain requires them to name the same address.
- **Order `setStaking` before `graduate()`.** `graduate()` copies `curve.staking` into
  `LockVault.registerLaunch` as the locked LP's token-leg fee recipient. Set it first and that wiring is
  correct and permanent. Set it after and the lock registers with `address(0)`; since **[M-11]**
  `claimStaking` reverts `NoStakingRecipient` in that state rather than silently paying the platform
  treasury, so the miss is loud — but repairing it needs the separate `setStakingRecipient` one-shot.
- **Set up the `DualStaking` pool itself.** After deploying the pad's `DualStaking` pool, `listReward` the
  token on the side the curve funds (this is done in `scripts/testnet-e2e-graduate.js`). Since **[L-2]**
  `DualStaking.fundTokenPushed` is permissionless when the asset is listed on a SINGLE side (the common pad —
  token listed once on the token side), the curve's `flushStaking()` push no longer needs the curve registered
  as a rewarder. Two exceptions still need `setRewarder(curve, true)`: `fundToken`/`fundETH` (the
  pull/`msg.value` paths), and an "earn the other" pad where the token is listed on BOTH sides (the push side is
  then caller-asserted, so only a trusted rewarder may resolve it).

Verify all five before you consider a pad live:

```bash
CURVE=0x… HOOK=0x… POOL_ID=0x… LOCK_VAULT=0x… LP_TOKEN_ID=… \
  npx hardhat run scripts/check-wiring.js --network robinhood
```

It is read-only and exits non-zero if anything is unset, so it can gate a deploy.

## 3. Run the revenue keeper (continuous)
```bash
# on the droplet, via pm2/cron, as the reward-keeper key:
PRIVATE_KEY=<keeper> ROBINHOOD_RPC=<rpc> npx hardhat run scripts/keeper.js --network robinhood
```
Sweeps every pad: collect LP fees → route quote→platform / token→staking, claim the 0.2% floor carve →
deploy into the wall → collect the wall's fees. **The keeper can only move already-owed funds to their
immutable destinations — it can never redirect or steal.** A compromised keeper key is a liveness risk, not
a theft risk.

> ### [R3-H5] REQUIRED keeper cadence — poke faster than `MAX_OBSERVED_GAP`
> `COMMIT_COOLDOWN` is now **65 min**, deliberately **greater than `MAX_OBSERVED_GAP` (60 min)** — that is the
> inequality that defeats the H-5 forced-fill (see `RobinFloorVault` `[R3-H5]` and
> `test/regression/H5.floor-forced-fill.test.js`). It has a direct operational consequence:
>
> **A keeper that pokes `addFloor` only once per `COMMIT_COOLDOWN` will NEVER commit the carve.** Each poke would
> land more than `MAX_OBSERVED_GAP` after the previous one, re-arming `belowSince` every time, so `MIN_DWELL` is
> never satisfied. **Poke every ~5-10 minutes** (comfortably inside the gap); commits then land once per
> cooldown, one `MAX_COMMIT_BPS` (20%) slice at a time — so a parked carve deploys over ~12h, not ~2h. That is
> the intended trade.
>
> Treat the floor poke as a **security control, not revenue plumbing**: a poke while the pad is dumped
> (`tick >= floorTickLower`) zeroes `belowSince` and denies an attacker the stale clock outright. Alert if
> `belowSince` ages. NOTE it is *not* a complete defence on its own — against a sustained-hold attacker the tick
> stays below the band, so pokes confirm the dwell instead of resetting it.

## Money model (per pad)
| | BUY (quote→token) | SELL (token→quote) |
|---|---|---|
| LP fee (locked seed LP) | → platform | → staking pool |
| 1% trade tax (hook) | → platform | → creator 0.8% + floor 0.2% |

- Holders earn by **staking** (no lock; claim fee = factory-set, shipped **0**, and the pad token is
  contract-exempt from it regardless — [R3-F1]). Any ERC20 can get a pool via `StakingFactory`.
- The floor is a **permanent, add-only** quote buy-wall — no remove path exists. [M-15] It is a FIXED band at the
  launch price, deepened while the token trades ABOVE it; in a sustained drawdown the carve parks rather than adding.
- Two live governance knobs (NOT one): `FeeWalletRegistry.platformFeeWallet` (Ownable2Step + 2-day timelock, and the
  [M-14] root-admin key that authorizes every per-pad wiring setter) AND `RobinV4FeeConfig.setDefaults` ([M-10]
  un-timelocked; governs fee + geometry for future launches and can reprice an open presale — [M-12]). Both multisig.

## Ground truth (Robinhood Chain, chainId 4663)
```
POOL_MANAGER     0x8366a39CC670B4001A1121B8F6A443A643e40951
POSITION_MANAGER 0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA
PERMIT2          0x000000000022D473030F116dDEE9F6B43aC78BA3
WETH             0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG (6dec)      0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```
Native quote = `address(0)` (always currency0). solc 0.8.26 / viaIR / runs 1 / cancun.
