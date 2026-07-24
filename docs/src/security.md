# Security Model

- **No proxies, no upgrades.** The contracts are immutable. The platform owner (Ownable2Step) can only set the fee wallet for *new* launches — never touch a live coin, its curve, or the Bond.
- **Floor-drain closed.** Graduation refuses to post above the ceiling — the only unbacked price zone. Anywhere inside the curve, moving price up costs real WETH that *joins* the raise, so a manipulated graduation price is one the attacker paid for, and the floor sits below it.
- **Conservation.** Every wei of WETH and every token is accounted for across the lifecycle — verified to the wei by a 300-run fuzz and a random-graduation battery.
- **Anti-snipe.** The creator's opening buy runs atomically inside the launch tx; a CREATE2 salt with per-launch entropy blocks pre-init pool DoS.
- **Fees in-protocol.** The 1% is the Uniswap LP fee tier, not a side transfer — no extra instruction is ever attached to a user's transaction.
- **No stranded protocol funds.** A coin's 0.1% deferred cut and floor escrow normally release at graduation; for a coin that never graduates, an owner-only `rescueUngraduated` recovers them to the platform. It moves only platform-owned escrow — never user, creator, or LP funds — and refuses a coin that has graduated.

## Audit & testing

Multiple internal audit passes — manual, a deep pre-production review, and a dedicated adversarial pass — plus heavy automated coverage. The core was attacked hard and held: floor-drain proven impossible, conservation exact, floor monotonic, anti-rug intact.

The full lifecycle is validated end-to-end by an automated headless test that drives the **real frontend** — launch, anti-snipe, buy, sell, creator fees, graduate + the Bond's three positions, LP staking (deposit, earn fees, withdraw), and admin — against a genuine Uniswap v3 deployment, plus fork tests against Robinhood Chain's live Uniswap v3 and 300-run conservation/graduation simulations. A live mainnet smoke test (`scripts/smoke-mainnet.cjs`) confirms the deployed bytecode before launch. A paid external audit is recommended before large TVL builds in the fund-custody contracts.

## Wallet safety

Buys are 100% approval-free (native ETH in). Sells use the single unavoidable EVM approval — an **exact-amount** approve to the canonical router only, never infinite and never to a personal wallet. Every trade is the standard single-signer swap shape, so a wallet's transaction scanner sees nothing unusual.

## Coin & transaction safety layer

Before anyone signs, the pad pre-vets **both the coin and the transaction**, out in the open (`assets/safety.js`). Three independent sources cover each other's blind spots — and the whole layer is strictly **read-only**: it never signs, never approves, never sends.

- **GoPlus token security.** GoPlus supports Robinhood Chain (chainId `4663`), so our coins get the same honeypot / tax / mintability / ownership-takeback / pausable-transfer scan that wallets like MetaMask, Blowfish and Blockaid consult. If our coins are clean here, wallets have nothing to red-flag. (GoPlus needs a few minutes to index a brand-new token — that's what the template check covers.)
- **Verified Robin Labs template.** Every coin launched by our factory runs our audited `LaunchToken` bytecode — not arbitrary user code. So we can prove a coin is a genuine Robin Labs launch (its record exists in our factory) and therefore *cannot* be a honeypot: **fixed 1B supply, no mint, no owner kill-switch, no pausable transfers, sells never blocked after the opening anti-snipe window, LP locked at graduation.** This holds from block one, before GoPlus indexes anything.
- **Transaction simulation.** Every state-changing action is simulated with `eth_call` *before* the wallet is asked to sign. A tx that would revert (honeypot sell, slippage, anti-snipe cap) never reaches the wallet — so the user sees "simulated ✓, you'll receive ~X" instead of the wallet's scary red failure screen.
