# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/app.db
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
