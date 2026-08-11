# Robin V4 — Testnet Bench (team only)

A **self-contained** static app that drives the **live V4 testnet contracts** — launch a coin (with in-browser
hook mining), buy, sell, and graduate. Faucet ETH only. **Nothing here touches the production `pad/` UI.**

It is a throwaway test harness, not the shipping frontend. Do not point it at mainnet.

## One-time setup (you)

1. **Deploy the testnet swap router** (so the bench can buy/sell from a browser):
   ```bash
   cd pad-v4
   PRIVATE_KEY=<hot-testnet-key> npx hardhat run scripts/deploy-testnet-extras.js --network robinhoodTestnet
   ```
   Copy the printed `PoolSwapTest` address — either paste it into `ADDR.swapRouter` in `staging/config.js`
   and re-serve, or just paste it into the app's “Swap router” field each session.

2. **Serve the folder, team-gated.** Any of:
   - **Vercel** (own project, password-protected): `vercel deploy pad-v4/staging --prod` then turn on
     Deployment Protection / a password in the project settings. Share the URL + password with the team.
   - **Quick local share:** `cd pad-v4/staging && npx serve` (or `python3 -m http.server`), expose via
     `cloudflared tunnel` / `ngrok`, hand the team the link.
   - It's `noindex,nofollow` + an unguessable path is enough for a short test window.

## How the team tests (each person)

1. Grab test-ETH from the faucet: <https://faucet.testnet.chain.robinhood.com>
2. Open the bench URL → **Connect wallet** (it adds/opens Robinhood Testnet, chainId 46630).
3. **Launch** a coin (name + symbol; leave supply at ~470,000 → graduates at ≈0.003 test-ETH).
4. **Buy** 0.001 ETH a few times, **Sell half**, watch the tick + balance move.
5. Keep buying until `ready=true`, then **Graduate** → the LP locks + the floor seeds.
6. Report anything weird in the Activity log.

## Regenerate config after a fresh deploy

If you redeploy the suite, refresh the embedded addresses/bytecode:
```bash
cd pad-v4 && npx hardhat compile && node scripts/gen-staging-config.js
```
Then update `ADDR` in `staging/config.js` with the new `deploy.curve.json` addresses (the generator writes the
current testnet set; edit if yours differ).

## Deps present on testnet
- PoolManager `0x8366…0951` ✓ · Permit2 `0x0000…22D473` ✓
- PositionManager: **only needed for graduation** — if it isn't at the mainnet address on testnet, the launch/
  buy/sell/stake steps still work; graduation is already proven by the mainnet fork test.
