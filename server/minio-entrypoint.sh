#!/bin/sh
set -eu

config_dir=${FREECORD_MINIO_CONFIG_DIR:-/run/freecord-minio}
if [ -d "$config_dir" ]; then
  [ -r "$config_dir/minio-root-user" ] || { echo "MinIO root-user configuration is unavailable" >&2; exit 1; }
  [ -r "$config_dir/minio-root-password" ] || { echo "MinIO root-password configuration is unavailable" >&2; exit 1; }
  MINIO_ROOT_USER=$(cat "$config_dir/minio-root-user")
  MINIO_ROOT_PASSWORD=$(cat "$config_dir/minio-root-password")
  export MINIO_ROOT_USER MINIO_ROOT_PASSWORD
fi

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"

# Docker creates a missing bind-mounted host directory as root. Correct only
# the dedicated MinIO data root, then drop privileges before starting MinIO.
chown minio:minio /data
exec su-exec minio:minio minio "$@"
