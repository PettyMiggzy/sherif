# Verify Disperse on Blockscout

Deployed: **`0xBF2904b4e31F751441C85590EDF10D8a592A9a38`** (Robinhood Chain, 4663)

The automated `hardhat verify` flow keeps getting rate-limited (429) on the RPCs.
Two reliable ways to get the green checkmark:

## Option A — Blockscout UI, Standard JSON (1 minute, no RPC needed)

1. Open `https://robinhoodchain.blockscout.com/address/0xBF2904b4e31F751441C85590EDF10D8a592A9a38`
2. **Contract** tab → **Verify & Publish** → method **"Solidity (Standard JSON Input)"**.
3. Fill in exactly:
   - **Compiler:** `v0.8.24+commit.e11b9ed9`
   - **Standard JSON Input file:** upload `launchpad/verify/Disperse.standard-input.json`
   - (settings are baked into the JSON: optimizer **enabled, runs 1**, evmVersion **paris**)
   - **Constructor args:** none
4. Verify → it matches and publishes the source.

## Option B — retry the automated verify when the RPC isn't throttled

```bash
cd launchpad
ROBINHOOD_RPC=<a non-rate-limited RPC> \
  npx hardhat verify --network robinhood 0xBF2904b4e31F751441C85590EDF10D8a592A9a38
```
(needs Node 22 for Hardhat; the settings above are already in hardhat.config.js.)

Verification is cosmetic — it publishes the source on the explorer. The contract
works and the pad feature is live regardless.
