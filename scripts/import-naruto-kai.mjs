#!/usr/bin/env node
// Regenerates src/data/naruto-kai.json from the upstream Stremio addon repo.
//
// Naruto Kai is a finished project against a single fixed torrent, so instead
// of proxying GitHub at request time (as we do for One Pace) we vendor the
// catalog, meta, and episode -> file index map into the Worker. Re-run this if
// upstream fixes a file index or cuts a new torrent:
//
//   node scripts/import-naruto-kai.mjs
//
// Cleanup applied on import:
//   - the per-episode thumbnail / released fields are collapsed to a single
//     default when every episode carries the same value
//   - stream entries are reduced to { fileIdx } plus one shared infoHash;
//     an episode only records its own infoHash when it differs from the default

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = 'cybr23/Naruto-Kai-Stremio-Addon';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/data/naruto-kai.json');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'one-pace-torbox-import' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function collapse(videos, field) {
  const values = new Set(videos.map(v => v[field]));
  if (values.size !== 1 || !videos[0][field]) return undefined;
  const value = videos[0][field];
  for (const v of videos) delete v[field];
  return value;
}

const manifest = await getJson(`${RAW}/manifest.json`);
const catalogId = manifest.catalogs[0].id;
const catalog = await getJson(`${RAW}/catalog/series/${catalogId}.json`);
const metaId = catalog.metas[0].id;
const { meta } = await getJson(`${RAW}/meta/series/${metaId}.json`);

// Stream files are named after the video id, but list the tree too so we
// notice stream files with no matching meta entry (or vice versa).
const tree = await getJson(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`);
const streamIds = tree.tree
  .filter(t => t.path.startsWith('stream/series/') && t.path.endsWith('.json'))
  .map(t => t.path.slice('stream/series/'.length, -'.json'.length));

const videoIds = new Set(meta.videos.map(v => v.id));
const orphanStreams = streamIds.filter(id => !videoIds.has(id));
const missingStreams = [...videoIds].filter(id => !streamIds.includes(id));
if (orphanStreams.length) console.warn(`stream files with no meta entry (ignored): ${orphanStreams.join(', ')}`);
if (missingStreams.length) console.warn(`meta entries with no stream file: ${missingStreams.join(', ')}`);

const rawStreams = {};
for (const id of meta.videos.map(v => v.id)) {
  if (!streamIds.includes(id)) continue;
  const { streams } = await getJson(`${RAW}/stream/series/${id}.json`);
  const { infoHash, fileIdx = 0 } = streams[0];
  rawStreams[id] = { infoHash: infoHash.toLowerCase(), fileIdx };
}

const hashCounts = {};
for (const s of Object.values(rawStreams)) hashCounts[s.infoHash] = (hashCounts[s.infoHash] || 0) + 1;
const infoHash = Object.entries(hashCounts).sort((a, b) => b[1] - a[1])[0][0];

const episodes = {};
for (const [id, s] of Object.entries(rawStreams)) {
  episodes[id] = s.infoHash === infoHash ? { fileIdx: s.fileIdx } : s;
}

const videos = meta.videos.map(v => ({ ...v }));
const thumbnail = collapse(videos, 'thumbnail');
const released = collapse(videos, 'released');

const data = {
  source: {
    repo: `https://github.com/${REPO}`,
    version: manifest.version,
    importedAt: new Date().toISOString().slice(0, 10),
  },
  catalogId,
  catalog: catalog.metas[0],
  meta: { ...meta, videos },
  defaults: { thumbnail, released },
  infoHash,
  episodes,
};

await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${videos.length} videos, ${Object.keys(episodes).length} episodes, ${Object.keys(hashCounts).length} infoHash(es), upstream v${manifest.version}`);
