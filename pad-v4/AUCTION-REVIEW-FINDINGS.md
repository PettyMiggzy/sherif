# Auction Pad — adversarial review findings

8 attack surfaces, 25 agents, 3.07M tokens, ~86 min. 52 raw findings; the top 8 by severity were
put through two independent refutation lenses (code + economics) and only findings that **survived
both** are marked confirmed. The other 44 are recorded as unverified — the run was concurrency-capped
at 2 agents, so verify capacity ran out. Unverified does not mean wrong.

---

## THE ONE THAT BLOCKS MAINNET — the LP surface is ungated

Found by the completeness critic; no attack surface caught it. **Verified independently.**

`BaseHook.sol:41` — `REQUIRED_FLAGS = 0x20CC`. Decoded, that is exactly:

```
ON   BEFORE_INITIALIZE, BEFORE_SWAP, AFTER_SWAP,
     BEFORE_SWAP_RETURNS_DELTA, AFTER_SWAP_RETURNS_DELTA
OFF  BEFORE_ADD_LIQUIDITY, AFTER_ADD_LIQUIDITY,
     BEFORE_REMOVE_LIQUIDITY, AFTER_REMOVE_LIQUIDITY, both donate flags
```

The hook has **no liquidity permissions at all**, so `poolManager.modifyLiquidity` on a pad pool is
completely ungated. `RobinFloorVault._add` and `RobinAmbushVault._add` already prove it in practice:
two non-factory contracts call it with no permission check.

Three consequences, all live in v4 **today**, before any auction exists:

**(a) LP-through is a tax-free exit.** The sell tax fires only in `afterSwap` on a `oneForZero` swap
(`RobinFeeHook.sol:348-363`), and `PadToken` is a plain ERC-20 with no transfer hook. Mint a
token-only range, let buyers walk down through it, then remove the position — now holding ETH.
Converting token → ETH that way is **not a swap**, so it pays no sell tax and no floor carve. The
creator's 1% sell stream and the permanent floor's funding are both avoidable by any patient holder.

L-25 closed the *sibling-pool* tax-free venue and left a tax-free venue open **inside the pad's own
pool**. The "unbypassable tax" claim is still not true.

**(b) Buy-flow interception starves graduation.** Plant liquidity in `[gradTick, startTick]` — the
same shape as the curve's own position — and every buy splits pro-rata by L between the curve and the
interloper. The curve never sells out, `ready()` never flips, the permanent LP is never minted,
staking is never funded. The repo knows about planted liquidity (`RobinCurveV4.sol:653-656`, the C-2
`restoreCeiling` note, `test/unit/RobinCurveV4.grief.test.js:92`) but **only** in the
below-the-ceiling overshoot variant. In-range interception is untested and unhandled.

**(c) An unlimited creation-time airdrop makes both free.** Airdrop to self → plant it as in-range
liquidity → the auction's own pooled buys fill against your position → you take the raise, untaxed,
without ever selling, without moving the visible price, and the pad never graduates.

**Why it is urgent rather than merely bad:** hook permissions are mined into the hook *address*
(`BaseHook.sol:60`, cross-checked by the factory). v4 is on **testnet 46630**; mainnet is **4663** and
has no v4 pads. So this costs one constant and one branch today, and becomes permanently unfixable
for every pad launched after the first mainnet launch.

**CLOSED.** `REQUIRED_FLAGS` is now `0x28CC` — `BEFORE_ADD_LIQUIDITY` (0x800) added — and
`RobinFeeHook.beforeAddLiquidity` gates third-party liquidity for the curve phase. See
[`LP-GATE.md`](LP-GATE.md) for the design and its honest scope; pinned by
`test/regression/LP1.liquidity-gate.test.js` (10 tests).

---

## CONFIRMED (survived both lenses)

**1 · CRITICAL — the launch config is welded into the token address.**
`CurvePadFactoryV4.sol:236` derives the CREATE2 salt as `keccak256(abi.encode(cfg, tokenSalt))` over
the *whole* `LaunchConfig`, then `:248` requires the mined `0x1ab5` brand, and `:261` folds the token
into the hook init-code so the 14-bit flag mine is bound to it too. Any post-settlement `curveSupply`
or `startTickMag` reverts `BadTokenSuffix`.

