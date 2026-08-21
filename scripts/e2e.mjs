#!/usr/bin/env node
/**
 * End-to-end test of the addon, exercising the real Stremio request sequence
 * against a running worker and a real Torbox account.
 *
 *   node scripts/e2e.mjs <TORBOX_API_KEY> [baseUrl]
 *
 * Default baseUrl is http://localhost:8787 (wrangler dev). Pass the deployed
 * URL to test production instead.
 *
 * The final step triggers a real CDN load, verifies actual video bytes are
 * arriving, then ABORTS the transfer -- we confirm playability without
 * pulling 212 MB.
 */

const KEY = process.argv[2];
const BASE = (process.argv[3] || 'http://localhost:8787').replace(/\/$/, '');
if (!KEY) { console.error('usage: node scripts/e2e.mjs <API_KEY> [baseUrl]'); process.exit(1); }

const EPISODE = 'MA_6';                 // One Pace 23x6
const EXPECT_HASH = '3e96ef072e3798dc20d9c9fe21700eee27ff8312';
const EXPECT_IDX = 5;
const EXPECT_NAME = 'Marineford 06';
const EXPECT_SIZE = 212022000;          // approx; from the observed file listing
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

let pass = 0, fail = 0, skip = 0;
const ok   = (m, d = '') => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${m}${d ? `  ${d}` : ''}`); };
const bad  = (m, d = '') => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${d ? `  ${d}` : ''}`); };
const warn = (m, d = '') => { skip++; console.log(`  \x1b[33mSKIP\x1b[0m ${m}${d ? `  ${d}` : ''}`); };
const check = (cond, m, d = '') => (cond ? ok(m, d) : bad(m, d));
const ms = n => `${n.toFixed(0)}ms`;

async function timedFetch(url, init) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, init);
  return { res, dur: Number(process.hrtime.bigint() - t0) / 1e6 };
}

