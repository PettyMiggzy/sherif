# Self-contained image for the coin auto-verifier (scripts/auto-verify.cjs).
# Bakes in the CURRENT build artifacts, so it verifies contracts compiled from THIS source. Build it
# AFTER a deploy (i.e. after `npx hardhat compile`) so the artifacts match the deployed bytecode.
#
#   build context = the launchpad repo root:
#     docker build -f docker/verifier.Dockerfile -t robinlabs-verifier .
FROM node:20-alpine
WORKDIR /app

# Only ethers is needed (no hardhat toolchain) — install first for layer caching.
COPY docker/verifier.package.json package.json
RUN npm install --no-audit --no-fund --omit=dev

# The verifier reads its own source + the compiled artifacts (build-info + the token/curve/bond .dbg.json).
COPY scripts ./scripts
COPY artifacts ./artifacts

ENV NODE_ENV=production
# Persisted scan progress lives here (mount a volume so restarts don't re-scan from block 0).
ENV STATE_FILE=/data/auto-verify-state.json
VOLUME ["/data"]

CMD ["node", "scripts/auto-verify.cjs"]
