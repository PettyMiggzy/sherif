# v2 pad — deploy runbook

**v2 is a SECOND factory deployed alongside the live one, not a replacement.** The live factory keeps running
and the coin already launched on it keeps trading, untouched. Nothing about this deploy migrates, pauses, or
rewrites anything that exists.

```bash
npx hardhat run scripts/deploy-v2.js                       # fork dry-run + gas estimate (FORK_RPC)
npx hardhat run scripts/deploy-v2.js --network robinhood   # real — PRIVATE_KEY must be the ROUTER OWNER
```

## Why this is only two contracts

| piece | v2 | why |
|---|---|---|
| `BondDeployer` | **NEW** | carries the deep wall band into every v2 coin's Bond |
| `CurvePadFactory` | **NEW** | zero guard, creator-chosen supply, points at the new bond deployer |
| `PadRouter` | reused | `setFactory` is an **allowlist**, built so one router can serve two factories |
| `LaunchTokenDeployer` | reused | permissionless, stateless, "reused across factories"; folds `msg.sender` into its CREATE2 salt so two factories can never collide on an address |
| `CurvePoolDeployer` | reused | same — and its `CurvePool` takes `bondDeployer` as a plain address argument, so a new one drops straight in |
| `FeeConfig`, WETH, v3 factory | reused | shared infrastructure |

## What changes, and what it costs

**1. Deep Bounty wall (the H-5 fix).** The live wall starts 200 ticks (~2%) below spot, which is farmable: hold
the price down, let the wall fill at your price, take the spread. No duration or TWAP gate fixes that — holding
a price costs nothing per unit time, and on-chain a held price and a real crash are the same observation. v2
bounds the attacker in **capital** instead, starting the wall at 9000 ticks (~59% below), past the measured
profitability crossover (~6000) and inside saturation (~12000).

> **This changes what the floor IS.** At 9000 it is a **crash catcher**, not a dip buyer. Any copy that says the
> Bond "buys every dip" is now false and must be rewritten before v2 takes a single launch.

Retuning it later is a one-contract deploy: stand up another `BondDeployer` and point a factory at it. A live
coin's wall is fixed by whichever deployer its curve was born pointing at, so retuning never disturbs anyone.

**2. No anti-snipe guard, permanently.** Every v2 coin opens with no per-wallet cap, no max-tx, no cooldown and
no dead window — first block, any size, any wallet. Robinhood Chain is FCFS with no public mempool, so pending-tx
front-running is not reachable. **It does not remove launch sniping**: a bot polling for new pools can still buy
in the next block, and on FCFS the fastest bot wins deterministically rather than probabilistically. Taken
knowingly. Note `seedBlocklist` is permanently unusable on a no-guard coin (it is frozen once the window is past,
and there is no window).

**3. Creator-chosen supply.** `launchWithSupply(p, supply, startTickMag)`; `launch(p)` is unchanged and equals
`launchWithSupply(p, 0, 0)`. Supply is unbounded; the implied FDV is what is checked. See `SPEC.md`.

**4. Dev buy stays uncapped.** Unchanged from v1 — bounded only by the curve ceiling and the ETH sent.

## Preconditions

- **The deploy key must be the `PadRouter` owner.** Step 3 calls `router.setFactory`, and without it every v2
  launch reverts at `register`. The script checks this *first* and aborts rather than half-deploying.
- Curve geometry is deliberately identical to v1 (`201600 / 23000 / 22800`), so the raise and market-cap numbers
  in `SPEC.md` still hold. v2 is a security and supply change, not a re-calibration.

## After deploying

1. **Verify both contracts** on Blockscout.
2. **Point the UI** at the new factory (`pad/assets/config.js` → `padFactory`).
3. **Decide about v1.** It stays authorized on the router, so a coin *can* still launch on it and get the
   shallow, farmable wall. To close that:
   ```
   router.removeFactory(<v1 factory>)
   ```
   This cannot disturb any live coin — `register` is once-only and theirs is already done. It only stops NEW
   registrations. Leaving v1 authorized is a choice to keep an exploitable launch path open; make it deliberately.

## Source pinning

The repo's `contracts/` now describes **v2**. The live v1 instances are frozen bytecode and their source is the
tree as of the commit that deployed them — do not read current `Bond.sol` or `CurvePadFactory.sol` as a
description of what is running at the v1 addresses in `deploy.json`.

## Still to run before this is safe to launch on

`test/fork/bond-h5-attack.fork.test.js` re-runs the attack sweep against the parameterized wall. **It has not
been run against `BOUNTY_NEAR = 9000` since the parameterization** — the 9000 figure comes from the earlier sweep
against the settable `BondDeep` harness. Re-run it with an RPC before v2 takes real money, and confirm the
crossover is where it was measured.
