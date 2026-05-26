# SHV-87: Real-Debrid Support — Analysis & Implementation Plan

## Executive Summary

Adding Real-Debrid (RD) support is **moderately complex**. The core challenge isn't the API integration itself — it's that RD uses a fundamentally different torrent lifecycle than TorBox, requiring a multi-step flow where TorBox is essentially one step. The codebase is currently tightly coupled to TorBox with no provider abstraction, so a refactor is needed first.

**Estimated effort:** Medium — the codebase is small (~378 lines, single file), but the refactoring touches nearly every function.

---

## Key Differences: TorBox vs Real-Debrid

| Concern | TorBox | Real-Debrid |
|---------|--------|-------------|
| **Auth** | Bearer token | Bearer token (same pattern) |
| **Add torrent** | 1 step: `POST /createtorrent` with magnet | 2+ steps: `POST /addMagnet` → poll status → `POST /selectFiles/{id}` |
| **File selection** | Automatic — all files available | **Manual** — must explicitly select file IDs or download never starts |
| **Status model** | `download_present`, `active`, `download_finished`, `download_state` | Single `status` string: `magnet_conversion` → `waiting_files_selection` → `queued` → `downloading` → `downloaded` |
| **Get download URL** | `GET /requestdl?token=...&file_id=...` → 302 redirect | 2 steps: get `links[]` from torrent info → `POST /unrestrict/link` → get `download` URL |
| **Find existing torrent** | `GET /mylist` → filter by hash | `GET /torrents` → filter by hash (paginated, up to 5000) |
| **Rate limits** | Undocumented | 250 req/min, HTTP 429 |
| **Cache check** | N/A (just checks `download_present`) | `/instantAvailability` is **deprecated/dead** — all major addons have disabled it |
| **File-to-link mapping** | Direct: `file_id` → download URL | Positional: `links[i]` corresponds to `selectedFiles[i]` |

### The Big Gotcha: File Selection

This is the most important architectural difference. With TorBox, you add a magnet and all files become available. With RD:

1. After `addMagnet`, the torrent sits in `waiting_files_selection` **forever** until you call `selectFiles`
2. You **must only select video files** — if you include non-video files, RD packages everything into a ZIP/RAR archive, which is unusable for streaming
3. Before you can call `selectFiles`, you may need to poll through `magnet_conversion` status (usually <30s)
4. The `links[]` array in the torrent info maps to selected files **by position index**, not by file ID

---

## Current Architecture (Problem)

Everything is hardcoded to TorBox:

```
handleResolve()
  → findTorrent()      // TorBox-specific API call
  → createTorrent()    // TorBox-specific API call  
  → getTorrent()       // TorBox-specific API call
  → statusReady()      // TorBox-specific field checks
  → statusError()      // TorBox-specific field checks
  → getDownloadUrl()   // TorBox-specific URL construction
```

The config page only asks for a TorBox API key. The manifest hardcodes "One Pace (Torbox)". The URL scheme is `/{apiKey}/...` with no provider indicator.

---

## Proposed Architecture

### URL Scheme Change

Current: `/{apiKey}/manifest.json`  
Proposed: `/{provider}:{apiKey}/manifest.json`

Where `provider` is `torbox` or `realdebrid`. This keeps the single-segment auth pattern and is backward-compatible if we default bare keys to `torbox`.

Example:
- `https://op.workers.dev/torbox:abc123/manifest.json`
- `https://op.workers.dev/realdebrid:xyz789/manifest.json`

### Provider Abstraction

Create a provider interface pattern (plain objects, no classes needed for a Worker):

```
provider = {
  name: string,
  findTorrent(apiKey, infoHash) → torrent | null,
  addTorrent(apiKey, infoHash) → { ready: bool, torrentId?, message? },
  getTorrent(apiKey, torrentId) → torrent,
  isReady(torrent) → bool,
  isError(torrent) → bool,
  getFiles(torrent) → [{ id, name, size }],
  getDownloadUrl(apiKey, torrent, file) → url string,
}
```

### Real-Debrid Resolve Flow

```
1. GET /torrents → find by hash
   ├─ Found & status=downloaded → skip to step 4
   ├─ Found & status=downloading/queued → return 503 "Downloading..."
   ├─ Found & status=waiting_files_selection → go to step 3
   ├─ Found & status=error/dead → delete, go to step 2
   └─ Not found → go to step 2

2. POST /torrents/addMagnet → get torrent ID
   └─ Poll GET /torrents/info/{id} until status != magnet_conversion
      (max ~5 attempts, 2s apart — tricky in a Worker, see concerns)

3. POST /torrents/selectFiles/{id} (video files only)
   └─ If torrent was cached on RD servers → instant → status=downloaded
      Otherwise → return 503 "Downloading..."

4. Map target fileIdx to selected file's positional link index
   └─ POST /unrestrict/link with the link → get download URL
      └─ Return 302 redirect to download URL
```

