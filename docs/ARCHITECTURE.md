# Architecture

FreeCord deliberately separates desktop privileges, application data, realtime state, and media transport.

## Desktop client

- **Electron main:** owns windows, trusted persistence, OS media selection, protocol handling, secure token storage, and fixed-purpose external navigation.
- **Preload:** exposes a narrow typed API through `contextBridge`.
- **React renderer:** owns UI, local message encryption/decryption, local search, LiveKit room state, and audio controls. It has no Node.js integration.

Context isolation and renderer sandboxing remain enabled. The app does not load the server as remote renderer content. Server and media responses cross validated IPC boundaries.

## Server stack

- **FreeCord API:** authentication, authorization, invitations, channels, messages, roles, moderation, audit events, S3 mediation, realtime server-sent events, permission-filtered voice rosters, and short-lived LiveKit token issuance.
- **PostgreSQL:** permanent relational data and integrity constraints.
- **LiveKit:** WebRTC voice, screen video, and screen audio when capture is available.
- **MinIO:** S3-compatible avatars, emotes, and attachments.
- **Config initializer:** runs without networking and generates isolated
  service credentials once. Each runtime service mounts only its own
  read-only configuration volume.

Redis is not currently required. Presence and event fan-out are process-local, so the supported topology is one API replica. Multi-replica deployment requires a shared realtime backplane before it is safe.

## Trust and encryption boundaries

Desktop clients trust the configured API origin and the LiveKit URL issued by it. HTTPS/WSS certificates must be publicly trusted. API credentials and infrastructure secrets never belong in the desktop bundle.

Message text uses client-side AES-256-GCM. The invitation transfers the community chat key to a new member; the desktop stores it with Electron `safeStorage`. The server can observe message metadata and stores ciphertext. This alpha key model has no recovery, device enrollment, key rotation, or cryptographic membership revocation protocol.

Attachments, GIF URLs, voice, and screen media are not covered by message end-to-end encryption. TLS and WebRTC protect them in transit, while the self-hosted services can access their content.

## Realtime and recovery

The client receives application events over authenticated server-sent events and reconciles channels, members, and messages through paginated HTTP APIs. Access tokens are short-lived and refresh tokens rotate. LiveKit handles media reconnection; device hot-plug falls back to operating-system defaults when a saved device disappears.

Pre-join voice rosters use a read-only API seam backed by LiveKit's room administration interface. The server checks `voice.connect` per channel, shares a three-second room cache across callers, retains stale data for at most ten seconds during an outage, validates participant identities against active members in the same community, and returns only user IDs plus mute/deafen/screen-share hints. The Electron main process bounds and validates every nested response field before crossing IPC, and polling is single-flight. The service never returns LiveKit room names or connection identifiers, and desktop clients do not join hidden rooms. Joined-room LiveKit state overrides the polled roster and supplies speaking activity.

## Deployment boundary

Caddy proxies API HTTPS and LiveKit WebSocket signaling. LiveKit media bypasses Caddy over direct UDP, with direct TCP fallback. PostgreSQL and MinIO remain private to Compose. TURN, horizontal API scaling, automatic updates, and managed secret storage are future hardening work.

The five configuration volumes, PostgreSQL, and MinIO form one recovery unit.
Initialization fails closed when retained data and generated configuration are
incomplete or obviously mismatched; backups and restores must keep all seven
volumes aligned.
