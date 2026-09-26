#!/usr/bin/env bash
# Verifies the pad's source on Robinhood Chain's Blockscout explorer
# (mainnet, chain 4663) or on Sourcify (VERIFIER=sourcify, any network). Needs no private key: verification only registers
# source against addresses that already have bytecode.
#
# Verified source is also what token scanners (GoPlus etc.) read as "open
# source"; an unverified contract is itself a red flag. Every launch token
# has identical runtime bytecode (plain ERC-20, no immutables), so once
# one is verified here Blockscout can match the rest.
#
# Usage (addresses from DeployRobinhood.s.sol's output):
#   NETWORK=mainnet TREASURY=0x.. HOOK=0x.. PORTAL=0x.. FACTORY=0x.. DEPLOYER=0x.. \
#   HOUSE_PAD=0x.. PAD_SETUP_FEE=100000000 LAUNCH_TOKEN=0x.. bash script/verify.sh
# FACTORY, HOLDER_PAD (the house pad DeployRobinhood builds; needs FACTORY),
# HOUSE_PAD (a template-#1 house pad, if you ever open one) and LAUNCH_TOKEN
# are optional.
# If the explorer's indexer lags the chain tip ("Address is not a
# smart-contract"), just re-run later.
#
# VERIFIER=sourcify sends it all to Sourcify instead (Blockscout imports
# Sourcify matches). Both sit behind Cloudflare bot checks that sometimes
# reject scripted requests outright (seen 2026-09-22 from a server); if every
# attempt gets a 403 "Just a moment..." page, retry later or verify through
# the explorer's web form in a browser.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${NETWORK:-}" in
  mainnet) CHAIN_ID=4663; VERIFIER_URL="https://robinhoodchain.blockscout.com/api/"; RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}" ;;
  testnet) CHAIN_ID=46630; VERIFIER=sourcify; VERIFIER_URL=""; RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}" ;;
  *) echo "set NETWORK=mainnet or NETWORK=testnet" >&2; exit 1 ;;
esac
: "${TREASURY:?}" "${HOOK:?}" "${PORTAL:?}" "${DEPLOYER:?}"
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 # the pad's quote asset (6 decimals)

verify() { # address, contract, constructor-args ("" for none)
  echo "== $2 at $1 =="
  local args=()
  if [ -n "$3" ]; then args=(--constructor-args "$3"); fi
  if [ "${VERIFIER:-blockscout}" = sourcify ]; then
    forge verify-contract "$1" "$2" --chain-id "$CHAIN_ID" --verifier sourcify ${args[@]+"${args[@]}"}
  else
    forge verify-contract "$1" "$2" --chain-id "$CHAIN_ID" --verifier blockscout --verifier-url "$VERIFIER_URL" ${args[@]+"${args[@]}"}
  fi
}

verify "$TREASURY" src/RobinTreasury.sol:RobinTreasury "$(cast abi-encode 'constructor(address)' "$DEPLOYER")"
verify "$HOOK" src/RobinHook.sol:RobinHook "$(cast abi-encode 'constructor(address,address)' "$POOL_MANAGER" "$DEPLOYER")"
verify "$PORTAL" src/RobinPortal.sol:RobinPortal \
  "$(cast abi-encode 'constructor(address,address,address,address,bool)' "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDG" true)"
if [ -n "${FACTORY:-}" ]; then
  # Owner = the deployer (see script/RobinhoodStack.sol). The splitter
  # implementation and template #1 are read back from the factory.
  SPLITTER_IMPL=$(cast call "$FACTORY" 'splitterImplementation()(address)' --rpc-url "$RPC")
  TEMPLATE=$(cast call "$FACTORY" 'padPortalTemplate()(address)' --rpc-url "$RPC")
  verify "$SPLITTER_IMPL" src/PadRevenueSplitter.sol:PadRevenueSplitter ""
  verify "$FACTORY" src/RobinPadFactory.sol:RobinPadFactory \
    "$(cast abi-encode 'constructor(address,address,address,address,address,uint256,address)' "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDG" "$SPLITTER_IMPL" "${PAD_SETUP_FEE:-100000000}" "$DEPLOYER")"
  # Created by the factory's constructor, so the factory is its deployer.
  verify "$TEMPLATE" src/PadPortalTemplate.sol:PadPortalTemplate \
    "$(cast abi-encode 'constructor(address,address,address,address,address)' "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDG" "$SPLITTER_IMPL")"
  if [ -n "${HOUSE_PAD:-}" ]; then
    # A template-#1 house pad. HOUSE_PAD_SETTINGS must be the settings it
    # was DEPLOYED with, not whatever it has now.
    verify "$HOUSE_PAD" src/PadPortal.sol:PadPortal \
      "$(cast abi-encode 'constructor(address,address,address,address,address,uint16,address,(uint16,uint16,uint16,uint256,uint256,bool,bool,uint256))' \
        "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDG" "$SPLITTER_IMPL" 1000 "$DEPLOYER" "${HOUSE_PAD_SETTINGS:-(0,0,1000,0,100000000,false,false,10000000000)}")"
  fi
fi
if [ -n "${HOLDER_PAD:-}" ]; then
  # Holder dividends (script/RobinhoodStack.sol): the token deployer,
  # template #2 and the house pad it built. All read back from the pad.
  : "${FACTORY:?HOLDER_PAD needs FACTORY}"
  SPLITTER_IMPL=$(cast call "$FACTORY" 'splitterImplementation()(address)' --rpc-url "$RPC")
  HOLDER_TOKEN_DEPLOYER=$(cast call "$HOLDER_PAD" 'holderTokenDeployer()(address)' --rpc-url "$RPC")
  HOLDER_TEMPLATE=$(cast call "$FACTORY" 'templateOf(address)(address)' "$HOLDER_PAD" --rpc-url "$RPC")
  verify "$HOLDER_TOKEN_DEPLOYER" src/HolderTokenDeployer.sol:HolderTokenDeployer ""
  verify "$HOLDER_TEMPLATE" src/HolderPadTemplate.sol:HolderPadTemplate \
    "$(cast abi-encode 'constructor(address,address,address,address,address,address,address)' "$FACTORY" "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDG" "$SPLITTER_IMPL" "$HOLDER_TOKEN_DEPLOYER")"
  # HOLDER_PAD_SETTINGS must be the settings it was DEPLOYED with; the
  # default is RobinhoodStack._housePadSettings().
  verify "$HOLDER_PAD" src/HolderPadPortal.sol:HolderPadPortal \
    "$(cast abi-encode 'constructor(address,address,address,address,address,uint16,address,(uint16,uint16,uint16,uint256,uint256,bool,bool,uint256),address)' \
      "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDG" "$SPLITTER_IMPL" 1000 "$DEPLOYER" "${HOLDER_PAD_SETTINGS:-(0,0,1000,0,100000000,false,false,10000000000)}" "$HOLDER_TOKEN_DEPLOYER")"
fi
if [ -n "${LAUNCH_TOKEN:-}" ]; then
  # Constructor args read back from the token itself: name, symbol, 1B supply, minted to the portal.
  NAME=$(cast call "$LAUNCH_TOKEN" 'name()(string)' --rpc-url "$RPC")
  SYMBOL=$(cast call "$LAUNCH_TOKEN" 'symbol()(string)' --rpc-url "$RPC")
  verify "$LAUNCH_TOKEN" src/RobinLaunchToken.sol:RobinLaunchToken \
    "$(cast abi-encode 'constructor(string,string,uint256,address)' "$NAME" "$SYMBOL" 1000000000000000000000000000 "$PORTAL")"
fi
