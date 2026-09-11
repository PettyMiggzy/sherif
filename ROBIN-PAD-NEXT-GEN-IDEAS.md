# Robin Pad — "No Pool" Next-Gen Concept (Brainstorm)

Status: **conversation capture only.** Nothing in this doc is built, wired, or committed
to any contract. Written down purely so nothing from the discussion gets lost — this is
a running notes file, expected to be tweaked, trimmed, and added to as the idea firms up.

**Standing process note:** from here on, everything discussed in this thread gets logged
here automatically, without asking first — and any new idea worth surfacing gets raised
proactively, not held back until asked.

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

- Public still goes through the existing 1–4 day auction (already built: PresaleVault,
  minRaise/target window, no-fail design — always launches once minRaise clears, no
  refund/fail path once the floor is hit).
- Creator gets a **separate guaranteed allocation** at creation: 10% of supply for $100
  flat, instant — no competing with the public auction for their own coin.
- That 10% vests/unlocks gradually (~2–4 weeks, exact length TBD) instead of all at once
  — stops an instant dump without relying on an unenforceable "ban the ruggers" list
  (trivially bypassed with a new wallet; an on-chain lock is real).
- Milestone payout: when the raise crosses ~4 ETH, platform + creator get a payout —
  replaces the old fixed "0.5 ETH each at graduation" idea (which assumed seeding a real
  pool). Paid straight out of treasury at that point instead. Exact payout size TBD.

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
- Community "Sacrifice" page (name TBD — avoid "burn," it over-promises a pump it won't
  deliver): user sells tokens in, but instead of taking the ETH payout, it's donated
  straight into the pool as permanent extra backing. Optionally also burn the tokens
  taken in, making it a user-funded version of the same buy-and-burn mechanic. Framed
  honestly to users: this raises the floor going forward, it is not an instant pump.
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
- **Sacrifice-page leaderboard.** Public ranking of top donors to the sacrifice/backing
  pool. Near-free once the sacrifice page exists — just surfaces events already being
  emitted. Gives people social credit for backing a project publicly.
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

## Open / unresolved

- Confirm DexScreener actually indexes Robinhood Chain at all.
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
- NOMO's contract address, to verify the burn-pump mechanism precisely.
- Naming for the "Sacrifice" page.

---
*Brainstorm capture only — nothing above is implemented, committed to a contract, or
final. This file exists purely so a long conversation doesn't lose ideas.*
