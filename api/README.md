# Shorts V1 — API and worker

Two independent Node.js 22+ projects. Extract both ZIPs into the same parent folder:

```
shorts/
  api/
  worker/
```

This starter implements temporary uploads, a PostgreSQL job queue, ordered trimming/concatenation, fit/crop, fixed-style burned-in captions, optional automatic captions, authenticated downloads, and expiry cleanup. No FE is included. No permanent video storage, Redis, PM2, or user-account system is needed.

## 1. Supabase database

Use a new project. Follow `api/MIGRATIONS.md`: create the backend role once with `api/bootstrap.sql`, then run `npm run db:migrate` from `api/` with a separate admin connection. This creates the private `shorts` schema, tables, and RLS policies. Existing installations created with `api/schema.sql` can adopt migrations without recreating the backend role. Never put the database password in your frontend.

Copy the direct or **session pooler** connection details from Supabase Connect. Use `shorts_backend` as the direct username, or `shorts_backend.PROJECT_REF` for the session pooler. Port is normally 5432. Do NOT use the transaction pooler: the worker uses a session advisory lock. Both services must use the SAME database and role. For an IPv4 Droplet use the session pooler if the direct endpoint requires IPv6.

Use certificate-verified TLS. The sample uses `sslmode=verify-full`. If your endpoint needs a provider CA, download the CA from Supabase, mount it read-only into both containers, remove `sslmode` from the URL, and set `PG_CA_FILE` to the mounted path. Do not set `rejectUnauthorized=false`.

## 2. Configure

```
cp api/.env.example api/.env
cp worker/.env.example worker/.env
```

Set `DATABASE_URL` in BOTH files, URL-encoding special characters in the password. Keep `DATA_DIR=/data`. Set `CORS_ORIGINS` in `api/.env` to your exact Vercel origin, without a trailing slash. Multiple origins are comma-separated. Set `OPENAI_API_KEY` only in `worker/.env` if you want automatic captions; manual captions need no external API.

Keep credentials out of Git. `.env` is excluded from Git and Docker builds. Use your provider's retention settings for audio sent to transcription; local deletion does not control provider retention.

## 3. Start on a Droplet

Recommended initial pilot: 2 vCPU / 4 GiB RAM. Install Docker Engine and Compose. No host Node.js or FFmpeg installation is needed. Allow SSH only from trusted IPs and public TCP 80/443. Do not expose PostgreSQL or API port 3001 publicly.

From `api/`:

```
docker compose up -d --build
docker compose logs -f api worker
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
```

This starts the API and worker. `/health` is liveness; `/ready` checks the DB connection. Only API port 3001 is bound to loopback. API and worker share the named volume `shorts-v1_media`, mounted at `/data`. Do not run the worker compose separately when using the combined API compose.

The worker image and API image both include FFmpeg; the API does not process video, but using the same runtime dependencies simplifies the initial setup. The worker normalizes clips one at a time with limited FFmpeg threads. Compose limits CPU/RAM, but benchmark your own clips before increasing capacity.

## 4. HTTPS

Point an API hostname's DNS A record to the Droplet. Set `API_HOST` in `api/.env` and run:

```
docker compose --profile https up -d --build
```

Caddy provisions HTTPS when DNS and ports 80/443 are reachable. Set `TRUST_PROXY=true` only with the included Caddy topology, where clients cannot bypass the proxy. For direct local development set it to `false`.

The FE uploads and downloads directly from this HTTPS API, not through Vercel Functions. The worker has no public port. Supabase remains managed externally.

## 5. FE integration

Read `API.md` (included in both ZIPs). Preview selected File objects locally in your editor. Submit uploaded asset IDs and editing instructions to the API. Poll jobs every 2–3 seconds. Keep the session token in memory/sessionStorage and send it in the Authorization header; never put it in a URL.

For automatic captions: submit a `transcribe` job with the current timeline, poll for `result.captions`, let the user edit them, then submit an `export` job with that timeline and captions. Caption times are relative to the assembled timeline. If clips are moved/trimmed after transcription, the FE must remap captions or request a new transcription. This V1 intentionally does not implement per-source transcription caching or word highlighting.

## Lifecycle and limits

- Up to 5 uploaded assets and 500 MiB combined per session.
- Up to 5 timeline clips, 180 seconds final duration, 1080×1920 at 30 fps.
- MP4/MOV and WebM/Matroska containers only; decoder support depends on FFmpeg. Media is validated by the worker, not by its filename.
- Source dimensions at most 4096 per side and source duration at most one hour. Browser preview codec support is separate from worker support.
- One worker globally, one outstanding job per session, 20 outstanding jobs globally, 10 total jobs per session, and 20 sessions at once.
- Upload inactivity expires after 2 hours; completed processing sets session expiry to 1 hour. Starting another job or uploading extends the session. Download attempts grant at least 15 minutes to finish.
- Expiry applies to the entire session, including every export. Times are returned by the status endpoint. Queued/running sessions are protected from cleanup.
- Worker cleanup deletes files and DB metadata together when sessions expire; it runs between jobs, so cleanup is approximate, not exact to the second. If worker is down, cleanup resumes at restart.
- Failed job intermediates are removed immediately; original uploads remain until expiry for retry. Restart-interrupted jobs become failed; submit a new job rather than automatically spending on a duplicate transcription.
- Graceful shutdown aborts media work. Each child process has a 15-minute limit; each job has a 30-minute limit.
- Fixed white subtitle style with black outline. To change it, edit `ass()` in worker/src/media.js and match it in FE preview. No Remotion, transitions, music layers, arbitrary fonts, word highlighting, or project saving yet.

## Deployment updates

```
docker compose --profile https up -d --build
```

For first-time testing, building on the Droplet is fine. For ongoing deployments, build each Dockerfile in CI, push version-tagged images to your private registry, and replace the Compose `build:` entries with `image:` references. Then use `docker compose pull` followed by `docker compose --profile https up -d`. A ready-to-run CI workflow is not included because repository/registry names are not configured.

Container replacement preserves named volumes. **Do not run `docker compose down -v` while sessions are active.** Video files are not backed up. A destroyed Droplet loses videos even if DB rows survive. This shared-local-disk implementation requires a single Droplet; scaling across hosts requires shared/object storage first.

## Testing and operating

```
cd api
npm ci
npm test
cd ../worker
npm ci
npm test
npm run test:media
```

The media test needs FFmpeg/ffprobe on the test machine; they are already in the Docker images. It renders real synthetic clips with and without audio, verifies portrait dimensions and audio, and rejects invalid trim ranges. It does not contact Supabase or a transcription provider.

Check worker logs for detailed processing errors; clients get sanitized errors. Logs rotate through Compose. Monitor available disk, queue length, job duration, and failure rate. The API checks free space before uploads and limits session admission. Rate limits are per process and are for a small pilot; add stronger user quotas/abuse protection before a broad anonymous launch. Docker restart policies restart exited containers; they do not automatically recover a hung service just because a health endpoint fails.

## References

- https://docs.docker.com/compose/how-tos/production/
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://ffmpeg.org/ffmpeg-filters.html
- https://developers.openai.com/api/docs/guides/speech-to-text
