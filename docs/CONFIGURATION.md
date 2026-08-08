# Configuration

Copy `.env.example` to an uncommitted `.env` file or enter equivalent values in Portainer. Blank values are intentional only where explicitly noted.

## PostgreSQL

| Variable | Required | Purpose |
| --- | --- | --- |
| `POSTGRES_DB` | Yes | Database created by the PostgreSQL container. |
| `POSTGRES_USER` | Yes | Database application user. |
| `POSTGRES_PASSWORD` | Yes | Strong database password. |
| `DATABASE_URL` | Yes | API connection string using the Compose hostname `postgres`. Percent-encode reserved password characters. |
| `DATABASE_SSL` | No | Keep `false` for the private Compose network; enable only with a correctly configured external TLS database. |

## Community and authentication

| Variable | Required | Purpose |
| --- | --- | --- |
| `FREECORD_INITIAL_ADMIN_USERNAME` | First start | Initial owner username; supply together with the password, then remove both. |
| `FREECORD_INITIAL_ADMIN_PASSWORD` | First start | Initial owner password; minimum 12 characters is recommended. |
| `FREECORD_COMMUNITY_NAME` | No | Display name for this single community. |
| `FREECORD_COMMUNITY_SLUG` | No | Stable lowercase community identifier. |
| `SESSION_SECRET` | Yes | Unique high-entropy secret for sessions and refresh-token protection. |
| `ACCESS_TOKEN_TTL_SECONDS` | No | Short-lived API access-token lifetime; default `600`. |
| `REFRESH_TOKEN_TTL_SECONDS` | No | Refresh-session lifetime; default `2592000` (30 days). |
| `ALLOWED_ORIGINS` | No | Comma-separated browser origins for CORS. Leave blank for desktop-only deployments. |

## LiveKit

| Variable | Required | Purpose |
| --- | --- | --- |
| `LIVEKIT_URL` | Yes | Public trusted signaling URL, normally `wss://rtc.example.com`. Returned to clients. |
| `LIVEKIT_API_URL` | Yes | Server-side LiveKit endpoint; keep `http://livekit:7880` in Compose. |
| `LIVEKIT_API_KEY` | Yes | Random LiveKit API key shared only by API and LiveKit. |
| `LIVEKIT_API_SECRET` | Yes | Strong signing secret shared only by API and LiveKit. |
| `LIVEKIT_TOKEN_TTL_SECONDS` | No | Participant token lifetime; default `60`. |
| `LIVEKIT_SIGNALING_PORT` | No | Host port mapped to signaling; default `7880`. Usually reached through the TLS proxy. |
| `LIVEKIT_RTC_TCP_PORT` | No | Direct TCP media fallback port; default `7881`. |
| `LIVEKIT_RTC_UDP_PORT_RANGE` | No | Direct UDP media range; default `50000-50010`. Keep host and firewall ranges aligned. |

## Object storage

| Variable | Required | Purpose |
| --- | --- | --- |
| `MINIO_ROOT_USER` | Yes | Private MinIO administrator used only during initialization. |
| `MINIO_ROOT_PASSWORD` | Yes | Strong MinIO administrator password. |
| `MINIO_CONSOLE_BIND` | No | Console bind address; default loopback only. |
| `MINIO_CONSOLE_PORT` | No | Host console port; default `9001`. |
| `MINIO_VERSION` | No | Pinned MinIO release used by the local image. |
| `MINIO_MC_VERSION` | No | Pinned MinIO client release used for initialization. |
| `S3_ENDPOINT` | Yes | API object endpoint; keep `http://minio:9000` in Compose. |
| `S3_REGION` | No | S3 region label; default `us-east-1`. |
| `S3_BUCKET` | No | Bucket initialized for FreeCord objects. |
| `S3_ACCESS_KEY` | Yes | Separate bucket-limited application access key. Do not reuse the MinIO root account. |
| `S3_SECRET_KEY` | Yes | Separate strong application storage secret. |
| `S3_FORCE_PATH_STYLE` | No | Keep `true` for the bundled MinIO service. |
| `MEDIA_MAX_UPLOAD_BYTES` | No | Maximum upload body, default `26214400` (25 MiB). Reverse-proxy limits must be at least this large. |

## Optional integrations and ports

| Variable | Required | Purpose |
| --- | --- | --- |
| `GIPHY_API_KEY` | No | Enables server-side Giphy search. Obtain and apply a key under Giphy's terms. |
| `FREECORD_API_PORT` | No | Host API port behind the reverse proxy; default `8081`. |
| `FREECORD_FILES_ORIGIN` | No | Desktop-process-only Copyparty origin. It is not consumed by Compose and must be present in the packaged client's process environment. The Copyparty host must allow embedding and use trusted HTTPS. |

## Secret rules

- Keep `.env` out of Git and limit it to the deployment administrator.
- Use a different random value for every secret field.
- Never put `DATABASE_URL`, LiveKit secrets, S3 secrets, or `SESSION_SECRET` in the Electron app.
- Rotate exposed secrets immediately, then revoke active sessions where applicable.
- The initial owner variables are bootstrap inputs, not an account-reset mechanism.
