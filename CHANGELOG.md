# Changelog

All notable public changes are documented here.

## Unreleased

## 0.8.0-alpha.5 - 2026-08-09

- Restored the previously working Electron loopback audio path on Windows while keeping isolated PipeWire capture Linux-only.

## 0.8.0-alpha.4 - 2026-08-09

- Restored native Electron fullscreen with synchronized compositor/window events.
- Replaced unreliable Chromium monitor-device discovery on Linux with an isolated PipeWire stream-audio sink and `pw-record` bridge.
- Excluded FreeCord participant audio from screen streams on Linux and made Windows screen audio fail closed when own-app isolation is unavailable.

## 0.8.0-alpha.3 - 2026-08-09

- Moved channel rename and deletion into an administrator-only right-click menu.
- Made the stream viewer use true fullscreen with distraction-free controls and a corner exit button.
- Added a dedicated unprocessed PipeWire/Pulse monitor-input path and source selector for Linux desktop audio.

## 0.8.0-alpha.2 - 2026-08-08

- Made the public Compose stack deployable directly from Portainer's Web Editor using GHCR service images.
- Added persistent automatic generation for internal PostgreSQL, session, LiveKit, MinIO, and S3 credentials.
- Reduced first-deployment inputs to the public LiveKit URL and initial owner password.
- Fixed desktop registration reporting failure after the server had already created the account and consumed the invite.
- Validate account requirements and secure local credential storage before submitting a one-time invite.

## 0.8.0-alpha.1 - 2026-08-08

- First public FreeCord source and installer release.
- Self-hosted single-community Docker Compose stack.
- Invite-only accounts, roles, channel administration, account recovery, and audit events.
- Encrypted text chat with reactions, edits, mentions, custom emotes, uploads, GIF search, local search, and shared-file browsing.
- LiveKit voice, device controls, RNNoise, screen sharing, and multi-stream viewing.
- Windows x64 and CachyOS/Arch x64 packaging.

This release starts a fresh public history and is not an in-place migration from earlier private prototype builds.
