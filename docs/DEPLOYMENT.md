# Deployment

This is the supported single-host deployment for one FreeCord community. Docker Compose runs the API, PostgreSQL, LiveKit, and MinIO. Caddy or another TLS reverse proxy runs on the host or on the same routable network.

## Requirements

- A Linux server with Docker Engine and Compose v2
- Two public DNS names: one for the API and one for LiveKit signaling
- A trusted TLS certificate for each name
- TCP `443` for HTTPS/WSS, TCP `7881` for LiveKit fallback, and UDP `50000-50010` for WebRTC media
- NAT forwarding for all of those ports when the server is behind a router

The included topology does not include TURN. Users behind restrictive or symmetric NAT may fail to establish media. Add a properly secured TURN service before treating FreeCord as universally reachable.

## Docker Compose

```sh
git clone https://github.com/calebast/FreeCord.git
cd FreeCord
cp .env.example .env
chmod 600 .env
```

Generate independent values for each secret. For example:

```sh
openssl rand -base64 48
```

Use a URL-safe PostgreSQL password or percent-encode it in `DATABASE_URL`. Never reuse the session, LiveKit, database, MinIO-root, or S3 application secrets.

After editing `.env` and the Caddy example:

```sh
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api livekit postgres minio
curl https://api.example.com/health
```

A healthy response reports the API, database, and LiveKit checks as `ok`.

## Portainer Git stack

Use these values when adding a stack from Git:

- Repository URL: `https://github.com/calebast/FreeCord.git`
- Repository reference: `refs/heads/main`
- Compose path: `compose.yaml`

Enter all non-commented variables from `.env.example` in Portainer's environment-variable editor. The values beginning with `change-me-` are examples only and must be replaced. Portainer must be allowed to build images from the repository.

On first startup, provide both `FREECORD_INITIAL_ADMIN_USERNAME` and `FREECORD_INITIAL_ADMIN_PASSWORD`. After the owner account is created and tested, remove both from the stack. Changing them does not reset the owner password.

## Reverse proxy and media ports

Adapt `deploy/Caddyfile.example` to your hostnames. The API hostname proxies `/health` and `/v1/*`; the RTC hostname proxies LiveKit's WebSocket signaling endpoint.

Caddy does not proxy WebRTC media. Route TCP `7881` and UDP `50000-50010` directly to the LiveKit container host. Do not expose PostgreSQL, MinIO port `9000`, or the MinIO console publicly.

## Persistent data

Compose creates two named volumes:

- `freecord_postgres-data`: accounts, channels, messages, roles, and audit events
- `freecord_minio-data`: avatars, emotes, and uploaded attachments

The exact prefix may vary with the Compose project name. Inspect it with `docker volume ls` rather than assuming a path.

Back up PostgreSQL and MinIO together so database object records match stored objects:

```sh
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > freecord.sql
docker run --rm -v freecord_minio-data:/source:ro -v "$PWD":/backup alpine \
  tar -C /source -czf /backup/freecord-minio.tar.gz .
```

Test restoration on a separate host. Treat backups as sensitive because attachments are server-readable and database rows include authentication and encrypted-message metadata.

## Upgrade

1. Back up both persistent stores.
2. Read `CHANGELOG.md` and release notes.
3. Pull the desired tag, not an unreviewed moving branch.
4. Run `docker compose config`.
5. Run `docker compose up -d --build`.
6. Check container health, API logs, sign-in, text, voice, and uploads.

Database migrations run during API startup and are forward-only. Alpha releases do not yet promise downgrade compatibility.
