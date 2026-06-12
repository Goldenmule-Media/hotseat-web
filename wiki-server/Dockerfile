# Builds wiki-server only; its tsdown bundle inlines wiki + wiki-mcp source. wiki-models is
# NOT baked in — it's mounted at /models (see docker-compose.yml).
#
# BUILD CONTEXT is the repo root, not wiki-server/, so COPY paths are repo-relative.
# Compose sets context `.` + dockerfile `wiki-server/Dockerfile`; manual: `docker build -f wiki-server/Dockerfile .`
FROM node:22-slim
WORKDIR /app

# Install workspace deps from manifests first (cache layer); npm needs every workspace's
# package.json, but only wiki/wiki-mcp/wiki-server source is copied below.
COPY package.json package-lock.json tsconfig.base.json ./
COPY wiki/package.json ./wiki/
COPY wiki-models/package.json ./wiki-models/
COPY wiki-mcp/package.json ./wiki-mcp/
COPY wiki-server/package.json ./wiki-server/
COPY wiki-mirror/package.json ./wiki-mirror/
RUN npm ci

COPY wiki ./wiki
COPY wiki-mcp ./wiki-mcp
COPY wiki-server ./wiki-server
RUN npm run build -w wiki-server

ENV WIKI_SERVER_HOST=0.0.0.0 \
    WIKI_SERVER_STORAGE=file \
    WIKI_SERVER_DATA_DIR=/data \
    WIKI_SERVER_LOG_FORMAT=json \
    WIKI_SERVER_MODELS_DIR=/models

VOLUME ["/data"]
EXPOSE 4437 4439
CMD ["node", "wiki-server/dist/main.js"]
