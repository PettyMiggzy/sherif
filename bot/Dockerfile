# $SHERIFF Buy Bot
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# Secrets come from the environment at runtime (do NOT bake .env into the image).
ENV NODE_ENV=production
CMD ["node", "buybot.js"]
