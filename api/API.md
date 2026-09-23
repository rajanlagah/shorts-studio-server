# API contract — v0.1

Base URL: `https://YOUR_API_HOST`. JSON except uploads/downloads. Times are seconds.
Every session endpoint requires `Authorization: Bearer SESSION_TOKEN`.
Errors: `{ "error": "message" }`. Invalid input: 400; missing token/session: 404; expired: 410; oversized upload: 413; admission/rate limit: 429 or 503.

## Create session

`POST /v1/sessions`, no body. Returns HTTP 201:

```json
{"id":"SESSION_UUID","token":"SECRET_TOKEN","expiresInSeconds":7200}
```

Save the token: it is returned only once. There is no account or recovery flow.

## Upload one asset

`POST /v1/sessions/:id/assets` with multipart field `file`. One file per request; repeat for more clips. Do not manually set the multipart Content-Type boundary.

```js
const body = new FormData();
body.append('file', file);
const response = await fetch(`${base}/v1/sessions/${id}/assets`, {
  method: 'POST', headers: {Authorization: `Bearer ${token}`}, body
});
```

HTTP 201: `{"id":"ASSET_UUID","bytes":12345}`. Raw filenames are not used on disk. Upload completion is not media validation; processing may reject an unsupported/corrupt file.

## Submit transcription or export

`POST /v1/sessions/:id/jobs`, JSON:

```json
{
  "kind": "export",
  "edit": {
    "clips": [
      {"assetId":"ASSET_UUID_1","start":1.0,"end":4.0,"fit":"crop"},
      {"assetId":"ASSET_UUID_2","start":0.0,"end":3.0,"fit":"fit"}
    ],
    "captions": [
      {"start":0.2,"end":2.5,"text":"My first caption"},
      {"start":3.0,"end":5.8,"text":"My second caption"}
    ],
    "wordsPerCaption": 2,
    "captionStyle": "highlight"
  }
}
```

Clips play in array order. `start` and `end` are SOURCE times. Caption times refer to the FINAL timeline. `fit` defaults to `fit` (letterbox); `crop` is centered fill. Captions are styled by `captionStyle` (see "Caption styles" below); auto-transcription can group words into 1-4-word captions via `wordsPerCaption`. No video/audio speed changes. Asset IDs may be reused. Captions default to an empty array.

`wordsPerCaption` (integer, 1-4, optional) is only meaningful for `kind: "transcribe"`; it groups real word-level ASR timing into that many words per generated caption instead of whole-sentence segments, defaulting to 2 words per caption if omitted. `captionStyle` (optional, defaults to `"classic"`) is only meaningful for `kind: "export"`.

### Caption styles

`captionStyle` is a style object (all fields required):

```jsonc
{
  "font": "montserrat",          // font id, see table
  "weight": 700,                 // 400 | 700
  "italic": false,
  "size": 72,                    // 24..160, ASS px on the 1080x1920 canvas
  "color": "#FFFFFF",            // #RRGGBB
  "uppercase": false,
  "letterSpacing": 0,            // -5..20, ASS px
  "outline": {"width": 4, "color": "#000000"},                 // width 0..12
  "shadow":  {"depth": 0, "color": "#000000", "opacity": 0.5},  // depth 0..12, opacity 0..1
  "box":     {"enabled": false, "color": "#000000", "opacity": 0.6, "padding": 16}, // padding 0..40, square corners
  "position": {"anchor": "bottom", "offset": 0},               // top|middle|bottom, offset -600..600 (+ = up)
  "highlight": {                                               // "highlight the word being spoken"
    "enabled": false,
    "color": "#FFD60A",
    "background": {"enabled": false, "color": "#7C3AED", "opacity": 1},
    "scale": 100,                // 100..130 (%), active-word pop
    "dimOpacity": 1              // 0.2..1, opacity of the non-active words
  }
}
```

The legacy strings still work and are converted to the equivalent object: `"classic"` (Noto Sans
bold 58, white, 3px black outline, bottom) and `"highlight"` (same at 66, `#FFD60A`).

Each caption may also carry:

- `style` — a *partial* style object (any subset of the fields above, nested objects partial too).
  The caption's effective style is the global `captionStyle` deep-merged with it.
- `words` — `[{"start","end"}, ...]`, one entry per whitespace-separated word of `text`, in timeline
  seconds (max 60). Used for the word highlight. If it is missing or its length doesn't match the
  word count, the worker splits the caption's duration equally across its words.

Fonts (bundled in the worker; `weight: 700` / `italic: true` on a font without that face — globally or via a caption override — is rejected with 400):

| id | Family | Bold | Italic |
|----|--------|------|--------|
| `noto-sans` | Noto Sans | yes | yes |
| `montserrat` | Montserrat | yes | yes |
| `poppins` | Poppins | yes | yes |
| `oswald` | Oswald | yes | no |
| `anton` | Anton | no | no |
| `bebas-neue` | Bebas Neue | no | no |
| `bangers` | Bangers | no | no |
| `permanent-marker` | Permanent Marker | no | no |

Line breaking is explicit so the burned-in export and a client preview wrap identically: the text
(uppercased first if `uppercase`) is broken on spaces into lines of at most
`N = floor(900 / (size * 0.55))` characters; explicit newlines are kept, and a single word longer
than `N` stays on its own line. Position: `bottom` puts the text's bottom edge at
`y = 1680 - offset`, `middle` centers it at `960 - offset`, `top` puts its top edge at
`240 - offset` (x is always centered). A highlighted word's background box extends
`round(size * 0.12)` px around the word.

