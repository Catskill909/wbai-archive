# KPFK Pacifica JSON audit and phased migration

Audit: September 14, 2026, approximately 9:17–9:21 p.m. EDT (September 15 UTC).
Status: feed audit and implementation plan. No runtime changes, deployment, or desktop duplication performed.

## Confirmed episode policy

**Display every episode in the accepted Pacifica JSON catalog, across all archive source groups.** There is no app-side five/six-episode cap, two-week cutoff, minimum-duration filter, or expiry-based play restriction. Pacifica controls its published availability, including the music window. `expires` may inform display text but never overrides catalog membership. Pagination may limit what is drawn at once, never which episodes can be reached.

The HTML archive and WBAI RSS are comparison evidence, not additional eligibility gates. Do not add page-only recordings to KPFK or remove JSON-only recordings because the page differs. On a successful valid catalog refresh, the current episode list follows that catalog; on a fetch/parse/validation failure, serve labeled last-known-good data. Keep show-directory records as metadata; a directory entry alone is not an episode or evidence of current programming.


## Planning documents

[Archive page and WBAI RSS audit](kpfk/archive-page-audit.md) establishes the distinction between feed length, available recordings and directory records. It also records the confirmed rule to display all JSON episodes.

This file preserves the feed audit and phase overview. For implementation decisions and detailed execution, use:

- [Architecture and data contracts](kpfk/architecture.md): station profile, identities, APIs, navigation, caching, retention and failure behavior.
- [Implementation work packages](kpfk/implementation.md): exact copy procedure, code touchpoints, dependencies, phase gates and rollback.
- [Verification and release evidence](kpfk/verification.md): offline, HTTP, browser and staging checks, with current evidence separated from pending work.
- [Fixture provenance](fixtures/pacifica-kpfk-2026-09-14/README.md): captured sources, hashes and reproducible counts.

The detailed design refines this overview where it specifies exact field names or behavior. All proposed modules/APIs remain unimplemented.

## Recommendation

Create a separate Desktop `kpfk-archive` working copy, then implement Pacifica JSON through station configuration and adapters. Preserve the existing archive/player API where practical; give the published schedule its own data model. WBAI continues operating on its current XML integration.

The new files supersede the August KPFT schema assumptions in [pacifica-json-dev.md](pacifica-json-dev.md). This is more than an XML parser substitution: the new catalog has nested source groups, published episode information, channel discovery, and a real dated schedule.

## 1. Sources and measured coverage

All eight filenames in the engineer's email returned valid JSON from `https://archive.kpfk.org/fe_feed/`. Public snapshots and HTTP headers are saved in [fixtures/pacifica-kpfk-2026-09-14](fixtures/pacifica-kpfk-2026-09-14/). Counts below describe this snapshot, not a guaranteed schema or availability contract.

