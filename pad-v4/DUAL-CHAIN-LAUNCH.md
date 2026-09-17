# Dual-chain launch (Arc + Robinhood Chain) — matching contract address

## The ask

A creator picks Arc, Robinhood Chain, or both. If both, the token's contract address must be
IDENTICAL on both chains, and (like every Robin pad token) always end in the `1ab5` brand suffix.

## The finding: no new Solidity needed

Every pad-v4 infra contract (`DeterministicDeployer`, `RobinStateView`, `FeeWalletRegistry`,
`LockVault`, `CurveV4Deployer`, `RobinV4FeeConfig`, `CurvePadFactoryV4`) is deployed via **plain
CREATE** (see `scripts/deploy-curve.js` / `deploy-curve-arc.js` — both call `.deploy(...)`
directly, never through `DeterministicDeployer`/CREATE2, for themselves). A plain-CREATE address
is `f(sender, nonce)` **only** — constructor arguments never factor in. So:

- Arc's and Robinhood's real Uniswap v4 infra addresses (PoolManager/PositionManager/Permit2)
  being different never breaks address matching — they're only ever constructor args here.
- What has to match is the **deploy sequence**: the same deployer key, the same contracts, in the
  same order, starting from the same nonce, on each chain.

Once `CurvePadFactoryV4` lands at a matching address on both chains, a `launch()` call with an
identical `LaunchConfig` + identical `(tokenSalt, hookSalt, curveSalt)` produces an identical token
address on both — CREATE2 through `DeterministicDeployer` (now matching too), with the init-code
hash depending on `(name, symbol, decimals, supply, factory address)` — nothing chain-specific. A
creator mines the branded salt **once**; it's valid on every chain the stack is mirrored on.

## Proof

`scripts/prove-dualchain-address-match.js` proves this empirically against two independent local
Hardhat nodes (different chainIds, independently-deployed mock Uniswap v4 infra with *different*
addresses on each — same shape as the real chains). Run:

```bash
HARDHAT_CHAIN_ID=4663 npx hardhat node --hostname 0.0.0.0 --port 8610   # chain A (Robinhood-sim)
HARDHAT_CHAIN_ID=5042 npx hardhat node --hostname 0.0.0.0 --port 8611   # chain B (Arc-sim)
CHAIN_A_RPC=http://127.0.0.1:8610 CHAIN_B_RPC=http://127.0.0.1:8611 node scripts/prove-dualchain-address-match.js
```

Verified for real: all 7 infra contracts land at identical addresses on both chains; the same
mined salt + `LaunchConfig` launches the identical token address on both
(`0x9C9f886714CD6bDb4e5af2128dd1EfA6aD101Ab5` in the run this doc was written from) — matching the
pre-launch prediction, ending in `1ab5`, gas usage identical on both (~7.3M).

**Side finding, fixed in the proof script**: `eth_estimateGas` for a full `launch()` call
(production-scale geometry) returned a wildly inflated estimate (~21.9M) that tripped the node's
16.7M-per-tx cap outright. The REAL gas usage, measured with an explicit `gasLimit`, is ~7.3M —
comfortably under the cap. This looks like a gas-estimation quirk on CREATE2-heavy multi-step
transactions rather than a real constraint; a launch client should pass an explicit `gasLimit`
(something in the 10-16M range) rather than trusting automatic estimation for this call.

## What this means for real deployment (not yet done — needs funded wallets on both chains)

1. Generate ONE fresh deployer key. Fund it on both Arc and Robinhood Chain.
2. Run the exact same bootstrap sequence (`deploy-curve.js`'s contract order) against each chain
   with that key, as its very first transactions on each — nothing else sent from that key on
   either chain beforehand, or the addresses permanently diverge.
3. **Real risk to flag**: `deploy-curve.js` and `deploy-curve-arc.js` currently duplicate this
   sequence as two independently-maintained scripts (one legacy type-0, one EIP-1559). Nothing
   enforces they stay in lockstep — an edit to one without the matching edit to the other would
   silently break future address matching. Worth factoring the shared sequence into one function
   both scripts call, the same way `prove-dualchain-address-match.js`'s `bootstrap()` does. Not
   done here since that's a refactor of live deploy tooling; flagging rather than touching it
   without sign-off.

## The "pick Arc / Robinhood / both" launch flow

Each chain has its own independent `CurvePadFactoryV4` instance and its own `PoolManager` — there
is no cross-chain messaging in this design (deliberately: simplest possible, no bridge/relayer
trust assumptions). "Launch to both" is two separate `launch()` submissions, one per chain, using
the identical `(cfg, tokenSalt, hookSalt, curveSalt)`:

- The creator fills in their launch config once; the client mines the branded token salt once
  (valid on any chain the stack is mirrored on, per the proof above).
- The client shows the creator which chain(s) they want to launch on (checkboxes/toggle: Arc,
  Robinhood, or both).
- For each selected chain, the client submits `launch()` against that chain's factory, signed
  separately — the creator needs their own gas on each chain they launch on (no way around this
  without a bridge, which is out of scope).
- Both resulting curves trade completely independently (independent liquidity, independent price
  action, independent graduation) — they only ever share an address and a name/symbol/supply.

Not yet built: the actual client/UI code for this picker. No existing pad-v4 frontend exists yet
to wire it into (confirmed earlier this session) — this is ready to build once there's a live pad
UI to attach it to, or as its own standalone launch flow if that's wanted sooner.
