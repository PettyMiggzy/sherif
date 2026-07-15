# The Sheriff's Pad — signing safety (audit before deploy)

Our anti-drainer rulebook was written for Solana / Phantom / Blowfish. Robinhood
Chain is an **EVM L2**, so the primitives are different (no `SystemProgram`, no
Jupiter, no client-side mint keypair) — but every safety rule maps 1:1. This
doc is the translation and the pre-deploy checklist. The enforcement lives in
`assets/wallet.js` (each rule is tagged `[Rule N]` in the code) and
`assets/config.js`.

Everything here is public. No RPC keys, no secrets — those never leave the
server / your `.env`.

---

## Rule-by-rule: Solana → EVM

### Rule 1 — No `approve` / `delegate` / `setAuthority` in a user-signed tx
The classic drainer signature. On EVM the equivalents are `approve`,
`increaseAllowance`, `setApprovalForAll`, and `permit`.

- **Launch** (`launch()`): approval-free. The only value moved is native ETH via
  `msg.value` (the optional dev buy). No token touches an allowance.
- **Buy** (`exactInputSingle`, `tokenIn = WETH` + `msg.value`): approval-free.
  We pay **native ETH**; the router wraps it. The buyer never approves anything.
- **Sell**: EVM has **no** approval-free way to sell a standard ERC-20 through an
  AMM. So this is the single, isolated approval in the whole app — and we keep it
  the safe form Blowfish does **not** flag:
  - **exact amount**, never `MaxUint256` / infinite;
  - to the **canonical, explorer-verified** SwapRouter only (never to us, never
    to an unknown contract);
  - **simulated first**, and only sent if allowance is short.
  We never use `permit` (a gasless approval is still an approval and reads as one
  to scanners).

### Rule 2 — One recipient, one signer, feePayer = the user. No fan-out.
- `launch()` sends to **one** contract (the factory). Swaps go to **one** router.
- No multi-recipient transfer is ever bundled into a signed tx. Any splitting
  (platform vs. creator, fee routing) happens **in-protocol or off-chain**, never
  as extra transfer calls in the user's tx.

### Rule 3 — Fees ride the protocol's native fee, not a side transfer
- Solana: Jupiter `platformFee` → referral account.
- EVM: our 1% is the **Uniswap 1% LP fee tier** (`POOL_FEE = 10000`), collected
  in-protocol by the pool. There is **never** an extra fee-transfer instruction
  bolted onto a user's swap. If a fee path is ever unavailable, trading still
  falls back to a plain swap — it never hard-fails.

### Rule 4 — Swaps are the standard single-signer shape
- Every EVM tx is single-signer by construction (`from` = the connected wallet).
  We use the canonical `exactInputSingle` shape — nothing custom that a scanner
  wouldn't recognize.

### Guard — simulate + balance-check BEFORE any signature
Phantom's scary red "malicious / blocked" screen is usually just *insufficient
funds*. We never let the user reach it:
1. `staticCall` the exact tx (an `eth_call` simulation) — catches contract
   reverts (anti-snipe cap, dev-buy > 2%, slippage) up front.
2. `estimateGas` (a second simulation) to price it.
3. `getBalance` ≥ `value + gasCost + GAS_BUFFER_WEI` — if not, we show a calm
   "Not enough ETH — needs ≈ X, you have Y" **locally**, and never open the
   wallet.
4. Only then send.

See `guardedSend()`.

### Link — `signMessage` for ownership, kept off the payment path
Binding a wallet to Telegram uses `personal_sign` (`linkTelegram()`) — a **free
signature, not a transaction**, never flagged. It moves no funds and is entirely
separate from any payment, exactly as on Solana.

### Deploy/launch — simulate before signing; nothing custom leaves the browser
Solana generates a mint keypair client-side. On EVM there is no client keypair:
the **factory contract** deploys the token deterministically on-chain. The
browser only builds and **simulates** the `launch()` call before asking for a
signature. Same spirit (nothing opaque leaves the browser, always simulate),
different mechanism.

---

## TL;DR checklist (enforced in code)

- ✅ Single-recipient, single-signer, feePayer = the user
- ✅ Simulate + balance-check before every signature
- ❌ No `approve` / `delegate` / `setApprovalForAll` / `permit` on launch or buy
- ⚠️ Sell = the one approval: **exact amount, verified router, simulated** (EVM
  has no approval-free AMM sell)
- ❌ No multi-recipient transfer inside a signed tx (splits are in-protocol)
- ✅ Fee = Uniswap LP fee tier, never a side transfer
- ✅ `signMessage` for ownership, separate from payment

---

## Pre-deploy checklist (fill `config.js`, then flip live)

Buys/sells and launch are **gated** until these are set — the UI honestly says
"opens at launch" and no tx can go to a zero/wrong address (`isDeployed()`).

1. Deploy `CurvePadFactory` (+ deployers) to Robinhood Chain. **Verify on the
   explorer.** Set `CONTRACTS.padFactory`.
2. Confirm the canonical Uniswap **SwapRouter02** address on Robinhood Chain,
   verify it, and set `CONTRACTS.swapRouter`. Confirm its `exactInputSingle`
   selector and the `unwrapWETH9` / `ADDRESS_THIS` (`0x…02`) sentinel used in
   `sell()` match the actual deployment.
3. (Recommended) Deploy/point `CONTRACTS.quoter` at a **QuoterV2** so `minOut`
   is exact instead of the spot-price estimate fallback.
4. Re-run the fork tests (`FORK_RPC=<archive rpc>`), including the dev-buy test,
   against the deployed addresses.
5. Independent review of `wallet.js` against this doc (the 7 tags above).
6. Test on Robinhood Chain with a real wallet: launch (no dev buy), launch (with
   dev buy), buy, sell, and the Telegram signature — confirm none trip Blowfish.

## Trust surface

- **`assets/wallet.js`** — ~250 lines, all in the open. The whole safety story.
- **`assets/config.js`** — addresses + ABIs, no secrets.
- **`assets/ethers.min.js`** — ethers **v6.13.4**, vendored (no runtime CDN), so
  the app is self-contained and pinned. Verify its hash against npm if desired.
- **RPC** — a public read-only endpoint for balances/quotes/simulation. The
  private archive RPC used by the fork tests is never shipped to the browser.
