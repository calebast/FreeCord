#!/bin/sh
set -eu
umask 077

state_dir=${FREECORD_STATE_DIR:-/run/freecord-state}
postgres_dir=${FREECORD_POSTGRES_CONFIG_DIR:-/run/freecord-postgres}
api_dir=${FREECORD_API_CONFIG_DIR:-/run/freecord-api}
livekit_dir=${FREECORD_LIVEKIT_CONFIG_DIR:-/run/freecord-livekit}
minio_dir=${FREECORD_MINIO_CONFIG_DIR:-/run/freecord-minio}
postgres_data_dir=${FREECORD_POSTGRES_DATA_DIR:-/state/postgres}
minio_data_dir=${FREECORD_MINIO_DATA_DIR:-/state/minio}
postgres_uid=${FREECORD_POSTGRES_CONFIG_UID:-0}
postgres_gid=${FREECORD_POSTGRES_CONFIG_GID:-0}
api_uid=${FREECORD_API_CONFIG_UID:-1000}
api_gid=${FREECORD_API_CONFIG_GID:-1000}
livekit_uid=${FREECORD_LIVEKIT_CONFIG_UID:-0}
livekit_gid=${FREECORD_LIVEKIT_CONFIG_GID:-0}
minio_uid=${FREECORD_MINIO_CONFIG_UID:-0}
minio_gid=${FREECORD_MINIO_CONFIG_GID:-0}

case "$postgres_uid:$postgres_gid:$api_uid:$api_gid:$livekit_uid:$livekit_gid:$minio_uid:$minio_gid" in
  *[!0-9:]*) printf 'FreeCord configuration initialization failed: configuration UIDs and GIDs must be numeric\n' >&2; exit 1 ;;
esac

fail() {
  printf 'FreeCord configuration initialization failed: %s\n' "$1" >&2
  exit 1
}

for directory in "$state_dir" "$postgres_dir" "$api_dir" "$livekit_dir" "$minio_dir"; do
  mkdir -p "$directory"
done

# Compose normally starts only one initializer, but the lock also makes manual
# and concurrent starts deterministic. It is released automatically on exit.
exec 9>"$state_dir/.init.lock"
flock -n 9 || fail "another initializer is already running"

has_data() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

postgres_has_data=false
minio_has_data=false
has_data "$postgres_data_dir" && postgres_has_data=true
has_data "$minio_data_dir" && minio_has_data=true

manifest="$state_dir/manifest-v1"
completion="$state_dir/complete-v1"

required_file() {
  [ -s "$1" ] || fail "persistent configuration is incomplete; restore every FreeCord volume from the same backup or start with all volumes empty"
}

if [ -s "$manifest" ]; then
  required_file "$postgres_dir/postgres-password"
  required_file "$api_dir/postgres-password"
  required_file "$api_dir/session-secret"
  required_file "$api_dir/livekit-api-key"
  required_file "$api_dir/livekit-api-secret"
  required_file "$api_dir/s3-access-key"
  required_file "$api_dir/s3-secret-key"
  required_file "$livekit_dir/livekit.yaml"
  required_file "$minio_dir/minio-root-user"
  required_file "$minio_dir/minio-root-password"
  required_file "$minio_dir/s3-access-key"
  required_file "$minio_dir/s3-secret-key"
  cmp -s "$postgres_dir/postgres-password" "$api_dir/postgres-password" || fail "PostgreSQL credential copies do not match"
  cmp -s "$minio_dir/s3-access-key" "$api_dir/s3-access-key" || fail "S3 access-key copies do not match"
  cmp -s "$minio_dir/s3-secret-key" "$api_dir/s3-secret-key" || fail "S3 secret-key copies do not match"
  if [ -s "$completion" ] && { [ "$postgres_has_data" != true ] || [ "$minio_has_data" != true ]; }; then
    fail "an initialized data store is missing; restore PostgreSQL, MinIO, and configuration together"
  fi
  printf 'FreeCord internal configuration is ready.\n'
  exit 0
fi

if [ "$postgres_has_data" = true ] || [ "$minio_has_data" = true ]; then
  fail "configuration is missing while persistent application data exists; restore every FreeCord volume from the same backup"
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"
}

override_or_random() {
  variable=$1
  bytes=$2
  value=$(printenv "$variable" 2>/dev/null || true)
  if [ -n "$value" ]; then printf '%s' "$value"; else random_hex "$bytes"; fi
}

override_or_default() {
  variable=$1
  fallback=$2
  value=$(printenv "$variable" 2>/dev/null || true)
  if [ -n "$value" ]; then printf '%s' "$value"; else printf '%s' "$fallback"; fi
}

safe_identifier() {
  value=$1
  name=$2
  case "$value" in *[!A-Za-z0-9_-]*) fail "$name may contain only letters, numbers, underscores, and hyphens" ;; esac
  [ -n "$value" ] || fail "$name must not be empty"
}

