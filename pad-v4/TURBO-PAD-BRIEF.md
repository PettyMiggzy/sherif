# Turbo pad — build brief

Product brief for the next build session. Written from a design conversation, not from code analysis —
**nothing here has been implemented or verified against the contracts.** Treat the "build notes" as leads to
check, not as findings.

---

## What it is

A launch tier for teams arriving with ETH in hand — chain migrations, or projects that already have a
community and don't need price discovery. It does **not** bypass the curve. The dev's ETH buys the curve out
in one shot, which graduates the pad normally, and the resulting supply is distributed to a holder list the
dev uploads.

Going *through* the curve rather than around it is the whole point: the platform keeps the buy tax, the curve
credit, and the locked LP position. Skipping the curve would forfeit all three.

## Why it exists

Today a migrating team does this by hand: holders send tokens to the dev, dev sells on the old chain, dev
buys on the new chain, dev airdrops from their own wallet. The result is one fresh wallet holding a large %
and feeding hundreds of others — which reads as a rug on Bubblemaps and similar tools, whether or not it is.

The fix is to replace the wallet with a contract, not to change the economics. The buy and the distribution
become one contract's job, and that contract ends at zero balance. The red flag was never the edges in the
graph — it's a node holding the bag. Remove the node.

## Flow

1. Dev arrives with ETH (however they raised it — out of scope)
2. Platform takes **0.5 ETH off the top** (not additive — 3.5 in means 3.0 works)
3. Remainder buys out the curve → pad graduates → LP locked in `LockVault`
4. Contract receives the curve supply
5. Dev uploads a CSV; contract pushes to the list in batches, dev pays gas
6. Contract ends at zero

## Decided

- Through the curve, not around it
- 0.5 ETH off the top
- **CSV push in batches** for v1 — merkle claim is a later option, not now
- Floor is **optional and creator-funded** — they decide whether to have one and how big
- Platform takes **100% of the ETH-side LP fee** on turbo pads (the floor is no longer the platform's cost)
- Launch + buyout must be **atomic in one transaction**
- The distributor is distribution-only: no withdraw, no owner drain

## Open — needs the fee lock before building the money paths

- 0.5 flat, or a % (matters at 20 ETH vs 3.5)
- Turbo buy/sell tax — same as curve pads or different
- Creator side: no graduation event means no `creatorGradBps` payout. Do they get anything?
- Airdrop bucket cap as a % of supply
- Exact mechanism for a creator to fund their floor, and when

## Build notes — leads to verify, not verified claims

- **Atomicity.** `PresaleVault.finalize` already does launch-and-buy in one transaction. That pattern is
  probably the right starting point. If the buyout is a separate tx, snipers front-run into it — they buy the
  cheap end of the curve and sell into the dev.
- **The gap.** Distribution batches can't fit in the launch tx, so the contract holds tokens between the buy
  and the last batch. That window needs to be safe by construction.
- **MC is not selectable.** Curve geometry is stamped from `RobinV4FeeConfig`, so raise and graduation MC move
  together — the ETH they bring picks the MC. `curveSupply` is per-launch and is the dial, but it moves the
  required raise with it. Worth confirming against the geometry before promising anything to a team.
- **No new hook exemptions.** If any path is tempted to exempt itself from the tax by `sender`, don't — H-1 in
  `AUDITOR-HANDOFF.md` flags that shape specifically. Carve supply or pay the tax.
- **One pool per token.** `AlreadyLaunched` guards were just added to all three factories (M-27). Turbo has to
  respect them, not route around them.
- **CSV handling.** Dedupe and drop zero addresses on upload; show total tokens and % of supply before
  committing; make batches idempotent so a failed batch can be retried without paying anyone twice.
- **Gas on arrival.** Migrated holders land with no ETH. Not required for v1 since the dev pushes, but it
  becomes required the moment merkle claim ships.

## Not in scope

- Bridges. Use a canonical one; do not build one.
- Selling the old-chain token on a schedule — a published sell schedule is front-run by everyone on that
  chain, so it fills worse than a single dump.
- Solana origins. Address binding is a separate problem; EVM→EVM first.

## Sequencing flag

The current system has 8 findings awaiting a decision plus the LOW tail open — see §0 of
`AUDITOR-HANDOFF.md`. Turbo widens the audit surface on top of that.
