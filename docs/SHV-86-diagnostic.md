# SHV-86: Loading Failed on Episode 20x1 — Final Diagnostic Report

## Resolution Summary

Episode 20x1 (SAB_1) **now works correctly**. The investigation uncovered and fixed several issues, and added permanent observability.

### Root Cause

The original failure was most likely caused by the SAB torrent (`2589926c...`) not being present in the user's Torbox account. When the worker's `createTorrent` API call couldn't auto-add it (Torbox didn't have it cached / insufficient seeders), it returned a 503 which Stremio displayed as "Loading failed."

The user confirmed that manually adding the infoHash to Torbox resolved the playback issue, supporting this diagnosis.

### Contributing Factor: Repo Out of Sync

The GitHub repository contained an **old version** of the worker code that lacked:
- Per-user API key routing (`/{apiKey}/...` path prefix)
- Configuration page at `/` and `/configure`
- Server-side Torbox redirect (to hide API key from clients)

This meant any deployment from the repo would break the live addon. The latest code existed only in a local directory (`/Users/arin/Documents/Programming/One Pace Torbox/one-pace-torbox/`).

---

## What Was Fixed

### 1. Repository Synced with Latest Code
The repo now contains the actual production code including:
- Config page for per-user Torbox API key entry
- `/{apiKey}/...` route prefix for all authenticated endpoints
- Server-side fetch of Torbox download URL (hides API key from client redirects)

### 2. Structured Logging Added (Permanent)
Every step of the resolve flow now logs to `console.log` with request IDs:

| Log Point | What It Captures |
|-----------|-----------------|
| `STREAM` | episodeId, cache hit/miss, infoHash, fileIdx |
| `RESOLVE START` | infoHash, fileIdx |
| `findTorrent` | API status, torrent count, hash matches, each match's state |
| `createTorrent` | API response, torrent_id, queued_id, errors |
| `getTorrent` | API response, torrent state |
| `Torrent state` | id, hash, active, download_finished, download_present, download_state |
| `Files` | Total count, video count, each file's idx/id/name/size |
| `requestdl` | Torbox response status, CDN redirect presence |
| `RESULT` | Final outcome (302/503/404/500/502) |

### 3. Config Page JS Fix
Replaced regex `/.../` with string `.replace()` in the config page to avoid escaping issues when deploying via API.

### 4. Wrangler Config Updated
- Worker name corrected to `op` (matches deployed worker)
- `[observability]` section added with `enabled = true`

### 5. Null Torrent Guard
Added explicit null check after `getTorrent` to prevent `statusError(null)` → `true` bug.

---

## Log Analysis (from successful test)

```
SAB_1 resolve flow:
- findTorrent: 214 torrents in list, 1 hash match
- Torrent: id=32034717, download_state=cached, statusReady=true
- Files: 11 total, 11 videos, fileIdx=0
- File: [One Pace][490-491] Sabaody Archipelago 01 [720p][066FD68B].mkv
- Torbox requestdl: status=307, hasLocation=true
- Result: 302 redirect to CDN ✅
```

---

## Remaining Concerns

### 1. `findTorrent` Fetches 214 Torrents Per Request
Every resolve call fetches the **entire torrent list** (214 items) and filters by hash. This is:
- Slow (large JSON response to parse)
- Rate-limit prone
- CPU-intensive for a Cloudflare Worker

**Recommendation**: Use `GET /api/torrents/checkcached?hash={hash}` to check availability first, and `GET /api/torrents/mylist?id={id}` for specific lookups.

### 2. No Automatic Retry for 503
When Torbox needs to download a torrent (not cached), the worker returns 503 and Stremio shows "Loading failed" with no retry. This is the UX the user experienced.

**Recommendation**: Consider a polling/retry mechanism or a more informative response.

### 3. Error Recovery Loop
If a torrent enters an error state, the worker creates a new one but doesn't delete the errored entry. This can cause repeated 503s.

### 4. `createTorrent` Response Not Validated
If the Torbox API returns an error, it's not surfaced — the code silently falls into the 503 "queued" path.

---

## Files Changed

- `src/index.js` — Synced with latest code, added structured logging, fixed config page JS
- `wrangler.toml` — Updated worker name to `op`, added `[observability]` section
- `docs/SHV-86-diagnostic.md` — This report

## How to View Logs

1. **Dashboard**: Cloudflare → Workers & Pages → `op` → Logs tab (observability enabled)
2. **CLI**: `npx wrangler tail op --format pretty`
