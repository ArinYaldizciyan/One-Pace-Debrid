# Research: Secondary Sources for One Pace Torrent Hashes

**Date:** 2026-06-30
**Context:** The addon currently sources episode → `{infoHash, fileIdx}` mappings from a single GitHub repo (`fedew04/OnePaceStremio`). When that repo lags behind a new One Pace release, there is no way to get the new hash. This documents where else hashes can be sourced. Produced via a fact-checked deep-research pass (21 sources fetched, 25 claims adversarially verified 3-vote, 4 killed).

## Executive summary

One Pace torrents remain reliably sourceable. The single best programmatic fallback is **Nyaa.si RSS**, which the official project itself points to as its canonical torrent index. Two premises we started with turned out to be **false** (verified):

1. **onepace.net still publishes infohashes** — it is back online and embeds a 40-char `infoHash` per release in its homepage Next.js JSON payload.
2. **Releases are 1080p now**, not only 720p — current/recent arcs are 1080p; older un-re-released back-catalog remains 720p/480p.

The official GraphQL API is **dead** (down since July 2024) — do not build on it.

## Premise corrections (verified 3-0)

- **onepace.net is a usable programmatic source again.** `GET onepace.net/en` (with a browser User-Agent — it 403s bots via Cloudflare) returns inline JSON containing e.g. `"infoHash":"80872a919a43b5d044caa3fd80933707344e4fab"`, `"infoHref":"https://nyaa.si/view/2126364"`, `"torrentFilename":"[One Pace] One Piece Fan Letter [1080p][59510B34].mkv"`. The `magnetHref` is an unresolved Next.js RSC ref (`$11`), so use the `infoHash` field directly.
- **1080p exists.** Egghead arc + re-released early arcs carry `[1080p]` tags; Dressrosa / Thriller Bark / Whole Cake and other un-re-released arcs remain 720p/480p. Our current season-packs are the 720p back-catalog.
- **GraphQL API is defunct.** Down since July 2024, breaking automated addon updates for over a year. The `au2001/onepace-stremio` addon switched (Sept 2025) to scraping the official Google Sheets. Claims that `onepace.net/api/graphql` is live were refuted 0-3.
- **The GitHub `one-pace` org has no hashes** — only `one-pace-public-subtitles` and `.github`.

## Ranked shortlist (how to query each)

| Rank | Source | How to query | Infohash? | Notes |
|---|---|---|---|---|
| 1 | **Nyaa RSS** | `GET nyaa.si/?page=rss&q=one+pace&c=0_0&f=0` | ✅ `<nyaa:infoHash>` (hex) + `<nyaa:seeders>` / `<nyaa:leechers>` per item | Best Worker fit: no `.torrent` parsing, built-in seeder filter. Field stability corroborated by Sonarr / SickChill / RSS-Bridge. Generic query returns all uploaders → must filter by title/cross-ref. |
| 2 | **onepace.net embedded JSON** | `GET onepace.net/en` with browser UA, parse inline `infoHash` | ✅ direct | Authoritative for *which* hash is the official release. Use to validate Nyaa results. |
| 3 | **@onepacef Telegram** | scrape `t.me/s/onepacef` (public web preview) | ✅ torrent files + magnets, tagged by arc | Fan-run, explicitly NOT official; no uptime guarantee; lags official. Last resort. |
| 4 | **Pixeldrain direct DL** | from onepace.net `pixeldrainHref` | ❌ direct HTTP only | Only useful if Torbox can ingest a URL. Subtitle/multi-audio support via this path is unverified (see open questions). |

## Architecture implications

### This is not a drop-in fallback
The worker depends on the GitHub repo's **per-episode** mapping `episodeId → {infoHash, fileIdx}` (e.g. `SAB_9 → season-pack hash, fileIdx 8`). Nyaa / onepace.net give **per-release torrents**, not the Stremio-episode → file-index mapping. A fallback needs a mapping layer: match a release to arc/episode and compute the right `fileIdx` within the pack. onepace.net JSON includes `torrentFilename` + arc/part/resolution, which is enough to build that mapping — but it is real work, not a config tweak.

### No trusted Nyaa uploader to filter on
All `nyaa.si/user/onepace*` variants return HTTP 404 (verified). Releases come from individual submitters (e.g. user `one`, `Galaxy9000`). To avoid third-party re-encodes, filter by title pattern **and** cross-reference onepace.net's authoritative `infoHref`.

### Statelessness is not a blocker
The request-path Worker is stateless per-request, but Cloudflare provides KV, D1, Durable Objects, the Cache API, and **Cron Triggers**. Recommended pattern:

- A **scheduled Worker** (cron, e.g. hourly) polls Nyaa RSS + onepace.net, builds/refreshes the `episodeId → {infoHash, fileIdx}` index, and writes it to **KV**.
- The **request-path Worker** reads the mapping from KV (fast, no external call on the hot path), falling back to the GitHub repo for anything not yet indexed.

