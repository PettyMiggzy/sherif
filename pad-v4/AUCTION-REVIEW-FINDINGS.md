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

Decision required before mainnet: either add `BEFORE_ADD_LIQUIDITY` to `REQUIRED_FLAGS` and admit only
the curve / floor / ambush / LockVault pre-graduation, **or** write into the audit brief that the sell
tax and floor carve are avoidable by any LP.

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
