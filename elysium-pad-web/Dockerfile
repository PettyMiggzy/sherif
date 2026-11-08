# Elysium Pad as a self-contained Node server (Next.js standalone output),
# for hosts that build a Dockerfile (the Vyre deploy box). Listens on 3000.
# Every NEXT_PUBLIC_* value has a default in lib/config.ts, so the build
# needs no env; server-only settings (DATABASE_URL, RPC_FALLBACK_URL, ...)
# come from the container's env at runtime.
FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