This keeps the "authoritative log" in KV, refreshed out-of-band — the request path stays simple and fast.

## Follow-up research (2026-06-30): three threads resolved

### A. fedew04 repo lag — the fallback is rarely needed
- Repo is **actively maintained**: latest data commit 2026-06-21 ("wano 60"), ~weekly cadence in 2026, single maintainer tracking releases closely.
- Lag on new releases is **0–7 days** (Wano 60 same-day; Egghead 21 Extended +3 days). Only current gap: "Fan Letter 01" (dropped 2026-06-28, not yet added).
- Apparent gaps like Wano 61–86 and Elbaf are **not repo lag** — One Pace hasn't released those at all; no fallback can help.
- Shape nuance: **newer releases are single-file 1080p torrents** (`fileIdx` omitted → 0); **older back-catalog are 720p season-packs with real `fileIdx`**. A fallback for *new* episodes largely avoids the `fileIdx` problem.
- **Implication:** the fallback's job is narrow — cover the days-long window after a new drop. Favors a light approach over a rearchitecture.

### B. au2001/onepace-stremio — the reference cron→index pipeline (read the official Sheets)
- Sources two **official public Google Sheets** (the One Pace team's own tracker):
  - Episodes: `1HQRMJgu_zArp-sLnvFMDzOyjdsht87eFLECxMK858lA`
  - Descriptions: `1M0Aa2p5x7NioaH9-u8FyHq6rH3t5s6Sccs8GoC6pHAM`
- Per episode the sheet gives: title, arc, anime-episode coverage, release date, and **MKV CRC32** (as cell text) plus a **Nyaa URL as the cell's hyperlink**.
- **Infohash join:** if the Nyaa URL is the `?q={infoHash}` form → hash is free; if `/view/{id}` → scrape the Nyaa page for `<kbd>{40-hex}</kbd>`.
- **fileIdx join:** download the `.torrent`, bencode-parse it, and pick the file whose name ends `[{CRC32}].mkv`. Single-file torrents → `fileIdx: undefined`.
- **Access from a Worker:** plain `GET https://sheets.googleapis.com/v4/spreadsheets/{id}?ranges='{Arc}'!B2:G&includeGridData=true&key={GOOGLE_API_KEY}`. A **free Google API key** is required to get the *hyperlinks* (`includeGridData`); the keyless CSV/gviz endpoints return only cell text (CRC32), not the Nyaa URL.
- **Architecture:** runs hourly via GitHub Actions cron, commits static JSON served from GitHub Pages (`onepace.arl.sh`) — i.e. the same pattern as fedew04, different (more official) source. This is the canonical blueprint for a cron→KV Worker version.

### C. Torbox API — direct-URL path is viable AND preserves subtitles/audio
- **Web downloads (direct URL) are first-class:** `POST /v1/api/webdl/createwebdownload` with `{ link }`; Pixeldrain is an explicitly supported hoster. Cache check: `GET /v1/api/webdl/checkcached?hash={md5(url)}` (note: the "hash" is the **MD5 of the URL string**, not a file checksum). CDN retrieval: `GET /v1/api/webdl/requestdl` — mirrors the torrent path exactly.
- **Subtitles / multi-audio survive.** The `requestdl` CDN path (what the addon already uses) serves the **original `.mkv` byte-for-byte with HTTP range support — no transcoding**, on both the torrent and webdl paths. Embedded subtitle + audio tracks are preserved; whether they surface is up to the player (Stremio/MPV/Exoplayer read embedded MKV tracks fine). Caveat: if Pixeldrain hosts a re-encoded file, Torbox can only pass through what's there.
- (Torbox's separate web-player/Streaming API *does* transcode and expose track selection, but that's a different, proprietary path the addon doesn't use.)
- **Batch cached-check for torrents:** `GET /v1/api/torrents/checkcached?hash={csv of SHA1 infohashes}&format=list&listFiles=true` — useful to pre-filter to hashes Torbox already has, and `listFiles=true` returns file names/sizes (an alternate way to derive `fileIdx` without parsing `.torrent` yourself).
- **Torbox search index:** `search-api.torbox.app` exists but is **paid-tier, IMDB-ID-keyed**, and One Pace (a fan edit) is poorly covered — **not a reliable sourcing route.** Skip.

## Feed-compatibility check (2026-06-30) — the "quick win" is NOT viable

Before building the option-1 fallback, we verified au2001's live feed (`onepace.arl.sh`). **The two feeds are identifier-incompatible**, so a read-through fallback cannot be a drop-in:

| | fedew04 (what we use) | au2001 (`onepace.arl.sh`) |
|---|---|---|
| Series/meta id | `pp_onepace` | `onepace` |
| Season 20 = | Sabaody arc | Post-Enies Lobby arc |
| Episode IDs | `SAB_1…SAB_11` | `PEN_1…` |
| Titles | One Pace titles | anime-episode titles |
| Numbering | its own | different arc/season numbering |

Our worker keys everything on **fedew04's** episode IDs — Stremio requests `stream/series/SAB_9.json`. au2001's feed has no `SAB_9`, so a fallback to `onepace.arl.sh/stream/series/{id}.json` would 404 every time. The earlier "~10 lines" estimate was wrong: "same *pattern*" (static JSON, same endpoint shape) is not "same identifiers."

Deeper reason it can't be trivial: our *identity* (episode IDs + meta) comes from fedew04, and no other source shares it. For the gap case (a new episode fedew04 hasn't added), fedew04 supplies neither the meta entry nor the hash, so a stream-only fallback can't even surface the episode. Any real fallback must either reconcile the two numbering schemes (a fuzzy arc/episode-number/title join) or own the meta+streams outright.

## Recommendation (revised)

Realistic options, given the compatibility finding:

1. ~~Add au2001's feed as a drop-in read-through fallback.~~ **Not viable** — ID-incompatible (see above).
2. **Cross-feed mapping fallback (medium effort).** When fedew04 lacks a stream, join to au2001 by arc + within-arc episode number / title to recover an infohash. Self-contained, but inherently fuzzy across two numbering schemes.
3. **Cron→KV pipeline / own the data (larger effort).** A Cloudflare **Cron Trigger** (hourly) reads the official Google Sheets, resolves infohashes via Nyaa, derives `fileIdx` (trivial `0` for new single-file releases; for the rare new season-pack, use Torbox `checkcached?listFiles=true` or `.torrent` bencode parsing), and writes both **meta and per-episode `{infoHash, fileIdx}` into KV**. Request Worker reads KV, falling back to fedew04. Lets us own the episode list, so brand-new episodes surface on day zero.
4. **Direct-URL/Pixeldrain via Torbox `webdl` — hold as a resilience layer, not a primary.** Viable and (good news) preserves subtitles/audio (byte-for-byte CDN, no transcode), but adds a second ingestion path (md5-of-url cache checks, webdl endpoints). Only worth it if torrent seeding becomes a real availability problem.
5. **Skip the Torbox search API** (paid, IMDB-keyed, poor fan-edit coverage).

## Decision (2026-06-30): shelved

**No fallback will be built at this time.** Rationale: (a) the cheap drop-in version does not exist (feed incompatibility above); (b) the next-episode **prefetch/warming** feature already resolved the actual user-facing "Loading failed" pain; (c) fedew04 lag is only 0–7 days and the user is far behind current releases, so lag is not a practical problem. If the situation changes, options **2** (cross-feed mapping) or **3** (cron→KV, for true independence) are the real paths — this doc is the record.

## Open questions — resolved

- ~~Does Torbox accept a direct URL / preserve subtitles?~~ **Yes and yes** (webdl path; `requestdl` is byte-for-byte, no transcode). See section C.
- ~~au2001 Google Sheets URLs / Worker-queryable?~~ **Resolved** — IDs above; queryable via Sheets API v4 REST with a free key. See section B.
- ~~How far behind is fedew04?~~ **0–7 days, well-maintained.** See section A.
- ~~Trusted Nyaa uploader?~~ Still none; use CRC32-from-Sheets + Nyaa join (au2001's method) rather than uploader filtering.
- ~~Torbox searchable index?~~ Exists but unsuitable (paid, IMDB-keyed). See section C.

### Remaining unknowns (minor)
- Whether One Pace has deployed a *new* GraphQL API since Sept 2025 (au2001 was "waiting for" one) — would be cleaner than scraping.
- Edge `.torrent` bencode parsing effort in a Worker for the rare new season-pack (mitigated by Torbox `checkcached?listFiles=true`).

## Key sources

- `nyaa.si/xmlns/nyaa` — RSS namespace (`<nyaa:infoHash>`, `<nyaa:seeders>`, `<nyaa:leechers>`) — primary
- `nyaa.si/?page=rss&q=one+pace` — live RSS feed — primary
- `onepace.net/en` — embedded infoHash JSON — primary
- `x.com/OnePaceProject/status/1878106019173224648` — official tweet: Torrent link → Nyaa search — primary
- `github.com/au2001/onepace-stremio` — ecosystem reference; GraphQL-dead + Google-Sheets pivot — primary
- `github.com/vasujain275/onepace-stremio` — older GraphQL approach (now defunct)
- `t.me/s/onepacef` — fan Telegram channel — primary
- `github.com/Viren070/AIOStreams` — references a Torbox search source — primary

## Refuted claims (do not act on)

- "A submitter named 'One Pace' is the consistent uploader across nearly all torrents" — **0-3**.
- "`onepace.net/api/graphql` is live and returns per-episode download/infohash data" — **0-3**.
- "The GraphQL `downloads` field yields an extractable infohash URI" — **0-3**.
