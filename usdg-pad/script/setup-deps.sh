#!/usr/bin/env bash
# Fetches lib/ dependencies at the exact commits pinned in foundry.lock,
# without relying on git submodule registration (a hand-written
# .gitmodules file alone does NOT register submodules with git — that
# only happens via `git submodule add`, which creates entries in
# .git/config. A source-only package like this one ships .gitmodules for
# documentation/reference, but reconstructing lib/ from scratch needs
# this script instead of `forge install`/`git submodule update`.)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lib

clone_pinned() {
  local dir="$1" url="$2" rev="${3:-}"
  if [ -d "lib/$dir/.git" ] || [ -f "lib/$dir/.git" ]; then
    # Present is not the same as pinned: a stale or `forge update`d
    # checkout would otherwise be accepted silently (audit deploy-config-3).
    if [ -n "$rev" ] && [ "$(git -C "lib/$dir" rev-parse HEAD)" != "$rev" ]; then
      echo "lib/$dir is at $(git -C "lib/$dir" rev-parse HEAD), expected $rev - fix it before building" >&2
      exit 1
    fi
    echo "lib/$dir already present at the pinned rev, skipping"
    return
  fi
  git clone "$url" "lib/$dir"
  if [ -n "$rev" ]; then
    git -C "lib/$dir" checkout "$rev"
  fi
  git -C "lib/$dir" submodule update --init --recursive
}

# Revisions match foundry.lock exactly — don't hand-edit either without
# updating the other from the same verification.
clone_pinned openzeppelin-contracts https://github.com/OpenZeppelin/openzeppelin-contracts cab19933c33c2ad1d4c7a84864a3601dddfd16f3
clone_pinned v4-core https://github.com/Uniswap/v4-core e50237c43811bd9b526eff40f26772152a42daba
clone_pinned v4-periphery https://github.com/Uniswap/v4-periphery 9969eec44cfdf07e24b41de47f40276a58401976
# forge-std is pinned too: its Script/Vm code runs inside the deploy script
# with cheatcode access next to the deployer key (audit deploy-config-3).
clone_pinned forge-std https://github.com/foundry-rs/forge-std 7239323e35487ba4339c93fe591065a63ce122aa

# v4-periphery carries its OWN nested v4-core submodule, independent of the
# top-level one just cloned above (audit finding D-5). This repo's
# remappings.txt already forces every `@uniswap/v4-core/` import — including
# v4-periphery's own — to resolve to the single top-level copy, so a
# mismatch here does NOT currently cause a divergent-types bug (verified:
# the only v4-periphery files this repo actually imports, LiquidityAmounts
# and HookMiner, both import v4-core via that aliased path, never a
# relative path into their own nested copy). Still worth knowing about, so
# a future v4-periphery file that DOES use a relative path doesn't silently
# compile against the wrong version.
TOP_LEVEL_V4_CORE_REV=e50237c43811bd9b526eff40f26772152a42daba
if [ -d "lib/v4-periphery/lib/v4-core/.git" ] || [ -f "lib/v4-periphery/lib/v4-core/.git" ]; then
  NESTED_V4_CORE_REV="$(git -C lib/v4-periphery/lib/v4-core rev-parse HEAD)"
  if [ "$NESTED_V4_CORE_REV" != "$TOP_LEVEL_V4_CORE_REV" ]; then
    echo "NOTE: lib/v4-periphery's own nested v4-core ($NESTED_V4_CORE_REV) differs from the top-level pin ($TOP_LEVEL_V4_CORE_REV)."
    echo "      Harmless today only because remappings.txt overrides every @uniswap/v4-core/ import to the top-level copy — do not remove that mapping."
  fi
fi

echo "Done. Run 'forge build' next."