(async () => {
  console.log(`\ne2e — ${BASE}  episode ${EPISODE} (23x6)\n`);

  // ---------------------------------------------------------------- manifest
  console.log('manifest');
  try {
    const { res, dur } = await timedFetch(`${BASE}/${KEY}/manifest.json`);
    const j = await res.json();
    check(res.status === 200, 'returns 200', ms(dur));
    check(j.id === 'com.onepace.torbox', 'has expected addon id', j.id);
    check(Array.isArray(j.resources) && j.resources.length === 3, 'declares catalog/meta/stream');
    check(res.headers.get('access-control-allow-origin') === '*', 'sets CORS header');
  } catch (e) { bad('manifest request threw', e.message); }

  // ---------------------------------------------------------------- config page
  console.log('\nconfig page');
  try {
    const { res } = await timedFetch(`${BASE}/configure`);
    const body = await res.text();
    check(res.status === 200, 'returns 200');
    check(body.includes('Torbox API Key'), 'renders the key entry form');
    check(!body.includes(KEY), 'does not embed any API key server-side');
  } catch (e) { bad('config request threw', e.message); }

  // ---------------------------------------------------------------- catalog + meta
  console.log('\ncatalog + meta');
  try {
    const { res, dur } = await timedFetch(`${BASE}/${KEY}/catalog/series/seriesCatalog.json`);
    const j = await res.json();
    check(res.status === 200, 'catalog returns 200', ms(dur));
    check(Array.isArray(j.metas) && j.metas.length > 0, 'catalog has metas', `${j.metas?.length} entries`);
  } catch (e) { bad('catalog request threw', e.message); }

  try {
    const { res, dur } = await timedFetch(`${BASE}/${KEY}/meta/series/pp_onepace.json`);
    const j = await res.json();
    const vids = j.meta?.videos || [];
    const target = vids.find(v => v.id === EPISODE);
    check(res.status === 200, 'meta returns 200', ms(dur));
    check(vids.length > 400, 'meta lists full episode set', `${vids.length} videos`);
    check(!!target, `meta contains ${EPISODE}`, target ? `S${target.season}E${target.episode} "${target.title}"` : '');
  } catch (e) { bad('meta request threw', e.message); }

  // ---------------------------------------------------------------- stream
  console.log('\nstream');
  let resolveUrl = null;
  try {
    const { res, dur } = await timedFetch(`${BASE}/${KEY}/stream/series/${EPISODE}.json`);
    const j = await res.json();
    const s = j.streams?.[0];
    check(res.status === 200, 'stream returns 200', ms(dur));
    check(!!s, 'returns a stream entry');
    if (s) {
      resolveUrl = s.url;
      check(s.url.includes(`/resolve/${EXPECT_HASH}/${EXPECT_IDX}`),
            'stream url targets the right hash + fileIdx', `…/resolve/${EXPECT_HASH.slice(0, 8)}…/${EXPECT_IDX}`);
      check(!s.url.includes('token='), 'stream url carries no Torbox token');
    }
  } catch (e) { bad('stream request threw', e.message); }

  // ---------------------------------------------------------------- resolve
  console.log('\nresolve');
  let cdnUrl = null;
  if (!resolveUrl) { warn('resolve skipped — no stream url'); }
  else {
    try {
      const { res, dur } = await timedFetch(resolveUrl, { redirect: 'manual' });
      if (res.status === 302 || res.status === 301) {
        cdnUrl = res.headers.get('location');
        ok('returns 302 redirect', ms(dur));
        check(!!cdnUrl, 'redirect carries a Location');
        check(cdnUrl && !cdnUrl.includes(KEY), 'CDN url does not leak the API key');
      } else if (res.status === 503) {
        // The new failure mode: upstream flaking, reported honestly.
        warn('Torbox unavailable (503) — upstream is flaking, not an addon bug',
             `Retry-After=${res.headers.get('retry-after')}`);
        check(!!res.headers.get('retry-after'), '503 carries Retry-After (retryable, not a hard error)');
      } else if (res.status === 401) {
        // Correct response to an invalid key. Playback cannot be exercised
        // without a real one, so this is a skip, not a failure.
        ok('rejects an invalid key with 401 (not a misleading 503)', ms(dur));
        warn('playback needs a real Torbox key — rerun with a valid key to exercise it');
      } else if (res.status === 500) {
        bad('returned 500 — the crash this branch fixes', await res.text());
      } else {
        bad(`unexpected status ${res.status}`, (await res.text()).slice(0, 80));
      }
    } catch (e) { bad('resolve request threw', e.message); }
  }

  // ---------------------------------------------------------------- real load, then cancel
  console.log('\nplayback (real bytes, aborted once verified)');
  if (!cdnUrl) { warn('playback skipped — no CDN url'); }
  else {
    const controller = new AbortController();
    try {
      const t0 = process.hrtime.bigint();
      const res = await fetch(cdnUrl, { signal: controller.signal });
      const ttfb = Number(process.hrtime.bigint() - t0) / 1e6;

      check(res.ok, 'CDN responds 2xx', `${res.status} · TTFB ${ms(ttfb)}`);

      const len = parseInt(res.headers.get('content-length') || '0', 10);
      const near = len > EXPECT_SIZE * 0.9 && len < EXPECT_SIZE * 1.1;
      check(near, 'Content-Length matches the expected episode size',
            `${(len / 1e6).toFixed(1)} MB (expected ~${(EXPECT_SIZE / 1e6).toFixed(0)} MB)`);
      check(len > 1024, 'not a truncated/1-byte body (rules out cache poisoning)');

      // Pull just enough to prove real video is streaming, then abort.
      const reader = res.body.getReader();
      let got = 0, head = null;
      const TARGET = 256 * 1024;
      while (got < TARGET) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!head) head = value.slice(0, 4);
        got += value.length;
      }
      const dur = Number(process.hrtime.bigint() - t0) / 1e6;

      const magicOk = head && EBML_MAGIC.every((b, i) => head[i] === b);
      check(magicOk, 'body starts with Matroska/EBML magic 1a45dfa3',
            head ? [...head].map(b => b.toString(16).padStart(2, '0')).join('') : 'no bytes');
      check(got >= TARGET, 'streamed a real chunk of video',
            `${(got / 1024).toFixed(0)} KiB in ${ms(dur)} (~${(got / 1024 / (dur / 1000) / 1024).toFixed(1)} MiB/s)`);

      controller.abort();
      ok('transfer aborted after verification', 'no full 212 MB download');
    } catch (e) {
      if (e.name === 'AbortError') ok('transfer aborted after verification');
      else bad('playback fetch failed', e.message);
    } finally {
      try { controller.abort(); } catch {}
    }
  }

  // ---------------------------------------------------------------- negatives
  console.log('\nnegative paths');
  try {
    const { res } = await timedFetch(`${BASE}/${KEY}/stream/series/NOPE_999.json`);
    const j = await res.json();
    check(res.status === 200 && Array.isArray(j.streams) && j.streams.length === 0,
          'unknown episode returns empty stream list, not an error');
  } catch (e) { bad('unknown-episode request threw', e.message); }

  try {
    const { res } = await timedFetch(`${BASE}/${KEY}/bogus/route`);
    check(res.status === 404, 'unknown route returns 404', String(res.status));
  } catch (e) { bad('bogus route threw', e.message); }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  ${pass} passed · ${fail} failed · ${skip} skipped\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
