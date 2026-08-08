# MinIO stopped publishing maintained Community Edition binaries in 2025.
# Build the signed security-fix release from source so FreeCord does not pin the
# older prebuilt image affected by the October 2025 session-policy CVE.
FROM golang:1.24.8-alpine AS build

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_MC_VERSION=RELEASE.2025-08-13T08-35-41Z
RUN CGO_ENABLED=0 go install github.com/minio/minio@${MINIO_VERSION} \
    && CGO_ENABLED=0 go install github.com/minio/mc@${MINIO_MC_VERSION}

FROM alpine:3.22
RUN apk add --no-cache ca-certificates su-exec \
    && addgroup -g 1000 minio \
    && adduser -D -H -u 1000 -G minio minio \
    && mkdir -p /data \
    && chown minio:minio /data
COPY --from=build /go/bin/minio /usr/local/bin/minio
COPY --from=build /go/bin/mc /usr/local/bin/mc
COPY --chmod=755 server/minio-entrypoint.sh /usr/local/bin/freecord-minio-entrypoint
COPY --chmod=755 server/minio-init.sh /usr/local/bin/freecord-minio-init
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/freecord-minio-entrypoint"]
CMD ["server", "/data", "--console-address", ":9001"]
