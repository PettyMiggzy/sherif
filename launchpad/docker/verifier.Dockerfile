# Self-contained coin auto-verifier (scripts/auto-verify.cjs). It COMPILES the contracts inside the
# image, so it needs NO pre-built artifacts on the host — `docker compose -f docker-compose.verifier.yml
# up -d --build` just works from a fresh git checkout. Rebuild it after a redeploy so the compiled
# bytecode matches the deployed contracts (it verifies coins by matching that bytecode on Blockscout).
FROM node:20
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install the exact toolchain from the lockfile (hardhat + solc + ethers), then compile — so the
# artifacts the verifier reads are byte-identical to what was deployed.
COPY package.json package-lock.json hardhat.config.js ./
RUN npm ci --no-audit --no-fund
COPY contracts ./contracts
COPY scripts ./scripts
RUN npx hardhat compile

# Deploy manifest → auto-verify reads FACTORY + factoryBlock from it (env vars still override).
COPY deploy.json ./deploy.json

ENV NODE_ENV=production
# Persisted scan progress (mount a volume so a restart doesn't re-scan from block 0).
ENV STATE_FILE=/data/auto-verify-state.json
VOLUME ["/data"]

CMD ["node", "scripts/auto-verify.cjs"]
