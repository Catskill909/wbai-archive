# KPFK design: contracts and decisions

Status: proposed implementation design, not implemented. Read with the [migration plan](../kpfk-json-migration-plan.md) and [implementation work packages](implementation.md).

Evidence baseline: source commit `f2ea8e886c8afd22a53f2ba16f62c1b6388d7585`; September 14 public feed snapshots. Source references below name functions so they survive line-number changes.

## Confirmed episode policy

**Display every episode in the accepted Pacifica JSON catalog, across all archive source groups.** There is no app-side five/six-episode cap, two-week cutoff, minimum-duration filter, or expiry-based play restriction. Pacifica controls its published availability, including the music window. `expires` may inform display text but never overrides catalog membership. Pagination may limit what is drawn at once, never which episodes can be reached.

The HTML archive and WBAI RSS are comparison evidence, not additional eligibility gates. Do not add page-only recordings to KPFK or remove JSON-only recordings because the page differs. On a successful valid catalog refresh, the current episode list follows that catalog; on a fetch/parse/validation failure, serve labeled last-known-good data. Keep show-directory records as metadata; a directory entry alone is not an episode or evidence of current programming.


## 1. Scope and ownership

The first deliverable is a separately runnable KPFK web app copied from WBAI. The second is KPFK desktop packaging pointing at that web app. The existing `desktop/` directory is a Tauri shell, not a second server or an offline archive application.

- WBAI source/runtime/data remain the reference baseline. Implementation happens in the future `kpfk-archive` copy.
- Keep shared behavior station-configurable; retain the legacy provider in the copy so fixes can later be transferred back deliberately. Do not refactor the entire WBAI server merely to extract it into modules.
- Preserve playback behavior, episode browsing, search, sharing, resume, accessibility, privacy and studio access. A new upstream format is not a reason to redesign these.
- Published scheduling and profiles without episodes require deliberate frontend changes. “Only swap the row producer” is insufficient.
- No database, framework conversion, audio mirroring, new account system, track timeline or multi-station switcher is required for this release.

## 2. Decision record

These are working design decisions; external assumptions are listed separately below.

| Decision | Reason / consequence |
| --- | --- |
| One public station profile plus deployment-only environment settings | Avoid independently maintained browser/server copies of stream and timezone constants. Never serialize secrets into browser configuration. |
| Select provider explicitly; reject missing/contradictory KPFK configuration before serving or harvesting | An empty environment currently defaults to WBAI. That must not start an accidental WBAI collector in the KPFK copy. |
| Fetch all catalog source groups; live-channel selection is separate | The fixture includes 137 uploaded episodes under `2kpfk`, despite one live channel. |
| Three independent data services: catalog, now-playing, schedule | Metadata failures must not interrupt audio; schedule failure must not empty the archive. |
| Catalog owns both normalized episodes and the show directory | Publish these together from one accepted generation so joins cannot disagree. |
| Stable, namespaced string IDs from the first KPFK build | Avoid later deep-link and analytics migration; prevent collisions between source groups. |
| JSON metadata replaces fields in its accepted generation | Legacy `recordShowInfo()` preserves old nonempty fields, which would undo deliberate upstream corrections/removals. |
| Direct archive/live audio; same-origin feed APIs and artwork proxy | This matches actual playback: current rows already carry absolute MP3 URLs. There is no need for a new audio proxy. |
| Successful refresh replaces the current episode list with the complete JSON catalog | No union with HTML, no XML accumulation, and no local retention rules. Keep last-good/previous snapshots for recovery. |
| Use plain text for published notes in the initial release | Fits existing `textContent`/escaping model and avoids a new rich-HTML rendering dependency. Keep source text in saved raw catalog for later reprocessing. |
| Default archive order is broadcast date descending, then stable ID | JSON object traversal and IDs are not evidence of ingestion order. Label the sort “Newest broadcast”; do not claim “Recently added.” |
| The schedule index is authoritative for available weeks | `fe_schedule_stamp` is not necessary for initial correctness; defer relying on undocumented fingerprint behavior. |
| Release rollback stays within KPFK | WBAI XML is not an appropriate fallback for a KPFK deployment. |

## 3. Proposed module boundaries

Names below are proposed files, not existing files.

```text
station profile ──► server configuration ──► public station configuration
                         │
                  provider selection
                    /           \
             legacy WBAI     Pacifica JSON
                                  │
                         bounded JSON fetcher
                          /       |       \
                      catalog   live    schedule index/weeks
                          │       |       │
                      normalizers + independent accepted snapshots
                          │       |       │
                    existing APIs + published schedule API
                                  │
                         existing web UI / Tauri shell
```

