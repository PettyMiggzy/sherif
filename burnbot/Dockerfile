# Robin Labs Buyback & Burn Bot
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/app/data
VOLUME ["/app/data"]
CMD ["node", "index.js"]
