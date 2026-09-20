# v3 pad — deploy runbook

**v3 is a THIRD factory deployed alongside the two that are already live, not a replacement.** The v1 and v2
factories keep running and every coin launched on them keeps trading, untouched. Nothing here migrates,
pauses, or rewrites anything that exists — a coin's fee config is register-once per router (`AlreadySet`), so
the coins on the older routers could not be moved even if we wanted to.

It ships as the same `scripts/deploy-v2.js` that stood v2 up. That script deploys whatever
`contracts/CurvePadFactory.sol` currently is, and what that is now is the v3 round. (The script's name
undersells what it does at this point — it has now stood up three generations — but renaming it is a
separate change from this runbook.)

## What v3 adds over the live v2 factory

| | |
|---|---|
| **Daily auction** | `auctionDays` 1–4 carves 10% of the curve's share per day into sealed-bid daily tranches (`DailyAuctionVault`). **NOT ENABLED on this deploy — see below.** |
| **Creator-chosen LP fee tier** | `poolFee` 500 or 10000. `0` keeps the old default (10000). |
| **Creation fee** | 0.001 ETH, mandatory on every launch, burned into the curve as a real seed buy so a coin is never underwater the instant it goes live. |

The live v2 factory (`0xD41479DE442366e0358Fd74Bf4a5911eBbF3055A`) predates all three. It has no
`setAuctionVaultDeployer` and no `auctionDays` in its `LaunchParams` — there is no setter to call and no
migration to run.

## The auction is deliberately OFF on this deploy

An adversarial audit of `DailyAuctionVault.sol` (240 lines, custodies bidder ETH) found **6 HIGH-severity
findings**, none fixed:

- `closeDay()` reverts Uniswap's `SPL` forever once the pool's spot price sits at or past the graduation
  ceiling — and that state is the *designed outcome* of the vault's own burn-buy on day 1 of any 2+ day
  auction, or of ordinary post-graduation trading on any coin that succeeds. There is no owner, sweep,
  deadline or force-settle in the contract, so the day's bidders and its token tranche are frozen with no
  rescue path.
- The burn-buy is an unprotected, sandwichable market order, and `closeDay` is permissionless — an attacker
  can buy, close, and sell in one transaction of their own.
- No reserve price: a sole 1-wei bid in the window's final block takes the entire day's tranche.
- A capped day's unspent ETH is paid to the platform instead of refunded to the bidders who supplied it.
- The lazily-deployed zero-bid-day `RobinStaking` pool can be atomically first-staked, for dust, by whoever
  calls `closeDay` — before its address is discoverable by anyone else.

Because of this, `scripts/deploy-v2.js` **does not deploy `RobinStakingDeployer` or
`DailyAuctionVaultDeployer` at all** unless `DEPLOY_AUCTION=true` is explicitly set. Left unset (the
default), `auctionVaultDeployer` stays at `address(0)` on the new factory and `auctionDays > 0` reverts
`BadValue`, same as the live v1 factory today. **Do not set `DEPLOY_AUCTION=true` until the vault above is
fixed and re-audited.**

What ships tonight, with the auction off, is the creation fee and the creator-chosen LP fee tier — real
changes over the live v2 factory, just not the auction.

## Before you spend gas

**The deploying key does NOT need to be any existing owner.** The router this script deploys is owned by the
deploying key at construction and only handed to the real owner at the end (step 6 of the printed NEXT
list), so the deploy itself always succeeds from any funded key.

**What DOES need the real owner is the factory's owner-only setters** — `setFdvBand` (only relevant if you
pass `MIN_FDV_ETH`/`MAX_FDV_ETH`) and, if `DEPLOY_AUCTION=true`, `setAuctionVaultDeployer`. The script
resolves the owner itself, in order: `OWNER=` env if you pass it, else the live v1 router's own `owner()`
read directly on-chain, else (only if that read fails, e.g. rehearsing on a devnet) `deploy.json`'s `owner`
field. **If that resolves to `0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8` — the hot deployer key search
turned up nothing recoverable for, see the repo's `LIVE_DEPLOYMENT.md` — the script refuses to proceed.**
Constructing anything `Ownable` to that address would strand its setters exactly the way the live v2
factory's already are. The real current owner is the cold wallet, `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf`
— that is what the script's on-chain lookup will resolve to by default; pass `OWNER=` explicitly only if you
want a different key to own this generation.

