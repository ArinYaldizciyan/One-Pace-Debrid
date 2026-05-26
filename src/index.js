const GITHUB_BASE = 'https://raw.githubusercontent.com/fedew04/OnePaceStremio/main';
const TORBOX_API = 'https://api.torbox.app/v1';
const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm'];
const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'http://anidex.moe:6969/announce',
  'http://tracker.anirena.com:80/announce',
  'udp://tracker.uw0.xyz:6969/announce',
  'http://share.camoe.cn:8080/announce',
  'http://t.nyaatracker.com:80/announce',
];

const MANIFEST = {
  id: 'com.onepace.torbox',
  version: '1.0.0',
  name: 'One Pace (Torbox)',
  description: 'One Pace fan edit with Torbox HTTP streaming.',
  logo: 'https://i.pinimg.com/originals/4c/46/ee/4c46ee47e0710a6d928454f68fc4ee17.png',
  resources: [
    'catalog',
    { name: 'meta', types: ['series'], idPrefixes: ['pp'] },
    'stream'
  ],
  types: ['series'],
  catalogs: [{
    type: 'series',
    id: 'seriesCatalog',
    name: 'One Pace',
    extra: [{ name: 'search', isRequired: false }]
  }]
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (path === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), { headers: JSON_HEADERS });
    }

    if (path === '/catalog/series/seriesCatalog.json') {
      return githubProxy('catalog/series/seriesCatalog.json', ctx);
    }

    if (path === '/meta/series/pp_onepace.json') {
      return githubProxy('meta/series/pp_onepace.json', ctx);
    }

    const streamMatch = path.match(/^\/stream\/series\/(.+)\.json$/);
    if (streamMatch) {
      return handleStream(streamMatch[1], request, env, ctx);
    }

    const resolveMatch = path.match(/^\/resolve\/([a-f0-9]+)\/(\d+)$/i);
    if (resolveMatch) {
      return handleResolve(resolveMatch[1].toLowerCase(), parseInt(resolveMatch[2]), env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// --- GitHub Proxy ---

async function githubProxy(filePath, ctx) {
  const url = `${GITHUB_BASE}/${filePath}`;
  const cache = caches.default;

  const cached = await cache.match(url);
  if (cached) return addCorsHeaders(cached);

  const response = await fetch(url);
  if (!response.ok) {
    return new Response('Upstream error', { status: response.status, headers: JSON_HEADERS });
  }

  const body = await response.text();
  ctx.waitUntil(cache.put(url, new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }
  })));

  return new Response(body, { headers: JSON_HEADERS });
}

function addCorsHeaders(response) {
  const r = new Response(response.body, response);
  Object.entries(JSON_HEADERS).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}

// --- Stream Handler ---

async function handleStream(episodeId, request, env, ctx) {
  const url = `${GITHUB_BASE}/stream/series/${episodeId}.json`;
  const cache = caches.default;
  let streamData;
  let fromCache = false;

  const cached = await cache.match(url);
  if (cached) {
    streamData = await cached.json();
    fromCache = true;
  } else {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`STREAM: episodeId=${episodeId} github_status=${response.status} - returning empty streams`);
      return new Response(JSON.stringify({ streams: [] }), { headers: JSON_HEADERS });
    }
    streamData = await response.json();
    ctx.waitUntil(cache.put(url, new Response(JSON.stringify(streamData), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }
    })));
  }

  const { infoHash, fileIdx = 0 } = streamData.streams[0];
  const host = new URL(request.url).origin;

  console.log(`STREAM: episodeId=${episodeId} cached=${fromCache} infoHash=${infoHash} fileIdx=${fileIdx} host=${host}`);

  return new Response(JSON.stringify({
    streams: [{
      name: 'One Pace\n[Torbox]',
      title: episodeId,
      url: `${host}/resolve/${infoHash}/${fileIdx}`
    }]
  }), { headers: JSON_HEADERS });
}

// --- Resolve Handler ---

