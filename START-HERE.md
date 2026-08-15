# START HERE — `PettyMiggzy/sherif` (private working monorepo)

**Read this first.** Last updated: 2026-08-15.

> ## The Robin Labs launchpad orientation has moved.
>
> Everything about the launchpad product — what it is, the live contract addresses, the money model,
> $ROBIN staking, the docs layout, the public rules — now lives in the canonical public repo:
>
> ### **<https://github.com/Robinlabz/Labs> → `START-HERE.md`**
>
> Read that first. **This file covers only what is specific to this private working monorepo** and is
> *not* in Labs: the v4 rewrite, the bots, marketing/mobile, and the migration.

---

## 1. What this repo is

The private working monorepo for Robin Labs. It is **all one project** — every tracked directory here is
Robin Labs, including the `$SHERIFF`-branded ones (`launchpad/`, `bot/`, root `README.md`, `game/`), which
are the **old branding of the same project**, not separate projects.

This repo is **being consolidated into `Robinlabz/Labs`** (§4). Never point a third party — Uniswap,
launchers, docs, integrators — at `PettyMiggzy/sherif`. Always at `Robinlabz/Labs`.

## 2. Two generations — know which you are touching

| | **`launchpad/` — LIVE (v3)** | **`pad-v4/` — the V4 rewrite (NOT deployed)** |
|---|---|---|
| AMM | Uniswap **v3** (factory + pool only, no NPM/router on-chain) | Uniswap **v4** hooks |
| Status | **Deployed to mainnet** (v2.1, 2026-07-24) — see `LIVE_DEPLOYMENT.md` | Contracts + tests complete, **audit-pending**, not deployed |
| Core | `CurvePadFactory`, `PadRouter`, `FeeConfig`, `Bond`, `MilestoneVault`, `LiquidityLocker` | `CurvePadFactoryV4`, `RobinFeeHook`, `RobinCurveV4`, `LockVault`, `RobinFloorVault`, `RobinAmbushVault`, `DualStaking`, `PresaleVault` |
| Documented in | **Labs `START-HERE.md`** (live model, addresses) + `LIVE_DEPLOYMENT.md` | this file, §3 |
| Where recent work is | stable | **active — branch `claude/robinhood-chain-website-8loxcm`** |

**The live product is v3.** pad-v4 is the next-gen rewrite. **Their fee models diverge** — any fee sheet
must say which version it represents. The v3-live model is in Labs `START-HERE.md` §5; the v4 target is
below.

### Repo map — what is here that is NOT in Labs

```
pad-v4/       V4 rewrite ("pad of pads"). Contracts, 220 passing tests, audit docs. See §3.
bot/          $SHERIFF buy bot.                 burnbot/   buyback & burn bot.
launchbot/    Telegram launch bot.              marketing/ outreach kits, radar hitlist.
mobile/       app-store submission docs.        game/      "Catch-Dodge" meme mini-game (standalone).
assets/       brand art + favicons.             tools/     robin-radar.mjs.
sdk/          @robinlabs/pad-sdk.
```

`launchpad/`, `pad/`, `indexer/`, `docs/` also live here, and this copy is **ahead of the Labs snapshot**
(Labs is a 2026-07-17 snapshot predating the v2.1 deploy — see Labs `START-HERE.md` §8). `launchpad/AUDIT.md`
is **private** and must not be published.

Root docs: `LIVE_DEPLOYMENT.md` (live addresses + droplet runbook), `HANDOFF.md` (v3 brief), `CLAUDE.md`
(hard rules), `TELEGRAM_COMPLIANCE.md`, and this file.

## 3. pad-v4 — the v4 rewrite

**Products (all share the curve + fee engine):**
- **Normal** curve pad. **Presale** pad (`PresaleVault` — trustless refundable ETH presale, same curve after).
- **Stock** pad (`StockPadFactory`) — money side is a stock ERC-20; **disabled** (no live stock registry, H-2).
- **Arrow** (`contracts/arrow/`) — **migration launcher**. Dev brings ETH + a merkle root of their holders;
  in one tx: 0.5 ETH off top → platform, buy out the whole curve, graduate (LP locked), airdrop the bought
  supply to holders via a no-withdraw merkle distributor. **Dev ends holding zero tokens.** See `pad-v4/ARROW.md`.

