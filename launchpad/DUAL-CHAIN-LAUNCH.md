# Dual-chain launch (Arc + Robinhood Chain) — matching contract address (v3)

Sibling of `pad-v4/DUAL-CHAIN-LAUNCH.md` — same claim, same mechanism, this pad's own contracts.

## The finding

Every v3 infra contract (`PadRouter`, `BondDeployer`, `CurvePoolDeployer`, `LaunchTokenDeployer`,
`CurvePadFactory`) deploys via **plain CREATE** (see `scripts/deploy-v2.js` — all `.deploy(...)`).
A plain-CREATE address is `f(sender, nonce)` only — constructor args (including the real Uniswap
v3 factory address, which genuinely differs between Arc and Robinhood Chain) never factor in. So
the same deployer key, running the same deploy sequence from the same starting nonce, lands every
infra contract — including `CurvePadFactory` itself — at the same address on both chains. Once
that holds, a `launchWithSalt()` call with an identical `LaunchParams` + identical mined salt
produces an identical branded (`1ab5`-ending) token address on both, via `LaunchTokenDeployer`'s
CREATE2 (salt bound to the caller, init-code hash depending only on `(name, symbol, supply,
factory address)` — nothing chain-specific).

## Proof

`scripts/prove-dualchain-address-match.js` proves this empirically against two independent local
Hardhat nodes, each running fresh REAL `@uniswap/v3-core` bytecode (different factory addresses on
each, same shape as the real chains):

```bash
HARDHAT_CHAIN_ID=4663 npx hardhat node --hostname 0.0.0.0 --port 8610   # chain A
npx hardhat node --hostname 0.0.0.0 --port 8611                        # chain B (v3's hardhat.config.js
                                                                         # doesn't parametrize chainId via env
                                                                         # the way pad-v4's does — cosmetic only,
                                                                         # doesn't affect the proof)
CHAIN_A_RPC=http://127.0.0.1:8610 CHAIN_B_RPC=http://127.0.0.1:8611 node scripts/prove-dualchain-address-match.js
```

Verified for real: all 5 infra contracts land at identical addresses on both simulated chains; the
same mined salt + `LaunchParams` launches the identical token address on both
(`0x5c7b06e6A7B6e38d1C3149fD2dBCFD91E9761aB5` in the run this doc was written from), matching the
pre-launch prediction, ending in `1ab5`, identical gas usage (~13.56M) on both.

**Side finding, same as pad-v4's**: a full `launchWithSalt()` call needs an explicit `gasLimit` —
the real usage (~13.56M) sits comfortably under the network's ~16.7M-per-tx cap, but without an
explicit limit the send can fail for unrelated reasons (an under-guessed default in a hand-rolled
script, as happened while writing this proof — not an automatic-estimation problem here the way it
was for pad-v4, just a reminder that this call is genuinely gas-heavy and a real launch client
should never leave the limit to a guess).

## What this means for real deployment (not yet done — needs funded wallets on both chains)

Same as pad-v4's doc: one fresh deployer key, funded on both chains, running the exact bootstrap
sequence `deploy-v2.js` already uses as its first transactions on each chain, nothing else sent
from that key beforehand on either chain. `deploy-v2.js` and any future v3-on-Arc deploy script
would need to stay in lockstep the same way pad-v4's `deploy-curve.js`/`deploy-curve-arc.js` do —
same drift risk, same recommendation to factor the shared sequence into one function both scripts
call rather than maintaining it by hand in two places.

## The "pick Arc / Robinhood / both" launch flow

Identical shape to pad-v4's: no cross-chain messaging, two independent `launchWithSalt()`
submissions (one per chain) using the same mined salt + config, each chain's curve trading
completely independently once launched. See `pad-v4/DUAL-CHAIN-LAUNCH.md` for the full writeup —
it applies here unchanged.
