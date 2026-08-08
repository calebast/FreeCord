# Contributing

Thanks for helping FreeCord. Keep changes focused, avoid committing deployment data or secrets, and describe platform-specific behavior explicitly.

1. Open an issue for substantial feature or architecture work.
2. Create a branch from `main`.
3. Run server tests, desktop type checks/build, Python contract tests, and migration validation.
4. Add tests for behavior changes.
5. Open a pull request with changed files, commands/tests run, failures, assumptions, and remaining risks.

Do not weaken Electron context isolation, sandboxing, IPC validation, authentication, authorization, or secret boundaries to simplify a feature. Do not include `.env`, tokens, personal deployment hostnames, user data, generated dependency trees, or release output in commits.

Database migrations are forward-only and must be additive. Coordinate shared API contracts and preload changes carefully because they affect server, main, preload, renderer, and tests together.
