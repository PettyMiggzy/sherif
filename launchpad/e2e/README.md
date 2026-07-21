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
5. **Drives `create.html` in headless Chromium** through an **injected wallet** (a local unlocked key —
   no MetaMask), clicks the real **Launch** button, and asserts the coin exists in the UI *and* on-chain,
   then opens its `token.html` page and asserts it renders real data (no demo banner).

## Why it matters

If the launch lands here, it lands on Robinhood Chain: the proxy makes the local node behave like the
real chain, so this is a faithful regression test of the legacy-tx gas fix in
`pad/assets/wallet.js` (`guardedSend`). It caught, and now guards, the exact failure that showed up as
"no ETH" / "missing revert data" in MetaMask:

```
PASS  UI reports launch success  (Launched ✓ tx 0x…)
PASS  a coin exists on-chain  (factory.tokenCount()=1)
PASS  launched token is a real ERC-20  (name="E2E Wolf" symbol="E2EW" supply=1000000000)
PASS  estimateGas was hostile (36M+ over the 2^24 cap) yet the launch still landed
PASS  the sent tx fit under the 2^24 per-tx cap  (0 rejected, 0 maxPriorityFee calls)
PASS  token page renders the real coin (no demo banner)
```

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
