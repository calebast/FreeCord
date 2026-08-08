#!/bin/sh
set -eu

config_dir=${FREECORD_MINIO_CONFIG_DIR:-/run/freecord-minio}
if [ -d "$config_dir" ]; then
  MINIO_ROOT_USER=$(cat "$config_dir/minio-root-user")
  MINIO_ROOT_PASSWORD=$(cat "$config_dir/minio-root-password")
  S3_ACCESS_KEY=$(cat "$config_dir/s3-access-key")
  S3_SECRET_KEY=$(cat "$config_dir/s3-secret-key")
  export MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY
fi

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"

alias_name=freecord
policy_file=/tmp/freecord-media-policy.json

if [ "$S3_ACCESS_KEY" = "$MINIO_ROOT_USER" ] || [ "$S3_SECRET_KEY" = "$MINIO_ROOT_PASSWORD" ]; then
  echo "S3 API credentials must be distinct from MinIO root credentials" >&2
  exit 1
fi

mc alias set "$alias_name" "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "$alias_name/$S3_BUCKET"

cat >"$policy_file" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET/*"]
    }
  ]
}
EOF

if mc admin user info "$alias_name" "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user enable "$alias_name" "$S3_ACCESS_KEY" >/dev/null
else
  mc admin user add "$alias_name" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
fi
if ! mc admin policy info "$alias_name" freecord-media >/dev/null 2>&1; then
  mc admin policy create "$alias_name" freecord-media "$policy_file"
fi
mc admin policy attach "$alias_name" freecord-media --user "$S3_ACCESS_KEY"
