# Next-Episode Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warm the next episode's Torbox CDN link in the background when a user starts playing an episode, so the next episode plays on first attempt instead of failing once and needing a retry.

**Architecture:** Add two exported helpers to `src/index.js` — a pure `computeNextFile()` (decides what to warm / when to skip) and an async `prefetchNextEpisode()` (dedupes via Cache API, then triggers Torbox edge staging with a 1-byte range GET). `handleResolve()` fires `prefetchNextEpisode()` through `ctx.waitUntil()` so it never adds latency to the current playback. Helpers take injectable `cache`/`fetchImpl` so they unit-test under plain vitest without the Workers runtime.

**Tech Stack:** Cloudflare Workers (ES module), vitest (new dev dependency) for tests.

## Global Constraints

- Worker name is `op`; `wrangler.toml` already has `[observability] enabled = true`. Do not change these.
- The next episode within an arc is the **same torrent**, `fileIdx + 1`. No cross-arc lookup.
- Lookahead is exactly **one** episode.
- Prefetch must **never** throw into the request path or add latency — all work runs in `ctx.waitUntil` and all errors are caught and logged.
- Dedupe marker TTL: 300 seconds (5 minutes).
- Warm request uses `GET` with header `Range: bytes=0-0` (not `HEAD`).
- Structured log lines use the existing `[reqId] LABEL ...` style; prefetch lines use label `PREFETCH`.
- Reuse the existing module-scope `isVideo()` and `getDownloadUrl()` — do not duplicate them.

---

### Task 1: Test tooling + `computeNextFile()`

**Files:**
- Modify: `package.json` (add vitest dev dependency + `test` script)
- Modify: `src/index.js` (add exported `computeNextFile`)
- Create: `test/prefetch.test.js`

**Interfaces:**
- Consumes: existing module-scope `isVideo(filename)`.
- Produces: `export function computeNextFile(torrent, fileIdx)` returning
  `{ skip: 'boundary' | 'non-video' | null, nextIdx: number, nextFile?: object }`.
  `nextFile` is present only when `skip !== 'boundary'`.

- [ ] **Step 1: Add vitest tooling to `package.json`**

Set the `scripts` and `devDependencies` blocks to:

```json
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "wrangler": "^4.72.0",
    "vitest": "^3.0.0"
  }
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: vitest added under `node_modules/.bin/vitest`, exit 0.

- [ ] **Step 3: Write the failing test**

Create `test/prefetch.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { computeNextFile } from '../src/index.js';

const torrent = {
  id: 32034717,
  files: [
    { id: 5, name: 'Sabaody Archipelago 01.mkv' },
    { id: 4, name: 'Sabaody Archipelago 02.mkv' },
    { id: 1, name: 'Sabaody Archipelago 09.mkv' }, // idx 2
    { id: 9, name: 'readme.txt' },                 // idx 3, non-video
  ],
};