This kills the "size the curve from the auction result" idea dead — but see the correction below: the
requirement it was serving does not actually exist.

---

## CORRECTIONS TO THE SPEC

**The curve already opens at the clearing price.** Every lens read "the curve opens at the final
clearing rung" as "`startTickMag` must equal the clearing rung", which is what collides with the
brand salt. That is wrong. The pooled buy **moves spot** — `finalize()` swaps price-limited at
`gradSqrt` (`PresaleVault.sol:311-322`) — so post-settlement spot *is* the clearing price and the
curve continues from there. `startTick` is rung 0, the reserve. Design point 6 is already delivered
by shipped code, and the salt collision was self-inflicted.

**A bidder cannot be filled above the graduation price.** Two independent refuters killed the
"blank cheque" finding on the same ground: `gradTick` is an immutable hard ceiling
(`RobinCurveV4.sol:124`), there is no liquidity beyond it, and the pooled buy is hard-limited at
`sqrtPriceLimitX96: gradSqrt`. The ceiling the design was missing already exists.

**The §2.2 hook window gate is withdrawn.** It does not gate `modifyLiquidity`, so the "exclusive
window" is not exclusive. It would be the first mutable trading permission in a system whose hook
config is deliberately write-once (`RobinFeeHook.sol:197`, "no setter anywhere") — a halt switch on
every pad, which is the textbook honeypot signature scanners flag, against pending task #32
(aggregator listings). And it gates out `restoreCeiling` (`RobinCurveV4.sol:506`) and the graduation
nudge (`:672`), which swap through the same hook — so a griefer plants liquidity below `gradTick`
during the window and the only recovery path is locked out until close.

**The 0.25% "discretionary to the coin's own staking pool" does not exist.** `PoolConfig`
(`RobinFeeHook.sol`) has exactly three sinks — `floorRecipient`, `bufferRecipient`, and the referral
book. There is **no staking recipient field**, and no path from swap tax to a staking pool. Staking is
funded at graduation out of leftover reserve tokens (`RobinCurveV4.sol:433-434`), not from the tax.

**Deployed tax is 1%/side, not 1.25%.** `deploy.curve.json` ships `buyTaxBps: 100, sellTaxBps: 100,
sellFloorShareBps: 2000, buyBufferShareBps: 2000`. `scripts/deploy-curve.js` now defaults to 125, but
that is what would deploy next, not what is live.

**The airdrop is already solved, in this repo.** `contracts/arrow/ArrowLauncher.sol` +
`ArrowDistributor.sol`. The launcher *buys* the distributed supply off the curve (`:139-160`) and
hands it to a no-withdraw merkle self-claim distributor. The dev ends holding zero tokens, the
no-dev-mint invariant (`CurvePadFactoryV4.sol:158-164`) is never touched, and the 16M gas clamp is
irrelevant because claims are self-service. "Unlimited airdrop deletes the anti-rug invariant" is only
true of a minted-bucket implementation nobody has to choose.

---

## THE MECHANISM THAT DOMINATES

The critic's synthesis, and it is better than §2.2: **the shipped `PresaleVault`, two fields changed.**