| Proposed file | Owns | Must not own |
| --- | --- | --- |
| `stations/kpfk.json` | Station identity, feed entry points, categories, public links/assets and configured origins | Passwords, local data paths, production credentials |
| `lib/station-config.js` | Profile validation and explicit public projection | Network fetches or UI state |
| `lib/pacifica/normalize.js` | Pure conversion, ID construction, text/URL validation, joins and diagnostics | Filesystem, timers, fetch or current wall clock hidden inside a function |
| `lib/pacifica/fetch-json.js` | UTF-8, byte limits, timeout, validators, constrained redirects | Station-specific field mapping or global media settings |
| `lib/pacifica/service.js` | Independent single-flight refreshes, generation acceptance, disk recovery, revisions | Rendering or audio control |
| `server.js` | Provider selection, HTTP APIs, existing auth/storage/usage/static serving | JSON rules duplicated inside each route |
| `public/app.js` | Existing player, presentation, profile route, dated schedule and revisions | Raw feed traversal, guessed source joins or upstream fetches |
| `public/track.js` | Existing aggregate events using public station configuration | Listener identifiers or independent station constants |

Use existing atomic-write utilities through an explicit dependency or small extraction only when necessary. Importing a normalizer must not load `server.js` and create data files. Module extraction must not introduce require-time network or storage side effects.

## 4. Configuration contract

Proposed profile shape (illustrative; unresolved editorial links/assets must be supplied before release):

```json
{
  "schemaVersion": 1,
  "id": "kpfk",
  "provider": "pacifica-json",
  "name": "KPFK",
  "frequency": "90.7 FM",
  "city": "Los Angeles",
  "timezone": "America/Los_Angeles",
  "primaryChannel": "kpfk",
  "feeds": {
    "catalog": "https://archive.kpfk.org/fe_feed/fe_catalog_kpfk.json",
    "channels": "https://archive.kpfk.org/fe_feed/fe_channels.json"
  },
  "liveStream": "https://streams.pacifica.org:9000/kpfk_128",
  "origins": {
    "feeds": ["https://archive.kpfk.org"],
    "audio": ["https://archive.kpfk.org", "https://streams.pacifica.org:9000"],
    "artwork": ["https://confessor.kpfk.org"]
  }
}
```

Deployment settings: proposed `STATION_PROFILE=stations/kpfk.json`, `PORT=8081` locally, clone-local `DATA_DIR`, existing studio/usage environment settings. Derive station ID/timezone from the profile; if existing `STATION_ID` or `STATION_TZ` are also supplied, require agreement rather than silent precedence. KPFK launch requires a profile. Keep legacy defaults confined to the legacy launch mode.

**Local launch trap:** `npm start` currently invokes `node server.js`; the server does not load `.env`. Simply copying `.env.example` does not configure it. Document explicit shell environment values or implement a deliberate launcher compatible with the supported Node version. `.env.example` also uses `/app/data`, a container path, not the intended local data directory.

Proposed `GET /api/station` returns only a whitelist: identity, timezone, public links/assets, stream and UI capabilities. The browser loads this before initializing audio, tracker classification and station-specific storage. Missing configuration shows a retry state with no WBAI defaults. Server-rendered page title, manifest and social metadata use the same profile; `index.html` must not flash WBAI while configuration loads. Keep the no-inline-script CSP and asset version stamping.

Discovery may propose a new stream/origin, but must not expand configured security policy automatically. Validate station identity; report stream disagreement in diagnostics and continue the configured known stream until the profile is deliberately updated. This distinguishes dynamic programming metadata from station deployment settings.

## 5. Identity and row contract

### Identity encoding

For the initial KPFK contract, allow source/slug components `[A-Za-z0-9_-]{1,128}` and positive integer episode IDs safely representable by JavaScript (or decimal strings). Preserve case rather than silently lowercasing upstream identifiers. Unsupported identity syntax rejects the candidate for review instead of creating aliases.

- `showKey = stationId + '.' + plistid + '.' + altid`, e.g. `kpfk.2kpfk.informap`.
- `episodeKey = stationId + '.' + plistid + '.' + upstreamId`, e.g. `kpfk.2kpfk.139554`.
- Keep `upstreamAltId`, `upstreamId`, `archiveSource` separately. UI never parses a composite key to guess a feed URL.
- `row.id` is always a string. `ogTags()` currently compares IDs strictly against URL query strings.
- `row.sho` and show-info map keys use the canonical `showKey`. The JSON now-playing compatibility field `altid` also carries this same key, with `upstreamAltId` alongside it.
- Update single-show route and studio history validators; their existing regular expressions reject dots, and studio's regex also rejects real KPFK underscores. Bypass the client's legacy lowercasing in `showKey()`/`archiveShowId()` for canonical JSON keys; exact case-preserving identity must survive end to end.
- New source groups cannot automatically merge with primary-channel shows sharing a title. No fuzzy title matching for JSON identities. A future cross-source alias must be explicit configuration/evidence.
- Zero duplicate IDs in this snapshot does not establish upstream's global uniqueness contract.