**Cost.** Measured on a devnet rehearsal of the current script (auction off): total deployment gas is lower
than the earlier auction-inclusive measurement, since `RobinStakingDeployer`/`DailyAuctionVaultDeployer` are
no longer deployed. At the base fee observed on chain this comes in well under 0.01 ETH including generous
headroom. See `AUDIT-V3.md` / the commit history for the exact number from the most recent rehearsal.

## Deploy

```bash
cd launchpad
PRIVATE_KEY=<any funded key — see "Before you spend gas" above> npx hardhat run scripts/deploy-v2.js --network robinhood
```

It writes `deploy.v{N}.json`, where `N` is one past the highest `deploy.vN.json` already on disk — so a real
run can never overwrite an earlier generation's tracked manifest, however many times this script gets reused.
It prints a numbered NEXT list with the real addresses filled in; follow that list, not this document — it is
generated from what actually deployed. `DEPLOY_V2_OUT=<path>` redirects the manifest entirely if you are
rehearsing and do not want any tracked file touched.

Two things the script wires automatically that used to be manual or missing:

- **`router.setFeeConfig`** — without this, the new router silently falls back to the legacy platform/creator
  split and the Bond floor gets 0% of trade fees instead of the advertised 10%. This shipped broken once
  already (verified on-chain: the live v2 router's `feeConfig()` reads the zero address). The script now
  calls it and asserts the read-back before moving on.
- **Reward legs (0.25% trader + 0.25% holder) stay OFF** — `setRewardVault` is never called, which the router
  treats as "skip the leg, charge nothing" (safe). The manifest records this as a deliberate decision. Do
  not repoint this router at the existing live `RewardVault` — its `router` is immutable to whichever router
  registered first, so `accrue` would revert and the try/catch around it would swallow that silently, meaning
  the legs would be charged and never paid out. A real reward vault for this generation is separate work.

## After it lands

1. **`wire-staking.js`** — the script now looks up the live `RobinTierStakingFactory` (from
   `pad/assets/config.js`) and its wired `feeder()` live on-chain, and prints the command with
   `TIER_STAKING_FACTORY=`/`STAKING_FEEDER=` already filled in. Run it as printed — running it with those
   unset deploys a SECOND staking factory, feeder, and flagship `$ROBIN` pool.
2. **`pad/assets/config.js`** — set `padFactory` to the new factory and fill the **first empty**
   `padRouterN` slot with the new router. Do not overwrite a filled one: each generation's router keeps its
   own coins forever, so overwriting a slot does not migrate those coins, it strands them. The script names
   the correct slot for you. A brand-new slot also needs its ABI entry in `config.js` and its name added to
   `ROUTER_TIERS` in `pad/assets/wallet.js`.
3. **The indexer**, on the droplet. `indexer/src/config.js` defaults to a hardcoded factory/router pair and
   takes `FACTORIES` / `ROUTERS` / `STAKING_ROUTER` as comma-separated overrides. **Add** the new addresses,
   do not replace: the script's printed list is now the union of every generation it can find a manifest
   for, not just the newest two, so paste it whole. `Launched` is emitted by the factory that did it, so a
   factory missing from that list means the coin never appears on browse, `recordOf` returns a zero dev for
   it and fails the creator gate, and its router-routed trades are credited to a contract address instead of
   the trader. `STAKING_ROUTER` is single-valued and drives the fee sweeper — with multiple staking-capable
   routers live, it can only target one.
4. **Verify on Blockscout:** `node scripts/verify-sourcify.cjs`.

## What this was checked against

Rehearsed end to end on a local devnet from this branch, running the real `scripts/deploy-v2.js` verbatim
against a `npx hardhat node` (not hardhat test's in-process chain), then `scripts/verify-v2-deploy-e2e.js`
against what it deployed. See the branch's commit history for the exact pass count and gas figures from the
most recent rehearsal — this file describes the procedure, not a snapshot of one run's numbers.

The launchpad suite (`npx hardhat test`) is required to be green before any real deploy; check the most
recent run rather than trusting a number written into this document, since it will go stale the moment
either changes.

What a devnet rehearsal does **not** cover: the real chain. Robinhood Chain's per-tx gas cap, its base fee,
and the live WETH / Uniswap v3 factory are the three things a devnet substitutes for.
