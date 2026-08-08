#!/bin/sh
set -eu

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

mc admin user add "$alias_name" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc admin policy create "$alias_name" freecord-media "$policy_file"
mc admin policy attach "$alias_name" freecord-media --user "$S3_ACCESS_KEY"