### Archive API

Retain `GET /api/archive` with `{updated, count, latest, shows}`. `shows` remains the existing episode-row array despite its historical name. Add `provider`, `revision`, `generatedAt`, `validatedAt`, `stale`, and `schemaVersion`.

Time units: `dt`, `expiresAt`, live/schedule boundaries and upstream `generatedAt` are epoch **seconds**. Existing `updated`, new `validatedAt`, and persisted fetch times are epoch **milliseconds**. Document and test every conversion; never infer units by magnitude at the client boundary.

| Row field | KPFK rule |
| --- | --- |
| `id`, `sho` | Canonical keys above |
| `title` | Decoded show name; do not append changing episode topic to show identity |
| `episodeTitle` | First nonempty published topic, otherwise show name plus station-local broadcast date |
| `dt`, `dateText` | `airDate`; existing `secToDateText()` output in profile timezone |
| `ord` | Index after deterministic broadcast-date sort; do not preserve grouped object traversal order |
| `host` | Episode-specific published host if available; otherwise show default |
| `durationSec`, `length` | Positive known duration or `0`/empty string; zero must not be displayed as a zero-length program |
| `mp3` | Validated absolute `mp3Url`; no filename reconstruction |
| `photo` | Local artwork-proxy URL or local placeholder |
| `cat`, `categoryLabel` | Configured UI category plus original upstream category label |
| `episodeDesc`, `published[]` | Flattened text for compatibility plus all structured published entries |
| `source`, `archiveSource` | `json` provider marker; upstream group e.g. `2kpfk` kept separate |
| `expiresAt`, `expiryState` | Exact upstream expiry; `known`, `unknown`, or explicitly confirmed `permanent` |
| `daysLeft` | Compatibility projection only for known expiry; client retention badge must handle unknown explicitly |
| `hasRSS`, `rss`, `bytes` | `false`, empty string, unknown; no invented RSS link or zero-byte claim |

`type` is not a category authority: **361 fixture episodes disagree with their show's `type`**. Preserve both for diagnosis; use show category for UI grouping. Do not infer rights/retention from “Music” versus “Talk.”

`revision` hashes deterministic normalized content, including descriptions, URLs and show metadata. Exclude fetch time and relative countdown values. Reordering raw object keys must not change it. `/api/archive/head` returns the same revision; the client refresh pill compares it, including when `count` is zero. A metadata correction with unchanged count/latest must refresh the listing and cached show info together.

### Show information

`/api/showinfo` returns `{updated, revision, count, shows: {[showKey]: info}}`, projecting current fields `name`, `dj`, `desc`, `shortdesc`, `url`, `facebook`, `photo` and new exact-key links/identity. `/api/showinfo/:showKey` reads the accepted catalog only. Unknown valid key returns a documented empty result; malformed key is 400.

Remove the frontend dependency on `/api/programs` for JSON stations, including `ensurePrograms()` and fuzzy `programFor()`. If the legacy route remains available, return a documented empty compatibility response in JSON mode without initiating WBAI scraping. Source metadata must not silently revive a description explicitly cleared in a newer catalog.

## 6. Published notes and artwork

Normalize all `pub` entries in source order. For each entry choose first nonblank `notes`, then `hotes`. When both differ and are nonempty, prefer `notes`, preserve raw data and record a diagnostic. Separate host/guest/topic/notes; concatenate nonempty sections with labels and paragraph breaks for `episodeDesc`. Two-entry arrays occur in the fixture, so taking `[0]` alone is a real data-loss bug.

Convert markup to text with bounded entity-decoding passes and explicit paragraph/line-break handling. Escape at the rendering boundary regardless. Test nested encodings and literal angle brackets rather than trusting current `htmlToText()` unmodified. Exact editorial fields should clear on an accepted generation; missing required shape is a validation failure, not a reason to retain arbitrary old text.

Artwork precedence: valid context-specific image → valid catalog image for exact show key → KPFK placeholder. Blank or `/pix` directory URLs are missing images. Proposed `/api/artwork/:token` maps an opaque token to a validated URL already present in accepted data. It never accepts an arbitrary remote URL query. Maintain the lookup across restart and the immediately previous generation, so an open tab's image still resolves after refresh. Bound response size/time and validate image content type; redirects must remain on allowed artwork origins. Failed artwork must not reject an otherwise usable catalog or block audio.

