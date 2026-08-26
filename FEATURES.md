# Feature inventory — what exists, and is it ready

Check this list. Every row is verified against code or live chain, not against memory. **"Ready"** means a real
user can reach it today on the deploying build.

**Deploying next = the v2 curve pad (`launchpad/`).** `pad-v4/` is a separate, later deploy — anything marked
v4-only is NOT in what ships, however finished it is.

---

## A. The launch itself

| # | feature | ready? | notes |
|---|---|---|---|
| A1 | One-tx launch → real Uniswap v3 pool, trading live | ✅ | the core flow, fork-tested |
| A2 | Creator's atomic opening buy, **uncapped** | ✅ | inside the launch tx, ahead of everyone |
| A3 | **Creator picks supply** | ⚠️ **contract only** | `launchWithSupply` built + fork-tested; UI calls old `launch()`, no input, still says "fixed 1B" |
| A4 | **Creator picks launch valuation** | ⚠️ **contract only** | `startTickMag` + FDV band; same UI gap as A3 |
| A5 | **Every CA ends in `1ab5`** | ✅ | `PadBrand.requireBrand` on v3 and on all three v4 factories, with no flag and no bypass. v3's salt-less entrypoints revert `SaltRequired`. The site, the Telegram bot and the SDK all run the one shared miner (`launchpad/mine/robin-mine.mjs`, ~2.6s). Creators do NOT choose the ending: owner decision, it is a fixed brand |
| A6 | Creator picks fee rate 1%–4% per side | ✅ | `TaxParams`; UI exposes it |
| A7 | No anti-snipe guard | ✅ | zero `GuardConfig`, pinned on a live fork |
| A8 | Anti-DoS launch (unpredictable token address) | ✅ | superseded by A5: a mined address is predictable BY THE CREATOR, so the unpredictability is replaced by (a) the factory binding `msg.sender` into the salt, so only they can reach it, and (b) `CurvePool.seed()` repairing a squatted pool instead of dying on it |

### BRAND (A5) — done, and what it cost

The ending is a **rule**: every Robin coin address ends in `1ab5`, on v3 and on v4, enforced in the contract
rather than in the launch tooling. Creators do not pick it and cannot override it. An earlier draft of this
document asked whether `1ab5` was "a floor or a default" — that question is closed: it is neither, it is fixed.

How it holds:

1. **`PadBrand.requireBrand(token)`** runs inside `_launch` right after the token is deployed and before any
   pool, curve or transfer exists, so an unmined salt wastes gas and can never half-create a pad.
2. **The salt-less entrypoints revert `SaltRequired`.** `launch(p)` and `launchWithSupply(p, s, m)` used to
   derive a salt from `block.number`/`block.timestamp` — unmineable by design, so under the brand rule they
   had no reachable success case. They are kept only so the published ABI still resolves and an old caller
   gets a named error instead of a missing function. **This broke every existing caller**, which is why it
   ships with a new factory address and updated clients, not on its own.
3. **`tokenSalt` is NOT a field of `LaunchParams`.** That was tried and reverted: a fifth struct field moved
   the `launch` selector and broke the SDK, the launchbot, `pad/assets/config.js` and the published ABI. The
   salt arrives through additive entrypoints — `launchWithSalt(p, tokenSalt)` and
   `launchWithSupplyAndSalt(p, supply, startTickMag, tokenSalt)`.
4. **The salt is bound before it reaches CREATE2.** The original plan claimed a caller-supplied salt was safe
   "because `LaunchTokenDeployer` already folds `msg.sender` in". That is false and it was a critical: on the
   launch path `msg.sender` at the deployer is the FACTORY, one constant address for every creator, so the
   fold separates a direct caller of the public deployer from the factory and separates NOTHING between two
   creators. `p.dev` is not a `LaunchToken` constructor argument either, so the coin's address did not depend
   on who was launching it — anyone who saw a salt could take that address with themselves as dev. v3 binds
   `msg.sender`; the v4 factories bind the whole `LaunchConfig` (the presale vault is the caller there, and
   its address is not knowable when the creator mines).
5. **One miner, not four.** `launchpad/mine/robin-mine.mjs` is the only implementation of the three-keccak
   chain; the site and the bot get GENERATED copies (`node scripts/sync-miner.mjs`) because neither can import
   across directories, and `launchpad/test/miner-sync.test.js` fails if a copy drifts. A stale copy mines
   addresses the factory never reaches and the only symptom is launches reverting `BadTokenSuffix`.
6. **The init-code hash comes from the chain.** `LaunchTokenDeployer.tokenInitCodeHash()` — the contract that
   embeds the coin's creation code, so the hash is by construction the code it will deploy. Bundling that
   bytecode into the website would let the client drift from what is live with no visible symptom. This is
   why the v3 relaunch deploys a NEW `LaunchTokenDeployer` rather than reusing the live one.
7. **Re-mine on failure, never retry the same salt.** Nobody picks the ending, so no creator needs their
   address in advance; a failed launch should mine again. That is what keeps a squatted pool from being
   permanent.

See `AUDIT-PRESALE-FEE-AND-SALT.md` and commits 78c174c / 98a61ca before changing any of this.

## B. After graduation

