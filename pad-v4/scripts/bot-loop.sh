#!/usr/bin/env bash
# Run BOTH fork bots against the live-forked deployed contracts, over and over, until TARGET consecutive
# all-green passes. A "pass" = both bots print "RESULT: N passed, 0 failed". Any failure resets the streak.
# Streak persists in a state file so the loop survives being cut by a per-call timeout and resumes.
cd /home/user/sherif/pad-v4 || exit 1
export FORK_RPC=https://rpc.testnet.chain.robinhood.com FORK_CHAINID=46630
SCR="/tmp/claude-0/-home-user-sherif/01029517-d6a2-53cc-bd34-e38f0a4e7c87/scratchpad"
STATE="$SCR/botloop.count"
TARGET=${TARGET:-5}
[ -f "$STATE" ] || echo 0 > "$STATE"

while :; do
  n=$(cat "$STATE")
  if [ "$n" -ge "$TARGET" ]; then echo "=== DONE: $n/$TARGET consecutive clean passes ==="; break; fi
  npx hardhat run scripts/fork-boundary-check.js > "$SCR/b.out" 2>&1
  npx hardhat run scripts/fork-e2e-bot.js       > "$SCR/e.out" 2>&1
  b=$(grep -E "RESULT:" "$SCR/b.out" | tail -1)
  e=$(grep -E "RESULT:" "$SCR/e.out" | tail -1)
  if echo "$b" | grep -q "0 failed" && echo "$e" | grep -q "0 failed"; then
    n=$((n + 1)); echo "$n" > "$STATE"
    echo "PASS ${n}/${TARGET}  |  boundary: ${b}  |  e2e: ${e}"
  else
    echo "0" > "$STATE"
    echo "FAIL — streak reset  |  boundary: ${b:-<none>}  |  e2e: ${e:-<none>}"
    echo "----- fork-boundary-check tail -----"; tail -18 "$SCR/b.out"
    echo "----- fork-e2e-bot tail -----";        tail -18 "$SCR/e.out"
    break   # stop on failure so it can be diagnosed rather than looping blind
  fi
done
