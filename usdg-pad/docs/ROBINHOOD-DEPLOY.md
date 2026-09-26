# USDG Pad — Robinhood Chain deploy runbook

Deploys the pad (ported from `PettyMiggzy/tr`'s `launchpad/`, built for
Arc) on Robinhood Chain (chain 4663), with **USDG** as every pool's quote
asset. The contracts in `src/` are byte-identical to Tr's audited source;
only the deploy scripts, tests and docs changed.

## What it deploys

One broadcast (`script/DeployRobinhood.s.sol`, built on
`script/RobinhoodStack.sol`), reaching the same state Arc reached in three
separate deploys:

| contract | role |
|---|---|
| `RobinTreasury` | shared treasury; receives the platform cut in USDG; owner withdraws |
| `RobinHook` | the one shared Uniswap v4 hook (mined address, flags `0x28CC`): swap tax in USDG, pool creation and liquidity gated |
| `RobinPortal` | the original main pad. Deployed mainly to fill the hook's one-shot main-portal slot, which has no renounce. It also works as a plain pad (10% platform / 90% creator) |
| `PadRevenueSplitter` | implementation every white-label launch's splitter is cloned from |
| `RobinPadFactory` | sells white-label pads (`PAD_SETUP_FEE`, default $100 in USDG); owner can approve templates. Plugged into the hook, which closes the hook's factory slot |
| `PadPortalTemplate` | template #1 (plain pads), created by the factory |
| `HolderTokenDeployer`, `HolderPadTemplate` | template #2: pads whose creators can pay holders dividends in USDG; approved on the factory |
| house pad (`HolderPadPortal`) | the pad the site points at: platform 10%, tax 0-10%, opening market cap $100-$10k, no launch fee, open to all |

Both of the hook's one-shot admin slots end up closed, so the deployer key
cannot authorize any other pool-creating contract afterwards.

## Before you run it

- **Gas is ETH.** The whole deploy is about 33M gas: about 0.001 ETH at
  2026-09-26's 0.029 gwei. Hold ~0.005 ETH for headroom. It needs **no USDG**.
- **`--legacy` is required.** Robinhood Chain takes type-0 transactions only.
- **Pass `--with-gas-price 40000000` (0.04 gwei).** With `--legacy`, forge
  prices every transaction at the base fee it quoted at the start, with no
  headroom. On 2026-09-26 the base fee rose by 0.03% between quote and send
  and every transaction after the first was rejected ("max fee per gas less
  than block base fee"). 0.04 gwei is ~40% above that day's base fee. The
  chain only charges the base fee, so it costs no more in practice, but the
  wallet must hold enough to cover the higher cap up front.
- **A deploy that stops partway is safe to run again from the start.** Each
  contract is only wired to the ones deployed in the same run, so anything
  from an interrupted run is simply left unused. The one thing that can't be
  redone is the hook's address; if the hook itself did land, re-mining
  finds a different one automatically.
- **Toolchain is pinned** in `foundry.toml` (solc 0.8.26, cancun,
  `bytecode_hash = "none"`). The hook's CREATE2 salt is mined against the
  exact init code, so build with that config. The script re-checks the mined
  address before and after deploying and reverts before spending if it
  doesn't match.
- **Pick the house pad's name** (`HOUSE_PAD_NAME`, default "Robin Labs Pad"). It
  is stored on-chain.
- Prefer a keystore or hardware wallet over a raw key:
  `--account <keystore-name> --sender <address>` or `--ledger --sender <address>`.

## Run it

```bash
cd usdg-pad
export PATH="$HOME/.foundry/bin:$PATH"
bash script/setup-deps.sh          # clones lib/ at the commits pinned in foundry.lock
forge build
ROBINHOOD_FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test   # 86 tests, incl. real-chain fork tests

HOUSE_PAD_NAME="Robin Labs Pad" forge script script/DeployRobinhood.s.sol:DeployRobinhood \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --broadcast --slow --legacy --with-gas-price 40000000 --account <keystore-name> --sender <address>
```

Save every address it prints. The house pad's address is the one the site
uses as its portal.

## Rehearse first (recommended)

Run the exact same deploy against a local fork, then walk a real coin
through launch, buy, sell, flush, holder dividends and payouts:

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546
DEPLOYER_PRIVATE_KEY=<an anvil key> forge script script/DeployRobinhood.s.sol:DeployRobinhood \
  --rpc-url http://127.0.0.1:8546 --broadcast --slow --legacy
# then follow the header of script/RehearseOnFork.s.sol
```

Done on 2026-09-26 against block 73039921: deploy succeeded, and the
rehearsal passed (a $100 USDG buy taxed exactly 3%, the holders' 20% shared
and claimed in USDG, creator and platform paid exactly).

## After deploying

1. Verify source: `NETWORK=mainnet TREASURY=.. HOOK=.. PORTAL=<main portal> FACTORY=.. HOLDER_PAD=<house pad> DEPLOYER=.. bash script/verify.sh`.
   Blockscout and Sourcify both sit behind Cloudflare bot checks that can
   reject scripted requests; if every attempt gets a 403 "Just a moment..."
   page, retry later or use the explorer's web form.
2. Point the frontend at the house pad (and the factory, for white-label
   pads). The website has not been ported or reskinned for Robin Labs yet.
3. Treasury: the owner withdraws accumulated USDG with
   `RobinTreasury.withdraw(USDG, to, amount)`. Nothing is automated.

## Things that differ from Arc

- **Quote asset:** USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`,
  6 decimals, Paxos), not Arc's USDC predeploy. Same decimals, so every raw
  amount in the contracts (`100e6` = $100) means the same dollars. Wherever
  the source comments say "USDC", read "the quote asset".
- **Gas:** ETH, not USDC. `RobinTreasury.receive()` therefore accepts ETH
  here; the owner can withdraw it with `withdraw(address(0), ...)`.
- **Address ordering:** USDG sorts at `0x5f…`, Arc's USDC at `0x36…`, so a
  larger share of coins land as `currency0`. Both orderings were already
  covered by `test/AuditFixes.t.sol`, and `test/ForkRobinhood.t.sol` now
  checks both against real USDG.
- **USDG can freeze and pause**, like USDC. The design already keeps every
  payout pull-based, so a frozen address can only block its own claim, never
  a swap or anyone else's funds.
- **Uniswap v4 PoolManager** is at the same address on both chains
  (`0x8366a39CC670B4001A1121B8F6A443A643e40951`), as is the CREATE2
  deployer the hook is mined against.
