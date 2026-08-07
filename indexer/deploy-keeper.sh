#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-shot: deploy + start the auto-graduate keeper (and LP-fee sweep) on the droplet.
#
# DO THESE ONCE, before running this script:
#   1) Fund a hot wallet with a little ETH on Robinhood Chain (chainId 4663) — ~0.1 ETH
#      is thousands of graduations. Use a DEDICATED wallet, not your deployer/cold key.
#   2) In indexer/.env set these two lines (this file lives ONLY on the server — never commit it):
#          GRAD_KEEPER_KEY=<that funded wallet's private key>
#          GRAD_KEEPER=1
#      and make sure RPC_URL is your WRITE-capable (Alchemy) endpoint, not the read-only Blockscout RPC.
#
# Then, from the repo on the droplet:  bash indexer/deploy-keeper.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"   # -> indexer/ (where docker-compose.yml lives)

echo "▶ pulling latest code…"
git pull --ff-only

if ! grep -qE '^\s*GRAD_KEEPER_KEY=..' .env 2>/dev/null; then
  echo "✗ GRAD_KEEPER_KEY is not set in indexer/.env — set it (+ GRAD_KEEPER=1) first, then re-run." >&2
  exit 1
fi

echo "▶ rebuilding + restarting the keeper container…"
docker compose up -d --build keeper

echo "▶ tailing the keeper log (Ctrl-C to stop) — you want to see:  [grad] running as 0x… poll 1000ms …"
docker compose logs -f --tail=40 keeper
