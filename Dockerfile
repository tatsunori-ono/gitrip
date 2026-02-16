FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Create non-root user for running the application
RUN groupadd -r -g 999 appuser && useradd -r -u 999 -g appuser -d /app appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /app /data \
    && chmod +x /app/docker-entrypoint.sh

# Persistent volume is mounted at /data by fly.toml
ENV DATABASE_PATH=/data/gitrip.db
ENV PORT=8080
EXPOSE 8080

# Start as root to fix volume permissions, then drop to appuser
ENTRYPOINT ["/app/docker-entrypoint.sh"]
