#!/usr/bin/env bash
# Wire the advanced-feature addresses into indexer/.env and restart the indexer.
# Idempotent: upserts each key (replaces if present, appends if not). Touches nothing else.
#
#   REWARD_VAULT=0x… TOKEN_VESTING_LOCK=0x… ./scripts/enable-advanced.sh
#   (EPOCH_LEN + FINALITY_DELAY MUST match the deployed RewardVault; defaults below.)
set -euo pipefail
cd "$(dirname "$0")/.."   # indexer/
ENV=.env
[ -f "$ENV" ] || { echo "no indexer/.env — copy .env.example first"; exit 1; }

EPOCH_LEN="${EPOCH_LEN:-604800}"
FINALITY_DELAY="${FINALITY_DELAY:-86400}"

# Reject anything that isn't a 0x-prefixed 40-hex address before it reaches sed, so a
# malformed value can never carry sed metacharacters (| & \) that would mangle .env.
is_addr() { printf '%s' "$1" | grep -qiE '^0x[0-9a-f]{40}$'; }

upsert_addr() { # key address
  local k="$1" v="$2"
  [ -n "$v" ] || return 0
  if ! is_addr "$v"; then echo "  ✗ ${k}=${v} is not a 0x address — skipping (fix and re-run)"; return 1; fi
  if grep -qE "^${k}=" "$ENV"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV"
  fi
  echo "  set ${k}=${v}"
}

upsert() { # key value (numeric/plain — validated by the caller)
  local k="$1" v="$2"
  [ -n "$v" ] || return 0
  if grep -qE "^${k}=" "$ENV"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV"
  fi
  echo "  set ${k}=${v}"
}

echo "Wiring advanced-feature env into indexer/.env:"
upsert_addr REWARD_VAULT "${REWARD_VAULT:-}"
upsert_addr TOKEN_VESTING_LOCK "${TOKEN_VESTING_LOCK:-}"
[ -n "${REWARD_VAULT:-}" ] && { upsert EPOCH_LEN "$EPOCH_LEN"; upsert FINALITY_DELAY "$FINALITY_DELAY"; }

echo "Restarting the indexer…"
if command -v docker >/dev/null && [ -f docker-compose.yml ]; then
  docker compose up -d --build
elif command -v pm2 >/dev/null; then
  pm2 restart indexer || pm2 restart all
else
  echo "  (no docker/pm2 found — restart the indexer process manually)"
fi
echo "Done. The scorer/poster pick up the new addresses on boot; rewards stay compute-only until POSTER_KEY is set."
