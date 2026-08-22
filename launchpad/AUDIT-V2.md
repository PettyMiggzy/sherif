# v2 pad — pre-deploy audit

**Scope.** The second pad factory deployed alongside the live one: `contracts/CurvePadFactory.sol`,
`contracts/Bond.sol`, `contracts/deployers/CurveDeployers.sol` (`BondDeployer`), `contracts/BondGeometry.sol`,
and every interface those share with **frozen, already-deployed** code. Also the three product changes v2 carries:
the deep Bounty wall, the removal of the anti-snipe guard, and creator-chosen supply.

**Method.** Source review plus local tests (`test/v2-stack.test.js`, `test/fdv-supply.test.js`). No RPC, so
nothing here is confirmed against live chain state or a fork; findings that need a fork are marked **OPEN**.

**Verdict: two blockers, both copy.** No fund-loss or brick finding in the new code. V2-4 is now **closed with
measurements on a fork against the real contract** (below). What still blocks the deploy is that v2 makes several
live user-facing claims false.

| id | sev | area | status |
|---|---|---|---|
| V2-1 | **MED** | "buys every dip" copy is false under a deep wall | **BLOCKER — open** |
| V2-2 | **MED** | anti-snipe copy/UI is false with no guard | **BLOCKER — open** |
| V2-3 | LOW | dead `seedBlocklist` entrypoint | **fixed** |
| V2-4 | MED | deep wall not re-swept since parameterization | **CLOSED — measured** |
| V2-5 | LOW | uncapped dev buy + no guard + deep wall compound | accepted (product) |
| V2-6 | INFO | small-supply truncation | verified unreachable |
| V2-7 | INFO | frozen `deploy()` selector | pinned by test |
| V2-8 | INFO | graduation `exemptAddress` now a no-op | benign |
| V2-9 | LOW | v1 stays authorized after deploy | runbook |
| V2-10 | INFO | deeper band vs `_clamp` | not reachable at shipped geometry |
| V2-11 | **MED** | the LIVE Bond's wall sits inside `MAX_DEV` | **v1 only — informs V2-9** |

---

## V2-1 — MEDIUM (blocker). The site promises a floor that "buys every dip". At `BOUNTY_NEAR = 9000` it does not.

The Bounty engages roughly **59% below spot**. It is a crash catcher. Every one of these is now false for a v2
coin, and several are in `<meta>` descriptions and schema.org JSON-LD, so they propagate to search results and
social cards:

- `pad/index.html:491`, `:502` — "A floor that buys the dip … buys every dip, forever"
- `pad/index.html:545` — "Fees keep deepening the floor, it buys every dip, forever."
- `pad/promo.html:11`, `:18`, `:27`, `:30` — meta description / og / twitter / JSON-LD, "a floor that buys dips"
- `pad/promo.html:158`, `:215` — "buys every dip"
- `pad/rewards.html:7`, `:14` — "deepening a floor that buys dips"

**Not fixed here deliberately** — this is brand voice and the wording is yours, not mine to overwrite across five
files. The claim that *is* true and still strong: the floor is protocol-owned, permanent, cannot be pulled, and
grows with every trade; it catches a crash rather than every wiggle. Something like *"a floor that can't be
pulled"* / *"catches the crash"* carries the same weight without being false.

Note this copy is **currently true-ish for the live v1 coin** (wall at 200 ticks). It only becomes false when v2
is the launch path — so the copy change and the UI repoint must ship together.

## V2-2 — MEDIUM (blocker). Anti-snipe is advertised and no longer exists.

- `pad/create.html:283` — "**Anti-snipe**: auto-expiring opening guard, sells never blocked" — false on v2.
- `pad/docs.html:243`, `:486` — describes the factory running an anti-snipe opening buy / guard.
- `pad/assets/safety.js:120` — the safety checker tells holders "the anti-snipe guard is buy-side only and
  auto-expires". Vacuously true, materially misleading: a scanner reassuring people about a guard that is absent.
- `pad/admin.html:149-152` — the whole blocklist admin panel is dead for v2 coins (see V2-3).
- `pad/assets/wallet.js:217` — maps a revert to "The opening anti-snipe window caps buy size right now", an error
  that can no longer occur.

`create.html:191` ("get your bag before the snipers, no cap") is worth re-reading in this light too: with no
guard, the dev's advantage over a sniper is now *only* atomicity, which is still real but is the whole of it.

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

## V2-9 — LOW. v1 remains authorized on the router after v2 deploys.

`PadRouter.setFactory` is an allowlist, so v1 keeps its authorization and a coin **can still launch on it** and
receive the shallow, farmable wall. Closing that is `router.removeFactory(<v1>)`, which cannot disturb any live
coin (`register` is once-only and theirs is already done). The runbook calls this out as a decision, not a
default — leaving v1 open is a choice to keep an exploitable launch path available.

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

1. **Rewrite the floor copy** (V2-1) and the **anti-snipe copy** (V2-2). Blocking — these are claims to users.
2. ~~Re-run the H-5 sweep~~ — **done**, see V2-4. The fix is measured on the shipped contract.
3. Run the v2 launch + graduation end-to-end on a fork.
4. Decide V2-9 — revoke v1 or knowingly leave it open. **V2-11 strengthens the case for revoking.**
5. Verify both contracts on Blockscout; repoint `pad/assets/config.js`.