describe('computeNextFile', () => {
  it('returns the next file for an in-bounds video', () => {
    const r = computeNextFile(torrent, 1);
    expect(r.skip).toBe(null);
    expect(r.nextIdx).toBe(2);
    expect(r.nextFile.id).toBe(1);
  });

  it('skips at the arc boundary (last file)', () => {
    const r = computeNextFile(torrent, 3);
    expect(r.skip).toBe('boundary');
    expect(r.nextIdx).toBe(4);
  });

  it('skips when the next file is not a video', () => {
    const r = computeNextFile(torrent, 2);
    expect(r.skip).toBe('non-video');
    expect(r.nextIdx).toBe(3);
  });

  it('skips boundary when torrent has no files', () => {
    const r = computeNextFile({ files: [] }, 0);
    expect(r.skip).toBe('boundary');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `computeNextFile` is not exported (import resolves to `undefined`).

- [ ] **Step 5: Implement `computeNextFile` in `src/index.js`**

Add immediately after the existing `isVideo()` function:

```javascript
export function computeNextFile(torrent, fileIdx) {
  const allFiles = torrent?.files || [];
  const nextIdx = fileIdx + 1;
  if (nextIdx >= allFiles.length) {
    return { skip: 'boundary', nextIdx };
  }
  const nextFile = allFiles[nextIdx];
  if (!isVideo(nextFile.short_name || nextFile.name)) {
    return { skip: 'non-video', nextIdx, nextFile };
  }
  return { skip: null, nextIdx, nextFile };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 4 `computeNextFile` cases green.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json test/prefetch.test.js src/index.js
git commit -m "feat: add computeNextFile helper + vitest tooling"
```

---

### Task 2: `prefetchNextEpisode()` — dedupe + warm

**Files:**
- Modify: `src/index.js` (add exported `prefetchNextEpisode`)
- Modify: `test/prefetch.test.js` (add cases)

**Interfaces:**
- Consumes: `computeNextFile(torrent, fileIdx)` (Task 1); existing `getDownloadUrl(apiKey, torrentId, fileId)`.
- Produces: `export async function prefetchNextEpisode({ apiKey, infoHash, torrent, fileIdx, cache, fetchImpl, reqId })`.
  - `cache` is a Cache-API-shaped object (`match(url)`, `put(url, response)`).
  - `fetchImpl` defaults to global `fetch`.
  - Marker key is the synthetic URL `https://prefetch.local/{infoHash}/{nextIdx}`.
  - Resolves to `undefined`; never throws.

- [ ] **Step 1: Write the failing tests**

Append to `test/prefetch.test.js`:

```javascript
import { vi } from 'vitest';
import { prefetchNextEpisode } from '../src/index.js';

function makeCache() {
  const store = new Map();
  return {
    store,
    async match(url) { return store.get(url); },
    async put(url, res) { store.set(url, res); },
  };
}

const warmTorrent = {
  id: 32034717,
  files: [
    { id: 5, name: 'Sabaody Archipelago 01.mkv' },
    { id: 1, name: 'Sabaody Archipelago 09.mkv' },
  ],
};

describe('prefetchNextEpisode', () => {
  it('warms the next file via a 1-byte range GET and marks the cache', async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ headers: { get: () => 'https://cdn.torbox/next.mkv' } }) // requestdl
      .mockResolvedValueOnce({ status: 206 }); // CDN warm

    await prefetchNextEpisode({
      apiKey: 'KEY', infoHash: 'abc', torrent: warmTorrent, fileIdx: 0,
      cache, fetchImpl, reqId: 't1',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // second call is the warm request to the CDN url with a 0-0 range
    const [warmUrl, warmOpts] = fetchImpl.mock.calls[1];
    expect(warmUrl).toBe('https://cdn.torbox/next.mkv');
    expect(warmOpts.headers.Range).toBe('bytes=0-0');
    expect(await cache.match('https://prefetch.local/abc/1')).toBeTruthy();
  });

  it('no-ops when the marker already exists (dedupe)', async () => {
    const cache = makeCache();
    await cache.put('https://prefetch.local/abc/1', { ok: true });
    const fetchImpl = vi.fn();

    await prefetchNextEpisode({
      apiKey: 'KEY', infoHash: 'abc', torrent: warmTorrent, fileIdx: 0,
      cache, fetchImpl, reqId: 't2',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing at the arc boundary', async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn();
    await prefetchNextEpisode({
      apiKey: 'KEY', infoHash: 'abc', torrent: warmTorrent, fileIdx: 1,
      cache, fetchImpl, reqId: 't3',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows errors and never throws', async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(prefetchNextEpisode({
      apiKey: 'KEY', infoHash: 'abc', torrent: warmTorrent, fileIdx: 0,
      cache, fetchImpl, reqId: 't4',
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `prefetchNextEpisode` is not exported.

- [ ] **Step 3: Implement `prefetchNextEpisode` in `src/index.js`**

Add immediately after `computeNextFile`:

```javascript
export async function prefetchNextEpisode({ apiKey, infoHash, torrent, fileIdx, cache, fetchImpl = fetch, reqId = '-' }) {
  try {
    const { skip, nextIdx, nextFile } = computeNextFile(torrent, fileIdx);
    if (skip) {
      console.log(`[${reqId}] PREFETCH: skip reason=${skip} nextIdx=${nextIdx}`);
      return;
    }

    const markerUrl = `https://prefetch.local/${infoHash}/${nextIdx}`;
    if (await cache.match(markerUrl)) {
      console.log(`[${reqId}] PREFETCH: skip reason=already-warmed nextIdx=${nextIdx}`);
      return;
    }
    await cache.put(markerUrl, new Response('1', { headers: { 'Cache-Control': 'max-age=300' } }));

    const torboxUrl = getDownloadUrl(apiKey, torrent.id, nextFile.id);
    const dlRes = await fetchImpl(torboxUrl, { redirect: 'manual' });
    const cdnUrl = dlRes.headers.get('Location');
    if (!cdnUrl) {
      console.log(`[${reqId}] PREFETCH: no CDN location for nextIdx=${nextIdx}`);
      return;
    }

    const warmRes = await fetchImpl(cdnUrl, { headers: { Range: 'bytes=0-0' } });
    console.log(`[${reqId}] PREFETCH: warmed nextIdx=${nextIdx} file=${nextFile.short_name || nextFile.name} status=${warmRes.status}`);
  } catch (err) {
    console.log(`[${reqId}] PREFETCH ERROR: ${err.message}`);
  }
}
```

Note: `new Response(...)` is available in the Workers runtime and in vitest's Node 18+ environment (global `Response`). The dedupe tests inject their own marker objects, so they do not depend on it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `computeNextFile` and `prefetchNextEpisode` cases green.

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/prefetch.test.js
git commit -m "feat: add prefetchNextEpisode with dedupe and edge warming"
```

---

### Task 3: Wire prefetch into `handleResolve`

**Files:**
- Modify: `src/index.js` — route call site (~line 132) and `handleResolve` (signature ~line 207, insertion before the current-file download fetch ~line 271)

**Interfaces:**
- Consumes: `prefetchNextEpisode(...)` (Task 2).
- Produces: `handleResolve(infoHash, fileIdx, apiKey, ctx)` — adds a trailing `ctx` parameter.

- [ ] **Step 1: Thread `ctx` into the route call**

In the `fetch` handler, change the resolve dispatch:

```javascript
    const resolveMatch = subPath.match(/^\/resolve\/([a-f0-9]+)\/(\d+)$/i);
    if (resolveMatch) {
      return handleResolve(resolveMatch[1].toLowerCase(), parseInt(resolveMatch[2]), apiKey, ctx);
    }
```

- [ ] **Step 2: Add `ctx` to the `handleResolve` signature**

Change:

```javascript
async function handleResolve(infoHash, fileIdx, apiKey, ctx) {
```

- [ ] **Step 3: Fire the prefetch once the current file is selected**

In `handleResolve`, immediately after the `if (!file) { ... 404 ... }` block and before the
`// Fetch the download URL server-side` comment, insert:

```javascript
    // Warm the next episode's CDN link in the background (no added latency)
    ctx?.waitUntil(prefetchNextEpisode({
      apiKey, infoHash, torrent, fileIdx, cache: caches.default, fetchImpl: fetch, reqId,
    }));
```

- [ ] **Step 4: Verify existing tests still pass and the worker parses**

Run: `npm test`
Expected: PASS — unchanged helper tests still green.

Run: `npx wrangler deploy --dry-run`
Expected: build succeeds, no syntax/bundling errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: trigger next-episode prefetch from handleResolve via waitUntil"
```

- [ ] **Step 6: Manual verification (requires deploy)**

Deploy: `npm run deploy`
Then in one terminal: `npx wrangler tail op --format pretty`
In Stremio, play an episode mid-arc (e.g. 20x1). In the logs, confirm:
- a `PREFETCH: warmed nextIdx=<n> file=... status=206` line appears for the following episode, and
- a `PREFETCH: skip reason=already-warmed` line on the repeat resolve probes.
Then play the next episode (20x2) and confirm it loads on the **first** attempt.

---

## Notes for the implementer

- `test/` is a new directory; vitest discovers `test/**/*.test.js` by default — no config file needed.
- Do not modify `wrangler.toml`, the manifest, or any existing handler logic beyond the three edits in Task 3.
- `caches.default` and global `fetch` are Workers runtime globals — only referenced inside functions, so importing `src/index.js` in vitest stays safe.