1. **Split `target` into `minRaise` and `hardCap`.** Today `target == hardCap`
   (`PresaleVault.sol:197`). Set `minRaise = MIN_TARGET` (0.01 ETH — so it effectively never fails,
   which is the owner's decision) and size `hardCap` from `_absorbableIn` at open. This closes the
   oversubscription trap *and* the "10% fee charged on ETH that never bought a token" path in one
   stroke, because with `hardCap` = capacity there is no unspent ETH.
2. **Call `curve.graduate()` inside `finalize()` when `ready()`**, before opening claims.
   `ArrowLauncher.sol:154` is the working reference implementation, in this repo, on this factory.

That delivers design points 2, 3, 5, 6 and 9 with **zero new contracts**:

| Design point | Already satisfied by |
|---|---|
| Auction window | `deadline`, `MIN_DURATION = 1 hours` |
| Ladder, first buy cheapest, monotone | the curve *is* the ladder; one uniform clearing price for all |
| Pro-rata by ETH | `_payout` (`:395-400`) |
| Reserve = rung 0 | `startTick`, FDV-banded at open (`:176-177`) and at launch (`:194-195`) |
| 10% platform / 90% curve | `PLATFORM_FEE_BPS = 1000` |
| Curve opens at the clearing price | post-buy spot, by construction |
| Instant graduation on a big raise | change (2) |
| Unbid supply "goes back to the curve" | it never leaves — the buy simply doesn't reach the ceiling |
| No failed auction | `minRaise` at the floor; `refund()` survives as the brick hatch |

`presaleImpl 0x66902BFe…` and `presaleFactory 0xbc91E2D8…` are **already deployed** on 46630.

---

## RECOMMENDED BUILD ORDER

1. **Decide the LP surface before mainnet.** Blocks mainnet, not the auction. Unfixable later.
2. **`hardCap` split from `target`** in `PresaleVault`. One field, kills two severity findings.
3. **`graduate()` inside `finalize()` when `ready()`.** Copy `ArrowLauncher.sol:154`.
4. **One-shot, pool-scoped settlement-swap tax exemption** — never a standing address exemption.
5. **Airdrop = curve buy + `ArrowDistributor`.** Zero factory changes.
6. **v4 to mainnet**, then aggregator listings (task #32).
7. **ROBIN accrual as a keeper** spending the platform's existing 10% graduation cut into ROBIN's own
   pool — identical tokenomic to the 40% leg, no `graduate()` rewrite, and it works while ROBIN is
   still on a curve.

## RECOMMENDED CUTS

- **The 1/2/3-day, 10%-per-day shape.** Three days of dead attention buys anti-snipe protection a
  single-sequencer FCFS chain already gives away.
- **The standalone rung/tranche ladder and its keeper.** The curve is the ladder. 288 scheduled
  executions is an ops liability on a chain where the team's own graduation keeper *has never fired in
  production* — `LIVE_DEPLOYMENT.md`: 9 coins, 46k trades, ~115 ETH, **0 graduated**.
- **The §2.2 hook window gate.** See corrections.
- **The dual-pool ROBIN 40% leg.** Three lenses killed it independently, and ROBIN itself has not
  graduated — the design would pair every graduating coin against a token still on a bonding curve.
- **The stock-paired variant.** A different product with near-zero code reuse.
- **The per-wallet cap as a whale control.** Sybil theatre at ~2.75e-6 ETH per wallet; keep it as a UI
  nicety, do not call it a control.

## UNPRICED RISK

`TELEGRAM_COMPLIANCE.md:11-13` puts fund-custody legality out of code scope and asks for securities
counsel. A multi-day pooled ETH raise with a declared reserve, pro-rata allocation, **no refunds** and
a 10% promoter cut — optionally paired to tokenized equity — is materially further into that territory
than an instant curve buy. Zero of eight lenses raised it.

## AND THE THING NO LENS SAID

With refunds gone the reserve price is the only bidder protection left, and **nothing in the design
says how a creator picks it.** `scripts/valuation.js` already computes FDV → USD. Wire the reserve to
it, bound it just above `minFdvWei`, and show the bidder the implied market cap before they commit.
A day of work, worth more than the entire ladder.

---

# Round 2 — review of the shipped PresaleVault + LP-1 changes

13 agents, 4 surfaces, 2-lens verify, completeness critic. **4 confirmed, 0 refuted, 7 unverified**
(verify capacity is 4 findings deep on a 2-slot container; unverified is not "wrong").

## CRITICAL — a 1-wei rounding disagreement bricked the whole vault

Found independently by three of the four surfaces. **Introduced by my own commit `ef1a8c0`.**

`finalize` reserves the platform's cut rounding **down** (`totalRaised * 1000 / 10000`) and then
reconstructs it rounding **up** out of the spend (`pooledEthSpent * 1000 / 9000`). Below curve
capacity the buy consumes the entire budget, so the two meet exactly — and on one residue class they
disagree by a wei:

```
totalRaised % 10 = 0..8   →  leftover 0
totalRaised % 10 = 9      →  leftover −1     ← underflow
```

`_payout`'s `totalRaised - pooledEthSpent - platformFee` then underflows. `finalized` is already true
so `fail()` is unreachable, which means **every claim, every preview and the platform withdrawal
revert forever, with 100% of contributor ETH and tokens inside.** One raise in ten, total loss.

Fixed by clamping `platformFee` to `totalRaised - pooledEthSpent`, making
`platformFee + pooledEthSpent <= totalRaised` structural rather than arithmetical. Costs the platform
at most one wei. Pinned by a residue sweep over 0, 8 and 9.

The reviewer's diagnosis of *why* it had no slack is the part worth keeping: below capacity the buy
spends the whole budget, so the ETH-back pool is exactly zero across that entire regime — there was
nothing anywhere to absorb a rounding excursion.

## HIGH — an under-gassed launch was burned as a front-run

If `finalize` runs out of gas inside a CREATE2, the 63/64 rule leaves the outer frame alive, CREATE2
yields the zero address, and `DeterministicDeployer.sol:37` reverts with the **typed**
`DeployFailed()`. L-12's empty-revert check therefore misses it, and a merely under-gassed call
irreversibly destroyed a funded raise as `Failed(3)`.

`DeployFailed` is now bubbled too. Even where a collision could produce it, bubbling is the safer
classification: it is retriable, and an unwinnable launch still reaches 100% refunds through the
reason-2 grace hatch. Misclassifying a snipe costs a wait; misclassifying an out-of-gas costs the
entire raise.

**Where I disagreed:** the review wanted `MIN_FINALIZE_GAS` raised from 2M to the measured ~8M. No
value works. A correctly estimated call arrives with roughly what it needs, so any floor high enough
to guarantee completion also rejects the honest caller whose estimator returned the true cost. It
stays at 2M, documented as ergonomics rather than protection, with the revert classification named as
the actual guard.

## What the review could NOT break

Recorded because each was a real attack surface that the code already closes:

- **Re-entrancy through graduation.** Nothing in `graduate()`'s call graph can re-enter the vault.
  `finalize` is `nonReentrant` (OZ's guard arms correctly in an EIP-1167 clone), `receive()` reverts
  unless `_gradInFlight`, and `unlockCallback` requires `_expectingUnlock`, which is false by then.
- **`_gradInFlight` cannot be left set** — both calls are try/caught, anything uncatchable rolls back.
- **The measured balance delta really is only the bounty** — `graduate()` books its other payouts
  rather than sending them. Measured 255,056,998,984,077 wei, conservation exact.
- **Keeping the bounty out of `platformFee` is right**, for the reason the code states.
- **The 16.7M gas cap is not a problem** — measured 7,978,067 for launch + buy + graduation.
- **The LP-1 gate does not block graduation's own permanent-LP mint**, and `liquidityDelta == 0` fee
  pokes route to `beforeRemoveLiquidity`, which is unflagged in `0x28CC`, so they are never gated.

## Also fixed from this round

- `scripts/check-wiring.js` read the hook config with a 15-field ABI against the new 16-field struct —
  every field after `quoteIsStock` was shifted by one word.
- `staging/config.js` still mined `HOOK_FLAGS = 0xcc`.
- `scripts/mine.js`'s flag comment enumerated four flags for a value of `0x28cc`.
- Inline graduation now emits `GraduationSkipped` instead of being swallowed by the catch.
- The M-22 operating rule was widened: the `minRaise` split added a second premature-call path
  (`BeforeDeadline` on a partial raise), and both reverts spend a correct preimage.
- The conservation test asserted an exact zero balance that only held when deposits happened to
  divide evenly. It now asserts the real property — residue bounded by depositor count — and keeps the
  exact assertion only for the single-depositor case, where it is genuinely exact.

## Still open

- **`floorRecipient` is admitted for any tick range** (LOW). It is a one-shot, platform-set contract,
  so this is a trust question rather than an exposure, but the gate does grant it more than the floor
  band.
- **Pro-rata dust has no sweep** (LOW). Bounded by depositor count; documented rather than swept,
  since there is no point at which "everyone has claimed" is knowable on-chain.
