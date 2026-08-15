# START HERE — Robin Labs orientation

**Read this first.** It's the single map of everything in this repo: what's live, what's being built,
the money model, the open threads, and the rules. If you're a new session, start at the top and follow the
pointers. Last updated: 2026-08-15.

---

## 1. What this is

**Robin Labs** — a creator-first **memecoin launchpad on Robinhood Chain** (Arbitrum Orbit L2, EVM,
**chainId 4663**). One-tx launches into a real Uniswap pool, a bonding curve, a **ceiling-only graduation at
~4.2 ETH** (creator gets **0.5 ETH** at grad), a permanently-locked protocol floor, and holder staking.

- **Formerly branded `$SHERIFF`** (Sheriff of Nottingham theme). The `$SHERIFF`-named folders/files
  (`launchpad/`, `bot/`, root `README.md`, `game/`) are the **old branding of the same project**, not separate
  projects. Everything in this repo is Robin Labs.
- **Canonical public repo: <https://github.com/Robinlabz/Labs>.** This repo (`PettyMiggzy/sherif`) is the
  private working monorepo and is **being consolidated into Labs** (see §7). Never point third parties (Uniswap,
  launchers, docs) at `PettyMiggzy/sherif` — always at `Robinlabz/Labs`.

## 2. Two generations — know which you're touching

| | **`launchpad/` — LIVE (v3)** | **`pad-v4/` — the V4 rewrite (NOT deployed)** |
|---|---|---|
| AMM | Uniswap **v3** (factory+pool only, no NPM/router on-chain) | Uniswap **v4** hooks |
| Status | **Deployed to mainnet** (v2.1, 2026-07-24) — see `LIVE_DEPLOYMENT.md` | Contracts + tests complete, **audit-pending**, not deployed |
| Core | `CurvePadFactory`, `PadRouter`, `FeeConfig`, `Bond`, `MilestoneVault`, `LiquidityLocker` | `CurvePadFactoryV4`, `RobinFeeHook`, `RobinCurveV4`, `LockVault`, `RobinFloorVault`, `RobinAmbushVault`, `DualStaking`, `PresaleVault` |
| Where recent work is | stable | **active — branch `claude/robinhood-chain-website-8loxcm`** |

**The live product is v3.** pad-v4 is the next-gen rewrite. Don't confuse their fee models (§5).

## 3. Repo map (all tracked dirs — 614 files; the 691M is gitignored `node_modules`/artifacts)

```
launchpad/    LIVE v3 protocol — Solidity + Hardhat. $SHERIFF-named, IS Robin Labs. AUDIT.md is private.
pad-v4/       V4 rewrite ("pad of pads"). Contracts, 220 passing tests, audit docs. See pad-v4/START below.
pad/          Static frontend — robinlab.io / *.robinlabs.fun coin sites. website.html = claim-a-site form.
indexer/      Node indexer + JSON API (api.robinlab.io). Powers the feed + coin-site data + slug moderation.
docs/         GitBook/Mintlify docs.
sdk/          @robinlabs/pad-sdk.
bot/          $SHERIFF buy bot (Robin Labs).      burnbot/  Robin Labs buyback&burn bot.
launchbot/    Robin Labs Telegram launch bot.     marketing/ outreach kits, radar hitlist.
mobile/       app-store submission docs.           game/     tiny "Catch-Dodge" meme mini-game (standalone).
assets/       brand art + favicons.                tools/    robin-radar.mjs.
```

Root docs: `LIVE_DEPLOYMENT.md` (live addresses), `HANDOFF.md` (v3 brief), `CLAUDE.md` (hard rules),
`TELEGRAM_COMPLIANCE.md`, and this file.

## 4. Live infrastructure

- **Contracts (mainnet, chainId 4663):** addresses + Blockscout links in `LIVE_DEPLOYMENT.md` (v2.1,
  deployed 2026-07-24). Owner = cold wallet `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf`.
- **Site:** Vercel auto-deploys `pad/` to **www.robinlab.io / www.robinlabs.fun** on every push to this repo.
- **Coin sites:** each launched coin can claim **`<slug>.robinlabs.fun`** (creator connects wallet at
  `robinlab.io/website.html?c=<coin>`, picks a style + slug, signs once). One wildcard covers all — see
  `pad/templates/coin-site/README.md`. **Open item:** confirm the `*.robinlabs.fun` wildcard domain is added in
  the pad's Vercel project (the `www` is live; the per-coin wildcard needs Vercel to hold the domain's
  nameservers for the wildcard SSL cert).
- **Indexer/API:** `api.robinlab.io` (see `indexer/`).

## 5. The money model — v3 LIVE vs v4 TARGET (they DIVERGE)

**These are different. Any fee sheet must say which it represents.**

**v3 — LIVE on mainnet today** (all owner-tunable via `FeeConfig`, no redeploy):
- LP fee (1% pool, every trade) → **platform 90% / creator 10%**.
- Swap-desk fee (router cut) → **platform 45% / creator 45% / floor 10%**.
- Graduation: ceiling-only **4.2 ETH**, **creator 0.5 ETH** at grad.
- Burn: `MilestoneVault` — 30% treasury, TWAP-gated tranche sells (2x/3x…), **dev-triggered buyback**
  (holds WETH → swaps to token → burns to `0x…dEaD`), 50% dev / 50% buyback split.