safe_url_value() {
  value=$1
  name=$2
  case "$value" in *[!A-Za-z0-9._~-]*) fail "$name must be URL-safe" ;; esac
  [ -n "$value" ] || fail "$name must not be empty"
}

postgres_password=$(override_or_random POSTGRES_PASSWORD 32)
session_secret=$(override_or_random SESSION_SECRET 48)
livekit_key=$(override_or_default LIVEKIT_API_KEY "freecord_$(random_hex 12)")
livekit_secret=$(override_or_random LIVEKIT_API_SECRET 48)
minio_root_user=$(override_or_default MINIO_ROOT_USER freecord_storage_admin)
minio_root_password=$(override_or_random MINIO_ROOT_PASSWORD 32)
s3_access_key=$(override_or_default S3_ACCESS_KEY freecord_api)
s3_secret_key=$(override_or_random S3_SECRET_KEY 48)

safe_url_value "$postgres_password" POSTGRES_PASSWORD
safe_identifier "$livekit_key" LIVEKIT_API_KEY
safe_url_value "$livekit_secret" LIVEKIT_API_SECRET
safe_identifier "$minio_root_user" MINIO_ROOT_USER
safe_identifier "$s3_access_key" S3_ACCESS_KEY
[ ${#session_secret} -ge 32 ] || fail "SESSION_SECRET must contain at least 32 characters"
[ ${#livekit_secret} -ge 32 ] || fail "LIVEKIT_API_SECRET must contain at least 32 characters"
[ ${#minio_root_password} -ge 12 ] || fail "MINIO_ROOT_PASSWORD must contain at least 12 characters"
[ ${#s3_secret_key} -ge 32 ] || fail "S3_SECRET_KEY must contain at least 32 characters"
[ "$session_secret" != "$livekit_secret" ] || fail "session and LiveKit secrets must be distinct"
[ "$session_secret" != "$s3_secret_key" ] || fail "session and S3 secrets must be distinct"
[ "$livekit_secret" != "$s3_secret_key" ] || fail "LiveKit and S3 secrets must be distinct"
[ "$minio_root_user" != "$s3_access_key" ] || fail "MinIO root and S3 application users must be distinct"
[ "$minio_root_password" != "$s3_secret_key" ] || fail "MinIO root and S3 application passwords must be distinct"

stage_file() {
  directory=$1
  filename=$2
  value=$3
  printf '%s' "$value" >"$directory/.freecord-next-$filename"
  chmod 0400 "$directory/.freecord-next-$filename"
}

stage_file "$postgres_dir" postgres-password "$postgres_password"
stage_file "$api_dir" postgres-password "$postgres_password"
stage_file "$api_dir" session-secret "$session_secret"
stage_file "$api_dir" livekit-api-key "$livekit_key"
stage_file "$api_dir" livekit-api-secret "$livekit_secret"
stage_file "$api_dir" s3-access-key "$s3_access_key"
stage_file "$api_dir" s3-secret-key "$s3_secret_key"
stage_file "$minio_dir" minio-root-user "$minio_root_user"
stage_file "$minio_dir" minio-root-password "$minio_root_password"
stage_file "$minio_dir" s3-access-key "$s3_access_key"
stage_file "$minio_dir" s3-secret-key "$s3_secret_key"

livekit_next="$livekit_dir/.freecord-next-livekit.yaml"
cat >"$livekit_next" <<EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50010
  use_external_ip: true
keys:
  $livekit_key: $livekit_secret
EOF
chmod 0400 "$livekit_next"

publish_staged() {
  directory=$1
  filename=$2
  mv "$directory/.freecord-next-$filename" "$directory/$filename"
}

publish_staged "$postgres_dir" postgres-password
for filename in postgres-password session-secret livekit-api-key livekit-api-secret s3-access-key s3-secret-key; do
  publish_staged "$api_dir" "$filename"
done
publish_staged "$livekit_dir" livekit.yaml
for filename in minio-root-user minio-root-password s3-access-key s3-secret-key; do
  publish_staged "$minio_dir" "$filename"
done

# The service images use fixed numeric users. Only each service-specific volume
# is readable by that service; no runtime container receives all credentials.
chown -R "$postgres_uid:$postgres_gid" "$postgres_dir"
chmod 0700 "$postgres_dir"
chown -R "$api_uid:$api_gid" "$api_dir"
chmod 0700 "$api_dir"
chown -R "$livekit_uid:$livekit_gid" "$livekit_dir"
chown -R "$minio_uid:$minio_gid" "$minio_dir"
chmod 0700 "$livekit_dir" "$minio_dir"

installation_id=$(random_hex 16)
printf 'version=1\ninstallation_id=%s\n' "$installation_id" >"$state_dir/.manifest-next"
chmod 0400 "$state_dir/.manifest-next"
mv "$state_dir/.manifest-next" "$manifest"
chmod 0700 "$state_dir"
printf 'Generated isolated internal credentials for a new FreeCord installation.\n'
