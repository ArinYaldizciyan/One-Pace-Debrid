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

  const cached = await cache.match(url);
  if (cached) {
    streamData = await cached.json();
  } else {
    const response = await fetch(url);
    if (!response.ok) {
      return new Response(JSON.stringify({ streams: [] }), { headers: JSON_HEADERS });
    }
    streamData = await response.json();
    ctx.waitUntil(cache.put(url, new Response(JSON.stringify(streamData), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }
    })));
  }

  const { infoHash, fileIdx = 0 } = streamData.streams[0];
  const host = new URL(request.url).origin;

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

  if (!apiKey) {
    return new Response('TORBOX_API_KEY not configured', { status: 500 });
  }

  try {
    let torrent = await findTorrent(apiKey, infoHash);

    if (!torrent) {
      const created = await createTorrent(apiKey, infoHash);
      if (created.data?.torrent_id) {
        // Torbox had it cached — fetch it immediately and fall through to resolve
        torrent = await getTorrent(apiKey, created.data.torrent_id);
      } else {
        // Queued for download, not instantly available
        return new Response('Adding to Torbox, try again shortly', { status: 503 });
      }
    }

    if (statusError(torrent)) {
      await createTorrent(apiKey, infoHash);
      return new Response('Torrent error, retrying. Try again shortly', { status: 503 });
    }

    if (!statusReady(torrent)) {
      return new Response('Downloading to Torbox...', { status: 503 });
    }

    const allFiles = torrent.files || [];
    const videos = allFiles
      .filter(f => isVideo(f.short_name || f.name))
      .sort((a, b) => b.size - a.size);

    // fileIdx refers to the position in the torrent's natural file order, not the sorted list
    const target = allFiles[fileIdx];
    const file = (target && isVideo(target.short_name || target.name)) ? target : videos[0];
    if (!file) {
      return new Response('No video file found in torrent', { status: 404 });
    }

    return Response.redirect(getDownloadUrl(apiKey, torrent.id, file.id), 302);

  } catch (err) {
    console.error('Resolve error:', err);
    return new Response('Internal error', { status: 500 });
  }
}

// --- Torbox API ---

async function findTorrent(apiKey, infoHash) {
  const res = await fetch(`${TORBOX_API}/api/torrents/mylist?bypass_cache=true`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'one-pace-torbox' }
  });
  const data = await res.json();
  if (!data.success || !Array.isArray(data.data)) return null;

  const matches = data.data.filter(t => t.hash === infoHash);
  return matches.find(t => !statusError(t)) || matches[0] || null;
}

async function getTorrent(apiKey, torrentId) {
  const res = await fetch(`${TORBOX_API}/api/torrents/mylist?id=${torrentId}&bypass_cache=true`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'one-pace-torbox' }
  });
  const data = await res.json();
  if (!data.success) return null;
  return Array.isArray(data.data) ? data.data[0] : data.data;
}

async function createTorrent(apiKey, infoHash) {
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
  return res.json();
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
