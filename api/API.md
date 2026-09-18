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
    ]
  }
}
```

Clips play in array order. `start` and `end` are SOURCE times. Caption times refer to the FINAL timeline. `fit` defaults to `fit` (letterbox); `crop` is centered fill. No speed changes. Asset IDs may be reused. Captions default to an empty array. One fixed caption style.

Set `kind` to `transcribe` and omit captions to generate sentence/segment captions. It calls OpenAI whisper-1 via the worker, sends extracted audio, and incurs provider usage charges. It does not export an MP4. No API key: job fails; manually supplied captions still work.

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
