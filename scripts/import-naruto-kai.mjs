#!/usr/bin/env node
// Regenerates src/data/naruto-kai.json from the upstream Stremio addon repo
// and the torrent it points at.
//
// Naruto Kai is a finished project against a single fixed torrent, so instead
// of proxying GitHub at request time (as we do for One Pace) we vendor the
// catalog, meta, and episode -> file map into the Worker. Re-run this if
// upstream fixes a mapping or cuts a new torrent:
//
//   node scripts/import-naruto-kai.mjs
//
// Why the torrent is parsed too: upstream's fileIdx values are positions in
// Stremio's own file ordering (files inside sub-folders first, then root
// files), which is neither the torrent's index order nor the order Torbox
// lists files in. We reproduce that ordering to translate each upstream
// fileIdx into a torrent file NAME, and store names in torrent-index order so
// the Worker can match Torbox files by name rather than by position.
//
// Cleanup applied on import:
//   - the per-episode thumbnail / released fields are collapsed to a single
//     default when every episode carries the same value
//   - stream entries are reduced to { fileIdx } (torrent index) plus one
//     shared infoHash; an episode only records its own infoHash when it
//     differs from the default

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const REPO = 'cybr23/Naruto-Kai-Stremio-Addon';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/data/naruto-kai.json');

const UA = { 'User-Agent': 'one-pace-torbox-import' };

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
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

// --- minimal bencode decoder (keeps byte offsets so we can hash `info`) ---

function bdecode(buf) {
  let i = 0;
  const str = () => {
    const colon = buf.indexOf(0x3a, i);
    const len = parseInt(buf.subarray(i, colon).toString('latin1'), 10);
    const out = buf.subarray(colon + 1, colon + 1 + len);
    i = colon + 1 + len;
    return out;
  };
  const any = () => {
    const c = buf[i];
    if (c === 0x69) { // i
      const end = buf.indexOf(0x65, i);
      const n = parseInt(buf.subarray(i + 1, end).toString('latin1'), 10);
      i = end + 1;
      return n;
    }
    if (c === 0x6c) { // l
      i++;
      const out = [];
      while (buf[i] !== 0x65) out.push(any());
      i++;
      return out;
    }
    if (c === 0x64) { // d
      i++;
      const out = {};
      while (buf[i] !== 0x65) {
        const key = str().toString('utf8');
        const start = i;
        out[key] = any();
        if (key === 'info') out.__infoBytes = buf.subarray(start, i);
      }
      i++;
      return out;
    }
    return str();
  };
  return any();
}

async function fetchTorrentFiles(nyaaId) {
  const res = await fetch(`https://nyaa.si/download/${nyaaId}.torrent`, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} fetching torrent ${nyaaId}`);
  const torrent = bdecode(Buffer.from(await res.arrayBuffer()));
  const infoHash = createHash('sha1').update(torrent.__infoBytes).digest('hex');
  const files = torrent.info.files.map(f => f.path.map(p => p.toString('utf8')));
  return { infoHash, files };
}

// Stremio's torrent engine lists files inside sub-folders before files at the
// torrent root, each group in path order. Upstream fileIdx values index into
// that list.
function stremioOrder(files) {
  return files
    .map((segments, torrentIdx) => ({ segments, torrentIdx }))
    .sort((a, b) => {
      const depth = (b.segments.length > 1) - (a.segments.length > 1);
      return depth || a.segments.join('/').localeCompare(b.segments.join('/'));
    });
}

// --- import ---

const manifest = await getJson(`${RAW}/manifest.json`);
const catalogId = manifest.catalogs[0].id;
const catalog = await getJson(`${RAW}/catalog/series/${catalogId}.json`);
const metaId = catalog.metas[0].id;
const { meta } = await getJson(`${RAW}/meta/series/${metaId}.json`);

const nyaaId = manifest.description.match(/nyaa\.si\/view\/(\d+)/)?.[1];
if (!nyaaId) throw new Error('could not find a nyaa.si/view/<id> link in the upstream manifest description');
const torrent = await fetchTorrentFiles(nyaaId);
const stremioFiles = stremioOrder(torrent.files);

const tree = await getJson(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`);
const streamIds = tree.tree
  .filter(t => t.path.startsWith('stream/series/') && t.path.endsWith('.json'))
  .map(t => t.path.slice('stream/series/'.length, -'.json'.length));

const videoIds = new Set(meta.videos.map(v => v.id));
const orphanStreams = streamIds.filter(id => !videoIds.has(id));
const missingStreams = [...videoIds].filter(id => !streamIds.includes(id));
if (orphanStreams.length) console.warn(`stream files with no meta entry (ignored): ${orphanStreams.join(', ')}`);
if (missingStreams.length) console.warn(`meta entries with no stream file: ${missingStreams.join(', ')}`);

const hashCounts = {};
const episodes = {};
const problems = [];

for (const video of meta.videos) {
  if (!streamIds.includes(video.id)) continue;
  const { streams } = await getJson(`${RAW}/stream/series/${video.id}.json`);
  const { infoHash, fileIdx = 0 } = streams[0];
  const hash = infoHash.toLowerCase();
  hashCounts[hash] = (hashCounts[hash] || 0) + 1;

  if (hash !== torrent.infoHash) {
    problems.push(`${video.id}: upstream hash ${hash} is not the nyaa torrent (${torrent.infoHash}); kept positional`);
    episodes[video.id] = { infoHash: hash, fileIdx };
    continue;
  }

  const entry = stremioFiles[fileIdx];
  if (!entry) {
    problems.push(`${video.id}: upstream fileIdx ${fileIdx} is past the end of the torrent`);
    continue;
  }

  // Sanity check: numbered episodes must land on a file with the same number.
  const want = video.title.match(/Episode (\d+)(?: ([AB]))?/);
  const got = entry.segments.at(-1).match(/Episode (\d+)(?: ([AB]))?/);
  if (want && (!got || got[1] !== want[1] || (got[2] || '') !== (want[2] || ''))) {
    problems.push(`${video.id}: "${video.title}" mapped to "${entry.segments.at(-1)}"`);
  }

  episodes[video.id] = { fileIdx: entry.torrentIdx };
}

if (problems.length) {
  console.error('mapping problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const videos = meta.videos.map(v => ({ ...v }));
const thumbnail = collapse(videos, 'thumbnail');
const released = collapse(videos, 'released');

const data = {
  source: {
    repo: `https://github.com/${REPO}`,
    version: manifest.version,
    torrent: `https://nyaa.si/view/${nyaaId}`,
    importedAt: new Date().toISOString().slice(0, 10),
  },
  catalogId,
  catalog: catalog.metas[0],
  meta: { ...meta, videos },
  defaults: { thumbnail, released },
  infoHash: torrent.infoHash,
  // Basenames in torrent-index order; episodes[].fileIdx indexes into this.
  files: torrent.files.map(segments => segments.at(-1)),
  episodes,
};

await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${videos.length} videos, ${Object.keys(episodes).length} episodes, ${data.files.length} torrent files, upstream v${manifest.version}`);
for (const id of ['naruto_kai:1', 'naruto_kai:27b', 'naruto_kai:28', 'naruto_kai:movie_the_last', 'naruto_kai:scroll_of_wind', 'naruto_kai:shinden_1']) {
  if (episodes[id]) console.log(`  ${id} -> [${episodes[id].fileIdx}] ${data.files[episodes[id].fileIdx]}`);
}
