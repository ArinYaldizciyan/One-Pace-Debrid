import { describe, it, expect } from 'vitest';
import { computeNextFile } from '../src/index.js';
import { vi } from 'vitest';
import { prefetchNextEpisode, tenantId } from '../src/index.js';

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
    const marker = `https://prefetch.local/${await tenantId('KEY')}/abc/1`;
    expect(await cache.match(marker)).toBeTruthy();
  });

  it('no-ops when the marker already exists (dedupe)', async () => {
    const cache = makeCache();
    await cache.put(`https://prefetch.local/${await tenantId('KEY')}/abc/1`, { ok: true });
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

  it('does not let one tenant\'s marker suppress another tenant\'s prefetch', async () => {
    const cache = makeCache();

    // Tenant A warms the episode.
    const fetchA = vi.fn()
      .mockResolvedValueOnce({ headers: { get: () => 'https://cdn.torbox/next.mkv' } })
      .mockResolvedValueOnce({ status: 206 });
    await prefetchNextEpisode({
      apiKey: 'KEY-A', infoHash: 'abc', torrent: warmTorrent, fileIdx: 0,
      cache, fetchImpl: fetchA, reqId: 'a',
    });
    expect(fetchA).toHaveBeenCalledTimes(2);

    // Tenant B must still warm it for themselves — different Torbox library,
    // different torrent_id, so A's marker must not apply.
    const fetchB = vi.fn()
      .mockResolvedValueOnce({ headers: { get: () => 'https://cdn.torbox/next-b.mkv' } })
      .mockResolvedValueOnce({ status: 206 });
    await prefetchNextEpisode({
      apiKey: 'KEY-B', infoHash: 'abc', torrent: warmTorrent, fileIdx: 0,
      cache, fetchImpl: fetchB, reqId: 'b',
    });
    expect(fetchB).toHaveBeenCalledTimes(2);

    // Two distinct markers, neither containing the raw key.
    expect(cache.store.size).toBe(2);
    for (const k of cache.store.keys()) {
      expect(k).not.toContain('KEY-A');
      expect(k).not.toContain('KEY-B');
    }
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
