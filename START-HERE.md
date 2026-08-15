# START HERE — Robin Labs orientation

**Read this first.** It's the single map of everything in this repo: what's live, what's being built,
the money model, the open threads, and the rules. If you're a new session, start at the top and follow the
pointers. Last updated: 2026-08-15.

---

## 1. What this is

**Robin Labs** — a creator-first **memecoin launchpad on Robinhood Chain** (Arbitrum Orbit L2, EVM,
**chainId 4663**). One-tx launches into a real Uniswap pool, a bonding curve, a **ceiling-only graduation at
~4.2 ETH** (creator **and** platform each get **0.5 ETH** at grad), a permanently-locked protocol floor, and holder staking.

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
| Core | `CurvePadFactory`, `CurvePool`, `PadRouter`, `FeeConfig`, `Bond`, `FloorCoop`, `RewardVault` | `CurvePadFactoryV4`, `RobinFeeHook`, `RobinCurveV4`, `LockVault`, `RobinFloorVault`, `RobinAmbushVault`, `DualStaking`, `PresaleVault` |
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

**These are different. Any fee sheet must say which it represents. The FULL contract-verified numbers (with
`file:line` for every value) live in [`ECONOMICS-VERIFIED.md`](./ECONOMICS-VERIFIED.md) — the single source of
truth; the summaries below are the headline only.**

**v3 — LIVE on mainnet today** (the `CurvePadFactory` / `CurvePool` / `Bond` / `FloorCoop` family). Verified
against the deployed contracts — **`MilestoneVault` / `AthVault` are NOT deployed** (earlier `$SHERIFF` design):
- **Supply split at launch:** **75% curve / 25% Bond Ambush** (`AMBUSH_BPS = 2500`); zero platform/dev premine.
- **Per-launch trade tax:** dev-chosen **1%–4% per side** (1% floor, 4% cap). The mandatory **base 1% goes to the
  PLATFORM on buys** (0.9% now + 0.1% released at grad) and **to the CREATOR on sells**; any tax **above 1%** splits
  **25% platform / 75% project**, and the project 75% is split wallet / Bond-floor / **buy-and-burn** (`burnBps` →
  `flushBurn` *buys the token with the escrowed ETH and sends it to `0x…dEaD`* — a real buy-and-burn, not a token
  skim). Read `configOf(token)` per coin; do NOT quote one protocol-wide tax.
- **Platform fee splits** (owner-tunable via `FeeConfig`): LP swap fees → **90% platform / 10% creator**; the
  configurable swap-desk split (when wired) → **45% platform / 45% creator / 10% floor**. Plus **+0.25%/side reward
  legs** (buy→trader pool, sell→holder pool) to `RewardVault`, off until wired.
- **Graduation:** ceiling-only ~**4.2 ETH**; **0.5 ETH to creator AND 0.5 ETH to platform** (each capped `raise/4`);
  the **Bond** posts the rest as **Sherwood (60% full-range LP) + Bounty (40% WETH buy wall) + Ambush (token sell
  wall)**, locked forever.
- **Staking / LP-deepening:** `FloorCoop` (locked-LP staking, 10% deposit fee, 5% of fees, 30/60/90/365/forever
  locks, 1–3× weight, 15%→45% scaled early-exit penalty) and `RewardVault` ($ROBIN).

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

## 7. Executable handoff — every open item, with exact steps (nothing lives only in chat)

Ordered by urgency. **Constraint that shapes all of this:** a session locked to the `pettymiggzy` owner CANNOT
push to `Robinlabz/Labs` (the add-repo tool refuses cross-owner adds). Anything touching Labs must run from a
**session rooted at `Robinlabz/Labs`** or from local git with both remotes.

### A. Correct the PUBLIC Labs repo NOW — 3 fixes (independent of the code migration)

The public `Robinlabz/Labs` tree is a **stale snapshot (2026-07-17, before the 07-24 v2.1 deploy)** and currently
publishes wrong, dangerous facts. Apply from a Labs-rooted session. (Sherif side already corrected in
`LIVE_DEPLOYMENT.md` + this file — commit `1dabf0b`.)

**Fix 1 — Graduation reward is BOTH legs** (Labs `START-HERE.md` + any README stating it). Find the line saying the
creator gets 0.5 ETH (creator only); replace with:
> At graduation, `GRAD_REWARD` pays **0.5 ETH to the creator AND 0.5 ETH to the platform** (each capped at
> `raise/4`), and the Bond floor keeps the remainder (≥50% of the raise, ~3.2 ETH). Verified in
> `CurvePool.graduate()`: `reward = min(GRAD_REWARD, raisedWeth/4); raisedWeth -= 2*reward; transfer(dev, reward);
> transfer(platform, reward);`

**Fix 2 — Factory address + table** (root `README.md`, `launchpad/README.md`). Replace the old factory
`0xc208e3…` → `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074`, and make the address table match `launchpad/deploy.json`
exactly (three are missing from the stale tree — `feeConfig`, `platformSplitter`, `floorCoopFactory`):