| # | feature | ready? | notes |
|---|---|---|---|
| B1 | Graduation only at the full ceiling | ✅ | no early path, no timeout |
| B2 | **0.5 ETH to creator at graduation** | ⚠️ **conditional** | `min(0.5 ETH, raise/4)`. Needs raise ≥ 2 ETH. Collides with A3/A4 — at the band floor it pays ~0.03 ETH |
| B3 | 0.5 ETH to platform at graduation | ⚠️ same cap | same rule |
| B4 | Bond posted: locked LP + buy wall + sell wall | ✅ | no withdraw path anywhere |
| B5 | **Deep, un-farmable buy wall** | ✅ | 9000–15600 ticks; measured on a fork, live band +0.2299 vs shipped −0.0649 |
| B6 | Bond auto-recenters (`poke`) | ✅ | permissionless, TWAP-guarded |
| B7 | **DexScreener update + 10× boost** | ❌ **no code at all** | manual promise, advertised as automatic, never tested |

## C. Money

| # | feature | ready? | notes |
|---|---|---|---|
| C1 | Swap fee split 45% platform / 45% creator / 10% floor | ✅ live | from `FeeConfig.swapSplit()`, both sides |
| C2 | LP fee split 10% creator / 90% platform | ✅ live | `lpCreatorBps = 1000` |
| C3 | Escrowed payouts (a trade can never revert on a payout) | ✅ | separate permissionless flushers |
| C4 | Creator allocation: wallet / floor / burn | ❌ **dead** | accepted and validated, then **ignored** — the FeeConfig branch overrides it |
| C5 | Platform buy-back cut on above-default fees | ❌ **dead** | same reason: legacy branch, `feeConfig` is set |

## D. Beyond the pad — other things in the repo

| # | feature | state |
|---|---|---|
| D1 | Swap / Bridge / Migrate / Airdrop (Disperse) / Portfolio | live pages, contracts set |
| D2 | Rewards (trader + diamond-hand ETH legs) | live — `rewardVault` deployed |
| D3 | Limit orders / DCA (`RobinLimit`) | live — `robinLimit` deployed |
| D4 | Dev-bag vesting lock | live — `tokenVestingLock` deployed |
| D5 | **Staking ($ROBIN + per-coin)** | ❌ **not deployed** — `stakingFactory`, `robinStaking`, `rewardConverter` all unset; UI gated off |
| D6 | Platform fee splitter | live — `splitter` deployed |
| D7 | **User-added locked LP (FloorCoop)** | ❌ **removed on your call** — pages deleted, config unset |
| D8 | **Telegram launch bot (custodial)** | built; holds user keys. See SEC-1 in `AUDIT-FINAL.md` |
| D9 | Buy bot / burn bot / indexer | built, operational tooling |
| D11 | **DEX trending service (10% fee)** | ❌ **not built** — see BOT below |
| D12 | **DEX volume service (10% fee)** | ❌ **not built** — see BOT below |
| D10 | AthVault, MilestoneVault, OtcVault, FeeRouter, SheriffStaking, RobinZap, RobinSwap, RobinStockSwap | **contracts exist, not wired into the pad or the site** — dormant code |

## E. Not shipping (v4 only)

Curve pad v4, seed-LP pad, **Turbo/Arrow**, presale vault, stock pad (fail-closed), dual staking, floor vault,
ambush vault, token treasury, `PadBrand`.

---

### BOT (D11/D12) — the trending + volume service has no code

`bot/` is a **read-only Telegram buy-alerts bot** for $SHERIFF on ape.store. Its own header: *"Reads the public
ape.store API and posts messages — no keys, no funds."* It **reports** volume (`/vol` reads recent trades); it
cannot generate any. There is no trending purchase, no volume engine, and **no 10% fee anywhere in the repo**.

To offer this as a paid product you need, and do not have: a funded wallet the bot can trade from, a fee
mechanism to take the 10%, per-customer accounting, and a kill switch. None of that is the alerts bot.

**Two separate things, worth keeping separate:**
- **Trending / boosts** — buying promotion. Ordinary advertising, no issue.
- **Volume generation** — trading with yourself to inflate the number. This is wash trading: most jurisdictions
  treat it as market manipulation, and DexScreener and the aggregators ban it and delist for it. Flagged once;
  you've said it's the product, so it's your call and I've stopped arguing. But do not put it in the *song* —
  a lyric is a permanent public advertisement of it, and it is the single easiest thing to get delisted over.
  Sell it privately if you sell it.

## What is actually blocking

1. ~~**A5 brand**~~ — done. Contract-enforced on v3 and v4, and mined by the site, the bot and the SDK. It
   ships with a NEW factory AND a new `LaunchTokenDeployer`, and the clients must be repointed at the same
   time: every one of them reverts against the new factory until it is.
2. **A3/A4 supply + valuation** — built, unreachable. UI wiring. Note the salted entrypoint is
   `launchWithSupplyAndSalt` now, not `launchWithSupply`.
3. **B2 reward vs A4** — pick: lift the FDV band floor so every launch still earns the full 0.5, or show the
   creator their real number.
4. **C4/C5 dead knobs** — the UI collects a fee allocation that the contract ignores. Either stop collecting it
   or restore the legacy path.
5. **B7 boost** — build it into the graduation runbook or soften the copy.
6. **D5 staking** — advertised nowhere and gated off, so not blocking; just know it is not live.
