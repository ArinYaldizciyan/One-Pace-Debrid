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

const CONFIG_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>One Pace (Torbox) - Configure</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #eee; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #16213e; border-radius: 12px; padding: 2rem; max-width: 480px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    p { color: #aaa; font-size: 0.9rem; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.85rem; margin-bottom: 0.4rem; color: #ccc; }
    input { width: 100%; padding: 0.7rem; border-radius: 6px; border: 1px solid #333; background: #0f3460; color: #eee; font-size: 0.95rem; }
    button { width: 100%; padding: 0.7rem; border-radius: 6px; border: none; background: #e94560; color: #fff; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
    button:hover { background: #c73e54; }
    .result { margin-top: 1rem; display: none; }
    .result a { color: #53d8fb; word-break: break-all; }
    .result code { display: block; background: #0f3460; padding: 0.6rem; border-radius: 6px; margin-top: 0.5rem; font-size: 0.8rem; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>One Pace (Torbox)</h1>
    <p>Enter your Torbox API key to generate your personal addon URL. Your key is never stored on this server — it becomes part of your unique URL.</p>
    <label for="apikey">Torbox API Key</label>
    <input type="text" id="apikey" placeholder="Paste your Torbox API key here">
    <button onclick="generate()">Install</button>
    <div class="result" id="result">
      <label>Your addon URL:</label>
      <code id="url"></code>
      <br>
      <a id="install" href="#">Click here to install in Stremio</a>
    </div>
  </div>
  <script>
    function generate() {
      const key = document.getElementById('apikey').value.trim();
      if (!key) return;
      const base = location.origin + '/' + encodeURIComponent(key);
      const manifest = base + '/manifest.json';
      document.getElementById('url').textContent = manifest;
      document.getElementById('install').href = 'stremio://' + manifest.replace('https://', '').replace('http://', '');
      document.getElementById('result').style.display = 'block';
    }
  </script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: JSON_HEADERS });
    }

    // --- Unauthenticated routes ---

    if (path === '/' || path === '/configure') {
      return new Response(CONFIG_PAGE, { headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    }

    // --- Authenticated routes: /{apiKey}/... ---

    const authMatch = path.match(/^\/([^/]+)(\/.*)?$/);
    if (!authMatch) {
      return new Response('Not Found', { status: 404 });
    }

    const apiKey = authMatch[1];
    const subPath = authMatch[2] || '/';

    if (subPath === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), { headers: JSON_HEADERS });
    }

    if (subPath === '/catalog/series/seriesCatalog.json') {
      return githubProxy('catalog/series/seriesCatalog.json', ctx);
    }

    if (subPath === '/meta/series/pp_onepace.json') {
      return githubProxy('meta/series/pp_onepace.json', ctx);
    }

    const streamMatch = subPath.match(/^\/stream\/series\/(.+)\.json$/);
    if (streamMatch) {
      return handleStream(streamMatch[1], apiKey, request, ctx);
    }

    const resolveMatch = subPath.match(/^\/resolve\/([a-f0-9]+)\/(\d+)$/i);
    if (resolveMatch) {
      return handleResolve(resolveMatch[1].toLowerCase(), parseInt(resolveMatch[2]), apiKey, ctx);
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

async function handleStream(episodeId, apiKey, request, ctx) {
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
      url: `${host}/${apiKey}/resolve/${infoHash}/${fileIdx}`
    }]
  }), { headers: JSON_HEADERS });
}

// --- Resolve Handler ---

async function handleResolve(infoHash, fileIdx, apiKey, ctx) {
  const reqId = crypto.randomUUID().slice(0, 8);

  console.log(`[${reqId}] RESOLVE START infoHash=${infoHash} fileIdx=${fileIdx}`);

  try {
    let torrent = await findTorrent(apiKey, infoHash, reqId);

    if (!torrent) {
      console.log(`[${reqId}] Torrent not found in list, creating...`);
      const created = await createTorrent(apiKey, infoHash, reqId);
      console.log(`[${reqId}] createTorrent response: success=${created.success} torrent_id=${created.data?.torrent_id} queued_id=${created.data?.queued_id} error=${JSON.stringify(created.error)} detail=${created.detail}`);

      if (created.data?.torrent_id) {
        console.log(`[${reqId}] Torbox cached, fetching torrent_id=${created.data.torrent_id}`);
        torrent = await getTorrent(apiKey, created.data.torrent_id, reqId);
        if (!torrent) {
          console.log(`[${reqId}] ERROR: getTorrent returned null after create`);
          return new Response('Failed to fetch newly created torrent', { status: 503 });
        }
      } else {
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

    const target = allFiles[fileIdx];
    const file = (target && isVideo(target.short_name || target.name)) ? target : videos[0];

    if (target && !isVideo(target.short_name || target.name)) {
      console.log(`[${reqId}] WARNING: fileIdx=${fileIdx} is not a video (${target.short_name || target.name}), falling back to largest video`);
    }
    if (!target) {
      console.log(`[${reqId}] WARNING: fileIdx=${fileIdx} out of bounds (${allFiles.length} files), falling back to largest video`);
    }

    if (!file) {
      console.log(`[${reqId}] RESULT: 404 - No video file found`);
      return new Response('No video file found in torrent', { status: 404 });
    }

    // Warm the next episode's CDN link in the background (no added latency)
    ctx?.waitUntil(prefetchNextEpisode({
      apiKey, infoHash, torrent, fileIdx, cache: caches.default, fetchImpl: fetch, reqId,
    }));

    // Fetch the download URL server-side to avoid leaking the API key
    const torboxUrl = getDownloadUrl(apiKey, torrent.id, file.id);
    console.log(`[${reqId}] Fetching download URL server-side: torrent_id=${torrent.id} file_id=${file.id} file_name=${file.short_name || file.name}`);

    const dlRes = await fetch(torboxUrl, { redirect: 'manual' });
    const cdnUrl = dlRes.headers.get('Location');

    console.log(`[${reqId}] Torbox requestdl response: status=${dlRes.status} hasLocation=${!!cdnUrl}`);

    if (cdnUrl) {
      console.log(`[${reqId}] RESULT: 302 - Redirecting to CDN`);
      return Response.redirect(cdnUrl, 302);
    }

    // If no redirect, try parsing JSON response for download link
    const dlData = await dlRes.json();
    console.log(`[${reqId}] Torbox requestdl JSON: success=${dlData.success} hasData=${!!dlData.data} error=${JSON.stringify(dlData.error)} detail=${dlData.detail}`);

    if (dlData.data) {
      console.log(`[${reqId}] RESULT: 302 - Redirecting via JSON data`);
      return Response.redirect(dlData.data, 302);
    }

    console.log(`[${reqId}] RESULT: 502 - Could not resolve download link`);
    return new Response('Could not resolve download link', { status: 502 });

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
    console.log(`[${reqId}] findTorrent: API returned non-success or non-array data`);
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
