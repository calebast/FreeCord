#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

/app/database/migrate.sh --init-community "${FREECORD_COMMUNITY_NAME:-FreeCord}" --slug "${FREECORD_COMMUNITY_SLUG:-freecord}"
exec node /app/server/dist/http-server.js
