import { describe, it, expect } from 'vitest';
import worker, { SOURCES, MANIFEST, sourceForEpisode, handleStream } from '../src/index.js';
import NARUTO_KAI from '../src/data/naruto-kai.json';

const KEY = 'test-key';
const BASE = 'https://op.example.workers.dev';
const ctx = { waitUntil: () => {} };

const get = (path) => worker.fetch(new Request(`${BASE}/${KEY}${path}`), {}, ctx);

describe('manifest', () => {
  it('advertises a catalog and meta prefix for every source', () => {
    expect(MANIFEST.catalogs.map(c => c.id)).toEqual(SOURCES.map(s => s.catalogId));
    expect(MANIFEST.catalogs.map(c => c.id)).toContain('seriesCatalog');
    expect(MANIFEST.catalogs.map(c => c.id)).toContain('narutokai_catalog');

    const meta = MANIFEST.resources.find(r => r.name === 'meta');
    expect(meta.idPrefixes).toEqual(expect.arrayContaining(['pp', 'naruto_kai']));
  });

  it('keeps the search extra on the One Pace catalog only', () => {
    const onePace = MANIFEST.catalogs.find(c => c.id === 'seriesCatalog');
    const naruto = MANIFEST.catalogs.find(c => c.id === 'narutokai_catalog');
    expect(onePace.extra).toEqual([{ name: 'search', isRequired: false }]);
    expect(naruto.extra).toBeUndefined();
  });

  it('is served on the authenticated manifest route', async () => {
    const res = await get('/manifest.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MANIFEST);
  });
});

describe('sourceForEpisode', () => {
  it('routes naruto_kai ids to Naruto Kai, including lettered episodes', () => {
    expect(sourceForEpisode('naruto_kai:1').name).toBe('Naruto Kai');
    expect(sourceForEpisode('naruto_kai:27a').name).toBe('Naruto Kai');
    expect(sourceForEpisode('naruto_kai:scroll_of_wind').name).toBe('Naruto Kai');
  });

  it('falls back to One Pace for everything else', () => {
    expect(sourceForEpisode('AL_1').name).toBe('One Pace');
    expect(sourceForEpisode('COVER_SHSS_1').name).toBe('One Pace');
  });
});

describe('Naruto Kai (vendored)', () => {
  it('serves the catalog without touching the network', async () => {
    const res = await get('/catalog/series/narutokai_catalog.json');
    expect(res.status).toBe(200);
    const { metas } = await res.json();
    expect(metas).toHaveLength(1);
    expect(metas[0].id).toBe('naruto_kai');
  });

  it('serves meta with every video re-expanded from the collapsed defaults', async () => {
    const res = await get('/meta/series/naruto_kai.json');
    expect(res.status).toBe(200);
    const { meta } = await res.json();
    expect(meta.id).toBe('naruto_kai');
    expect(meta.videos).toHaveLength(NARUTO_KAI.meta.videos.length);
    for (const v of meta.videos) {
      expect(v.thumbnail).toBe(NARUTO_KAI.defaults.thumbnail);
      expect(v.released).toBe(NARUTO_KAI.defaults.released);
      expect(typeof v.season).toBe('number');
      expect(typeof v.episode).toBe('number');
    }
  });

  it('has a stream entry for every video in the meta', () => {
    for (const v of NARUTO_KAI.meta.videos) {
      expect(NARUTO_KAI.episodes[v.id], v.id).toBeDefined();
    }
  });

  it('builds a resolve URL from the vendored hash and file index', async () => {
    const res = await handleStream('naruto_kai:1', KEY, new Request(`${BASE}/${KEY}/stream/series/naruto_kai:1.json`), ctx);
    const { streams } = await res.json();
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('Naruto Kai\n[Torbox]');
    expect(streams[0].url).toBe(`${BASE}/${KEY}/resolve/${NARUTO_KAI.infoHash}/${NARUTO_KAI.episodes['naruto_kai:1'].fileIdx}`);
  });

  it('returns empty streams for an unknown naruto_kai episode', async () => {
    const res = await handleStream('naruto_kai:999', KEY, new Request(`${BASE}/${KEY}/stream/series/naruto_kai:999.json`), ctx);
    expect(await res.json()).toEqual({ streams: [] });
  });

  it('shares one torrent across all episodes', () => {
    expect(NARUTO_KAI.infoHash).toMatch(/^[a-f0-9]{40}$/);
    expect(Object.values(NARUTO_KAI.episodes).some(e => e.infoHash)).toBe(false);
  });
});

describe('unknown catalog / meta ids', () => {
  it('404s instead of proxying arbitrary GitHub paths', async () => {
    expect((await get('/catalog/series/other.json')).status).toBe(404);
    expect((await get('/meta/series/other.json')).status).toBe(404);
  });
});
