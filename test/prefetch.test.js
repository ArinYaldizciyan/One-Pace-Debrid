import { describe, it, expect } from 'vitest';
import { computeNextFile } from '../src/index.js';
import { vi } from 'vitest';
import { prefetchNextEpisode } from '../src/index.js';

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
