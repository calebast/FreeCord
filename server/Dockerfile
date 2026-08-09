FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server
COPY server/tsconfig.json server/*.ts ./server/
RUN npm run build --prefix server

FROM node:22-bookworm-slim

ARG APP_VERSION=0.8.0-alpha.4

RUN apt-get update \
    && apt-get install --no-install-recommends --yes postgresql-client util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --chown=node:node database /app/database
COPY --chmod=755 --chown=node:node server/docker-entrypoint.sh /usr/local/bin/freecord-entrypoint
COPY --chmod=755 --chown=node:node server/config-init.sh /usr/local/bin/freecord-config-init
COPY --chmod=755 --chown=node:node server/config-finalize.sh /usr/local/bin/freecord-config-finalize

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV APP_VERSION=${APP_VERSION}

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/freecord-entrypoint"]
