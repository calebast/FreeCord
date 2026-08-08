# Security policy

## Supported versions

Only the newest published alpha receives security fixes. FreeCord has not completed an independent security audit and should be evaluated carefully before use with sensitive communities.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting feature on the FreeCord repository. Include the affected version, impact, reproduction steps, and any suggested mitigation without including real credentials or user data.

## Deployment responsibilities

- Use trusted TLS and strong unique secrets.
- Keep PostgreSQL, MinIO, and its console off the public internet.
- Expose only the documented API and LiveKit ports.
- Back up and patch the host and containers.
- Rotate any secret pasted into chat, logs, issues, or source control.
- Understand that attachments and media are not end-to-end encrypted.

Never submit `.env` files, session tokens, LiveKit tokens, presigned object URLs, passwords, private keys, or unsanitized logs.
