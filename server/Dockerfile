FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server
COPY server/tsconfig.json server/*.ts ./server/
RUN npm run build --prefix server

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends --yes postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --chown=node:node database /app/database
COPY --chown=node:node server/docker-entrypoint.sh /usr/local/bin/freecord-entrypoint

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/freecord-entrypoint"]
