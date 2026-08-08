# Deployment

FreeCord supports a single-host Docker Standalone deployment through Portainer's Web Editor or Docker Compose v2. The stack pulls published images; it does not clone the repository or build on the server.

## Requirements

- A Linux host with Docker Engine and Compose v2, or Portainer using a Docker Standalone environment
- Two public DNS names: one for the API and one for LiveKit signaling
- Publicly trusted TLS certificates; self-signed certificates are not supported by the desktop client
- TCP `443` for HTTPS/WSS, direct TCP `7881`, and direct UDP `50000-50010`
- NAT forwarding for those ports when the server is behind a router

The included topology has no TURN server. Restrictive or symmetric NAT can still prevent media connections.

## Portainer Web Editor

1. In Portainer, open **Stacks**, choose **Add stack**, and select **Web editor**.
2. Name the stack `freecord`.
3. Copy the repository's complete [`compose.yaml`](../compose.yaml) into the editor.
4. Add these environment variables below the editor:

   ```dotenv
   LIVEKIT_URL=wss://rtc.example.com
   FREECORD_INITIAL_ADMIN_PASSWORD=replace-with-a-strong-unique-password
   ```

5. Optionally add `FREECORD_INITIAL_ADMIN_USERNAME`, `FREECORD_COMMUNITY_NAME`, `FREECORD_COMMUNITY_SLUG`, or `GIPHY_API_KEY`. See [Configuration](CONFIGURATION.md) for the full list.
6. Deploy the stack. Enable Portainer's option to pull a newer image when intentionally upgrading a moving tag.

`config-init`, `minio-init`, and `config-finalize` are one-shot jobs. An exited status with code `0` is expected. PostgreSQL, LiveKit, MinIO, and the API should remain running and become healthy.

After signing in successfully, remove `FREECORD_INITIAL_ADMIN_PASSWORD` from the stack and redeploy. The owner account remains; changing this bootstrap value is not a password-reset mechanism.

If an image pull reports `unauthorized`, confirm the GHCR package is public. If it reports `manifest unknown`, use `latest`, `main`, or an existing release tag from the package page.

## Docker Compose

```sh
git clone https://github.com/calebast/FreeCord.git
cd FreeCord
cp .env.example .env
chmod 600 .env
# Edit LIVEKIT_URL and FREECORD_INITIAL_ADMIN_PASSWORD.
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
```

The published service images currently target Linux AMD64. Exact release tags are preferred for controlled deployments; `latest` follows approved `main`.

## Reverse proxy and media ports

Adapt [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) to your hostnames. The API hostname proxies `/health` and `/v1/*`; the RTC hostname proxies LiveKit WebSocket signaling.

Caddy does not proxy WebRTC media. Route TCP `7881` and UDP `50000-50010` directly to the LiveKit host. Do not expose PostgreSQL, MinIO port `9000`, or the MinIO console publicly. The generated LiveKit configuration discovers the host's external IP for public/NAT deployments.

## Persistent data and credentials

Compose creates seven named volumes:

- `config-state`, `postgres-config`, `api-config`, `livekit-config`, and `minio-config`: generated installation metadata and isolated service credentials
- `postgres-data`: accounts, channels, messages, roles, and audit events
- `minio-data`: avatars, emotes, and uploaded attachments

The Compose project name is added as a prefix. Use `docker volume ls` to see the exact names.

Back up and restore **all seven volumes together**. The initializer refuses to silently generate new credentials when retained application data is detected, and it refuses a deployment where only one of PostgreSQL or MinIO still contains data. The volumes contain plaintext secrets or user data; protect Docker, Portainer, the host, and backups accordingly.

Automatic generation is a convenience for single-host installs, not a managed secret vault. Advanced first-start overrides and current rotation limitations are documented in [Configuration](CONFIGURATION.md).

## Upgrade

1. Back up all seven persistent volumes as one recovery set.
2. Read `CHANGELOG.md` and release notes.
3. Set `FREECORD_IMAGE_TAG` to the desired exact release tag, or intentionally keep `latest`.
4. In Portainer, enable pulling a newer image and redeploy. With the CLI, run:

   ```sh
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

5. Verify sign-in, text, voice, and uploads.

Database migrations run during API startup and are forward-only. Alpha releases do not promise downgrade compatibility.