Set `kind` to `transcribe` and omit captions to generate word-grouped captions (see `wordsPerCaption` above). It calls OpenAI whisper-1 via the worker, sends extracted audio, and incurs provider usage charges. It does not export an MP4. No API key: job fails; manually supplied captions still work.

HTTP 202: `{"id":"JOB_UUID","status":"queued"}`.

## Poll status

`GET /v1/sessions/:id/jobs/:job`

```json
{
  "id":"JOB_UUID",
  "kind":"export",
  "status":"completed",
  "progress":100,
  "result":{"downloadReady":true},
  "error":null,
  "created_at":"ISO_TIMESTAMP",
  "finished_at":"ISO_TIMESTAMP",
  "expiresAt":"ISO_TIMESTAMP"
}
```

Status: queued / running / completed / failed. Progress is phase-based, not exact per-frame progress. A completed transcription has `result: {"captions":[...]}`. User should review generated text before export.

## Download export

`GET /v1/sessions/:id/jobs/:job/download` returns MP4 with Content-Disposition attachment. A plain anchor cannot supply an Authorization header; use fetch + Blob for this capped V1:

```js
const response = await fetch(`${base}/v1/sessions/${id}/jobs/${job}/download`, {
  headers: {Authorization: `Bearer ${token}`}
});
if (!response.ok) throw new Error('Download failed');
const url = URL.createObjectURL(await response.blob());
const a = document.createElement('a');
a.href = url; a.download = 'short.mp4'; a.click();
setTimeout(() => URL.revokeObjectURL(url), 60_000);
```

This buffers the output in browser memory. No range/resumable download support in this starter. Re-download remains available until expiry.

## Health

`GET /health` checks process liveness. `GET /ready` also checks DB connectivity. Neither endpoint checks worker health; inspect worker logs and queued job age.

## Accounts and projects — v0.1

A separate auth boundary from the anonymous editor sessions above: real Google-authenticated
users, each with a plan and a `builds_remaining` counter. Every endpoint below requires
`Authorization: Bearer USER_TOKEN`; a missing/expired/unknown token returns 401 (not 404/410 —
that convention is specific to the anonymous session endpoints).

### Sign in with Google

`POST /v1/auth/google`, JSON `{"idToken":"GOOGLE_ID_TOKEN"}` (from Google Identity Services on
the frontend). Verifies the token against Google's `tokeninfo` endpoint, upserts the user, and
returns HTTP 201:

```json
{"token":"USER_TOKEN","user":{"id":"...","email":"...","name":"...","avatarUrl":"...","plan":"free","buildsRemaining":3,"buildsResetAt":"ISO_TIMESTAMP"}}
```

`buildsRemaining` is `null` for unlimited plans (starter/pro). Requires `GOOGLE_CLIENT_ID` set on
the server; 503 if unset.

### Current user

`GET /v1/me` → the same `user` object as above. `POST /v1/logout` → 204, invalidates the token.

### Projects

`GET /v1/projects` → array of the caller's projects, most recently updated first (summary fields
only — no `edit`, kept light for the list view).
`GET /v1/projects/:id` → a single project, including its full `edit` (see below). 404 if not found
or not owned by the caller.
`POST /v1/projects`, optional JSON `{"title":"..."}` → HTTP 201, a new `draft` project.
`PATCH /v1/projects/:id`, JSON subset of `{"title","clipCount","duration","thumbnail","edit"}` → the
updated project (summary fields only in the response — `edit` is not echoed back). `DELETE
/v1/projects/:id` → 204.

A project looks like:

```json
{"id":"...","title":"...","status":"draft","clipCount":0,"duration":0,"thumbnail":null,"sessionId":null,"jobId":null,"createdAt":"...","updatedAt":"..."}
```

`status` is one of `draft`/`processing`/`completed`/`failed`.

### A project's saved edit (resume)

`GET /v1/projects/:id` additionally returns `"edit":{"clips":[...],"captions":[...]}` (defaults to
`{"clips":[],"captions":[]}` if never saved). `PATCH /v1/projects/:id` accepts the same shape as an
optional `edit` field:

```json
{"edit":{"clips":[{"assetId":"...","start":0,"end":2,"fit":"fit"}],"captions":[{"start":0,"end":2,"text":"..."}]}}
```

The saved edit may also include `captionStyle` (a style object or legacy string, see "Caption
styles"; a legacy string is stored as the converted object) and each caption's optional
`style`/`words`. A project saved without `captionStyle` returns none — the client picks its default.

0-5 clips, 0-500 captions; caption `text` and the clips array may be empty (a mid-typing caption, or
a freshly reset project, must be saveable). When `edit` is present in a `PATCH`, `clipCount` and
`duration` are derived from it server-side — any `clipCount`/`duration` sent in the same request
body are ignored.

**Video bytes are never sent to or stored by this endpoint.** `assetId` here is an opaque
client-generated id the frontend uses to match a clip back to its locally-cached video (IndexedDB);
it is unrelated to the session-scoped asset ids from `POST /v1/sessions/:id/assets` used during
actual export.

### Sync a project against its editor job

`POST /v1/projects/:id/sync`, JSON `{"sessionId":"...","jobId":"..."}` (the anonymous editor
session/job from the flow above) → `{"project":{...},"user":{...}}`. Re-reads the real job status
server-side (never trusts the client's claim), updates the project's status, and — the first time
an `export` job is observed `completed` for that project — decrements `builds_remaining` by one.
Returns 402 if the Free plan's builds are already exhausted. Call this right after submitting an
export and again once polling observes `completed`/`failed`, so the project and builds-remaining
count stay accurate.
