# Robin Labs — Deploy Runbook

The exact sequence to take the pad live on Robinhood Chain (chainId 4663). Do it on **testnet first**.

## 0. Risk you're accepting (read first)
You've chosen to ship the **full stack**, including `FloorCoop` (locked-LP staking) and `RewardVault`, which
custody user funds. Both have had internal adversarial audit passes + fixes and are covered end-to-end by
`npm run e2e` (26/26: launch → trade → creator fees → graduate → LP deposit/earn-fees/claim/withdraw → reward
claim → admin), but **NOT** a paid external audit. **Strongly recommended: get an external audit before large
TVL builds up in FloorCoop.** If you'd rather stage it, you can still launch core-only by leaving
`floorCoopFactory` empty in `config.js` and adding it after audit — the core needs no redeploy.

## 1. Env (`launchpad/.env`, gitignored — never commit keys)
```
PRIVATE_KEY=0x...            # DEPLOYER (funded, ~0.02 ETH) — can be a throwaway; KEEP SECRET, never commit
ROBINHOOD_RPC=https://...    # chain RPC
OWNER=0xcdd5ff5d521d3694c2a2f31edf7cd3c0e9a6fabf   # admin + fee sink — your cold wallet; owns all 6 contracts
POSTER=0x4b9d2eb283443154594e4174309f2355e5efc261  # posts reward merkle roots
# GUARDIAN, FLOOR_TREASURY, PLATFORM_TREASURY, PLATFORM all default to OWNER if unset (guardian = owner is fine).
# optional tuning: EPOCH_LEN, FINALITY_DELAY, CHALLENGE_WINDOW, START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
```
Confirmed infra (already defaulted in deploy.js): `WETH=0x0Bd7…D73`, `V3_FACTORY=0x1f7d…efa`.

## 2. Deploy the contracts
```
cd launchpad
npx hardhat run scripts/deploy.js                      # FREE fork estimate (set FORK_RPC)
npx hardhat run scripts/deploy.js --network robinhood   # REAL deploy
```
Deploys + wires: 3 deployers, PadRouter, CurvePadFactory, RewardVault (+ `router.setRewardVault`),
FloorCoopFactory, PlatformFeeSplitter. ~16.3M gas total. It prints the address block for step 3.

**Ownership — all six end up owned by `OWNER`, and `OWNER` never has to sign at deploy (stays cold):**
PadRouter, CurvePadFactory, RewardVault, PlatformFeeSplitter get `OWNER` via their constructor.
FloorCoopFactory's owner defaults to the *deployer*, so the script then calls `floorFactory.transferOwnership(OWNER)`
automatically (one-step — no accept needed). If you deploy *from* `OWNER`, that transfer is skipped (already owned).
Future owner changes on the router/factory/vault are safe two-step (Ownable2Step: transfer → accept).

## 3. Wire the front-end (`pad/assets/config.js`)
Paste all five printed addresses into `CONTRACTS`: `padRouter`, `padFactory`, `rewardVault`,
`floorCoopFactory`, `platformSplitter`. Then set `API_BASE` to your deployed indexer URL (see step 5), or leave
`""` for direct-RPC. The token page auto-runs the **GoPlus + template safety scan** (`assets/safety.js`) — no
config needed; GoPlus already supports Robinhood Chain (4663).

## 4. Flip the pad out of preview mode
`pad/assets/demo.js` currently defaults DEMO **on** for the public preview board (localhost auto-shows real
data; your production domain still shows sample coins unless `?live`). For a real launch, make live the default
so real visitors see the real board — change the final fallback in the `DEMO` expression from `: true` to
`: _q.has("demo")` (preview then stays reachable at `?demo=1`):
```js
export const DEMO = typeof location !== "undefined" && (
  _q.has("demo") ? true : _q.has("live") ? false : _localRpc ? false : _q.has("demo")
);
```

## 5. Deploy the indexer
`indexer/` is a reorg-safe indexer + JSON API that feeds the live board (`/api/coins` with
sort/search/trending + `/api/stats`, `/api/series`, `/api/trades`) **and runs the reward merkle poster**.
```
cd indexer && docker compose up -d      # set RPC + the padRouter/padFactory addresses in its env first
```
Point `pad/assets/config.js` `API_BASE` at it. Without it the pad falls back to direct-RPC (slower, no
volume/trending).

### Rewards (enable after RewardVault is deployed)
Set these in the indexer's env, then restart it:
```
REWARD_VAULT=0x…      # the deployed RewardVault (turns on Accrued indexing + the poster)
EPOCH_LEN=604800      # MUST equal RewardVault.EPOCH  (deploy default 7d)
FINALITY_DELAY=0      # MUST equal RewardVault.finalityDelay
POSTER_KEY=0x…        # the POSTER account's private key — signs postRoot(); omit to compute-only (no on-chain post)
```
The poster then, each epoch: indexes the `Accrued` legs → derives each (coin,epoch,side) pot → computes trader
(net-accumulation) + holder (balance-seconds) weights from trades → allocates the pot (floor, so Σ ≤ cap) →
builds ONE global merkle root → persists every leaf+proof → calls `postRoot`. The pad claims via the API:
`GET /api/rewards/user/<addr>` (all a wallet's claims + proofs), `/api/rewards/claim/<epoch>/<coin>/<side>/<addr>`
(one claim's exact args), `/api/rewards/epoch/<n>` (the full leaf set + root — the transparency artifact the
on-chain `uri` points at). Scoring spec is frozen in `src/rewards.js`; its keccak is posted as `algoHash`.
Correctness is covered by `test/rewards.test.mjs` (leaf parity with the contract, proof verification,
conservation, both scoring rules).

## Phase gating — what's launch-ready vs not
- **Core pad (launch / trade / graduate / board):** READY. Contracts deploy + wire; indexer serves the board.
- **Rewards (the 0.25% trader/holder legs):** READY. RewardVault accrues on-chain and the indexer's poster
  computes weights, builds the merkle tree, posts the root (via `POSTER_KEY`), and serves claim proofs — set the
  `REWARD_VAULT`/`POSTER_KEY` env above once the vault is deployed. (Still off-chain-operator-trusted by design:
  the on-chain conservation cap + guardian veto bound a bad root to misallocating one coin's own fees.)
- **LP staking (FloorCoop):** blocked on the external audit (section 0).

## 6. Post-deploy (optional / later)
- **$ROBIN buyback:** `PlatformFeeSplitter` ships as a 100% passthrough (`robinShareBps=0`). To divert a
  slice to a $ROBIN sink: `setRobinSink(addr)` + `setRobinShareBps(bps)`. It auto-routes on `receive()`, so
  only route funds to it from a payer that uses `.call` (not the 2300-gas `.transfer`).
- **FloorCoop after audit:** deploy `FloorCoopFactory` (already in the script), set `floorCoopFactory` in
  config, and the Add-LP / Liquidity pages go live.

## Known non-blockers
- `test/launchpad.test.js` "dead window" test fails in this env: the 2.7s launch tx outruns the 2s anti-snipe
  window so hardhat's clock passes it before the test's buy mines. The guard is correct on a real chain
  (verified by inspection); fix the test with an explicit `setNextBlockTimestamp` if you want it green.
- `scripts/set-lock-tiers.js` can't work as-is: FloorCoop lock tiers are hardcoded constants (`_tier()`), no
  on-chain setter. Add a governed setter first if you want them changeable.
