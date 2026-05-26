# SHV-86: Loading Failed on Episode 20x1 — Diagnostic Report

## Episode Identity

- **User-facing**: Season 20, Episode 1 ("20x1")
- **Internal ID**: `SAB_1` (Sabaody Archipelago arc, Episode 1: "Flying Fish Riders")
- **Torrent**: Multi-file torrent containing all 11 SAB episodes
  - **infoHash**: `2589926c8f90e8f031a6caeab93bcd5b79990c0e`
  - **fileIdx**: `0` (SAB_1 is the first file in the torrent)

## Request Flow

```
Stremio → /stream/series/SAB_1.json → GitHub (cached 24h) → {infoHash, fileIdx: 0}
       → /resolve/{infoHash}/0       → Torbox API          → 302 redirect to CDN
```

---

## Potential Causes (Ranked by Likelihood)

### 1. Torrent Not Available on Torbox (HIGH)

The most likely cause. When the torrent isn't cached by Torbox, the resolve flow returns HTTP 503, which Stremio displays as "Loading failed" with no retry mechanism.

**What happens:**
1. `findTorrent()` → null (torrent not in user's Torbox list)
2. `createTorrent()` → Torbox starts downloading
3. If Torbox doesn't have it cached: returns `503 "Adding to Torbox, try again shortly"`
4. Stremio shows "Loading failed" — user is stuck

**Why this hits SAB specifically:**
- This is an 11-episode multi-file torrent (larger download)
- Larger torrents take longer to cache and are more likely to fail
- One Pace torrents may have few seeders, making Torbox caching unreliable

### 2. Error State Infinite Loop (HIGH)

If the torrent enters an error state on Torbox, the worker gets trapped in a loop:

```
Request → findTorrent() → finds errored torrent
       → statusError() returns true
       → createTorrent() (creates duplicate, doesn't delete errored one)
       → returns 503
Next request → findTorrent() → finds errored torrent again → same loop
```

**The bug in `findTorrent`:**
```javascript
const matches = data.data.filter(t => t.hash === infoHash);
return matches.find(t => !statusError(t)) || matches[0] || null;
```
It prefers non-error torrents, but if only the errored one exists (the newly created one hasn't appeared in the list yet due to API lag), it picks the error torrent every time. The `createTorrent` in the error path doesn't clean up or delete the old errored torrent.

### 3. Null Torrent After `getTorrent` Failure (MEDIUM)

A subtle bug where `getTorrent` returns null but the code doesn't handle it:

```javascript
const created = await createTorrent(apiKey, infoHash);
if (created.data?.torrent_id) {
  torrent = await getTorrent(apiKey, created.data.torrent_id);  // can return null!
}
// torrent is null here, falls through to:
if (statusError(torrent)) { ... }  // statusError(null) → true!
```

`statusError(null)` evaluates to `true` because `(!undefined && !undefined)` → `true`. This triggers unnecessary error recovery and returns 503.

### 4. fileIdx=0 Points to Non-Video File (MEDIUM)

In a multi-file torrent, index 0 might be a non-video file (e.g., `.nfo`, `.txt`, `.srt`). The fallback logic:

```javascript
const target = allFiles[fileIdx];  // allFiles[0] might be .nfo
const file = (target && isVideo(target.short_name || target.name)) ? target : videos[0];
```

**Two outcomes:**
- If non-video files exist at index 0: falls back to `videos[0]` (the **largest** video), which is likely the **wrong episode** (maybe episode 11 instead of episode 1)
- If no video files at all: returns `404 "No video file found"`

This wouldn't cause "Loading failed" per se — it would play the wrong episode. But it's worth verifying.

### 5. Stale Cache Serving Dead infoHash (MEDIUM)

The worker caches GitHub data for 24 hours. If the upstream `SAB_1.json` was updated with a new infoHash (e.g., torrent was re-released), the worker would serve the old, dead infoHash for up to 24 hours.

**Evidence this could be happening:**
- Cache TTL was recently increased from 1 hour to 24 hours (commit `7b56ab5`)
- No cache invalidation mechanism exists
- No way to force-purge the cache

### 6. `createTorrent` Silent API Failures (LOW-MEDIUM)

The `createTorrent` function doesn't validate the API response:

```javascript
async function createTorrent(apiKey, infoHash) {
  // ...
  const res = await fetch(`${TORBOX_API}/api/torrents/createtorrent`, { ... });
  return res.json();  // No check for success/error!
}
```

If Torbox returns `{success: false, error: "Rate limit exceeded"}`, the code treats it as "queued for download" and returns 503. The user has no idea the API call failed.

### 7. `findTorrent` Performance Bottleneck (LOW)

`findTorrent` fetches the **entire torrent list** (`/api/torrents/mylist`) every request, then filters by hash. If the Torbox account has many torrents:
- Large response → slow parsing
- Could hit Cloudflare Worker CPU limits (30ms free tier, 50ms paid)
- Could hit Torbox API rate limits

---

## Architectural Issues

### No Observability
The worker has zero logging or metrics beyond `console.error` for caught exceptions. The user's complaint "I cannot debug it since I don't have logs on the Cloudflare worker" confirms this is a fundamental gap. There's no way to determine which specific failure path is being hit.

### No Retry Mechanism
When `/resolve/` returns 503, Stremio shows "Loading failed" immediately. There's no:
- Client-side retry with backoff
- "Try again" button or messaging
- Progress indication for downloading torrents

### Generic Error Responses
All 503 responses are plain text with no structured error info:
- `"Adding to Torbox, try again shortly"` — which step failed?
- `"Torrent error, retrying. Try again shortly"` — what error?
- `"Downloading to Torbox..."` — how long will it take?

### Cache Cannot Be Invalidated
No mechanism exists to purge the Cloudflare cache. If stale data causes issues, the only fix is waiting 24 hours or redeploying the worker.

---

## Recommendations (Investigation Only — No Implementation)

1. **Add structured logging** — Log every step of the resolve flow with the infoHash, fileIdx, torrent state, and API responses. Use `console.log` for Cloudflare's dashboard or integrate with a logging service.

2. **Handle null torrent after getTorrent** — Check for null before calling `statusError()`.

3. **Break the error loop** — Delete errored torrents before re-creating, or track retry count.

4. **Validate createTorrent response** — Check `created.success` and surface API errors.

5. **Add a health-check/debug endpoint** — e.g., `/debug/resolve/{infoHash}/{fileIdx}` that returns JSON with the full torrent state instead of a redirect.

6. **Consider cache busting** — Add a query param or versioned URL to allow manual cache invalidation.

7. **Verify fileIdx=0 mapping** — Check the actual Torbox file list for this torrent to confirm index 0 is indeed the correct video file.
