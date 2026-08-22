# v2 pad — pre-deploy audit

**Scope.** The second pad factory deployed alongside the live one: `contracts/CurvePadFactory.sol`,
`contracts/Bond.sol`, `contracts/deployers/CurveDeployers.sol` (`BondDeployer`), `contracts/BondGeometry.sol`,
and every interface those share with **frozen, already-deployed** code. Also the three product changes v2 carries:
the deep Bounty wall, the removal of the anti-snipe guard, and creator-chosen supply.

**Method.** Source review plus local tests (`test/v2-stack.test.js`, `test/fdv-supply.test.js`). No RPC, so
nothing here is confirmed against live chain state or a fork; findings that need a fork are marked **OPEN**.

**Verdict: no blockers remain.** No fund-loss or brick finding in the new code. V2-4 is closed with measurements
on a fork against the real contract, and V2-1/V2-2 (the false user-facing claims) are rewritten. Every suite is
green, fork suites included. What is left is operational: deploy, verify, repoint the UI, and monitor v1.

| id | sev | area | status |
|---|---|---|---|
| V2-1 | **MED** | "buys every dip" copy is false under a deep wall | **FIXED** |
| V2-2 | **MED** | anti-snipe copy/UI is false with no guard | **FIXED** |
| V2-3 | LOW | dead `seedBlocklist` entrypoint | **fixed** |
| V2-4 | MED | deep wall not re-swept since parameterization | **CLOSED — measured** |
| V2-5 | LOW | uncapped dev buy + no guard + deep wall compound | accepted (product) |
| V2-6 | INFO | small-supply truncation | verified unreachable |
| V2-7 | INFO | frozen `deploy()` selector | pinned by test |
| V2-8 | INFO | graduation `exemptAddress` now a no-op | benign |
| V2-9 | LOW | v1 stays authorized after deploy | **accepted — owner decision** |
| V2-10 | INFO | deeper band vs `_clamp` | not reachable at shipped geometry |
| V2-11 | **MED** | the LIVE Bond's wall sits inside `MAX_DEV` | **v1 only — informs V2-9** |

---

## V2-1 — MEDIUM. The site promised a floor that "buys every dip". At `BOUNTY_NEAR = 9000` it does not. **FIXED.**

The Bounty engages roughly **59% below spot**. It is a crash catcher. Every one of these is now false for a v2
coin, and several are in `<meta>` descriptions and schema.org JSON-LD, so they propagate to search results and
social cards:

- `pad/index.html:491`, `:502` — "A floor that buys the dip … buys every dip, forever"
- `pad/index.html:545` — "Fees keep deepening the floor, it buys every dip, forever."
- `pad/promo.html:11`, `:18`, `:27`, `:30` — meta description / og / twitter / JSON-LD, "a floor that buys dips"
- `pad/promo.html:158`, `:215` — "buys every dip"
- `pad/rewards.html:7`, `:14` — "deepening a floor that buys dips"

**Rewritten around the claim that is both true and stronger.** A shallow floor gets *farmed* — measured at
**+0.2299 ETH** per round trip (V2-4) — so it is drained before a real crash ever arrives. A deep one cannot be,
which is why it is still there when it matters. The copy now leads on that: *"A floor that can't be drained …
can't be pulled and can't be farmed. It sits deep on purpose, so it's still there when a real crash comes."*
Nothing claims dip-buying anywhere, including the `<meta>`/og/twitter descriptions and the schema.org JSON-LD.

Note this copy is **currently true-ish for the live v1 coin** (wall at 200 ticks). It only becomes false when v2
is the launch path — so the copy change and the UI repoint must ship together.

## V2-2 — MEDIUM. Anti-snipe was advertised and no longer exists. **FIXED.**

- `pad/create.html:283` — "**Anti-snipe**: auto-expiring opening guard, sells never blocked" — false on v2.
- `pad/docs.html:243`, `:486` — describes the factory running an anti-snipe opening buy / guard.
- `pad/assets/safety.js:120` — the safety checker tells holders "the anti-snipe guard is buy-side only and
  auto-expires". Vacuously true, materially misleading: a scanner reassuring people about a guard that is absent.
- `pad/admin.html:149-152` — the whole blocklist admin panel is dead for v2 coins (see V2-3).
- `pad/assets/wallet.js:217` — maps a revert to "The opening anti-snipe window caps buy size right now", an error
  that can no longer occur.

`create.html:191` was re-read in this light too: with no guard the dev's advantage is *only* atomicity, so the
hint now says exactly that — "runs inside the launch tx, before anyone else can trade, no cap".

