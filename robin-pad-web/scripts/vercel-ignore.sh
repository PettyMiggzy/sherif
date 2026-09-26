#!/usr/bin/env bash
# The pad project's "Ignored Build Step" (vercel.json): exit 0 skips the build, exit 1 builds.
# Every push to the branch deploys both sites, and the pad's build costs build minutes, so it's
# skipped when nothing under pad-web/ changed since the pad's last successful deployment. Whenever
# that can't be told (no previous deployment, a shallow clone without it), it builds.
# An env-var-only change still needs a redeploy from the Vercel dashboard.
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
[ -n "$prev" ] || exit 1
git cat-file -e "${prev}^{commit}" 2>/dev/null || exit 1
git diff --quiet "$prev" HEAD -- . && exit 0
exit 1