| Contract | Address |
|---|---|
| padFactory (CurvePadFactory) | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` |
| padRouter | `0xA6BaAB820809C7fC8350311776627298f91F07eC` |
| feeConfig | `0x064D977B66FCC29256510dBCD8cC0C51bBb2De14` |
| floorCoopFactory | `0x564EDF561Bed46C972d5D44D84f5FAc9C5118668` |
| platformSplitter | `0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a` |
| rewardVault | `0x03d5d26E492B288e62D897E7dde91af3CceB4347` |
| launchTokenDeployer | `0xb3748cB6ba4e47b885f8333aCa8C004A4657383d` |
| curvePoolDeployer | `0x020524511aD8B99828b19DA0FD3Bb7BE919A080c` |
| bondDeployer | `0x8B04d9e55C904d6D371eA6e81ecb2a0911843AD3` |
| tokenVestingLock | `0x7453856c3E5f6832dc660e48c7Daa6f46f3355DF` |

`owner`/`platform`: `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf` · factory block `17752965` · chainId `4663`.

**Fix 3 — Graduation model** (root `README.md`, `launchpad/README.md`). Find the "let it ride" / creator-settable
target description; replace with:
> Graduation is **ceiling-only**. A coin graduates only when buys carry price all the way to the fixed ceiling
> (~4.2 ETH raised) — no early graduation, no creator-settable target. `gradTarget` is fixed at the ceiling at seed
> time (there is no `setGradTarget`), so `ready()` flips true only at the ceiling tick.

> If the code migration (C) lands promptly, A becomes moot — the current sherif tree overwrites these files. Do A
> now only if C is delayed and you don't want wrong addresses live on the public repo in the meantime.

### B. Reconcile the two working branches (before the migration)

Two branches have modified sherif and both edit `START-HERE.md`:
- **`claude/robinhood-chain-website-8loxcm`** — all pad-v4 work + the full `START-HERE.md` + the grad-reward fix (this file).
- **`claude/labs-launchpad-start-here-bg1p2i`** — the trimmed sherif `START-HERE.md` + the new Labs-repo `START-HERE.md`.

**Action:** pick one canonical and merge (or let the Labs migration supersede). Recommended: merge both into the
default branch before/at migration so the full pad-v4 work AND the Labs orientation both survive. The grad-reward
correction in Fix 1 must end up in whichever `START-HERE` wins.

### C. The code migration: `sherif → Labs` (closes the stale-snapshot gap)

- **Scope:** all **614 tracked files** — it's all Robin Labs. Gitignored `node_modules`/artifacts don't move.
- **Run from:** a session rooted at `Robinlabz/Labs`, or local git with both remotes.
- **Recommended: clean start** — one "Import Robin Labs" commit (drops the mixed history + avoids republishing any
  secret ever committed). Alternative: preserve full history (only if the secret scan below is 100% clean).
- **MANDATORY secret scan before the first PUBLIC push:**
  ```
  git grep -niE "PRIVATE_KEY|MNEMONIC|SEED_PHRASE|BEGIN (RSA|EC|OPENSSH) PRIVATE|api[_-]?key|secret|password|0x[a-f0-9]{64}" -- . ':!*.min.js'
  git ls-files | grep -iE "\.env($|\.)|\.pem$|id_rsa|keystore|secret"
  ```
  Resolve every real hit before pushing. Do **not** preserve history if a secret ever sat in it.
- **At run time confirm:** replace vs merge Labs' current content (last push 2026-08-02 — can't be inspected from a
  sherif-locked session).
- This refresh **brings the live `FeeConfig` / `PlatformFeeSplitter` / `FloorCoop` contracts into the Labs tree**
  (currently missing) and makes the A fixes automatic.

### D. Infra — WHICH repo serves the site, then the subdomain wildcard (Vercel)

**Context (2026-08-15):** `Robinlabz/Labs` was deleted and re-imported. `www.robinlab.io` is confirmed **still live**
(full site, no errors) — so it's either served by `sherif`, or by a **frozen last-build from the old (deleted) Labs**
(Vercel keeps serving the last deployment after a repo is deleted; it just stops deploying new pushes). The
domain↔repo binding is **only in the Vercel dashboard**, never in the repo (`vercel.json` = rewrites/headers only),
so the repo cannot answer this.

**D0. Determine the serving repo (do first):** Vercel dashboard → the project that lists `robinlab.io` under
**Settings → Domains** → **Deployments** → latest **Production** deploy shows `Source: owner/repo @ branch @ commit`
(or **Settings → Git** shows the connected repo). 
- If it's **`sherif`** → nothing broke; re-point to Labs *deliberately* during the migration (C).
- If it's the **old/deleted Labs** → the site is on a frozen build; **re-link Vercel to the re-imported Labs (or to
  sherif) in Settings → Git → Connect** to restore deploys. Re-importing does NOT auto-reconnect Vercel.

**D1. The coin-site wildcard** (same project — root dir `pad/`, the one serving `www.robinlabs.fun`):
1. Check: open `https://test123.robinlabs.fun`. "Not found / claim" page → already live, done. Vercel/SSL/DNS error → add it.
2. Add domain `*.robinlabs.fun` to that project.
3. DNS: add what Vercel shows — `CNAME` name `*` → `cname.vercel-dns.com`. **Wildcard SSL needs the domain on
   Vercel's nameservers** (`ns1/ns2.vercel-dns.com`); since `www` works it's likely already there → one click.