**What each became.** `create.html` leads on the truth instead of the absence: *"No trading limits: no wallet
caps, no cooldowns, buys and sells open from block one"* — which is a real selling point, not an apology.
`docs.html` relabels the audit bullet **Launch integrity** and states the removal outright rather than letting a
heading imply a guard. `safety.js` now says the template has no sell restriction *of any kind*, which is both
truer and stronger than the old guard-flavoured wording. `admin.html`'s blocklist panel is marked **v1 coins
only**, since the entrypoint no longer exists on the v2 factory.

**`wallet.js:217` was deliberately KEPT.** The revert it maps cannot fire for a v2 coin — but v1 stays
authorized (V2-9), so a coin launched there does have a window and can still produce it. Removing the branch
would hand those users a raw revert string. Only the wording changed, to stop asserting which factory it is.

## V2-3 — LOW. `CurvePadFactory.seedBlocklist` could only ever revert. **Fixed.**

The token freezes its blocklist once the anti-snipe window is past, and on v2 there is no window — so the
owner-only pass-through would revert `WindowOver` on every call. An owner entrypoint that always reverts is worse
than no entrypoint: it advertises a protection the factory cannot deliver. Removed, with the reasoning left in
place at the call site. Pinned by `test/v2-stack.test.js` ("the factory exposes NO blocklist entrypoint").

## V2-4 — MEDIUM. **CLOSED.** The shipped wall was re-measured on a fork against the real `Bond`.

Run against live Robinhood Chain (`rpc.mainnet.chain.robinhood.com`), real graduation shape (4.09 ETH raise,
`SHERWOOD_WETH_BPS = 6000`, so 60% Sherwood / 40% Bounty), sustained-hold attack, each row run **twice** — once
poking the Bond while the price is held and once not. The difference between those two runs is the EDGE: what
manipulating the Bond was actually worth, with plain trading-against-the-walls subtracted out.

| wall starts | depth | attacker PnL | **edge** | |
|---|---|---|---|---|
| 200 | ~2% | +0.222341 | **+0.229890** | still pays — **this is what is live** |
| 3000 | ~26% | +0.075542 | **+0.083092** | still pays |
| 6000 | ~45% | −0.021620 | −0.014071 | crossover |
| **9000** | **~59%** | **−0.072436** | **−0.064886** | **shipped** |
| 12000 | ~70% | −0.090253 | −0.082704 | saturating |
| 16000 | ~80% | −0.090840 | −0.083290 | saturated |

Then the same attack against the **real, shipped `Bond`** rather than the `BondDeep` harness the sweep uses —
which is the specific gap this finding was about:

```
LIVE today  200/6800  | attacker  0.222341 | EDGE  0.229890   <-- STILL PAYS
SHIPPED v2 9000/15600 | attacker -0.072436 | EDGE -0.064886   <- no edge
```

The test asserts both directions: the attack **must still reproduce** against the live band (or it would prove
nothing about the fix), and the shipped band must leave no edge. 9000 is past the crossover with margin and
inside saturation — 12000 and 16000 buy almost nothing more, so there is no reason to go deeper and give up more
of the floor's usefulness.

## V2-5 — LOW, accepted. No guard + uncapped dev buy + a deep wall compound each other.

Individually each is a decision already taken. Together, the shape of a v2 launch is: the dev can buy the entire
curve to the ceiling atomically inside the launch tx, no wallet cap applies to anyone afterwards, and if the coin
then sells off there is **no support at all until ~59% down**.

This is not a contract bug and it is not new money at risk — it is the honest composite of three choices, written
down so nobody is surprised by it later. The deep wall does cut the *other* way here: a dev dumping their bag into
the Bounty takes a ~59% haircut to do it, so the wall is much harder to use as an exit.

## V2-6 — INFO. Small-supply truncation is unreachable inside the FDV band. **Verified.**

Creator-chosen supply makes `ambushAmt = supply * 2500 / 10000` variable, so the 75/25 split could in principle
truncate to zero at tiny supply. It cannot, because the FDV floor sets a minimum in-band supply:

| launch tick | min in-band supply (raw) | ambush share | truncates? |
|---|---|---|---|
| 200 | 5.6e16 | 1.4e16 | no |
| 20000 | 4.1e17 | 1.0e17 | no |
| 86400 | 3.1e20 | 7.8e19 | no |
| 201600 | 3.1e25 | 7.8e24 | no |

The smallest possible ambush share is ~1.4e16 raw units — sixteen orders of magnitude clear of 1 wei. The
explicit `ambushAmt == 0 || curveAmt == 0` guard in `_launch` is therefore belt-and-braces, not load-bearing.
Curve liquidity is safe by the same margin (`L ≈ curveSupply / Δ√P`, with `Δ√P` order-1 at the shipped width).

## V2-7 — INFO. The frozen `deploy()` selector is pinned. **Verified.**

