# Robin Labs Launch Bot
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# Secrets come from the environment at runtime (do NOT bake .env into the image).
# The encrypted wallet store persists in /app/data — mount a volume there.
ENV NODE_ENV=production DATA_DIR=/app/data
VOLUME ["/app/data"]
CMD ["node", "bot.js"]
