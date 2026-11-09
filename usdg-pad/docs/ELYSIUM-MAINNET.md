# Elysium mainnet launch runbook (chain 99901)

**DEPLOYED Nov 9 2026 (blocks 3,035,141 to 3,035,644), every contract at the addresses below, verified on-chain (hook authorizes the portal, quote = USDC, admin owns treasury and PoolManager).**

**Earlier status (Nov 8 2026):** mainnet is already running (block 2.7M+). Public RPCs in use: `https://rpc.elyscan.live`
(primary) and `https://rpc-live.elysp.com` (backup); both agree on block hashes. Mainnet USDC =
`0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` (6 decimals; `l1Address()` is HyperEVM's native USDC and
HyperEVM's own gateway computes the same address). The deploy was rehearsed on a fork of mainnet: `forge test`
(ForkElysiumTest) and the full browser E2E pass, and the real deploy lands at the addresses already in the site's
mainnet profile (deployer `0xDaF4…5fBD0` at nonce 0). What is left is funding the deployer and broadcasting.

Kinetiq publishes the public RPC, explorer and mainnet USDC address at launch
(https://elysium.kinetiq.xyz/docs/connecting-to-elysium and
/docs/contract-addresses). Nothing below needs a code change except filling
values in. Do not use the HypeDexer mainnet RPC: it is not public.

## 0. Decide before deploying (contract constants, not changeable after)
- Tax split: creators get 80% of a launch's tax and the platform 20% (current).
- LP fee: 1% of every trade to the platform (USDC side to the treasury, token side to the fee desk, sold 10% under the pool).
- Admin / owner of treasury, factory, PoolManager: `0x5899a0576A94327a6316E01190f951edf7645914`.

## 1. Fund the deployer
`0xDaF4749aC7e07EB6d2a37688053ED5f9f0B5fBD0` (its key stays in the session scratchpad, never in git).
Send about 0.02 HYPE on Elysium mainnet (the rehearsal deploy cost about 0.0013 HYPE).
HYPE bridges 1:1 from HyperEVM as native gas (Kinetiq docs: token bridging).

## 2. Pre-flight (reads only)
```
cd usdg-pad
RPC=<mainnet rpc> EXPECTED_CHAIN_ID=99901 QUOTE_TOKEN=<mainnet USDC> \
DEPLOYER=0xDaF4749aC7e07EB6d2a37688053ED5f9f0B5fBD0 bash script/preflight-elysium.sh
```
Must end `PREFLIGHT PASSED` (chain id, CREATE2 deployer, Permit2, 6-decimal USDC, balance).

## 3. Rehearse on a fork of mainnet (free)
```
anvil --fork-url <mainnet rpc> --port 8549 --chain-id 99901
ELYSIUM_FORK_URL=https://rpc.elyscan.live ELYSIUM_CHAIN_ID=99901 ELYSIUM_USDC=0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65 forge test --match-contract ForkElysiumTest -vv
```

## 4. Deploy (one broadcast)
```
QUOTE_TOKEN=<mainnet USDC> EXPECTED_CHAIN_ID=99901 ADMIN=0x5899a0576A94327a6316E01190f951edf7645914 \
DEPLOYER_PRIVATE_KEY=<from scratchpad key.json> \
forge script script/DeployElysium.s.sol:DeployElysium --rpc-url <mainnet rpc> --broadcast --slow
```
Copy every printed address and the block number.

## 5. Point the site at it
Fill the `mainnet` profile in `elysium-pad-web/lib/config.ts` (rpcUrl, explorerUrl, usdc, portal, hook,
treasury, feeDesk, factory, poolManager, router, genesisBlock = the deploy block, backupRpc if any),
set `NEXT_PUBLIC_NETWORK` default to `'mainnet'`, update `scripts/e2e-fork.cjs` constants, commit, push,
then `redeploy_app elysium-pad` on the Vyre box (about 5 minutes).

## 6. Verify and sweep
- Verify sources on Conduit's Sourcify (`--verifier sourcify --verifier-url https://contracts.conduit.xyz`).
- Fork E2E against the mainnet fork (`scripts/e2e-fork.cjs`).
- Launch one small token from the site, buy and sell; check /admin collects.
- Sweep leftover HYPE from the deployer back to the admin wallet.