The live `CurvePoolDeployer` is reused, and its `CurvePool` bytecode calls
`bondDeployer.deploy(address,address,address,address,address)` — selector `0x9937a678`. This is the sharpest edge
in the whole v2 design: had the wall band been threaded through that call, **every v2 coin would launch fine and
then brick at graduation, with the raise already committed.** That is why the geometry lives on the deployer as
immutables instead. `test/v2-stack.test.js` asserts the selector against a hardcoded literal so a future change
has to be deliberate. `CurvePoolDeployer.deploy`'s `bondDeployer` argument is confirmed a plain `address`.

## V2-8 — INFO. `CurvePool` exempting the Bond at graduation is now a no-op. Benign.

`CurvePool.sol:349` exempts the fresh Bond from the token's guard, because `Bond.poke()`'s `pool.collect()` reads
as a buy and would trip maxTx/maxWallet if a coin graduated inside the window. With no window there is nothing to
trip. The call is `try/catch` and idempotent, so it stays harmless — no change needed, and leaving it means the
same `CurvePool` still works for a future guarded factory.

## V2-9 — LOW. v1 remains authorized on the router. **ACCEPTED — owner decision: leave it in place.**

`PadRouter.setFactory` is an allowlist, so v1 keeps its authorization when v2 deploys. The owner has decided to
**leave v1 as-is and simply not use it** (ROBIN launched from it; a migration may happen later). Recorded, not
argued — but the residual is written down so nobody rediscovers it as a surprise:

- **v1's `launch()` is permissionless.** The UI pointing only at v2 keeps ordinary users away, but anyone calling
  the contract directly can still launch a coin on v1 and receive the shallow, farmable wall (V2-4: edge
  **+0.2299 ETH**) and a Bounty band inside `MAX_DEV` (V2-11). If that ever happens, it is a Robin Labs coin with
  a floor we know is drainable.
- **Nothing about ROBIN required this.** `register` is once-only (`PadRouter:199`, `AlreadySet`) and
  `removeFactory` only clears `isFactory` — ROBIN's config is already written and immutable, so revoking v1 would
  not have touched its trading, taxes, curve, or a future graduation. A later migration would not need v1
  authorized either. The decision to leave it open is therefore a standalone one, and can be reversed at any time
  with a single `router.removeFactory(<v1>)` if a stray launch ever shows up there.

**Monitoring instead of revoking:** since v1 stays live, watch it. A `Launched` event from the v1 factory after
v2 goes up is the signal that this residual has become real.

## V2-10 — INFO. A deeper band sits closer to the tick clamp. Not reachable at the shipped geometry.

`_band` clamps to ±`TICK_BOUND` (887200). Moving the wall from 6800 to 15600 ticks below spot moves the deepest
bid ~8800 ticks closer to that bound. At the shipped curve geometry the deepest reachable band edge is ~194200,
so there is ~4.5x of headroom. If lo and hi ever both clamped to the same value the band would be zero-width and
`singleSidedLiquidityOrZero` would return 0 — the Bounty silently would not place and the WETH would park in the
Bond for the next poke. That is fail-safe (nothing lost, retriable), and it is pre-existing behaviour, but it is
worth knowing the deeper band is nearer to it.

**Band placement verified in both token orderings** at the shipped geometry: token-as-token1 puts the Bounty at
ticks [163000, 169600]; token-as-token0 puts it at [-194200, -187600]. Both well inside range, both strictly
single-sided with respect to spot (`BOUNTY_NEAR = 9000 > MAX_DEV = 300`, enforced in the `Bond` constructor).

---

## V2-11 — MEDIUM (v1 only). The LIVE Bond's wall sits inside the poke deviation tolerance.

Found by accident, and worth recording: v2's `Bond` constructor requires `BOUNTY_NEAR > MAX_DEV`, and the
**deployed** Bond has `BOUNTY_NEAR = 200` against `MAX_DEV = 300`. The live configuration is one the new
validation refuses to construct. The fork tests that reproduce the attack against what is live now have to use
the `BondDeep` harness, because the real contract will no longer build at those numbers.

That is not a workaround, it is the finding: within ±`MAX_DEV` a mean-only recenter can straddle spot, so the
Bounty band stops being strictly single-sided and can end up holding token instead of the WETH it is supposed to
be bidding with. It is a second, independent reason not to leave v1 as a live launch path — see **V2-9**.

## Before deploy

1. ~~Rewrite the floor and anti-snipe copy~~ — **done**, V2-1 and V2-2.
2. ~~Re-run the H-5 sweep~~ — **done**, see V2-4. The fix is measured on the shipped contract.
3. ~~Run the v2 launch + graduation end-to-end on a fork~~ — **done**: `curvepad.fork.test.js` 8 passing against
   live chain, including a 10,000-supply coin launching, trading and reaching graduation.
4. ~~Decide V2-9~~ — **decided: leave v1 authorized and unused.** Residual + monitoring in V2-9.
5. Verify both contracts on Blockscout; repoint `pad/assets/config.js`.