### Config Page

Redesign to offer a provider dropdown/toggle:
- User selects "TorBox" or "Real-Debrid"
- Enters corresponding API key
- URL is generated with the `{provider}:{apiKey}` format

### Manifest

Dynamic based on provider:
- `name`: "One Pace (TorBox)" or "One Pace (Real-Debrid)"
- `id`: Could remain the same or be per-provider

---

## Implementation Concerns & Risks

### 1. Polling in a Cloudflare Worker (Medium Risk)

RD's `magnet_conversion` phase requires polling (`GET /torrents/info/{id}` every 2s until ready). Cloudflare Workers have a **30-second CPU time limit** (or 50ms on free plan, 30s on paid). Polling with `await new Promise(r => setTimeout(r, 2000))` counts as wall-clock time, not CPU time, so it _should_ work on a paid plan. But:

- On the **free plan**, this is very tight
- Each poll is a subrequest (Workers allow up to 50 subrequests per invocation)
- If magnet conversion takes >20s, we may need to return 503 and let Stremio retry

**Recommendation:** Attempt up to 3 polls (6s total). If still converting, return 503. Stremio will retry automatically.

### 2. File Selection Mapping (Medium Risk)

The positional mapping between `links[]` and selected files is fragile. We need to:
- Get torrent info to see all files
- Filter to video files only
- Select those files
- Then later, map the `fileIdx` from the stream data to the correct positional index in `links[]`

Since the stream data's `fileIdx` refers to the **original torrent file index** (not the selected-files index), we need a careful mapping step.

### 3. No Instant Availability Check (Low Risk)

Since `/instantAvailability` is dead, every first request for a torrent will trigger the full add → select → wait flow. This means:
- First play of any episode will be slower than TorBox
- If the torrent IS cached on RD servers, it'll still be fast after the add+select steps
- If not cached, user sees "Downloading..." and must wait

### 4. Rate Limits (Low Risk)

250 req/min is generous for a personal addon. One resolve flow uses ~3-5 API calls. Would only be a concern if many users share one API key (unlikely for personal use).

### 5. IP Parameter (Low Risk)

Some RD endpoints accept an `ip` parameter to avoid IP mismatch errors when the server IP differs from the user's. Since this runs on Cloudflare Workers (different IP than user), we may need to pass the client's IP via `request.headers.get('CF-Connecting-IP')`. Other Stremio addons do this. Worth implementing.

---

## Implementation Steps

### Phase 1: Refactor (no behavior change)
1. Extract TorBox-specific functions into a `torbox` provider object
2. Extract shared logic (video detection, file selection) into helpers
3. Update `handleResolve` to call through the provider abstraction
4. Verify everything still works with TorBox

### Phase 2: Config & Routing
5. Update URL parsing to support `{provider}:{apiKey}` format
6. Update config page with provider selection UI
7. Make manifest name dynamic based on provider

### Phase 3: Real-Debrid Provider
8. Implement RD provider: `findTorrent`, `addTorrent` (with magnet conversion polling), `selectFiles`, `getTorrent`, `getDownloadUrl` (with unrestrict/link)
9. Implement RD status helpers (`isReady`, `isError`)
10. Handle the file-to-link positional mapping

### Phase 4: Polish
11. Error handling for RD-specific error codes (rate limits, not premium, etc.)
12. Logging with provider context
13. Testing with real RD account

---

## Verdict

| Aspect | Rating | Notes |
|--------|--------|-------|
| **API complexity** | Medium | More steps than TorBox, but well-documented |
| **Refactoring effort** | Medium | Small codebase, but every function is touched |
| **Risk** | Low-Medium | Polling in Workers is the main concern |
| **Testing** | Medium | Need a real RD premium account to test |
| **Overall difficulty** | **Medium** | Doable in a focused session, ~2-3 hours of implementation |

The hardest parts are:
1. The `selectFiles` step and positional link mapping
2. Handling the `magnet_conversion` polling within Worker constraints
3. Getting the config page UX right for multi-provider support

None of these are blockers — they're just more involved than TorBox's simpler API.
