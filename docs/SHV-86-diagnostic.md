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

## Key Finding: Torrent IS Available

The user confirmed that manually adding this infoHash to Torbox works fine. This **rules out** torrent availability as the root cause. The issue is in the **API interaction between the worker and Torbox**, not the torrent itself.

---

## Torbox API Analysis

We verified the Torbox SDK source code. The API uses **snake_case** field names (`download_present`, `torrent_id`, `download_state`, etc.) — matching the worker code. Field naming is **not** the issue.

However, potential API behavior changes to investigate:
- `createTorrent` may now return `queued_id` in cases where it previously returned `torrent_id`
- The `checkcached` endpoint exists (`/api/torrents/checkcached`) but is not used — the worker calls the full `mylist` endpoint instead, which is inefficient and may behave differently
- New parameters like `as_queued` in `createTorrent` could change queueing behavior

---

## Potential Causes (Ranked by Likelihood)

### 1. Torbox API Behavior Change (HIGH — NEEDS LOGS TO CONFIRM)

The `createTorrent` response may have changed. The worker checks `created.data?.torrent_id` to determine if Torbox had the torrent cached. If the API now:
- Returns `queued_id` instead of `torrent_id` for cached torrents
- Wraps `data` differently
- Returns a different response structure for already-existing torrents

...the worker would always fall into the "Queued for download" path (503), even when the torrent is immediately available.

**Logging deployed to capture**: `createTorrent` full response including `torrent_id`, `queued_id`, `hash`, `error`, and `detail`.

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
It prefers non-error torrents, but if only the errored one exists (the newly created one hasn't appeared in the list yet due to API lag), it picks the error torrent every time.

**Logging deployed to capture**: Each match's `active`, `download_finished`, `download_present`, `download_state`, and computed `statusError`/`statusReady` values.

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

`statusError(null)` evaluates to `true` because `(!undefined && !undefined)` is `true`. This triggers unnecessary error recovery and returns 503.

**Fix deployed**: The instrumented code now returns 503 with a specific message when `getTorrent` returns null after create, preventing the null from reaching `statusError`.

### 4. `createTorrent` Silent API Failures (MEDIUM)

The `createTorrent` function doesn't validate the API response. If Torbox returns `{success: false, error: "Rate limit exceeded"}`, the code treats it as "queued for download" and returns 503.

**Logging deployed to capture**: Full `createTorrent` response including `success`, `error`, and `detail`.

### 5. fileIdx=0 Points to Non-Video File (MEDIUM)

In a multi-file torrent, index 0 might be a non-video file (e.g., `.nfo`, `.txt`). This wouldn't cause "Loading failed" but would play the **wrong episode**.

**Logging deployed to capture**: All files in the torrent with their index, name, and size.

### 6. Stale Cache Serving Dead infoHash (LOW)

The worker caches GitHub data for 24 hours. If upstream data changed, old infoHash could be served. However, the user confirmed the torrent hash works manually, so this is less likely the current issue.

---

## What Was Deployed

### Structured Logging (LIVE on `op` worker)

Every step of the resolve flow now logs to `console.log` with a request ID prefix (`[reqId]`):

| Log Point | What It Captures |
|-----------|-----------------|
| `STREAM` | episodeId, cache hit/miss, infoHash, fileIdx, host |
| `RESOLVE START` | infoHash, fileIdx |
| `findTorrent` | API status, success, data shape, match count, each match's state |
| `createTorrent` | API status, success, torrent_id, queued_id, error, detail |
| `getTorrent` | API status, success, torrent state |
| `Torrent state` | id, hash, active, download_finished, download_present, download_state |
| `Files` | Total count, video count, each file's idx/id/name/size |
| `RESULT` | Final outcome (302/503/404/500) with details |

### How to View Logs

1. **Cloudflare Dashboard**: Workers & Pages → `op` → Logs tab
2. **CLI**: `npx wrangler tail op` (streams real-time logs)

---

## Cloudflare MCP Observability Permissions

The current MCP API token can manage worker scripts but **cannot** access the Workers Observability/Telemetry API (returns auth error 10000).

### To enable programmatic log querying, add these permissions to the API token:

1. Go to **Cloudflare Dashboard** → **My Profile** → **API Tokens**
2. Edit the token used by the MCP server
3. Add these permissions:
   - **Account** → **Workers Tail** → **Read** (for `wrangler tail` and tail API)
   - **Account** → **Account Analytics** → **Read** (for observability/telemetry queries)
   - **Account** → **Logs** → **Edit** (for logpush configuration, optional)

After updating the token, the MCP will be able to run queries like:
```
POST /accounts/{account_id}/workers/observability/telemetry/query
```
to search historical logs, filter by request ID, and analyze error patterns programmatically.

---

## Infrastructure Notes

- **Worker name mismatch**: `wrangler.toml` says `name = "one-pace-torbox"` but the deployed worker is `op`. Keep as `op` since Stremio clients reference this URL.
- **Worker URL**: `https://op.one-pace-torbox.workers.dev`
- **Torbox API version**: Using `/v1/` — no deprecation notices found, but monitor for changes.

---

## Next Steps

1. **Reproduce the failure** on episode 20x1 and check the Cloudflare Logs tab for the detailed trace
2. **Identify which code path** the request takes (the logs will show exactly where it fails)
3. **Fix the root cause** based on log evidence
4. **Update MCP token permissions** to enable programmatic log queries for future debugging
