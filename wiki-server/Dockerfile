# wiki-server — durable Durable Streams host (DESIGN §8.2).
# Build from the package directory after `npm run build` (dist/ present).
FROM node:22-slim
WORKDIR /app

# Production deps only (the runtime needs @durable-streams/server).
COPY package.json ./
RUN npm install --omit=dev --no-package-lock

COPY dist ./dist

# Bind off-loopback INSIDE the container; put TLS + auth in a reverse proxy (DESIGN §9).
ENV WIKI_SERVER_HOST=0.0.0.0 \
    WIKI_SERVER_STORAGE=file \
    WIKI_SERVER_DATA_DIR=/data \
    WIKI_SERVER_LOG_FORMAT=json

VOLUME ["/data"]
EXPOSE 4437
USER node
ENTRYPOINT ["node", "dist/main.js"]
