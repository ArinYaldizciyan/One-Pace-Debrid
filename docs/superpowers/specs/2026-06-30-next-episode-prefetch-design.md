# Next-Episode Prefetch — Design

**Date:** 2026-06-30
**Component:** `src/index.js` (`handleResolve`)
**Status:** Approved, pending implementation plan

## Problem

When a user starts an episode that has never been played before, Stremio frequently
shows "Loading failed" on the first attempt and succeeds on a manual retry.

Root cause (confirmed via `wrangler tail` logs for episode 20x9 / SAB_9): the worker
itself is healthy — every resolve returns `302` to a valid Torbox CDN URL. The failure
is on the Torbox side: Torbox stages a file to its CDN edge **when the CDN URL is first
hit**, not when the worker calls `requestdl`. The worker receives a `Location` instantly
regardless, so the very first playback follows a CDN URL whose bytes are not yet served,
and the player times out → "Loading failed." Seconds later the file is staged and the
retry plays.

This is the same UX issue noted as "Remaining Concern #2" in
`docs/SHV-86-diagnostic.md`.

## Goal

Eliminate the first-play failure for the common binge case by warming the **next**
episode's CDN link in the background while the current episode plays, so that by the time
the user advances, the file is already staged on Torbox's edge.

## Key Facts

- Episodes within an arc share a single season-pack torrent. The next episode is the
  **same `torrent.id`, `fileIdx + 1`** (verified: SAB_9 = `fileIdx 8` → next is
  `fileIdx 9`, both in torrent `32034717`).
- A bare `requestdl` (`getDownloadUrl`) does **not** stage the file — only hitting the
  returned CDN URL does. Therefore warming requires an actual request to the CDN URL.
- `handleResolve` already holds the full `torrent` object (with `files[]`) for the
  current request, so no additional `findTorrent` call is needed to warm the next file.

## Design

Add a fire-and-forget prefetch step to `handleResolve()`, executed after the current
episode's `302` redirect is computed and immediately before it is returned.

### Trigger
On **resolve** (actual playback start), not on stream/browse requests.

### Lookahead
**One** episode (`fileIdx + 1`).

### Steps
1. Reuse the already-fetched `torrent` object. Compute `nextIdx = fileIdx + 1`.
2. If `nextIdx >= allFiles.length` → **skip** (arc boundary; no cross-arc lookup).
3. `nextFile = allFiles[nextIdx]`. If `nextFile` is not a video → skip.
4. Dedupe gate: check `caches.default` for marker key `prefetch:{infoHash}:{nextIdx}`.
   If present → skip (a prior probe in this play already warmed it).
5. Otherwise, write the marker (short TTL, ~5 min), then:
   - `getDownloadUrl(apiKey, torrent.id, nextFile.id)`
   - `fetch(torboxUrl, { redirect: 'manual' })` → read `Location` (CDN URL).
   - Warm it: `fetch(cdnUrl, { headers: { Range: 'bytes=0-0' } })` to trigger Torbox
     edge staging. Read minimal/no body; discard.
6. Wrap steps 4–5 (the network work) in `ctx.waitUntil(...)` so it runs after the user's
   redirect returns — **zero added latency** to the current playback.

### Why `Range: bytes=0-0`
A one-byte range GET triggers the CDN to begin serving (staging) the file with negligible
transfer. A `HEAD` is avoided in case the CDN does not stage on `HEAD`.

### Dedupe rationale
Stremio issues ~4 resolve probes per play (observed: one `HEAD` + several `GET`s). Without
a gate, each probe would warm the next episode again. The Cache API marker keyed by
`infoHash:nextIdx` ensures the first probe warms and the rest no-op.

### Plumbing
`handleResolve` does not currently receive `ctx`. Thread `ctx` from `fetch` →
`handleResolve` so `ctx.waitUntil` is available.

### Logging
Add a `PREFETCH` structured log line consistent with existing logs:
- skip reason (boundary / non-video / already-warmed), or
- next file name + CDN warm response status.

### Failure handling
All prefetch errors are caught and logged, never thrown. A failed or slow warm must never
affect the user's current playback or response.

## Scope

**In scope:** resolve-time, next-1, same-torrent warming with dedupe and logging.

**Out of scope (explicitly):**
- Cross-arc / boundary warming (first episode of a new arc may still cold-start once —
  acceptable, falls back to existing retry behavior).
- Lookahead greater than one episode.
- Stream/browse-time triggering.

## Testing

- Unit-level: next-index computation, boundary skip, non-video skip, dedupe gate
  (second call within TTL no-ops).
- The warm step (`getDownloadUrl` → CDN `Range` GET) is mocked; assert it is invoked with
  the correct `torrent.id` / `file.id` and only once per `infoHash:nextIdx`.
- Verify `ctx.waitUntil` is used (prefetch does not block the response).
- Manual verification via `wrangler tail op`: play an episode, confirm a `PREFETCH` log
  for `fileIdx+1`, then confirm the next episode plays on first attempt.