**v4 — TARGET (built this session in `pad-v4/`, not deployed):**
- **Platform is ETH-only — never holds a pad token** (invariant, tested).
- Buy tax 1% (ETH, fee-on-input): 0.2% curve buffer→platform, 0.2% referrer (if ref link), rest→platform.
- Sell tax 1% (ETH output): 0.2% floor, 0.8% creator.
- LP fee 1%: **ETH leg → 100% platform**; **token leg → `RobinTokenTreasury` (70% staking / 30% creator-burn)**.
  Burn = **direct token burn** to `0x…dEaD` (the treasury already receives token, so no buyback swap), creator-gated.
- Graduation waterfall (of the raise, after keeper bounty `min(0.2%, 0.02 ETH)`): platform 10 / creator 10 /
  ambush 5 / locked LP ~75. Grad is permissionless + bounty-driven (auto in practice).
- Full economics: `pad-v4/ROBIN-V4-CURVE-ECON.md`.

## 6. pad-v4 — the launchers & this session's work

**Products (all share the curve + fee engine):**
- **Normal** curve pad. **Presale** pad (`PresaleVault` — trustless refundable ETH presale, same curve after).
- **Stock** pad (`StockPadFactory`) — money side is a stock ERC-20; **disabled** (no live stock registry, H-2).
- **Arrow** (`contracts/arrow/`) — **migration launcher**. Dev brings ETH + a merkle root of their holders;
  in one tx: 0.5 ETH off top → platform, buy out the whole curve, graduate (LP locked), airdrop the bought
  supply to holders via a no-withdraw merkle distributor. **Dev ends holding zero tokens.** See `pad-v4/ARROW.md`.

**Built this session (branch `claude/robinhood-chain-website-8loxcm`, 220 tests passing / 0 failing):**
1. Closed the platform-token leak in `RobinFloorVault` (platform is now ETH-only, invariant-tested).
2. Fee-model round 2: ETH LP → 100% platform (`buyLpFloorShareBps=0`); token LP → 70/30 via new
   `RobinTokenTreasury`; creator-triggered burn.
3. **Arrow** launcher + distributor + adversarial hardening tests.

**pad-v4 doc index:** `AUDITOR-HANDOFF.md` (remediation ledger — start §0), `AUDIT-SCOPE.md`, `DEPLOY.md`,
`ROBIN-V4-CURVE-ECON.md` (economics), `ROBIN-V4-ARCHITECTURE.md`, `ARROW.md`, `FLOOR-REDESIGN.md` (H-5 floor,
TWAP direction — deferred to external auditor).

## 7. The consolidation: `PettyMiggzy/sherif` → `Robinlabz/Labs`

**Intent:** move everything into the clean public `Robinlabz/Labs` repo and retire the confusing mixed monorepo.
Scope is simple — **it's all Robin Labs**, so "move it all" = the whole 614-file tracked tree.

**How to run it (a session locked to the `pettymiggzy` owner CANNOT push to `Robinlabz/Labs`** — the add-repo
tool refuses cross-owner). Do the migration from a **fresh session rooted at `Robinlabz/Labs`**, or via local git.
Decisions still open when it runs:
- **Clean start (recommended)** — one "Import Robin Labs" commit — vs preserve full history.
- **What's in Labs already** (last push 2026-08-02) — replace vs merge (can't see it from a sherif-locked session).
- **Scan for secrets before publishing** — Labs is **public**. Check for private keys, `.env`, API tokens in the
  tracked files before the first push. Do not republish any secret that ever sat in old history (favors clean start).

## 8. Hard rules (from `CLAUDE.md` + operating constraints)

- **Canonical repo = `https://github.com/Robinlabz/Labs`.** Never hand anyone `PettyMiggzy/sherif`.
- **Never commit or echo secrets.** A compromised key must **not** be reused for mainnet.
- Work/commit/push on branch **`claude/robinhood-chain-website-8loxcm`**. Don't push elsewhere without permission.
- **Do not open PRs** unless explicitly asked.
- Keep the internal model identifier out of commits, PRs, code, and any pushed artifact (chat only).

## 9. Open threads (as of 2026-08-15)

1. **Subdomain wildcard** — verify/add `*.robinlabs.fun` in the pad's Vercel project (§4).
2. **Fee sheet** — a shareable fee-model artifact exists but reflects **v4-target**, not v3-live. Decide which
   version to publish (or show both) before handing to Uniswap/launchers.
3. **v4 burn shape** — confirmed as direct token-burn (not a v3-style buyback); revisit only if the funding flips.
4. **The `sherif → Labs` migration** (§7) — awaiting go + the clean-start/replace decisions.
5. **pad-v4 external audit** — Arrow's launcher is new audit surface (3-leg atomicity); route through the
   external auditor before mainnet. Floor H-5 TWAP redesign also deferred to the auditor.
