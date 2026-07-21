# Headless E2E — launch the pad without MetaMask, a fork, or a faucet

```bash
npm run e2e        # from launchpad/
```

One command. It proves the **real** pad frontend can launch a coin on Robinhood-Chain-like
conditions, with nobody clicking anything. Exit code `0` = all green.

## What it does

1. **Boots a plain hardhat node** (unlimited local ETH, unlocked accounts). No fork, no archive RPC,
   no network — `FORK_RPC` is forced empty so it never tries to fork.
2. **Deploys a complete, real stack** (`scripts/e2e-deploy.cjs`): a genuine `UniswapV3Factory` from the
   `@uniswap/v3-core` artifact (the same chain-agnostic bytecode Robinhood Chain runs) + `MockWETH9` +
   the full pad (router, factory, reward vault, floor factory, splitter) — wired exactly like `deploy.js`.
3. **Stands up a "Robinhood Chain emulator" RPC proxy** in front of the node that reproduces the two
   quirks that broke MetaMask on the real chain:
   - `eth_maxPriorityFeePerGas` → `-32601` (the chain doesn't implement it),
   - `eth_sendTransaction` → **rejected** if it asks for more than the **2^24 (16,777,216)** per-tx cap.

   (It also triples any `estimateGas` result to force the over-estimate. In practice hardhat's own engine
   already caps `estimateGas` at that same 2^24 value, so the launch's ~36M estimate errors on the cap
   *exactly* like the real chain — the emulator just guarantees it either way.)
4. **Serves a copy of `pad/`** with `config.js` pointed at the proxy and the fresh addresses (your real
   `config.js` is never touched).
5. **Drives EVERY feature in headless Chromium** through an **injected wallet** (a local unlocked key —
   no MetaMask), asserting each in the UI *and* on-chain:
   - **Link Telegram** — a free `personal_sign` on `create.html` (never a tx).
   - **Launch** — the real Launch button on `create.html`; asserts a coin appears on-chain.
   - **Token page** — opens `token.html`, asserts it renders real data (no demo banner).
   - **Buy / Sell** — advances past the token's anti-snipe window (a trader arriving after the opening), then
     the real Buy button, then the Sell toggle (exact-amount approval → `router.sell`).
   - **Creator controls** — set graduation target, collect fees (`withdrawDev`), buy & burn (`burnDev`).
   - **Graduate** — climbs the curve, clicks the real Graduate button; asserts the Bond posts, on-chain
     `graduated()` flips true, and the page shows "Graduated".
   - **LP vault (lock liquidity)** — warms the pool's TWAP oracle, then deposit → claim fees → withdraw.
   - **Rewards** — accrues a 0.25% leg, advances the epoch, the poster posts a merkle root, then the frontend
     `claimReward` claims real ETH.
   - **Admin panel** — drives `admin.html` as the owner to withdraw the platform's accrued fees.

## Why it matters

If the launch lands here, it lands on Robinhood Chain: the proxy makes the local node behave like the
real chain, so this is a faithful regression test of the legacy-tx gas fix in
`pad/assets/wallet.js` (`guardedSend`). It caught, and now guards, the exact failure that showed up as
"no ETH" / "missing revert data" in MetaMask:

```
PASS  Telegram link via free signature works        (personal_sign)
PASS  UI reports launch success                      (Launched ✓)
PASS  a coin exists on-chain / real ERC-20           (E2EW, 1B supply)
PASS  estimateGas was hostile (36M+ over the cap) yet the launch still landed
PASS  the sent tx fit under the 2^24 per-tx cap      (0 rejected, 0 maxPriorityFee calls)
PASS  token page renders the real coin (no demo banner)
PASS  UI buy on the curve works                      (Bought ✓)
PASS  UI sell works (approval + router.sell)         (Sold ✓)
PASS  UI set graduation target (dev control)         (Target updated ✓)
PASS  UI collect creator fees (withdrawDev)          (Collected ✓)
PASS  UI buy & burn (burnDev)                        (Burned ✓)
PASS  curve reaches the graduation window
PASS  UI graduate succeeds (Bond posted, under the cap)
PASS  coin graduated on-chain with a live Bond
PASS  token page shows the Graduated stage
PASS  UI lock liquidity (FloorCoop deposit)          (shares minted)
PASS  UI claim floor fees / UI withdraw from floor   (shares → 0)
PASS  UI claim reward (RewardVault)                  (claimed real ETH)
PASS  admin panel withdraws platform fees            (escrow → 0)
```

24/24 primary checks green. Measured gas, all under Robinhood's 16,777,216 per-tx cap: **launch 12.9M ·
buy 228k · sell 223k · graduate 2.7M · floor deposit 496k · reward claim 88k**. `scripts/e2e-debug.cjs` is a
bare contract-level harness (no UI, no proxy) for reproducing these numbers / any revert directly.

## Artifacts

Everything runtime lands in `e2e/.run/` (git-ignored): the staged pad copy, deployed `addresses.json`,
and `shots/` — full-page screenshots of the create page after launch and the rendered token page.

## Requirements

- `npm install` (adds the `@uniswap/v3-core` and `playwright` devDeps).
- A Chromium for Playwright. CI/most machines: `npx playwright install chromium`. If a browser is
  pre-provisioned, point at it with `E2E_CHROME=/path/to/chromium`.

## Knobs

`E2E_DEBUG=1` traces every RPC method through the proxy. `E2E_NODE_PORT` / `E2E_PROXY_PORT` /
`E2E_WEB_PORT` move the ports (defaults 8545 / 8546 / 8547).
