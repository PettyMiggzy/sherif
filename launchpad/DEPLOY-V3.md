# v3 pad — deploy runbook

**v3 is a THIRD factory deployed alongside the two that are already live, not a replacement.** The v1 and v2
factories keep running and every coin launched on them keeps trading, untouched. Nothing here migrates,
pauses, or rewrites anything that exists — a coin's fee config is register-once per router (`AlreadySet`), so
the coins on the older routers could not be moved even if we wanted to.

It ships as the same `scripts/deploy-v2.js` that stood v2 up. That script deploys whatever
`contracts/CurvePadFactory.sol` currently is, and what that is now is the v3 round.

## What v3 adds over the live v2 factory

| | |
|---|---|
| **Daily auction** | `auctionDays` 1–4 carves 10% of the curve's share per day into sealed-bid daily tranches (`DailyAuctionVault`). A bid day pays the platform a flat 10% and spends the rest on a real burn-buy against the curve's pool; a zero-bid day lazily deploys a `RobinStaking` pool and sends that day's tranche there instead. |
| **Creator-chosen LP fee tier** | `poolFee` 500 or 10000. `0` keeps the old default (10000). |
| **Creation fee** | 0.001 ETH, mandatory on every launch, burned into the curve as a real seed buy so a coin is never underwater the instant it goes live. |

The live v2 factory (`0xD41479DE442366e0358Fd74Bf4a5911eBbF3055A`) predates all three. It has no
`setAuctionVaultDeployer` and no `auctionDays` in its `LaunchParams` — there is no setter to call and no
migration to run. **A new factory is the only way to get an auction.**

## Before you spend gas

**Deploy from the factory owner's key.** `deploy-v2.js` constructs the factory already owned by
`deploy.json`'s `owner` and *then* calls `setAuctionVaultDeployer` on it. That call is `onlyOwner`, so it only
lands when the deploying key genuinely is that owner. Deploy from any other key and the script still succeeds,
loudly reports the feature OFF, and **every `auctionDays > 0` launch reverts `BadValue` until the owner makes
that one call by hand.** That is exactly the trap the live v1 deploy fell into.

The owner on record is `0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8`. If you want to deploy from a different
key, pass `OWNER=<that key's address>` and the whole stack comes up owned by it, auction included.

**Cost.** Measured on a devnet rehearsal of this exact script: **18,388,722 gas** across 7 transactions
(the largest is 3.55M, well inside the chain's ~16.7M per-tx cap). At the base fee observed on chain that is
well under 0.01 ETH including generous headroom; a first launch with a 4-day auction adds ~15M gas plus the
0.001 ETH creation fee.

## Deploy

```bash
cd launchpad
PRIVATE_KEY=<the owner key> npx hardhat run scripts/deploy-v2.js --network robinhood
```

It writes `deploy.v2.json` and prints a numbered NEXT list with the real addresses filled in. Follow that
list — it is generated from what actually deployed, and this document is the explanation, not the source of
truth. `DEPLOY_V2_OUT=<path>` redirects the manifest if you are rehearsing and do not want the tracked one
touched.

The one line to check before anything else:

```
factory.setAuctionVaultDeployer(0x…) — auction feature ON
```

If it says **NOT CALLED** instead, stop and fix the key before launching anything.

## After it lands

1. **`wire-staking.js`** with `ROUTER=` the new router — it makes all five connections and reads each back.
2. **`pad/assets/config.js`** — set `padFactory` to the new factory and fill the **first empty**
   `padRouterN` slot with the new router. Do not overwrite a filled one: each generation's router keeps its
   own coins forever, so overwriting a slot does not migrate those coins, it strands them. The script names
   the correct slot for you. A brand-new slot also needs its ABI entry in `config.js` and its name added to
   `ROUTER_TIERS` in `pad/assets/wallet.js`.
3. **The indexer**, on the droplet. `indexer/src/config.js` defaults to a hardcoded factory/router pair and
   takes `FACTORIES` / `ROUTERS` / `STAKING_ROUTER` as comma-separated overrides. **Add** the new addresses,
   do not replace: `Launched` is emitted by the factory that did it, so a factory missing from that list
   means the coin never appears on browse, `recordOf` returns a zero dev for it and fails the creator gate,
   and its router-routed trades are credited to a contract address instead of the trader. `STAKING_ROUTER` is
   single-valued and drives the fee sweeper — with two staking-capable routers live, it can only target one.
4. **Verify on Blockscout:** `node scripts/verify-sourcify.cjs`.

## What this was checked against

Rehearsed end to end on a local devnet from this branch, running the real `scripts/deploy-v2.js` verbatim
against a `npx hardhat node` (not hardhat test's in-process chain), then `scripts/verify-v2-deploy-e2e.js`
against what it deployed: **43/43 checks passed** — a real launch at `poolFee` 500 with `auctionDays` 2
paying the creation fee, the `1ab5` brand suffix, two real bidders, `closeDay` splitting the platform's flat
10% and doing a burn-buy that genuinely moved the pool tick, a pro-rata claim, a zero-bid day that lazily
deployed and funded a `RobinStaking` pool, and graduation paying both the creator's and the platform's
`GRAD_REWARD`. The launchpad suite is **360 passing, 0 failing**.

What that does **not** cover: the real chain. Robinhood Chain's per-tx gas cap, its base fee, and the live
WETH / Uniswap v3 factory are the three things a devnet substitutes for, and a launch with a 4-day auction
was measured at ~14.98M against a ~16.7M cap — real, but not a wide margin. Launch with a smaller
`auctionDays` first if you want the margin.
