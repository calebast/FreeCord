#!/usr/bin/env bash
set -Eeuo pipefail

config_dir=${FREECORD_API_CONFIG_DIR:-/run/freecord-api}

read_config() {
    path="$config_dir/$1"
    [[ -r "$path" ]] || { printf 'FreeCord configuration file is unavailable: %s\n' "$path" >&2; exit 1; }
    value=$(cat "$path")
    [[ -n "$value" ]] || { printf 'FreeCord configuration file is empty: %s\n' "$path" >&2; exit 1; }
    printf '%s' "$value"
}

postgres_user=${POSTGRES_USER:-freecord}
postgres_database=${POSTGRES_DB:-freecord}
[[ "$postgres_user" =~ ^[A-Za-z0-9_]+$ ]] || { printf 'POSTGRES_USER contains unsupported characters\n' >&2; exit 1; }
[[ "$postgres_database" =~ ^[A-Za-z0-9_]+$ ]] || { printf 'POSTGRES_DB contains unsupported characters\n' >&2; exit 1; }

if [[ -d "$config_dir" ]]; then
    postgres_password=$(read_config postgres-password)
    [[ "$postgres_password" =~ ^[A-Za-z0-9._~-]+$ ]] || { printf 'Generated PostgreSQL password is not URL-safe\n' >&2; exit 1; }
    export PGHOST=postgres PGPORT=5432 PGUSER="$postgres_user" PGDATABASE="$postgres_database" PGPASSWORD="$postgres_password"
    export DATABASE_PASSWORD_FILE="$config_dir/postgres-password"
    export SESSION_SECRET_FILE="$config_dir/session-secret"
    export LIVEKIT_API_KEY_FILE="$config_dir/livekit-api-key"
    export LIVEKIT_API_SECRET_FILE="$config_dir/livekit-api-secret"
    export S3_ACCESS_KEY_FILE="$config_dir/s3-access-key"
    export S3_SECRET_KEY_FILE="$config_dir/s3-secret-key"
    export S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}"
    export S3_BUCKET="${S3_BUCKET:-freecord-media}"
fi

: "${DATABASE_URL:-${DATABASE_PASSWORD_FILE:?DATABASE_URL or generated database configuration is required}}"

/app/database/migrate.sh --init-community "${FREECORD_COMMUNITY_NAME:-FreeCord}" --slug "${FREECORD_COMMUNITY_SLUG:-freecord}"
unset PGPASSWORD postgres_password
exec node /app/server/dist/http-server.js
