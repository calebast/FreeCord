# Configuration

FreeCord generates and persists its internal database, session, LiveKit, MinIO, and S3 credentials. A normal deployment only needs two values.

## Required on first deployment

| Variable | Purpose |
| --- | --- |
| `LIVEKIT_URL` | Public trusted signaling URL returned to clients, normally `wss://rtc.example.com`. |
| `FREECORD_INITIAL_ADMIN_PASSWORD` | Initial owner password. Use at least 12 characters. It is ignored after the first account is created and may then be removed. |

The initial username defaults to `admin`. When no bootstrap password is present, the username is ignored; this allows the password to be removed safely after initialization.

## Common options

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREECORD_INITIAL_ADMIN_USERNAME` | `admin` | Initial owner username. |
| `FREECORD_COMMUNITY_NAME` | `FreeCord` | Name of this installation's single community. |
| `FREECORD_COMMUNITY_SLUG` | `freecord` | Stable lowercase community identifier. |
| `FREECORD_API_PORT` | `8081` | Host port for the API reverse proxy. |
| `GIPHY_API_KEY` | blank | Enables server-side Giphy search. |
| `ALLOWED_ORIGINS` | blank | Comma-separated browser origins for CORS. Desktop-only deployments leave this blank. |
| `FREECORD_IMAGE_TAG` | `latest` | GHCR image tag. Pin a release tag for controlled production upgrades. |

## Networking and limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIVEKIT_SIGNALING_PORT` | `7880` | Host signaling port behind the TLS proxy. |
| `LIVEKIT_RTC_TCP_PORT` | `7881` | Direct WebRTC TCP fallback port. |
| `LIVEKIT_RTC_UDP_PORT_RANGE` | `50000-50010` | Direct WebRTC UDP media range. Keep firewall forwarding aligned. |
| `MINIO_CONSOLE_BIND` | `127.0.0.1` | MinIO console bind address. Do not expose it publicly. |
| `MINIO_CONSOLE_PORT` | `9001` | MinIO console port. |
| `MEDIA_MAX_UPLOAD_BYTES` | `26214400` | Upload maximum, capped by the API at 25 MiB. |
| `ACCESS_TOKEN_TTL_SECONDS` | `600` | API access-token lifetime. |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-session lifetime. |
| `LIVEKIT_TOKEN_TTL_SECONDS` | `60` | LiveKit participant-token lifetime. |

## Storage options

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3_REGION` | `us-east-1` | S3-compatible region label. |
| `S3_BUCKET` | `freecord-media` | MinIO bucket. Set only before first initialization. |

## Automatically generated internal secrets

The offline one-shot `config-init` service creates these values without logging their contents:

- PostgreSQL password
- API session secret
- LiveKit API key and signing secret
- MinIO root username and password
- Bucket-limited S3 application key and secret
- LiveKit server configuration

Credentials are split across `postgres-config`, `api-config`, `livekit-config`, and `minio-config`; runtime services mount only their own volume read-only. `config-state` records initialization and is finalized only after PostgreSQL and MinIO are ready, allowing an interrupted first boot to resume safely. Files are mode `0400`, directories are mode `0700`, and normal redeployment reuses them.

Treat all five configuration volumes plus `postgres-data` and `minio-data` as one backup and restore set. The initializer fails closed when configuration is missing but retained data exists, or when only one application data store remains. Do not delete or restore these volumes independently.

Advanced operators may seed values on the **first** deployment with `POSTGRES_PASSWORD`, `SESSION_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`. Existing generated files take precedence on later deployments, so changing these environment variables does not rotate credentials. Identifiers are restricted to letters, numbers, underscores, and hyphens; the PostgreSQL password must be URL-safe; service secrets must contain at least 32 characters and remain distinct.

The bootstrap owner password is necessarily visible to Portainer/Docker while supplied as an environment value. The API removes it from its process environment after loading it, hashes it for first-account initialization, and does not persist the plaintext; remove the value from Portainer after the owner exists. Do not put any server credential in the desktop application. Rotation currently requires coordinated maintenance and is not performed by ordinary redeployment.
