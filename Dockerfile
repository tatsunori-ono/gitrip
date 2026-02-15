FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Persistent volume is mounted at /data by fly.toml
ENV DATABASE_PATH=/data/gitrip.db
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/server.js"]
