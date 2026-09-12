# Robin Pad — "No Pool" Next-Gen Concept (Brainstorm)

Status: **conversation capture only.** Nothing in this doc is built, wired, or committed
to any contract. Written down purely so nothing from the discussion gets lost — this is
a running notes file, expected to be tweaked, trimmed, and added to as the idea firms up.

**Standing process note:** from here on, everything discussed in this thread gets logged
here automatically, without asking first — and any new idea worth surfacing gets raised
proactively, not held back until asked.

**UI build status (Phase 1 — hidden preview pages in `pad/`, no backend wiring yet):**
every idea below that has a checkbox has already been built into one of the six hidden
preview pages, so it survives a memory/context reset even before the backend exists.
Anything without a checkbox is still notes-only.

- [x] Token page, **now doubles as the landing page** → `no-pool-preview.html` (a hero
  pitch up top, same job the real site's home page does, then chart, buy/sell/limit tax
  breakdown, holder rewards, burn leaderboard, community locks, launch history,
  mirror-pool note). Nav links across all six preview pages now actually navigate
  between them (previously dead text, matching the real site's look only).
- [x] Create flow → `no-pool-create-preview.html` (creator-picked supply, auction
  window, vested 10% allocation, review)
- [x] Live auction → `no-pool-auction-preview.html` (countdown, min/target progress,
  contribute, what happens at finalize)
- [x] Our own DexScreener-style page, **renamed to plain "DEX"** (was "Perch" — clever
  but nobody knew what it meant; user pushed back after seeing real DexScreener
  screenshots, plain beats clever here) → `no-pool-browse-preview.html`.
  Column density deliberately mirrors real DexScreener/DexTools (age, txns, 5m/1h/6h/24h
  % change, liquidity, mcap) rather than a simplified version — direction was explicit:
  "we need to look just as good or people won't take our DEX seriously." Includes a paid
  "Boost" concept (flame-marked rows, boosted-only tab, a "Boost your token" button) —
  ranking-only, footer note makes clear price/volume/liquidity numbers are never
  adjustable by a boost, only ranking is. **Boost decided:** not an instant #1 —
  ranking runs on a real composite algorithm (volume weighed together with unique
  trader count and other activity signals), so a cheap volume/trend bot can't easily
  out-rank someone actually paying to boost. A boost adds weight on top of that same
  score; organic activity can still out-rank a boosted token. Also added: new launches
  can buy a flat guaranteed top-5 slot for their first 24 hours — a distinct, simpler
  product from ongoing Boost. **Rebuilt for density after direct reference to real
  DexScreener screenshots** — added a top ticker of hot/boosted tokens, a 24h
  volume/txns stat bar, rank numbers, a TRADERS column, and a "Sponsored" ad slot
  (matches DexScreener's own ad-banner monetization pattern). Deliberately kept this
  site's own top nav instead of copying DexScreener's left-sidebar app-shell, since a
  sidebar would be inconsistent with every other real page on the site. Same density
  upgrade applied to the token page: a proper stat panel (liquidity/FDV/mcap,
  5m/1h/6h/24h % row, buy-vs-sell split bars for txns/volume/traders), tabs above the
  transaction list (Transactions / Top Traders / Holders), and an ad slot of its own.
  **Chart architecture decision:** render with
  TradingView's lightweight-charts library (industry-standard, free), but the data
  itself comes from our own indexer — NOT a third-party API like CoinGecko or
  DexScreener's own API, since neither is guaranteed to index this chain or a
  brand-new token. Those two stay separate: our own chart is never dependent on a
  third party's indexing schedule; a third party (DexScreener, maybe CoinGecko) picking
  up the separate thin visibility pool is still just a bonus distribution channel, not
  something the main product relies on.
- [x] DEX page rows are now clickable, DexScreener-style — clicking anywhere on a token
  row (except the favorite star, which still just toggles) navigates to that token's
  detail page; the still-in-auction row routes to the auction page instead since it
  isn't trading yet. Static preview limitation: all three non-$ROBIN rows currently
  point at the same `no-pool-preview.html` (there's only one built detail page) —
  real per-token pages are a Phase 2/indexer thing, not a UI-only concern.
- [x] Token detail page rebuilt into a real 3-panel DexScreener-style layout (user
  supplied a reference sample of DexScreener's actual token-detail page and said
  "clone dex screener one or make a better one," not to copy it verbatim) — left
  column: stats block + a new "Contract" panel (address, supply, renounced ownership,
  "no pool — nothing to drain," reframing DexScreener's contract-verification panel
  around our own no-pool pitch) + an ad slot; center column: chart (now with a
  1m/5m/15m/1H/4H-style timeframe toggle above it, previously static) + transactions/
  traders/holders tabs + launch history; right column: Trade (buy/sell/limit) + community
  locks + rewards + burn. More columns of real content than DexScreener's own sample
  since we're a full DEX, not just a chart aggregator — their layout, our features and
  colors.
- [x] Token page's 3 columns now each scroll independently — hover a column and scroll,
  only that column's content moves (page itself doesn't jump), each pinned in place via
  `position:sticky` with its own bounded height + `overflow-y:auto` +
  `overscroll-behavior:contain` so scrolling past one column's end doesn't bleed into
  the page scroll. Collapses back to normal single-page scroll on narrow/mobile widths
  where the columns stack.
- [x] Migration (zero holder action) → `no-pool-migrate-preview.html`
- [x] Pad-wide transparency page → `no-pool-transparency-preview.html`
- [ ] Everything else below is still concept-only — no page yet.

---

## Core pivot

- Question raised: does the pad need a real Uniswap liquidity pool at all?
- Direction being explored: **no.** The bonding curve becomes the permanent market —
  buy = mint from curve, sell = redeem into curve, forever. No "graduation" into a real
  pool, ever. Removes graduation risk, the LP-1-style pool attack surface, and most of
  the ambush/floor-vault complexity as currently built for the pool-graduation model.
- Trade-off: no real pool means no DexScreener/DexTools listing by default — that's the
  main discovery channel today. **Not yet confirmed:** does DexScreener even index
  Robinhood Chain at all, pool or no pool.

## Visibility without making the curve a real pool

- Build our own DexScreener-style page just for the pad — chart, trade history, volume,
  trending/new tabs. Price data comes straight off the curve's own trade log. Same look
  and feel as a real chart, no pool required.
- Separately: seed a thin, real, ETH-paired LP pool purely so outside aggregators can see
  and index the token. Funded from a slice of the curve's own treasury (same carve-out
  pattern as the existing ambush/floor vault funding), not new money.
  - This pool is **not** the real market — the curve is. This pool's only job is visibility.

## Keeping the visibility pool safe

- Dangerous direction: buy cheap on the visibility pool → sell into the curve for more →
  drains real treasury ETH. Must be prevented.
- Safe direction: buy cheap from the curve → sell into the visibility pool for more →
  grows treasury, harmless.
- Design: visibility pool is public **sell-only** (buy side restricted) — closes off the
  dangerous arb path since the public can't buy real size out of it. Only we, via a
  keeper bot (same pattern as the existing floor/ambush/support keepers), buy back
  whatever piles up in the pool on a schedule — refilling ETH, clearing the pile-up.
  Left alone, a sell-only pool would drain its ETH and look like a dying chart.
- Why big buyers still prefer the curve over the pool: the visibility pool is
  deliberately thin, so any real size there slips badly. No trick needed — just math
  naturally routes size to the curve.
- **Confirmed: the public genuinely can still profit off this, on purpose, one
  direction only.** Since the public can only sell into the pool (never buy from it),
  the only arbitrage path left open to them is buy-cheap-from-curve /
  sell-into-pool — real, risk-bounded profit, and people will take it. That's fine: their
  ETH lands in our treasury, the tokens they sell just sit in the pool until our keeper
  buys them back with that same treasury money later. Nothing ever leaves us. The
  direction that would cost us — buy cheap on the pool, cash out on the curve — has no
  door to walk through regardless of the price gap, because the public can't buy from
  the pool at all. Framing: it's not a leak, it's a small, capped finder's fee to
  whoever keeps the visibility pool stocked and priced right — same as arbitrageurs get
  paid everywhere in finance for keeping markets in line.
- **Confirmed: the keeper's buyback job has a real, ongoing cost — not a rug, but not
  free either.** When someone sells into the pool, the ETH they receive is gone for
  good — it's theirs. When the keeper later buys those tokens back to refill the pool,
  that's separate, fresh treasury money. So over time we're effectively paying twice for
  the same batch of tokens' liquidity: once when a seller cashes out, again when we buy
  it back. This is just the normal cost of always being the one who shows up to buy
  when everyone else wants to sell — same category of expense as the floor/ambush
  vault support spend elsewhere in the system. Two things keep it bounded rather than
  scary: (1) the pool is deliberately kept thin, capping the maximum exposure at any
  moment; (2) the 1.5%/1.5% tax bump exists specifically to fund jobs like this — it's
  a budgeted, recurring line item, not a surprise leak.
- **Caught: the visibility pool must charge the same sell tax as the curve, or people
  just route sells through the cheaper one.** If selling on the DEX/LP side were
  untaxed (or taxed less) than selling on the curve, rational sellers would prefer the
  DEX purely to dodge the tax, quietly gutting sell-tax revenue. Fix: the visibility
  pool is built on the same hook system already taxing the curve — apply the identical
  sell tax there too, so it costs the same either way and there's no cheaper route to
  shop for. Not new tech, just the same hook pointed at a second venue. (Taxed pools
  already trade fine on DexScreener today elsewhere in the industry — no compatibility
  concern.)

## Revenue model (no real pool = no real LP-fee income)

- Shipped baseline (263/263 pad-v4 tests passing) was 1% buy / 1% sell. **Superseded
  below** — with no real pool, there's no LP-fee income to lean on, so tax carries the
  whole load now.
- **Current proposal (agreed in conversation, not yet built): 1.5% buy / 1.5% sell,**
  with the entire incremental 0.5% on each side earmarked for the new programs rather
  than just padding platform's cut:
  - Buy 1.5%: 0.20 → holders (unchanged) / 0.20 → referrer (unchanged) / 0.60 → platform
    (unchanged) / **0.50 → trader rebate pool (new)**
  - Sell 1.5%: 1.00 → creator (unchanged, protects the creator pitch) / **0.50 → holder
    reward pool (new)**
  - LP fees on the thin visibility pool: ETH side → platform, token side → staking
    (same invariant as before — platform never holds pad tokens). Expected to be minor
    given the pool is deliberately thin.
  - Rationale for going from 1%→1.5% instead of just reshuffling the existing 1%: in the
    old pool-graduation model, every trade would've *also* paid a real pool fee to
    somebody (that's just how pools work) — we just weren't the one collecting all of
    it. Removing the pool doesn't make that cost disappear for free, it just goes
    uncollected unless it's rolled into our own tax.
  - Known trade-off, said out loud on purpose: 1.5%+1.5% = 3% round-trip, higher than
    some named competitors' headline numbers (pools.trade 0.25%, Pons 1%) — the honest
    counter is those numbers usually exclude a separate pool fee layered on top that the
    trader pays anyway; ours is presented as the real all-in cost.
- **Still open:** total platform take across auction settlement (10%) + milestone payout
  (~10% at the 4 ETH mark) — flagged earlier as ~19%, not yet reconciled against this
  updated tax model.

## Auction / launch mechanics

- **Creator controls as much as safely possible.** Standing principle: open up any
  parameter that's purely the creator's own call (total supply, likely auction length
  within the window), keep a floor only on parameters that protect *other people* from
  the creator (vesting minimum, tax rate stays platform-wide/fixed) — their money, their
  coin, their call, wherever it doesn't put someone else at risk.
- Creator picks the token's total supply at creation — no fixed number imposed by us,
  the curve just prices against whatever supply exists.
- Public still goes through the existing 1–4 day auction (already built: PresaleVault,
  minRaise/target window, no-fail design — always launches once minRaise clears, no
  refund/fail path once the floor is hit).
- Creator gets a **separate guaranteed allocation** at creation: 10% of supply for $100
  flat, instant — no competing with the public auction for their own coin.
- **Decided, overrides the earlier default:** vesting length on the creator's 10% is
  fully optional, not mandatory — a creator can launch with zero vesting if they want.
  (Earlier default was a 2-week enforced floor to protect the community from an instant
  dump; explicit direction reversed that — creator control wins here.) Consistency fix
  applied across the UI: since it's no longer universally true, "can't be dumped"
  dropped as a blanket claim on Perch/the token page — replaced with "vesting is
  optional, always shown, never hidden," since whatever a creator actually chose still
  shows up in their facts-only launch history either way.
- **Decided: milestone payout is flat 0.5 ETH each to creator and platform**, at the
  ~$34K mcap / ~4 ETH raised mark — not a percentage cut. This is the number "as
  promised" already, and closes the earlier open question about 0.5 ETH vs. a
  percentage-derived 0.419 ETH. Paid straight out of treasury at that point, same as
  before — no pool-seeding involved.

## Migration feature

- Let an existing project's community move to Robin with zero action from holders:
  snapshot real on-chain balances on the source chain, deploy the new token here, batch
  airdrop to everyone from that snapshot. Holders just wake up holding it — no claim, no
  bridge step.
- Creator pays a flat fee to trigger it — $200 (bumped up from an initial $100 idea) to
  cover real gas/API cost with margin.
- Batch-sending at real scale needs real tooling — repo already has some
  Disperse-related contract-verification artifacts sitting around; worth checking if
  reusable before building new batch-send logic.
- Possible sweetener: bundle a free week of front-page/trending placement with the fee.

## Rewards — moving past plain staking

- Baseline: an open reward pool anyone holding/staking draws from, pro-rata, guaranteed
  — nobody excluded.
- Optional boost: burning your own tokens increases *your* share of that same pool. Not
  a separate lottery, not winner-take-all — burning just buys a bigger slice of the same
  guaranteed pool.
- **Confirmed technical point:** a plain ERC-20 burn does *not* move price on our curve
  design — our pricing comes off the pool/curve's own reserves and ticks, not off total
  token supply. This differs from some other projects (e.g. a friend's project "NOMO"
  on Robinhood Chain, reportedly ~$70k mcap) whose curve may price directly off total
  supply, where burning could legitimately pump price. Need NOMO's contract address to
  verify exactly how it's wired instead of guessing — flagged as a to-do.
- The real price-pump lever is **buy-then-burn**, not burn alone: protocol-funded
  buybacks (reusing the buyback keeper already built tonight) purchase tokens off the
  curve — the buy is what moves price — then burn them instead of holding, so the gain
  can't later be reversed by a resale.
- **Named: "Burn" page** (decided — catchier than "Sacrifice," user's call). Substance
  unchanged, and this still isn't a price-pump mechanic on its own (see the burn/price
  note above) — the label is punchy, but the on-page copy stays honest: user sells
  tokens in, but instead of taking the ETH payout, it's donated straight into the pool
  as permanent extra backing. Optionally also burn the tokens taken in, making it a
  user-funded version of the same buy-and-burn mechanic. Framed honestly to users: this
  raises the floor going forward, it is not an instant pump — the name is just the name.
  - **Open question raised, recommendation attached:** should the dev/creator retain
    access to reclaim these donated/burned tokens later "in case they need them"?
    **Recommendation: no.** Reversibility breaks the entire premise — it stops actually
    raising the floor durably, and if the community ever learns the dev can pull back
    what was marketed as permanently sacrificed, that reads as a rug vector regardless
    of intent. If the team needs working capital, that should come from their own
    already-agreed revenue (sell tax, milestone payout) — not from the community-facing
    sacrifice pool.
- Trader rebate: trade $X volume, get X% back. Separate from the above — explicitly
  meant to also attract bots/automated volume, since trading fees are the platform's
  main revenue driver. Guardrail (not yet built, just noted): the rebate rate must
  always stay below the tax rate paid, or wash-trading bots farm it for free and drain
  the pool with zero real value created.

## Standing differentiator brief

Explicit direction from the user: don't build a cookie-cutter pad — there are ~200
competing launchpads, we need to actually stand out, not just match features. Any
genuinely new idea should be raised proactively, not held back until asked.

Ideas on the table so far, beyond the mechanics above:

- **Public, on-chain creator launch history — facts only, no score.** Originally
  pitched as a "trust score," revised after a real concern: a score or rating implies
  WE vouched for the creator, so if they rug anyway, that reads as our fault, not
  theirs — false confidence we'd own the blame for. Fix: show plain, neutral facts with
  zero verdict attached — "launched 2 tokens here before, both still trading normally,"
  or "sold full allocation 3 days after launch." No grade, no color, no safe/risky
  label. A wallet with no history isn't flagged as risky either, just "no prior
  launches" — so first-time creators aren't scared off by looking worse than anyone
  else. We're a mirror, not a judge. Cheap to build: mostly reading events already
  emitted.
- **Burn-page leaderboard.** Public ranking of top donors to the burn/backing pool.
  Near-free once the burn page exists — just surfaces events already being emitted.
  Gives people social credit for backing a project publicly.
- **Lead with structural rug-immunity as the pitch, not a footnote.** Because there's no
  real pool to drain, this pad can honestly claim something most of the ~200
  competitors can't. Combine with the launch history above for the actual headline: "the
  coin can't be rugged, and the creator's history follows them."
- **No public mempool is a real, already-true superpower — we just haven't said it out
  loud.** Robinhood Chain has no public mempool, meaning there's no waiting room where a
  bot can see a pending trade and jump in front of it or sandwich it — that's how most
  front-running/sniping works on chains that do have one. Stack it with "no pool to
  rug" and "creator allocation is vested" and it's a three-layer pitch nobody can copy
  without changing chains: can't be front-run, can't be rugged, can't be instantly
  dumped. Nothing to build here — it's already true, just needs to be said.
- **"Skin in the game" locks instead of paid hype.** Paid shills hype a coin then dump
  it — hard to tell a real believer from a paid one. Let ANYONE (not just the creator)
  publicly lock some of their own tokens for a chosen period, shown next to their name
  wherever the community talks. A costly, on-chain, unfakeable statement of conviction —
  reuses the same lock/vesting tech already being built for the creator's allocation,
  just opened up to anyone who wants to publicly back their own opinion.
- **Pad-wide live transparency page.** Since the whole pitch is "backed by real money,
  not a pool," show it directly — total ETH sitting across every curve, total ever
  donated through the sacrifice page, total the support keepers have deployed. Pad-wide,
  not per-token. Most of this space is a black box; showing the receipts is itself a
  differentiator.
- **Court the bots instead of fighting them.** Bots bring volume, volume is the
  business. Most pads build anti-bot walls; publish a clean, simple, identical
  interface for trading bots to plug into any token here instead. Since there's no
  mempool to snipe from anyway, embracing bots doesn't carry the usual downside other
  chains have.
- **A "good" version of a mempool — sealed/private pending orders.** A normal mempool is
  bad because everyone can see what's pending and jump in front of it. Build our own
  pending-order queue (limit orders, scheduled trades) where the order's contents are
  sealed/committed and only revealed at the moment they execute — same commit-reveal
  technique already used in the presale auction, just applied to ongoing trading. Lets
  us honestly say "we built our own mempool" as a real, bullish, differentiating claim,
  while it's actually the version that can't be sniped. Not a trick — genuinely better
  engineering, marketed honestly.
  - **Hard safety requirement, non-negotiable:** submitting a sealed order must lock
    real funds immediately, not just register an intent. If canceling before execution
    were free, people would spam many sealed orders and only let the ones that turned
    out favorable actually execute — a risk-free, zero-downside option at the pad's
    expense. Cancellation (if allowed at all) must cost something. Same standing rule as
    everything else on this pad: nobody gets upside with zero downside.

## RPC / infra notes (Phase 2, backend — not started)

- **Paid RPC as a read fallback:** already has a slot — `indexer/src/config.js`'s
  `RPC_BACKUP` env var is wired into the read-priority order (`readOrder` = free →
  primary → backup → blockscout) but empty by default. No code change needed — just
  set `RPC_BACKUP=<paid RPC URL>` in the droplet's `.env` and restart. Writes/broadcasts
  stay pinned to the primary `RPC_URL` on purpose (keepers shouldn't bounce between
  providers mid-transaction).
- **Robinhood's free read-only WSS:** genuinely new work, not config. Today everything
  is polled HTTP JSON-RPC. Subscribing to new blocks/logs over WSS instead would push
  updates rather than poll for them — lower latency, less RPC load, and it's exactly
  what would make our own chart/ticker data (see "chart architecture decision" above)
  feel truly live instead of refresh-on-an-interval. Real code when Phase 2 starts, not
  a flag to flip.

## Open / unresolved

- ~~Confirm DexScreener actually indexes Robinhood Chain at all.~~ **Resolved: yes** —
  confirmed via a real Robinhood Chain surface at dexscreener.com/robinhood.
- `services.html` is owned by a different Claude session (trending-bot branch, per
  `COORDINATION.md`) — coordinate before adding a market-maker-support listing there,
  don't edit solo.
- Stock-token LP pairing (users wanting to create LPs paired against "stock" tokens, not
  just ETH) — real observed demand, no design yet, separate problem to revisit.
- Exact vesting length for the creator's 10% allocation.
- Exact milestone-payout size at the ~4 ETH raise mark.
- Final call on visibility-pool openness (fully sell-only vs. something more open).
- The ~19%-total-platform-take number from earlier tonight — still unresolved, not yet
  reconciled with this new no-pool model.
- **NOMO investigated, partially resolved, real concern found.** Contract address
  `0xfD036176739e03BaB9E5eA881069Ca2845e5c0de` (name "NoMore", symbol NOMO, 18
  decimals), launched via a different launchpad ("hood.dev"). Confirmed on-chain: a
  real, standalone, non-proxy contract (~6.7KB bytecode, no EIP-1967 implementation
  slot). Checked for burns two ways — Transfer events to the dead address
  (`0x…dEaD`) and to the zero address — across the last 300,000 blocks: **zero burn
  transfers found, either way.** Could not pull verified source (Blockscout's API was
  blocked from this environment) to confirm the exact pricing mechanism. This doesn't
  prove the friend lied, but a claimed burn with no matching on-chain event over that
  wide a window is a real red flag — next step is getting the actual burn transaction
  hash to check directly, rather than guessing further.
- Perch's paid "Boost" feature may overlap with the existing "DEX Trending" product
  already sold on `services.html` (owned by the trending-bot session per
  `COORDINATION.md`) — worth checking whether that's the same product wearing two
  names, or genuinely different (boosting rank on our own internal page vs. boosting
  visibility on external DexScreener/DexTools), before building real payment plumbing
  for it.

---
*Brainstorm capture only — nothing above is implemented, committed to a contract, or
final. This file exists purely so a long conversation doesn't lose ideas.*
