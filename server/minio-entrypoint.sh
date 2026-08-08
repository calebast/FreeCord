#!/bin/sh
set -eu

# Docker creates a missing bind-mounted host directory as root. Correct only
# the dedicated MinIO data root, then drop privileges before starting MinIO.
chown minio:minio /data
exec su-exec minio:minio minio "$@"
