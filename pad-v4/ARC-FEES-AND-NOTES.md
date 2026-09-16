# Arc pad — fee design (implemented)

Durable record of the fee-model discussion and what got built from it. See ROBIN-V4-CURVE-ECON.md
for how the ORIGINAL Robinhood Chain fee model works — this file documents where the Arc/new-model
design deliberately diverges from it.

## Status: BUILT AND TESTED

## Milestone payout — DONE

One-time checkpoint (not a repeating ladder — repeated ETH extraction would hurt the chart, and the
contract's checkpoint is architecturally one-time anyway). Fires at the curve's ~$34K FDV ceiling
(`gradTick`) — already the calibrated target, matching the standing creator promise ("half ETH at
$34K market cap").

Implementation: `RobinCurveV4.graduate()`'s no-pool-forever branch. The `lpEth` value (what would
have funded a permanent LP) now splits 50% creator / 50% platform instead of 100% to staking — only
the creator's half is explicitly booked (`creatorEthOwed += lpEth/2`); the platform's half is left
as unclaimed balance, picked up by the existing end-of-function catch-all
(`platformEthOwed = balance - everything else owed`) so it's never double-counted.

Verified: tick geometry lands exactly as calculated on a real local deploy; `RobinCurveV4.noPoolForever.test.js`
and `RobinDividendPool.test.js` updated and passing (creator's half claimable independent of
staking wiring — a real improvement over the old design, which could strand a large sum if staking
wasn't wired yet).

**DexScreener $400 boost:** deliberately NOT a contract concern — no oracle, per the user ("I don't
know that you can make a contract do that... probably need an Oracle and it'd be a big bill").
STILL PENDING: extend `indexer/src/announcer.js` (the existing Telegram bot) to alert the team when
`NoPoolCheckpoint` fires, so a human buys the boost manually. Not yet built — needs the indexer to
track this event first.

## Ongoing buy/sell tax split — DONE, v2 ("keep it simple" + working referrals)

Final numbers (v2, supersedes the first pass): **1% flat to creator (referral-independent), 1% to
a combined trader-rebate + referral pool, split evenly per leg** (0.5%/0.5% of each 1% tax side).
Floor and ambush are **retired** for pads using this model, per explicit instruction — not deleted
from the codebase (`RobinFloorVault`/`RobinAmbushVault` stay; Robinhood Chain's live pads still use
them), just zero-allocated in the governed defaults (`ambushGradBps: 0`) so nothing deploys or gets
funded for new launches.

v1 → v2 change: the user wanted referrals to actually pay out meaningfully, not be squeezed to a
small carve off an already-thin creator cut. v1 had crept the split to 1.5% creator / 0.5% pool,
with referral carved from the CREATOR's cut. v2: creator flat 1% (bufferShareBps raised from 25% to
50% each leg), and referral now carves from the REBATE POOL instead of creator — so the creator's
share is exactly `fee - bufferCut` always, completely unaffected by whether a referral fires.

Implementation, in `RobinFeeHook.sol` (see the `[SIMPLE-FEES]` / `[SIMPLE-FEES v2]` comments there
for the full reasoning):
- `_bookBuy`: creator's cut is `fee - bufferCut` (flat). Referral carves `referralShareBps` of
  `bufferCut` (the rebate pool), not of the creator's remainder — so referral only ever redistributes
  within the pool, never touches the creator.
- `afterSwap`: the sell-tax carve (still governed by `sellFloorShareBps`, repurposed) credits
  `bufferOwed`, not `floorOwed` — joining the SAME pot the buy-side buffer feeds (no referral on the
  sell leg — matches the existing hookData-based referral mechanism, which is buy-only). Both
  directions' trader-rebate money flows through one existing pull path (`claimBuffer()` → curve →
  `stakingEthOwed` → `_fundStakingEth()` → wherever `curve.staking` is wired) instead of building a
  new accrual/claim mechanism from scratch.

At the default `referralShareBps=2500`: buy volume splits 0.5% creator / 0.375% trader-rebate /
0.125% referral (when used); sell volume splits 0.5% creator / 0.5% trader-rebate (no referral).
Overall: creator 1% flat, referral+trader-rebate pool 1% combined.

Platform's revenue comes from the LP fee instead of the tax. Buy-side (ETH) LP fee was already 100%
platform by default — no change needed. **Deliberately did NOT extend "100% platform" to the
sell-side (token) LP fee** — that would mean the platform holding pad tokens, which conflicts with
an existing audited invariant ("platform is ETH-only," with a dedicated test proving it holds zero
pad tokens even with a nonzero fee). Left untouched; flagged to the user rather than silently built
around.

Verified: 19/19 tests passing across the three hook test files (adversarial, referral, skim), each
updated to test the new deliberate routing rather than the old platform/floor destinations. A fresh
local Arc deploy with the new config confirms the curve/checkpoint math is unaffected.

A full-suite run afterward caught two more regression files that predate this change and still
referenced the old `floorOwed`/`platformOwed` destinations: `test/regression/H1.selltax-waiver.test.js`
(a `taxed()` helper undercounted total tax since the sell carve now lands in `bufferOwed`; a claim test
used `floorOwed`/`claimFloor` directly) and `test/regression/H3.short-return.test.js` (a buy-tax
assertion checked `platformOwed`, which a buy no longer touches under this fee model). Both updated to
the new `creatorOwed`/`bufferOwed`/`claimBuffer` routing — H1's suite also now wires a `bufferRecipient`
(via `setBufferRecipient`, correctly ordered AFTER the test's initial LP add, since wiring it earlier
trips the [LP-1] liquidity lock for any non-recipient signer). 13/13 passing in both files.

## Reminders (already-existing features, unaffected)

- **Optional 1-4 day auction before the curve launches** — already exists (`PresaleVault` / the
  auction pages). Nothing to build for Arc.

## Not yet built / open

- **Creator makes a small buy at creation, split between the DEX-visibility pool and a curve sell
  buffer** — does not map onto anything currently in the contracts. New "minimum creator buy-in at
  launch, auto-split" mechanic. Not started.
- **Telegram alert for the milestone checkpoint** (see above) — needs indexer event tracking first.

## Blocked on the user, not on engineering

- **Dual-chain badge** — needs Venice API credits (`VENICE_API_KEY` in indexer/.env), user said
  they'll add tomorrow. Don't build/test until the key exists.
- **Pitch decks** for Arc — outside this repo's scope as far as I can tell; flagged, not acted on.