## 7. Schedule and program navigation

Proposed APIs:

- `GET /api/schedule`: accepted index `{stationId, channelId, timezone, revision, weeks, stale, generatedAt, validatedAt}`; weeks contain `weekStart` and display label, not a client-fetchable arbitrary URL.
- `GET /api/schedule?weekStart=<epoch>`: week payload with exact dated `days[]`, normalized `slots[]`, generation/revision/staleness. Only fetch a week admitted by a validated index or a previously accepted cached week.
- Invalid week parameter: 400. Unknown/nonpublished week: 404. Upstream failure with cached week: 200 plus stale status. No usable week: 503; archive and live still work.

Slot contract: `slotKey`, `showKey`, upstream slug, date, `startTime`, `endTime`, name/host/description/artwork/category and `published[]`. A slot is not an episode. Use channel + start epoch + show key for stable slot identity; schedule edits may legitimately replace it. Boundaries come from epochs, with profile timezone for dates and labels.

New internal route model: `{kind:'program', showKey, slotKey?}` or `{kind:'episode', episodeKey}`. Keep existing `?show=<episodeKey>` links; introduce `?program=<showKey>` for program profiles with no selected episode. If both are supplied, episode selection wins. Malformed/unknown program links receive an explicit unavailable state, not a guessed episode. Extend social metadata for program links.

Listener behavior:

| Action / condition | Result |
| --- | --- |
| Open scheduled program with recordings | Profile and past-episodes affordance for the exact show key; no automatic play |
| Open scheduled program without recordings | Program description and “No archived episodes available”; never a fake play button |
| Open current on-air slot | Preserve live/past chooser; offer past episodes only if available; allow show information independently |
| Select future week | Actual dates shown; no “Live” badge based only on matching weekday/time |
| Live metadata disagrees with scheduled slot | Live panel follows fresh actual metadata; schedule remains published plan, labeled “Scheduled” when needed |
| Open unavailable episode link | Explain unavailable recording; show retained program information if known; no automatic jump to a different episode |
| Refresh while listening or viewing a sheet | Do not reset audio or selection; update text/rail safely; explicitly handle selected recording removed from current listing |

Stop using archive title unions, snapping, inferred timezone offsets and 14-day staleness heuristics for published KPFK slots. Preserve day-tab keyboard behavior, history, focus restoration and reachable player controls. Use actual dates to identify today; use fresh live identity plus `start <= now < end` for actual on-air highlighting. Missing/conflicting slot joins can display published slot text with no archive link; never guess by title.

## 8. Live metadata contract

Keep `/api/nowplaying` compatibility fields `current.{name,dj,altid,song,artist,start,end,photo}` and corresponding next fields; add actual epoch boundaries, station/channel identity, generation, validation time and stale status. Explicitly map JSON `host` to client `dj`. Treat `current:null`, `next:null`, blank track fields and no-program periods as valid states.

Source-time validity and fetch freshness are different. Proposed initial policy: suppress track/current-on-air claims if feed `updated` is over three minutes old or current `endTime` is past; a fresh HTTP 304 does not make old programming current. Keep live listening available and use station artwork/name. A valid future next item can be shown as scheduled, not promised live. Hide synthetic `Talk`/`Talk` track text rather than treating it as a song title. Test configurable threshold with a clock fixture.

A refresh must not change an existing audio element's URL, restart playback or switch streams. Stream configuration changes take effect on the next explicit tune-in. Preserve fresh-element-on-live-play behavior, Media Session and the archive/live transport ownership model.

## 9. Acceptance, caching and retention

Initial polling values are engineering defaults, not measured Pacifica SLAs:

| Resource | Refresh eligibility | Initial request limit |
| --- | --- | --- |
| Catalog | 5 minutes | 12 seconds, 10 MiB decoded body |
| Channels | 1 hour | 12 seconds, 256 KiB |
| Now-playing | 15 seconds while requested | 6 seconds, 256 KiB |
| Schedule index | 5 minutes while requested | 12 seconds, 256 KiB |
| Selected/current week | 5 minutes while requested, even if filename unchanged | 12 seconds, 2 MiB |

Request-driven refresh with shared promises is sufficient initially; no per-client upstream polling and no independent unconditional sweep. A visible open schedule polls its API; the server's eligibility/backoff applies across clients. Revisit intervals after cadence evidence. Cap combined upstream concurrency at three; retry on subsequent eligible request with backoff (15s, 30s, 60s, increasing to 5m). Honor bounded Retry-After; never loop on malformed JSON or fetch a full catalog per show.

