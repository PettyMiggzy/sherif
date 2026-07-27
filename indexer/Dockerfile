# Robin Labs Pad indexer — one container runs the poller + the JSON API.
FROM node:20-slim

# better-sqlite3 builds a native addon; slim needs build tools at install time.
# fontconfig + DejaVu are for the social share cards (sharp/librsvg renders the card's
# text through fontconfig; node:20-slim ships no fonts, so without these the card text
# would render blank in the container).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ fontconfig fonts-dejavu-core \
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
