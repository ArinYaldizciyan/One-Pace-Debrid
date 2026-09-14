import { describe, it, expect, vi } from 'vitest';
import { handleResolve } from '../src/index.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function redirectTo(url) {
  return {
    ok: false, status: 307,
    headers: { get: (h) => (h === 'Location' ? url : null) },
    text: async () => '', json: async () => ({}),
  };
}

// Like the Workers Cache API: each match() hands back a fresh, unread Response.
function makeCache() {
  const store = new Map();
  return {
    store,
    async match(url) {
      const hit = store.get(url);
      return hit && new Response(hit);
    },
    async put(url, res) { store.set(url, await res.text()); },
    async delete(url) { return store.delete(url); },
  };
}

const torrent = {
  id: 96794154, hash: 'abc123', active: false, download_finished: true,
  download_present: true, download_state: 'cached',
  files: [{ id: 0, name: 'Post-War 08.mkv', size: 1648500000 }],
};

const opts = (fetchImpl, cache) => ({ delayMs: 0, retries: 0, reqId: 'test', fetchImpl, cache });

describe('handleResolve — link cache', () => {
  it('serves repeat range requests from cache without calling Torbox', async () => {
    const cache = makeCache();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { torrent_id: 96794154 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: torrent }))
      .mockResolvedValueOnce(redirectTo('https://cdn.torbox/a.mkv'));

    const first = await handleResolve('abc123', 0, 'KEY', null, opts(fetchImpl, cache));
    expect(first.headers.get('Location')).toBe('https://cdn.torbox/a.mkv');
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 3; i++) {
      const again = await handleResolve('abc123', 0, 'KEY', null, opts(fetchImpl, cache));
      expect(again.status).toBe(302);
      expect(again.headers.get('Location')).toBe('https://cdn.torbox/a.mkv');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never calls the full library list on the happy path', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { torrent_id: 96794154 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: torrent }))
      .mockResolvedValueOnce(redirectTo('https://cdn.torbox/a.mkv'));
    await handleResolve('abc123', 0, 'KEY', null, opts(fetchImpl, makeCache()));
    const urls = fetchImpl.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('mylist?bypass_cache'))).toBe(false);
  });

  it('keeps links separate per user', async () => {
    const cache = makeCache();
    const make = (url) => vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { torrent_id: 96794154 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: torrent }))
      .mockResolvedValueOnce(redirectTo(url));

    await handleResolve('abc123', 0, 'KEY_A', null, opts(make('https://cdn.torbox/a.mkv'), cache));
    const b = await handleResolve('abc123', 0, 'KEY_B', null, opts(make('https://cdn.torbox/b.mkv'), cache));
    expect(b.headers.get('Location')).toBe('https://cdn.torbox/b.mkv');
    for (const key of cache.store.keys()) {
      expect(key).not.toContain('KEY_A');
      expect(key).not.toContain('KEY_B');
    }
  });

  it('does not cache a still-downloading torrent', async () => {
    const cache = makeCache();
    const downloading = { ...torrent, active: true, download_finished: false, download_present: false, download_state: 'downloading' };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { torrent_id: 96794154 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: downloading }));
    const res = await handleResolve('abc123', 0, 'KEY', null, opts(fetchImpl, cache));
    expect(res.status).toBe(503);
    expect(cache.store.size).toBe(0);
  });

  it('only needs requestdl when the link expired but the torrent is cached', async () => {
    const cache = makeCache();
    const warm = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { torrent_id: 96794154 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: torrent }))
      .mockResolvedValueOnce(redirectTo('https://cdn.torbox/old.mkv'));
    await handleResolve('abc123', 0, 'KEY', null, opts(warm, cache));
    for (const key of [...cache.store.keys()]) if (key.startsWith('https://resolve.local/')) cache.store.delete(key);

    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectTo('https://cdn.torbox/new.mkv'));
    const res = await handleResolve('abc123', 0, 'KEY', null, opts(fetchImpl, cache));
    expect(res.headers.get('Location')).toBe('https://cdn.torbox/new.mkv');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('requestdl');
  });

  it('forgets a cached torrent when requestdl stops returning a link', async () => {
    const cache = makeCache();
    const warm = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { torrent_id: 96794154 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: torrent }))
      .mockResolvedValueOnce(redirectTo('https://cdn.torbox/old.mkv'));
    await handleResolve('abc123', 0, 'KEY', null, opts(warm, cache));
    for (const key of [...cache.store.keys()]) if (key.startsWith('https://resolve.local/')) cache.store.delete(key);

    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'DATABASE_ERROR', data: null }, 404)
    );
    const res = await handleResolve('abc123', 0, 'KEY', null, opts(fetchImpl, cache));
    expect(res.status).toBe(502);
    expect(cache.store.size).toBe(0);
  });
});
