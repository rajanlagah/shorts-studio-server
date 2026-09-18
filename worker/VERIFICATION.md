# Verification performed

- Installed dependencies and generated npm lockfiles for both projects.
- Syntax-checked API and worker JavaScript.
- Passed three validation tests in each project (UUID/path rejection, invalid edits, defaults/reused assets).
- Passed a real FFmpeg smoke test: portrait export, crop/fit, clips with/without audio, subtitle rendering, duration check, invalid source trim rejection.
- Applied database schema to PGlite (embedded PostgreSQL); checked backend RLS access and queue admission query.
- Exercised HTTP API against a local PGlite socket: session creation, unauthorized request rejection, streaming upload, job creation, duplicate outstanding job rejection.

Not verified here: Docker image builds, Caddy HTTPS, live Supabase connectivity/pooler/TLS, multi-connection PostgreSQL locking and full worker lifecycle, or a paid transcription request. PGlite's socket multiplexer could not reliably support the worker's dedicated lock connection plus pool connection, so it is not used as evidence of production queue behavior. Run a complete upload → export → download → expiry test on your Droplet before inviting users.

Run `npm test` in each project and `npm run test:media` in worker to reproduce the included tests. Setup steps are in README.md. This is a starter for a small pilot, not a deployed service.
