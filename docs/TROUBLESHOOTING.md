# Troubleshooting

## The desktop says the server rejected the request

Confirm `https://your-api-host/health` succeeds with a trusted certificate, inspect `docker compose logs --tail=200 api`, and verify the client contains only the API origin—no `/v1` suffix. Bootstrap environment values do not overwrite an existing owner account.

## Voice stays connecting or reports unauthorized

Verify the system clocks, the API health response, matching LiveKit API key/secret values, and `LIVEKIT_URL`. Open TCP `7881` and UDP `50000-50010` directly to the LiveKit host. Caddy proxies signaling only. A short-lived token can expire if a join is delayed; leave and rejoin after restoring the connection.

## Local clients work but remote clients do not

This is normally DNS, NAT, certificate, or UDP forwarding—not an API-port issue. Test both hostnames from outside the LAN. Split DNS or host-file entries may help local testing but do not configure remote resolution. Restrictive NAT may require TURN, which is not included yet.

## CachyOS screen sharing fails

Install and start PipeWire, WirePlumber, `pipewire-pulse`, `xdg-desktop-portal`, and `xdg-desktop-portal-kde`, then log out and back in after changing portal packages. FreeCord automatically captures applications playing through the default speaker; no KDE routing is required. If audio fails, confirm the application is actively playing through the default output before starting the share. Run the AppImage from a terminal and include sanitized logs in a bug report.

## Attachments fail

Check `minio`, `minio-init`, and `api` health. Confirm S3 application credentials match, the bucket exists, and reverse-proxy body limits exceed `MEDIA_MAX_UPLOAD_BYTES`. Linux file selection also requires a functioning desktop portal.

## Resetting a member

An authorized owner/admin can reset a member password, clear persistent voice restrictions, or deactivate an account in Settings → Admin. Password reset revokes active sessions but cannot recover a message key that existed only on a lost device.

When reporting a problem, redact tokens, `.env`, passwords, private hostnames, IP addresses, and attachment URLs.
