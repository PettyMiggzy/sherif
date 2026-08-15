# Arrow — the migration launcher

**Arrow** is a one-transaction migration launcher for Robin V4. A dev arrives with ETH and a committed snapshot of
their existing holders; Arrow buys out the whole curve, graduates the pad (LP locked), and hands the entire bought
supply to a no-withdraw distributor that the holders claim from. **The dev ends holding zero tokens.** The pitch:
*no dev wallet holds the bag, clean bubble map — through the curve, not around it.*

Arrow is a **composer over public interfaces**. It calls `factory.launch`, the public PoolManager swap path, and the
permissionless `curve.graduate()`. It modifies **nothing** in the audited curve / hook / factory.

## The one-tx flow (`ArrowLauncher.launch`)

1. **0.5 ETH off the top → platform.** A flat `PLATFORM_FEE = 0.5 ether` is sent to the timelocked platform wallet.
   The platform takes ETH only. `msg.value` must exceed the fee.
2. **Launch the pad.** `factory.launch(cfg, salts)` deploys token + hook + curve, initializes the pool at `startTick`,
   and seeds the single-sided curve (exactly `curveSupply` over `[gradTick, startTick]`).
3. **Buy out the whole curve.** One exact-input swap, **price-limited at `gradSqrt`**, sized to `_absorbableIn` (the
   exact ETH to walk `startTick → gradTick`, grossed up for lpFee then buyTax) **plus a +1% margin**. The margin
   guarantees the swap *reaches* the ceiling (the exact figure is a floor, a couple wei short → `graduate()` would
   revert `NotReady`); the price limit caps execution *at* `gradSqrt`, so the margin never overshoots. The hook taxes
   the requested input, so the over-request costs a negligible `margin·buyTax`; the unspent remainder is refunded.
4. **Graduate.** `curve.graduate()` — spot is exactly at `gradSqrt`, so `ready()`; the permanent LP is minted and
   **locked** in `LockVault`. The pad is live and un-ruggable.
5. **Airdrop.** A fresh `ArrowDistributor(token, merkleRoot)` is deployed and the **entire bought supply** transferred
   to it. Holders self-claim against the committed root.
6. **Refund.** Every ETH the launch didn't spend (unspent buyout budget + the graduation keeper bounty the launcher
   collected) is refunded to the dev. The dev keeps **no token** — only their ETH change.

The dev's ongoing economics are the ordinary **creator** stream — the sell tax + the graduation creator share,
claimable from the curve (`cfg.creator` = the dev's address). Never a token bag.

## The distributor (`ArrowDistributor`)

A no-withdraw merkle airdrop. The dev commits `merkleRoot` = the root of their ordered `(index, account, amount)`
holder snapshot (their CSV, hashed). It is **immutable** — the recipient set can never be swapped afterward.

- **Self-claim.** `claim(index, account, amount, proof)` is permissionless; the tokens **always** go to the leaf's
  `account`, never the caller. Anyone may pay the gas to claim on a holder's behalf.
- **No withdraw / rescue / owner path.** Token can *only* leave via a valid claim. The deployer cannot pull the
  supply back, redirect it, or change the root. **This absence is the "no dev holds the bag" guarantee.**
- **Ends at zero.** If the leaf amounts sum to the funded supply, full claims drain it to zero. Any unclaimed
  remainder stays **forever** (there is no path out) — unclaimed is burned-in-place, never returned to the dev.

Leaf encoding (must match the contract): `keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))`,
with OZ sorted-pair (`MerkleProof.verify`) internal nodes. See `test/sim/arrow.sim.test.js` for a reference builder.

## Things a dev / operator must get right

- **The dev funds the ENTIRE raise.** "Buy out the whole curve" means providing all the ETH that would normally come
  from many buyers. The buyout cost is **geometry × curveSupply**, not a fixed number — at the production geometry
  (start ~$3.4k / grad ~$34k) it's ~4.2 ETH; a different geometry or a larger `curveSupply` costs proportionally
  more. `launch` reverts `UnderfundedBuyout` if `msg.value − 0.5 ETH` can't cover it. Quote the real figure per
  geometry — do not promise a fixed buyout.
- **Commit amounts summing to ≤ `curveSupply`.** The distributor is funded with the bought supply (≈ `curveSupply`).
  If the committed amounts sum to *more* than was bought, the last claims fail (insufficient balance). Commit a sum
  ≤ `curveSupply`, leaving a tiny buffer; any shortfall is a dev error, not a contract bug.
- **`raise ∝ curveSupply`, but graduation market cap is INDEPENDENT of `curveSupply`.** Doubling `curveSupply`
  ~doubles the buyout the dev must fund, but graduation MC is set by the *ticks* (`gradTick` + total supply), not
  `curveSupply`. Two different levers — never promise a migrating team they move together.
- **Front-running.** Arrow reveals + uses the salts atomically in one tx (no commit-reveal window). On a public
  mempool a copycat could front-run `factory.launch` with the same salts, reverting the dev's tx (their ETH is
  returned) — the dev retries with a fresh salt. No theft is possible: a front-runner would be spending their **own**
  ETH to airdrop the **dev's** holders. On Robinhood Chain's single-sequencer FCFS ordering this isn't reachable.
- **Contract devs.** The ETH refund is a plain send to `msg.sender`; a dev contract that reverts on receive bricks
  its own launch (the whole tx reverts — no funds lost). Launch from an EOA, or an address that accepts ETH.
- **Post-graduation wiring is still the operator's job.** Arrow graduates the pad instantly but does **not** wire the
  staking pool / token treasury / floor vault — that's the standard post-graduation runbook (deploy the staking pool
  + `RobinTokenTreasury`, point the `LockVault` token leg + floor `tokenSink` + ambush at the treasury). Until then,
  the sell-side token LP fees **park** safely (the sinks are non-bricking / revert-and-retry), losing nothing.

## Tests

- `test/sim/arrow.sim.test.js` — full end-to-end on a real v4 stack at production geometry: launch → full buyout →
  atomic graduation → airdrop; asserts the dev holds zero token, the platform got exactly 0.5 ETH, holders self-claim,
  and the underfunded / below-fee / empty-root reverts.
- `test/unit/ArrowDistributor.test.js` — merkle claim correctness, one-claim-per-index, funds-to-account-not-caller,
  no-withdraw shape, ends-at-zero.

## Open money-path decisions (locked)

Off-top = **flat 0.5 ETH to platform**. Distributor = **merkle self-claim** (dev commits the holder root). Both per
the operator's decision. If teams span very different raise sizes and a flat fee is too blunt, `max(0.5 ETH, X%)` is
a localized change in `launch` (add a percentage floor before the buyout sizing).
