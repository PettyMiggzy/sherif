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
| A5 | **Creator picks their CA ending, default `1ab5`** | ❌ **NOT BUILT ANYWHERE** | see BRAND below — this is the one I had wrong |
| A6 | Creator picks fee rate 1%–4% per side | ✅ | `TaxParams`; UI exposes it |
| A7 | No anti-snipe guard | ✅ | zero `GuardConfig`, pinned on a live fork |
| A8 | Anti-DoS launch (unpredictable token address) | ✅ | but see BRAND — it is what blocks A5 |

### BRAND (A5) — the correction

You want **creators to pick their own address ending, defaulting to `1ab5`**. Neither build does that:

- `pad-v4` **forces** `1ab5` on every coin. No choice, no override, deliberately no bypass. That is a *brand
  rule*, not a *creator feature* — and it is v4 anyway, so it does not ship next.
- `launchpad` v2 has **no suffix logic at all**, and *cannot* have any today: the factory builds the CREATE2
  salt itself from `block.number`/`block.timestamp`, so it is unmineable by design.

To get what you actually want, on the pad that ships:
1. Accept a caller-supplied `tokenSalt` in the launch params (this is the real change — it replaces the block
   entropy, which is safe because `LaunchTokenDeployer` already folds `msg.sender` into the salt and that is
   what defeats the pre-init DoS; FCFS removes the mempool race).
2. Enforce **only** that the address ends in the creator's chosen suffix — defaulting to `1ab5` when they do
   not pick one — rather than forcing one global value.
3. Mine it in the browser. `1ab5` alone is ~65k tries (~2s plain JS, far less with WASM keccak); each extra
   chosen hex character multiplies the work by 16, so cap the length (hood.dev caps at 6).

Decision needed: **is `1ab5` a floor or a default?** If every Robin coin must end in `1ab5` *and* creators may
extend it (e.g. `…ab1ab5`), impersonation stays visible. If a creator may replace it entirely, the brand signal
is gone. Those are different products; the code is easy either way.

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

1. **A5 brand** — not built anywhere in the form you want. Needs the decision above.
2. **A3/A4 supply + valuation** — built, unreachable. UI wiring.
3. **B2 reward vs A4** — pick: lift the FDV band floor so every launch still earns the full 0.5, or show the
   creator their real number.
4. **C4/C5 dead knobs** — the UI collects a fee allocation that the contract ignores. Either stop collecting it
   or restore the legacy path.
5. **B7 boost** — build it into the graduation runbook or soften the copy.
6. **D5 staking** — advertised nowhere and gated off, so not blocking; just know it is not live.
