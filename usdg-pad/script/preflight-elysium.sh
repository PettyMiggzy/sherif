#!/usr/bin/env bash
# Go/no-go check before deploying the pad on an Elysium chain (testnet or mainnet).
#   RPC=<url> EXPECTED_CHAIN_ID=99901 QUOTE_TOKEN=<USDC> DEPLOYER=<address> bash script/preflight-elysium.sh
# Reads only; sends nothing. Exit 0 = every check passed.
set -u
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${RPC:?set RPC}; WANT=${EXPECTED_CHAIN_ID:?set EXPECTED_CHAIN_ID}; USDC=${QUOTE_TOKEN:?set QUOTE_TOKEN}; DEP=${DEPLOYER:?set DEPLOYER}
MIN_HYPE=${MIN_HYPE:-0.01}
CREATE2=0x4e59b44847b379578588920cA78FbF26c0B4956C
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
fail=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

got=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || { bad "RPC unreachable: $RPC"; exit 1; }
[ "$got" = "$WANT" ] && ok "chain id $got" || bad "chain id is $got, expected $WANT"
for pair in "CREATE2 deployer:$CREATE2" "Permit2:$PERMIT2" "USDC:$USDC"; do
  n=${pair%%:*}; a=${pair#*:}
  [ "$(cast code "$a" --rpc-url "$RPC" 2>/dev/null | wc -c)" -gt 4 ] && ok "$n has code ($a)" || bad "$n has no code at $a"
done
dec=$(cast call "$USDC" 'decimals()(uint8)' --rpc-url "$RPC" 2>/dev/null); sym=$(cast call "$USDC" 'symbol()(string)' --rpc-url "$RPC" 2>/dev/null)
[ "$dec" = "6" ] && ok "USDC has 6 decimals (symbol $sym)" || bad "USDC decimals is '$dec', the pad needs 6"
bal=$(cast balance "$DEP" --rpc-url "$RPC" -e 2>/dev/null); nonce=$(cast nonce "$DEP" --rpc-url "$RPC" 2>/dev/null)
python3 -c "import sys; sys.exit(0 if float('${bal:-0}')>=float('$MIN_HYPE') else 1)" && ok "deployer holds $bal HYPE (needs >= $MIN_HYPE)" || bad "deployer holds ${bal:-0} HYPE, needs >= $MIN_HYPE"
[ "$nonce" = "0" ] && ok "deployer nonce 0 (addresses match the rehearsal when the quote token matches)" || printf '  note  deployer nonce is %s, so addresses will differ from the rehearsal\n' "$nonce"
printf '  info  gas price %s wei, block %s\n' "$(cast gas-price --rpc-url "$RPC" 2>/dev/null)" "$(cast block-number --rpc-url "$RPC" 2>/dev/null)"
[ $fail = 0 ] && echo "PREFLIGHT PASSED" || echo "PREFLIGHT FAILED"
exit $fail
