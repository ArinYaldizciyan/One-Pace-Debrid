#!/usr/bin/env node
/**
 * Head-to-head benchmark: current resolve path vs proposed createtorrent-first path.
 *
 *   node scripts/bench-torbox.mjs <TORBOX_API_KEY> [iterations]
 *
 * Measures latency, bytes transferred, and failure rate for:
 *   A (current)  : GET  mylist?bypass_cache=true        -> scan all torrents for hash
 *   B (proposed) : POST createtorrent                   -> torrent_id, then
 *                  GET  mylist?id=<id>&bypass_cache     -> files
 *   C (info only): POST checkcached                     -> availability by hash
 *
 * A and B are INTERLEAVED so Torbox flakiness hits both paths equally — otherwise
 * a bad minute would unfairly punish whichever path ran during it.
 *
 * Also verifies the idempotency claim: that repeated createtorrent calls return a
 * stable torrent_id and do NOT grow the library with duplicates.
 */

const TORBOX = 'https://api.torbox.app/v1';
const HASH = '3e96ef072e3798dc20d9c9fe21700eee27ff8312'; // Marineford — known present, cached
const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'http://anidex.moe:6969/announce',
  'http://tracker.anirena.com:80/announce',
];

const KEY = process.argv[2];
const ITERS = parseInt(process.argv[3] || '5', 10);
if (!KEY) { console.error('usage: node scripts/bench-torbox.mjs <API_KEY> [iterations]'); process.exit(1); }

const H = { Authorization: `Bearer ${KEY}`, 'User-Agent': 'one-pace-torbox-bench' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ms = n => `${n.toFixed(0)}ms`;

// Times a fetch and classifies the outcome the same way the worker now does.
async function timed(label, url, init = {}) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    const dur = Number(process.hrtime.bigint() - t0) / 1e6;
    let json = null, parseOk = true;
    try { json = JSON.parse(body); } catch { parseOk = false; }
    return { label, ok: res.ok && parseOk, status: res.status, dur, bytes: body.length, json, parseOk,
             snippet: parseOk ? '' : body.slice(0, 40).replace(/\n/g, ' ') };
  } catch (err) {
    const dur = Number(process.hrtime.bigint() - t0) / 1e6;
    return { label, ok: false, status: 0, dur, bytes: 0, json: null, parseOk: false, snippet: `network: ${err.message}` };
  }
}

const magnet = () =>
  `magnet:?xt=urn:btih:${HASH}` + TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');

const mylistFull = () => timed('A:mylist-full', `${TORBOX}/api/torrents/mylist?bypass_cache=true`, { headers: H });
const mylistById = id => timed('B:mylist-byid', `${TORBOX}/api/torrents/mylist?id=${id}&bypass_cache=true`, { headers: H });

function createTorrent() {
  const body = new URLSearchParams({ magnet: magnet(), allow_zip: 'false' });
  return timed('B:createtorrent', `${TORBOX}/api/torrents/createtorrent`, { method: 'POST', headers: H, body });
}

function checkCached() {
  return timed('C:checkcached',
    `${TORBOX}/api/torrents/checkcached?format=list&list_files=true`,
    { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [HASH] }) });
}

const stats = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, min: s[0], p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1],
           mean: s.reduce((a, b) => a + b, 0) / s.length };
};

const results = { A: [], B: [], C: [] };
const failures = [];
const idsSeen = new Set();

function record(bucket, r) {
  if (r.ok) results[bucket].push(r.dur);
  else failures.push(`${r.label} status=${r.status} ${r.parseOk ? '' : `non-JSON:"${r.snippet}"`}`);
  return r;
}

(async () => {
  console.log(`\nTorbox path benchmark — hash ${HASH.slice(0, 12)}…, ${ITERS} iterations, interleaved\n`);

  const before = await mylistFull();
  const libSize = Array.isArray(before.json?.data) ? before.json.data.length : '?';
  const dupBefore = Array.isArray(before.json?.data) ? before.json.data.filter(t => t.hash === HASH).length : '?';
  console.log(`library: ${libSize} torrents, ${(before.bytes / 1024).toFixed(0)} KiB payload, entries matching our hash: ${dupBefore}\n`);

  for (let i = 1; i <= ITERS; i++) {
    // --- Path A: current implementation
    const a = record('A', await mylistFull());
    let aBytes = a.bytes;
    if (a.ok && Array.isArray(a.json?.data)) a.json.data.find(t => t.hash === HASH); // the scan
    await sleep(400);

    // --- Path B: proposed
    const c = record('B', await createTorrent());
    let bTotal = c.dur, bBytes = c.bytes;
    const tid = c.json?.data?.torrent_id;
    if (tid) idsSeen.add(tid);
    if (tid) {
      await sleep(200);
      const g = await mylistById(tid);
      if (g.ok) { bTotal += g.dur; bBytes += g.bytes; results.B[results.B.length - 1] = bTotal; }
      else failures.push(`${g.label} status=${g.status}`);
    }
    await sleep(400);

    console.log(`  iter ${i}: A ${a.ok ? ms(a.dur) : 'FAIL'} (${(aBytes / 1024).toFixed(0)} KiB)` +
                `   B ${c.ok ? ms(bTotal) : 'FAIL'} (${(bBytes / 1024).toFixed(1)} KiB)` +
                `   torrent_id=${tid ?? 'n/a'}`);
  }

  console.log('');
  record('C', await checkCached());

  const after = await mylistFull();
  const dupAfter = Array.isArray(after.json?.data) ? after.json.data.filter(t => t.hash === HASH).length : '?';
  const libAfter = Array.isArray(after.json?.data) ? after.json.data.length : '?';

  const A = stats(results.A), B = stats(results.B), C = stats(results.C);
  const row = (name, s) => s
    ? `  ${name.padEnd(22)} n=${String(s.n).padEnd(3)} p50=${ms(s.p50).padEnd(8)} p95=${ms(s.p95).padEnd(8)} mean=${ms(s.mean)}`
    : `  ${name.padEnd(22)} no successful samples`;

  console.log('── latency ──');
  console.log(row('A current (scan)', A));
  console.log(row('B proposed (create+id)', B));
  console.log(row('C checkcached', C));
  if (A && B) {
    const d = ((A.p50 - B.p50) / A.p50) * 100;
    console.log(`\n  p50 delta: ${d > 0 ? '-' : '+'}${Math.abs(d).toFixed(1)}% ${d > 0 ? 'faster' : 'SLOWER'} for proposed path`);
  }

  console.log('\n── idempotency ──');
  console.log(`  distinct torrent_ids returned by ${ITERS} createtorrent calls: ${[...idsSeen].join(', ') || 'none'}`);
  console.log(`  entries matching hash: ${dupBefore} before -> ${dupAfter} after  ${dupAfter === dupBefore ? '(no duplicates)' : '*** DUPLICATES CREATED ***'}`);
  console.log(`  library size: ${libSize} -> ${libAfter}`);

  console.log('\n── reliability ──');
  const total = ITERS * 2 + 2;
  console.log(`  failures: ${failures.length} / ~${total} calls`);
  failures.forEach(f => console.log(`    ${f}`));
  console.log('');
})();