| Feed | Observed role / contents |
| --- | --- |
| [fe_catalog_kpfk.json](https://archive.kpfk.org/fe_feed/fe_catalog_kpfk.json) | 520,453 bytes; `updated`, `channels[]`, `shows[source][]`, `episodes[source][altid][airDate]` |
| [fe_channels.json](https://archive.kpfk.org/fe_feed/fe_channels.json) | `primary: kpfk`; one live channel; stream URL and relative now-playing/schedule-index filenames |
| [fe_nowplaying_kpfk.json](https://archive.kpfk.org/fe_feed/fe_nowplaying_kpfk.json) | Station identity/timezone, stream, current program, track, next program; epoch boundaries and display labels |
| [fe_schedule_kpfk_index.json](https://archive.kpfk.org/fe_feed/fe_schedule_kpfk_index.json) | Three dated weeks and their relative filenames |
| [Week September 13](https://archive.kpfk.org/fe_feed/fe_schedule_kpfk_1789282800.json) | Seven days, 148 slots, two slots with published information |
| [Week September 20](https://archive.kpfk.org/fe_feed/fe_schedule_kpfk_1789887600.json) | Seven days, 148 slots, no populated `pub` arrays |
| [Week September 27](https://archive.kpfk.org/fe_feed/fe_schedule_kpfk_1790492400.json) | Seven days, 148 slots, no populated `pub` arrays |
| [fe_schedule_stamp.json](https://archive.kpfk.org/fe_feed/fe_schedule_stamp.json) | `{kpfk: {fp, built}}`; opaque fingerprint plus build epoch; treat as a potential invalidation hint pending confirmation |

Catalog joins:

- 184 show records: 165 under `kpfk`, 19 under `2kpfk` (source label `Upload`).
- 1,143 episodes: 1,006 broadcast-source episodes and 137 uploads.
- Zero duplicate episode IDs; zero episode-to-show orphans using `(plistid, altid)`; no overlapping show slugs across these two groups in this snapshot. Namespace identities anyway.
- 109 shows have recordings and **75 have none**. Program information must be able to open independently of an episode.
- **361 episodes disagree with their show’s `type`**. Preserve both fields; use show category for UI grouping and do not infer retention from type.
- Nine episodes have zero duration. None is already expired relative to catalog `updated`; none has the old KPFT `2147483647` expiry value.
- Two uploads have future `airDate` values relative to catalog generation. Both audio URLs already answer successfully. Do not automatically equate future dates with unavailable audio or silently discard them.
- All 1,143 `airDateText` values match `airDate` formatted in `America/Los_Angeles`.
- 29 episodes have populated `pub` arrays. Keys are `host`, `guest`, `topic`, and **`hotes`**. Schedule `pub` uses **`notes`** instead. Some episode `pub` arrays have two entries, so reading only the first loses information.
- Of 184 shows, 26 lack description, 85 lack short description, 81 lack artwork, and 10 lack host. The directory is broad but does not guarantee every editorial field is filled.
- Categories: Arts & Entertainment; Español; Health & Spirituality; Music; News; Public Affairs - Local; Public Affairs- National+Syndicated; Special Program.

Each week has continuous ordered coverage with no adjacent gaps, overlaps, or nonpositive slot durations, and every slot joins the primary source's show directory. These September weeks do not establish DST behavior or prove alternating-week correctness; dedicated fixtures are still required.

HTTP checks: catalog conditional GET returned **304** using its observed Last-Modified value. Four one-byte MP3 range requests (one past broadcast, one past upload, both future-dated uploads) returned **206 audio/mpeg**. This establishes sample URL/range availability, not full playback or whole-catalog playability. Regeneration cadence and multi-file atomicity remain unproven.

## 2. Findings that affect the design

### Channel is not the same as archive source

`fe_channels` lists one playable live stream, while the catalog includes two archive source groups. Keep all intended catalog groups. Use channel discovery for live listening, and `(station, plistid, altid)` for show identity. Preserve upstream episode ID separately from any station-namespaced application ID. The engineer's single-catalog explanation is consistent with this sample; it does not justify dropping uploads or building a filename for every group.

### The supplied PHP address is WPFW programming

The supplied [WPFW PHP endpoint](https://confessor.wpfwfm.org/playlist/_pl_current_ary.php), fetched with the existing app's empty-POST convention, returned WPFW's “Brother Ah’s Collectors: Next Generation in Sound” and WPFW links. KPFK's JSON identified KPFK 90.7 Los Angeles, with Pacifica Evening News followed by IMRU during the audit.

Use the KPFK JSON as the proposed live metadata source. Treat the supplied WPFW URL as a backend example until the engineer explains any intended shared routing. If PHP fallback is actually needed, verify a KPFK-specific endpoint first. Do not silently combine WPFW metadata with KPFK audio. The legacy PHP configuration block was not printed or copied into the repository.

Published KPFK stream: `https://streams.pacifica.org:9000/kpfk_128`. Its playback, browser policy, casting, and desktop compatibility need validation in the implementation phases.

### Artwork needs catalog fallback

All **444 schedule slots** and the sampled current program have `photoUrl: https://confessor.kpfk.org/pix`, a directory URL. Prefer valid catalog show artwork when schedule/live artwork is blank or directory-shaped, then a station placeholder. Ask the engineer to fix generation. Do not feed the directory URL into the existing filename-only image proxy.

### Published information is now available

The August statement “no episode description” no longer applies. Normalize `pub` arrays, retaining every entry and separate topic, guest, host and notes fields. Accept the first nonblank `notes`, then `hotes`, preserving raw input and diagnosing conflicting nonblank values. Confirm upstream’s intended spelling before removing compatibility support. Use topic as episode-specific display information with a show/date fallback. Keep episode host overrides distinct from the default show host.

Descriptions contain HTML and sometimes multiple levels of entity encoding. Normalize to safe text or tightly sanitized markup; do not insert decoded upstream HTML directly into the DOM. Test accented text, quotes, links, paragraph breaks, and empty arrays.

### Published schedules deserve a separate interface

Today `deriveSchedule()` in `public/app.js` infers a recurring grid from archive rows. Actual dated slots remove that inference for KPFK and include programs with no archived audio. Add a schedule adapter and `/api/schedule` contract; do not manufacture playable episode rows for future slots. Follow `weeks[].file` from the index, resolving relative URLs safely. Never hardcode these three filenames or compute week starts by adding 604800 seconds across DST.

### Follow the feed for episode availability

The complete accepted JSON catalog is the episode authority. Preserve all source groups and all supplied episodes. Do not impose a per-show count, music-window calculation, duration threshold or `expires` gate. Pacifica controls the published music/talk windows. The archive page is audit evidence only. A valid refresh updates catalog membership; a failed fetch retains labeled last-good data.

## 3. Current app seams and required changes

| Current code / behavior | KPFK migration |
| --- | --- |
| `server.js`: `getArchive()`, scrape, `harvestFeeds`, `applyFeeds` | JSON adapter supplies existing `{updated,count,latest,shows:[rows]}` response; JSON mode must bypass every XML/scrape refresh and studio recheck path |
| `/api/archive/head`: newest date plus count | Add a content revision so corrected metadata/schedule-independent archive edits with unchanged count/date can refresh clients |
| `/api/showinfo`, `/api/programs`, opportunistic live harvest and WBAI seed | Populate show information from catalog; adapt existing consumers; disable WBAI program scraping/seed for KPFK |
| `getNowPlaying()` | Normalize JSON into current client fields (`dj`, `start`, `end`, `song`, `artist`, etc.), retaining real epoch boundaries |
| `deriveSchedule()` and schedule chooser | Dated schedule model, explicit week selection and show-directory lookup; preserve live/past choice and empty-archive behavior |
| `UPSTREAM`, browser MP3/live constants, CSP and proxy rules | Station-owned archive, stream, artwork and link configuration; include actual port 9000 origin and redirects only as verified |
| Branding, donation/social/privacy links, manifest, metadata, localStorage | KPFK profile and assets; station-specific storage keys and launch origin |
| Desktop station profile, bundle identity, icons, installer, deployed app URL | Separate KPFK profile/build; changing the window title alone does not convert the web app |
| Studio diagnostics and actions | Report JSON source health, generation/fetch times, stale status, rejected records and refresh results; remove XML-specific action assumptions |
| Persistent files and deployment volume | Fresh KPFK `DATA_DIR`, station identity and secrets; atomic writes and independent backups |

Archive row mapping: `id` is a namespaced string episode key; `sho` is a namespaced show key (exact encoding in the architecture document); `dt` from `airDate`; `dateText` formatted in station timezone; `mp3` from `mp3Url`; `durationSec` retained with unknown-duration handling; `length` derived only when known; `episodeDesc` from normalized published information; `cat` from configurable category mapping; `source: json`; preserve explicit expiry and upstream source separately. Do not use the upstream textual `source` label as the application's provider flag.

Proposed category mapping: arts → Arts & Entertainment, music → Music, health → Health & Spirituality, news → News, public-affairs → both public affairs labels, special → Special Program. Preserve Español as a language/category label rather than claiming it means a content genre; choose its UI treatment during station styling. Unknown categories remain visible with a safe fallback.

## 4. Phased ground plan and completion gates

### Phase 0 — Freeze evidence and settle feed semantics

Deliverables: this audit, public snapshots, field mapping, and engineer questions below. Re-fetch after upstream fixes; measure changes over several refreshes and an actual program transition. Verify station routing, `pub` spelling, schedule-stamp contract and refresh cadence. Episode availability already has a settled rule: follow the JSON catalog.

Gate: documented adapter assumptions and fixtures for each known irregularity. Source-format work can start while cadence questions are pending; no automatic-retirement feature is part of this migration.

### Phase 1 — Duplicate and isolate the KPFK project

Create `/Users/paulhenshaw/Desktop/kpfk-archive` from the reviewed WBAI source, recording the source commit and any uncommitted changes. Preserve source history where practical and give KPFK its own development branch/remotes before any push. Exclude live `data/`, `.env`/secrets, dependency/build output and WBAI harvested seed content from the new runtime. Keep a station-neutral fixture/test baseline. Use a separate local port (proposed 8081), fresh KPFK data directory and independent desktop bundle identity.

Gate: KPFK workspace and configuration load with no WBAI data; the existing WBAI server and data remain intact. Do not start an unconfigured clone that begins harvesting WBAI. This is the user's Desktop project copy, distinct from the repo's `desktop/` Tauri wrapper.

### Phase 2 — Station profile and offline JSON adapters

Define explicit provider `pacifica-json`, feed base/catalog URL, primary channel, `America/Los_Angeles`, assets, links and allowed media/artwork origins in one station configuration. Discover now-playing and schedule index from channels. Implement pure catalog, show-info, now-playing and schedule normalization with fixtures before enabling background fetches.

Gate: tests cover both archive groups, duplicate/orphan identities, `hotes`/`notes`, mixed HTML encoding, unknown/zero durations, future uploads, missing artwork, empty versus malformed feeds, metadata-only revisions, cross-midnight slots, DST and a show with no episodes. Register new offline tests in `npm test`.

### Phase 3 — Archive and show information

Wire the catalog into `getArchive` and show-information APIs. Add bounded fetches, conditional requests, request coalescing, schema validation, atomic last-good persistence and visible stale status. A failed/truncated response must not replace good data. Retain rejected-record diagnostics. Explicit JSON configuration must not fall back to WBAI XML. Disable legacy harvesting at request, startup, timer and studio entry points.

Gate: snapshot parity accounts for all 1,143 episodes and 184 directory entries with no app-side episode filtering; representative broadcast/upload items work through search, show sheet, episode rail, sharing and resume. Restart using saved JSON while upstream is unavailable. Keep zero-episode shows in the directory, not in the playable archive.

### Phase 4 — Live audio and metadata

Configure the discovered KPFK stream and JSON metadata. Map current/up-next to the existing player, use catalog artwork fallback and clear stale track text on transitions. Display stale metadata honestly without interrupting an otherwise healthy stream. Preserve the existing two-audio/player ownership model; read `live-audio-pattern.md` and `big-audio-bug.md` before edits.

Gate: verify real KPFK identity/audio and a show transition; run live-stream browser suites in normal and strict autoplay modes. Check pause/resume, archive/live switching, mobile lock-screen metadata, casting and the desktop shell. An HTTP response alone is insufficient.

### Phase 5 — Published weekly schedule

Fetch index and selected/current week with independent caching. Render dated slots in Los Angeles time; use catalog metadata as fallback. Support all published weeks, index rollover, unavailable weeks, programs without archives, midnight boundaries and explicit schedule revisions. Preserve schedule overlay history and accessible player controls.

Gate: compare all 148 slots in each supplied week to rendered dates/times; fixture tests prove alternating weeks and DST. Run schedule and episode-rail browser suites. KPFK no longer relies on `deriveSchedule` heuristics when published schedule data is available; outages use labeled last-good data.

### Phase 6 — KPFK branding, retention, studio and release validation

Finish station copy/assets, all menu/donation/privacy links, web manifest, social/share metadata, desktop packaging and station storage keys. Verify full catalog coverage and JSON diagnostics; add no independent retention filter. Review remaining WBAI references individually; do not blindly replace historical docs or fixtures.

Gate: offline regression suite plus affected browser suites; mobile, desktop and accessibility smoke checks; sample archive playback/seeking; invalid JSON/HTTP errors and restart recovery; no unexpected WBAI upstream requests from the KPFK app. Validate persistent `storage.instanceId` across a staging redeploy and keep a tested rollback to the last KPFK build/snapshot. Local persistence checks do not prove production persistence. Deployment is a later concrete step after the implementation is reviewable.

### Later, optional

Cue/VTI track timelines, richer guest/topic search and multi-live-channel selection. Keep these outside the initial conversion unless needed to preserve an existing feature.

## 5. Questions to send Pacifica (draft only; not sent)

1. The KPFK base URL is verified working. Was the WPFW PHP URL an example or intended shared routing? Is JSON now-playing the preferred source and on what cadence?
2. Show and episode `type` disagree on 361 sampled episodes: which field is authoritative and what does it mean? Is episode `pub[].hotes` a typo for `notes`? Will it be fixed, and should clients support both? Can `pub` contain multiple entries, and what determines their order?
3. Can schedule/live `photoUrl` be fixed to include the filename? Every sampled schedule slot currently points to `/pix`.
4. Confirm `2kpfk` uploads belong in the primary KPFK app. Are `plistid` and episode IDs stable and globally unique, or scoped to a station/source? What changes when another confessor is added?
5. Optional metadata clarification: what do expiry sentinels and replacement-recording dates mean? This does not gate migration or episode eligibility: the app follows catalog membership.
6. How often does each feed regenerate, and how soon after recording completion does the catalog publish it? Are related files published atomically? Is `fp` an opaque supported invalidation token, and is `built` seconds?
7. How does the schedule index roll forward, represent cancellations/alternation and cross-midnight/DST slots? Are missing weeks temporarily unavailable or deliberately unpublished?

## Scope and limits

This audit inspected live public feeds and current source code, saved public evidence, checked joins/timestamps/schedule continuity, verified conditional caching and sampled four MP3 URLs. It did not exercise browser playback, poll long enough to establish cadence, verify all audio files, contact the engineer, create the Desktop clone or change application code. The implementation phases above make those completion criteria explicit.
