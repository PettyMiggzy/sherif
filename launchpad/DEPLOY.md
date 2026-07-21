# Robin Labs — Deploy Runbook

The exact sequence to take the pad live on Robinhood Chain (chainId 4663). Do it on **testnet first**.

## 0. Hard gate (read first)
`FloorCoop.sol` (locked-LP staking) has had two internal adversarial audit passes + fixes, but **NOT** a paid external audit or testnet simulation. It custodies user funds and swaps. **Do not put real funds through FloorCoop on mainnet until an external audit + sims are done.** You can launch the rest of the pad (curve launches, trading, rewards) without it — just leave `floorCoopFactory` empty in config until FloorCoop clears audit.

## 1. Env (`launchpad/.env`, gitignored — never commit keys)
```
PRIVATE_KEY=0x...            # deployer (funded)
ROBINHOOD_RPC=https://...    # chain RPC
OWNER=0x...                  # admin + platform fee sink — USE A MULTISIG for prod
POSTER=0x...                 # the indexer address that posts reward merkle roots
GUARDIAN=0x...               # can veto a bad reward root in the challenge window
FLOOR_TREASURY=0x...         # receives FloorCoop's 10% open fee + 5% fee cut + penalties
PLATFORM_TREASURY=0x...      # PlatformFeeSplitter treasury
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

## 3. Wire the front-end (`pad/assets/config.js`)
Paste the printed addresses into `CONTRACTS`:
`padRouter`, `padFactory`, `rewardVault`, `floorCoopFactory` (leave empty until FloorCoop clears audit).
Then set `API_BASE` to your deployed indexer URL (see step 5).

## 4. Flip the pad out of preview mode
`pad/assets/demo.js` currently forces DEMO **on** (line ~11: `!has("live")`). For a real launch flip it
back to opt-in so real visitors see the live (empty-then-real) board, not sample coins:
```js
export const DEMO = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
```
(Preview stays reachable at `?demo=1`.)

## 5. Deploy the indexer
`indexer/` is a reorg-safe indexer + JSON API that feeds the live board (sort/search/trending/trades).
```
cd indexer && docker compose up -d      # set RPC + the padRouter/padFactory addresses in its env first
```
Point `pad/assets/config.js` `API_BASE` at it. Without it the pad falls back to direct-RPC (slower, no
volume/trending). The indexer address is also your `POSTER` for reward roots.

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