**v4 money model — TARGET, not deployed** (diverges from v3-live; see §2):
- **Platform is ETH-only — never holds a pad token** (invariant, tested).
- Buy tax 1% (ETH, fee-on-input): 0.2% curve buffer → platform, 0.2% referrer (if ref link), rest → platform.
- Sell tax 1% (ETH output): 0.2% floor, 0.8% creator.
- LP fee 1%: **ETH leg → 100% platform**; **token leg → `RobinTokenTreasury` (70% staking / 30% creator-burn)**.
  Burn = **direct token burn** to `0x…dEaD` (the treasury already holds token, so no buyback swap), creator-gated.
- Graduation waterfall (of the raise, after keeper bounty `min(0.2%, 0.02 ETH)`): platform 10 / creator 10 /
  ambush 5 / locked LP ~75. Grad is permissionless + bounty-driven (auto in practice).
- Full economics: `pad-v4/ROBIN-V4-CURVE-ECON.md`.

**Built on branch `claude/robinhood-chain-website-8loxcm` (220 tests passing / 0 failing):**
1. Closed the platform-token leak in `RobinFloorVault` (platform is now ETH-only, invariant-tested).
2. Fee-model round 2: ETH LP → 100% platform (`buyLpFloorShareBps=0`); token LP → 70/30 via new
   `RobinTokenTreasury`; creator-triggered burn.
3. **Arrow** launcher + distributor + adversarial hardening tests.

**pad-v4 doc index:** `AUDITOR-HANDOFF.md` (remediation ledger — start §0), `AUDIT-SCOPE.md`, `DEPLOY.md`,
`ROBIN-V4-CURVE-ECON.md` (economics), `ROBIN-V4-ARCHITECTURE.md`, `ARROW.md`, `FLOOR-REDESIGN.md` (H-5 floor,
TWAP direction — deferred to external auditor).

## 4. The consolidation: `PettyMiggzy/sherif` → `Robinlabz/Labs`

**Intent:** move everything into the clean public `Robinlabz/Labs` repo and retire this mixed monorepo.
Scope is simple — **it's all Robin Labs**, so "move it all" = the whole 614-file tracked tree.

**Done so far:** the launchpad orientation (this file's former §1–§6) now lives in Labs as `START-HERE.md`.
The code itself has not moved — Labs still holds only its 2026-07-17 snapshot of `launchpad/`, `pad/`,
`indexer/`, `docs/`.

**How to run the rest** (a session locked to the `pettymiggzy` owner **cannot** push to `Robinlabz/Labs` —
the add-repo tool refuses cross-owner). Do the migration from a **fresh session rooted at `Robinlabz/Labs`**,
or via local git. Decisions still open when it runs:
- **Clean start (recommended)** — one "Import Robin Labs" commit — vs preserve full history.
- **What's in Labs already** — replace vs merge.
- **Scan for secrets before publishing** — Labs is **public**. Check for private keys, `.env`, API tokens in
  the tracked files before the first push. Do not republish any secret that ever sat in old history (favors
  clean start). Keep `launchpad/AUDIT.md` private.

## 5. Hard rules (from `CLAUDE.md` + operating constraints)

- **Canonical repo = `https://github.com/Robinlabz/Labs`.** Never hand anyone `PettyMiggzy/sherif`.
- **Never commit or echo secrets.** A compromised key must **not** be reused for mainnet.
- Work/commit/push on branch **`claude/robinhood-chain-website-8loxcm`**. Don't push elsewhere without permission.
- **Do not open PRs** unless explicitly asked.
- Keep the internal model identifier out of commits, PRs, code, and any pushed artifact (chat only).

## 6. Open threads (as of 2026-08-15)

1. **Subdomain wildcard** — verify/add `*.robinlabs.fun` in the pad's Vercel project. The `www` is live; the
   per-coin wildcard needs Vercel to hold the domain's nameservers for the wildcard SSL cert.
2. **Fee sheet** — a shareable fee-model artifact exists but reflects **v4-target**, not v3-live. Decide which
   version to publish (or show both) before handing to Uniswap/launchers. v4 economics are deliberately **not**
   published in the public Labs repo pending that call.
3. **v4 burn shape** — confirmed as direct token-burn (not a v3-style buyback); revisit only if the funding flips.
4. **The `sherif → Labs` migration** (§4) — the code move is still awaiting go + the clean-start/replace decisions.
5. **Refresh the Labs code snapshot to v2.1** — Labs' tracked `launchpad/` predates `FeeConfig` /
   `PlatformFeeSplitter` / `FloorCoop`, and its READMEs still say "let it ride". Flagged in Labs
   `START-HERE.md` §8; fixed properly by the migration.
6. **pad-v4 external audit** — Arrow's launcher is new audit surface (3-leg atomicity); route through the
   external auditor before mainnet. Floor H-5 TWAP redesign also deferred to the auditor.