Conditional GET: retain ETag/Last-Modified only with a successfully accepted body. A 304 requires a corresponding last-good body; otherwise retry once unconditionally. Handle status before JSON parsing. `fetchText()` is not sufficient unmodified: it defaults to latin1, rejects 304 and buffers without a body cap. Count actual streamed/decoded bytes; do not trust Content-Length alone.

Acceptance rules:

1. Validate root types and required arrays/maps, station/source identity, nested episode keys versus fields, unique canonical identities, timestamps and safe URLs before publication. Unknown additive fields are allowed.
2. Optional empty text, zero duration, missing photos, future uploads and show/episode type disagreement are accepted with explicit normalized meaning. Negative/nonfinite duration degrades to unknown with a diagnostic; invalid air dates and identity do not.
3. Invalid catalog identity/join or conflicting duplicates reject the whole candidate initially. This deliberately avoids silent partial archive loss; report precise record path and reason. A future partial-acceptance policy requires separate evidence.
4. Accept a structurally valid catalog even when its count shrinks or its episode map is empty. Report count changes diagnostically; never impose a count-based acceptance gate. An empty HTTP body or malformed JSON is a failed fetch, not a valid empty catalog.
5. Accept catalog and show directory together. Accept index, individual weeks and live metadata independently. Do not require all feed `updated` values to match; the fixtures already differ.
6. Build normalized candidate and content revision, persist atomically, then promote in-memory generation. Disk failure retains the previous durable generation; first boot without one reports unavailable. Do not clear last-good to “force refresh.”
7. Reject backward generation times for automatic adoption and report the candidate; legitimate upstream clock reset requires explicit reconciliation. Revalidate stored raw JSON with the current adapter on restart.

Persistence proposal under KPFK `DATA_DIR/pacifica/`: accepted raw catalog with revision/schema/station identity and validators, one previous catalog generation, channels, index and one file per accepted week. Persist catalog and generation metadata in one atomic envelope; derive current episodes and show directory together from it. Keep current index weeks and two previous weeks for recovery. A permanent historical catalog or automatic retirement service is outside the conversion scope.

Catalog membership policy: render all supplied episodes regardless of count, music/talk type, duration, future date or `expires`. If an episode disappears in a successful refresh, it leaves the current browse list; if it reappears, it returns. A failed refresh preserves last-good. An unavailable deep link explains that the episode is no longer in the current feed. An already playing audio element is not interrupted by a catalog refresh. Upstream expiry is optional descriptive metadata, not a local play gate.

## 10. Studio, usage and operations

`studioStats()` currently iterates `feedStore`; `ingestEvent()` attributes plays through `feedIndex()`; studio history validates a different slug grammar. A JSON row adapter alone would leave plausible-looking empty/unattributed statistics.

Introduce provider-neutral episode/show indexes for these consumers. Attribute exact accepted MP3 URLs to canonical show keys, retaining recent historical URLs for in-flight listening across refresh. `public/track.js` classifies live by configured stream identity instead of `streaming.wbai.org`. Preserve the existing aggregate event fields and no-identifier behavior; do not add search text or raw upstream configuration to telemetry.

JSON studio actions: refresh catalog, refresh schedule index/current week, refresh live metadata and existing live probe. Keep existing auth/CSRF/cooldowns/coalescing. Replace “Drop archive cache” with refresh preserving last-good. Detailed diagnostics show held candidates and validation reasons. Do not add an acceptance-bypass action: malformed schema and station mismatch must be corrected at source or through a deliberate adapter/configuration change.

Health: station/provider, catalog readiness/revision, generation versus fetch times, stale/error state per resource, storage instance identity and persistence failure. Basic process liveness can remain 200 while data is unavailable; add an explicit readiness result for deployment checks. Do not report a JSON station as broken merely because XML feed count is zero. Studio holds detailed rejected-record diagnostics; public endpoints expose concise status without secrets.

## 11. Decisions still needing outside evidence

- Engineer: source scope/identity stability, `hotes` compatibility, generation cadence, fingerprint and week-publication semantics, WPFW URL intent.
- Station/release preparation: final logos, public/donation/privacy links, deployment host, desktop signing/identifier ownership. Local adapter work does not depend on these.
- Product default proposed: all archive source groups in one list, upload provenance available in episode information, same existing layout, explicit dated week selector, no initial track-timeline feature.

Use [verification.md](verification.md) to resolve these through measured acceptance checks, rather than treating this design document as proof that the behavior exists.