4. Verify: re-open `https://test123.robinlabs.fun`. No code change — `pad/vercel.json` already rewrites
   `*.robinlabs.fun` → `/site.html`. Creators then claim a slug at `robinlab.io/website.html?c=<coin>`.

### E. Decisions (recommended defaults — none is blocking; confirm when convenient)

- **Promote v4 economics to the public repo?** Default **NO.** Keep v4 numbers out of public Labs until v4 is
  deployed + audited + the model is locked. Labs states only "a v4 rewrite exists, audit-pending — do not quote its
  numbers." Full v4 model stays in this repo (§5, `pad-v4/ROBIN-V4-CURVE-ECON.md`). Promote deliberately later.
- **Fee sheet for external sharing (Uniswap/launchers).** The built artifact is **v4-TARGET**
  (published: `https://claude.ai/code/artifact/95c45fc7-4b71-4030-b1fc-dec8462ee9a3`). **What is LIVE is v3.**
  Default: build a **v3-LIVE** version for anything shared now, taken **directly from `ECONOMICS-VERIFIED.md`**
  (do not hand-derive — that's how the earlier errors crept in). Key headline: base 1% goes platform-on-buys /
  creator-on-sells, above-1% splits 25/75, LP 90/10, grad 0.5+0.5, buy-and-burn via `burnBps`. Do **not** reuse the
  old `MilestoneVault` description — it isn't deployed. Keep the v4 sheet for internal/roadmap.
- **v4 burn shape — CLOSED.** Direct token-burn (the treasury receives token; no buyback swap). Correct for v4's
  funding. Revisit only if the funding flips to holding ETH.
- **Anti-snipe — DECIDED: NONE. "Bots are traders too."** Fair launch, no launch-time guards. **v4 already delivers
  this** — `PadToken` is a plain immutable ERC20 (no `maxTx`/`maxWallet`/blocklist/transfer hook). The **live v3**
  still has a minimal auto-expiring window in `LaunchToken` (dead 2s → maxTx 0.5%/wallet 1% to 60s → 1%/2% to 300s,
  hardcoded by the deployed factory). Existing v3 coins keep it (immutable). To drop it from *new* v3 launches =
  zero the anti-snipe params in `CurvePadFactory` and **redeploy the factory** (offered, not yet done — it would
  diverge the source from the live `0x8aa92d…` bytecode). Stop selling anti-snipe as a feature in the pitch.

### F. pad-v4 external audit (before ANY v4 mainnet)

Arrow launcher (`pad-v4/contracts/arrow/`) is new audit surface — 3-leg atomicity + the instant-graduation coupling.
Floor **H-5 TWAP** redesign is deferred (`pad-v4/FLOOR-REDESIGN.md`). Route through the external auditor; the full
ledger is `pad-v4/AUDITOR-HANDOFF.md` (start at §0).

## 8. Hard rules (from `CLAUDE.md` + operating constraints)

- **Canonical repo = `https://github.com/Robinlabz/Labs`.** Never hand anyone `PettyMiggzy/sherif`.
- **Never commit or echo secrets.** A compromised key must **not** be reused for mainnet.
- Do NOT push to a branch you weren't told to; **do not open PRs** unless explicitly asked.
- Keep the internal model identifier out of commits, PRs, code, and any pushed artifact (chat only).

## 9. Definition of done — this handoff is complete when every box is ✅

Already done (sherif side, this session):
- ✅ pad-v4: platform ETH-only + fee-model round 2 + Arrow (220 tests passing / 0 failing), committed + pushed.
- ✅ Graduation-reward doc corrected to both 0.5 ETH legs (`LIVE_DEPLOYMENT.md` + this file).
- ✅ This complete handoff, in-repo.

Remaining (each has exact steps above — nothing is undocumented):
- [ ] **A** — Labs public repo: 3 fixes (grad both legs · factory address+table · ceiling-only graduation).
- [ ] **B** — reconcile the two branches; the grad fix survives into the winning `START-HERE`.
- [ ] **C** — run the migration (all Robin Labs content → Labs, secret-scanned, clean start).
- [ ] **D** — confirm in Vercel which repo serves the site (Labs was deleted+re-imported; reconnect if needed), then verify/add the `*.robinlabs.fun` wildcard.
- [ ] **E** — confirm the v4-promotion + fee-sheet-version defaults (or override).
- [ ] **F** — send pad-v4 to external audit before any v4 mainnet.
