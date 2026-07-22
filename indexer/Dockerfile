# Robin Labs Pad indexer — one container runs the poller + the JSON API.
FROM node:20-slim

# better-sqlite3 builds a native addon; slim needs build tools at install time.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy the lockfile too so `npm ci` gives a reproducible, pinned dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Persist the SQLite db on a volume so restarts don't re-backfill.
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/robinlabs.db
EXPOSE 8787

CMD ["node", "src/server.js"]