async function handleResolve(infoHash, fileIdx, env) {
  const apiKey = env.TORBOX_API_KEY;
  const reqId = crypto.randomUUID().slice(0, 8);

  console.log(`[${reqId}] RESOLVE START infoHash=${infoHash} fileIdx=${fileIdx}`);

  if (!apiKey) {
    console.log(`[${reqId}] ERROR: TORBOX_API_KEY not configured`);
    return new Response('TORBOX_API_KEY not configured', { status: 500 });
  }

  try {
    let torrent = await findTorrent(apiKey, infoHash, reqId);

    if (!torrent) {
      console.log(`[${reqId}] Torrent not found in list, creating...`);
      const created = await createTorrent(apiKey, infoHash, reqId);
      console.log(`[${reqId}] createTorrent response: success=${created.success} torrent_id=${created.data?.torrent_id} queued_id=${created.data?.queued_id} error=${JSON.stringify(created.error)} detail=${created.detail}`);

      if (created.data?.torrent_id) {
        // Torbox had it cached — fetch it immediately and fall through to resolve
        console.log(`[${reqId}] Torbox cached, fetching torrent_id=${created.data.torrent_id}`);
        torrent = await getTorrent(apiKey, created.data.torrent_id, reqId);
        if (!torrent) {
          console.log(`[${reqId}] ERROR: getTorrent returned null after create`);
          return new Response('Failed to fetch newly created torrent', { status: 503 });
        }
      } else {
        // Queued for download, not instantly available
        console.log(`[${reqId}] RESULT: 503 - Queued for download`);
        return new Response('Adding to Torbox, try again shortly', { status: 503 });
      }
    }

    console.log(`[${reqId}] Torrent state: id=${torrent.id} hash=${torrent.hash} active=${torrent.active} download_finished=${torrent.download_finished} download_present=${torrent.download_present} download_state=${torrent.download_state} files_count=${torrent.files?.length}`);

    if (statusError(torrent)) {
      console.log(`[${reqId}] Torrent in error state, re-creating...`);
      await createTorrent(apiKey, infoHash, reqId);
      console.log(`[${reqId}] RESULT: 503 - Torrent error`);
      return new Response('Torrent error, retrying. Try again shortly', { status: 503 });
    }

    if (!statusReady(torrent)) {
      console.log(`[${reqId}] RESULT: 503 - Still downloading`);
      return new Response('Downloading to Torbox...', { status: 503 });
    }

    const allFiles = torrent.files || [];
    const videos = allFiles
      .filter(f => isVideo(f.short_name || f.name))
      .sort((a, b) => b.size - a.size);

    console.log(`[${reqId}] Files: total=${allFiles.length} videos=${videos.length} fileIdx=${fileIdx}`);
    if (allFiles.length > 0) {
      console.log(`[${reqId}] All files: ${JSON.stringify(allFiles.map((f, i) => ({ idx: i, id: f.id, name: f.short_name || f.name, size: f.size })))}`);
    }

    // fileIdx refers to the position in the torrent's natural file order, not the sorted list
    const target = allFiles[fileIdx];
    const file = (target && isVideo(target.short_name || target.name)) ? target : videos[0];

    if (target && !isVideo(target.short_name || target.name)) {
      console.log(`[${reqId}] WARNING: fileIdx=${fileIdx} is not a video (${target.short_name || target.name}), falling back to largest video`);
    }

    if (!file) {
      console.log(`[${reqId}] RESULT: 404 - No video file found`);
      return new Response('No video file found in torrent', { status: 404 });
    }

    const dlUrl = getDownloadUrl(apiKey, torrent.id, file.id);
    console.log(`[${reqId}] RESULT: 302 - Redirecting to download torrent_id=${torrent.id} file_id=${file.id} file_name=${file.short_name || file.name}`);
    return Response.redirect(dlUrl, 302);

  } catch (err) {
    console.error(`[${reqId}] RESOLVE ERROR:`, err.message, err.stack);
    return new Response('Internal error', { status: 500 });
  }
}

// --- Torbox API ---

async function findTorrent(apiKey, infoHash, reqId = '-') {
  const res = await fetch(`${TORBOX_API}/api/torrents/mylist?bypass_cache=true`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'one-pace-torbox' }
  });
  const data = await res.json();
  console.log(`[${reqId}] findTorrent: status=${res.status} success=${data.success} isArray=${Array.isArray(data.data)} count=${Array.isArray(data.data) ? data.data.length : 'N/A'} error=${JSON.stringify(data.error)} detail=${data.detail}`);

  if (!data.success || !Array.isArray(data.data)) {
    console.log(`[${reqId}] findTorrent: API returned non-success or non-array data. Raw keys: ${data.data ? Object.keys(data.data) : 'null'}`);
    return null;
  }

  const matches = data.data.filter(t => t.hash === infoHash);
  console.log(`[${reqId}] findTorrent: ${matches.length} hash matches for ${infoHash}`);
  if (matches.length > 0) {
    matches.forEach((t, i) => {
      console.log(`[${reqId}] findTorrent match[${i}]: id=${t.id} active=${t.active} download_finished=${t.download_finished} download_present=${t.download_present} download_state=${t.download_state} statusError=${statusError(t)} statusReady=${statusReady(t)}`);
    });
  }

  return matches.find(t => !statusError(t)) || matches[0] || null;
}

async function getTorrent(apiKey, torrentId, reqId = '-') {
  const res = await fetch(`${TORBOX_API}/api/torrents/mylist?id=${torrentId}&bypass_cache=true`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'one-pace-torbox' }
  });
  const data = await res.json();
  console.log(`[${reqId}] getTorrent: status=${res.status} success=${data.success} torrentId=${torrentId} isArray=${Array.isArray(data.data)} error=${JSON.stringify(data.error)}`);

  if (!data.success) return null;
  const torrent = Array.isArray(data.data) ? data.data[0] : data.data;
  if (torrent) {
    console.log(`[${reqId}] getTorrent result: id=${torrent.id} hash=${torrent.hash} active=${torrent.active} download_present=${torrent.download_present} download_state=${torrent.download_state} files=${torrent.files?.length}`);
  }
  return torrent;
}

async function createTorrent(apiKey, infoHash, reqId = '-') {
  const trackerParams = ANIME_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  const magnet = `magnet:?xt=urn:btih:${infoHash}${trackerParams}`;
  const body = new URLSearchParams({
    magnet,
    allow_zip: 'false'
  });
  const res = await fetch(`${TORBOX_API}/api/torrents/createtorrent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'one-pace-torbox' },
    body
  });
  const result = await res.json();
  console.log(`[${reqId}] createTorrent: status=${res.status} success=${result.success} torrent_id=${result.data?.torrent_id} queued_id=${result.data?.queued_id} hash=${result.data?.hash} error=${JSON.stringify(result.error)} detail=${result.detail}`);
  return result;
}

function getDownloadUrl(apiKey, torrentId, fileId) {
  return `${TORBOX_API}/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
}

// --- Status Helpers (mirrors torrentio/moch/torbox.js) ---

function statusReady(torrent) {
  return !!torrent?.download_present;
}

function statusError(torrent) {
  return (!torrent?.active && !torrent?.download_finished) || torrent?.download_state === 'error';
}

function isVideo(filename = '') {
  return VIDEO_EXTS.some(ext => filename.toLowerCase().endsWith(ext));
}
