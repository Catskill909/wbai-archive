# Studio exports — WBAI

**Status: built 2026-09-16**, ported from the KPFK archive, where the feature was
designed and verified live the same day. The full design record — why a dialog,
why fetch-then-save downloads, why no PDF library, the decisions on dates and
presets — is KPFK's `docs/exports.md` (`/Users/paulhenshaw/Desktop/kpfk-archive`).
This file records what WBAI has and where it differs.

In the studio header, **Export** opens a dialog with two tabs.

## Reports

| Dataset | Files | Dates | Source on WBAI |
| --- | --- | --- | --- |
| **Listening** | Daily, Per show, Reach (CSV); Everything (JSON); read-me | UTC days — counters were bucketed that way when recorded | `stats/` month files (current month from memory) |
| **Archive** (`inventory`) | Episodes, Shows (CSV); JSON; read-me | Air date in `America/New_York` | `feeds.json` — every episode held, including those kept after they left the feed |
| **Coverage** | Every show (CSV); JSON with a gap summary; read-me | None — a snapshot | `feeds.json` ∪ `known-slugs.json`, plus `showinfo.json`, `photomap.json`, `programs.json` |
| **Printable report** | `/studio/report?from=&to=` — browser Print → Save as PDF | Both clocks, stated on the page | The same builders as the downloads |

Presets: this month, last month, this year, all time (from the server's `today`,
never the browser's clock). Signed-in only; `Cache-Control: private, no-store`.

### Where WBAI differs from KPFK

- **No station profile export.** WBAI has no station profile (KPFK's is its JSON
  config). Decided 2026-09-16.
- **Archive = what the app holds**, not what the listing shows: the same store
  the studio's "Every feed" dashboard counts, so the two agree (tested). Columns
  add `file_bytes` / `total_bytes` (WBAI's feeds state file sizes) and drop
  `episode_id` and `expires_utc` (the XML feeds have neither; `audio_url` is the
  unique key, as it is for `mergeFeedItems`). Items with no parseable date are
  counted in `manifest.undated_skipped`, never dropped silently.
- **Coverage has no published schedule to lean on** (the schedule is derived from
  archive rows), so `in_published_schedule` is gone. Its rows are every slug the
  listing has ever named plus every held feed, and the biggest gap it shows is
  `has_feed: false` — a listed show with no podcast feed has no episodes in this
  feed-only app ([missing-show.md](missing-show.md)). `in_program_directory` is the
  studio's existing approximate title match.
- **Generic artwork:** an image on 4+ shows is not a show's own. On 2026-09-16
  `…/pix/WBAI_it_.jpg` was the feed image of 17 shows — the same class KPFK found
  with Pacifica's `KPFK_med.jpg`. Artwork also counts from the schedule-page photo
  map and show records.
- **Titles:** feed title → show record (`showinfo.json` `name`) → empty cell in a
  file, the slug on screen. The studio's Most listened shows and show history use
  the same lookup (KPFK `0f0ad11`), so a show with no feed held is named when the
  harvest has met it.

## Backup & restore

**A WBAI backup is usage `stats/` months + `feeds.json`** (decided 2026-09-16).
`feeds.json` holds episodes WBAI's ~5-item feeds no longer list; they cannot be
re-fetched (CLAUDE.md §4), so a move without them loses the archive's depth.
KPFK's backup has no feeds because Pacifica's JSON can be re-fetched.

- **File:** `wbai-backup-YYYY-MM-DD.json` — `format: "pacifica-archive-backup"`,
  `formatVersion: 1`, `stats` + `checksums` (per month), `settings` (empty),
  `feeds` (per show: `channel` and `items` with only the known fields — fetch state
  `lastModified`/`fetchedAt` does not travel) + `feedsChecksum`.
- **Validation refuses, never trims** (`lib/export/backup.js`): KPFK's month rules,
  plus for feeds — slug shape, no unknown field on a show, channel or episode,
  text fields are text, counts are whole numbers, audio and image addresses are
  http(s), ≤ 2000 episodes per show (`FEED_ITEM_CAP`), checksum. A backup with no
  months is accepted if it has episodes (`USAGE_TRACKING=off` stations).
- **Months: preview, then replace** — as KPFK.
- **Episodes: merged per show** with the harvest's own `mergeFeedItems`. Every
  episode is kept, none duplicated, and **this server's copy wins a collision**
  (it is the more recent telling). A show the restore adds gets no fetch state, so
  the next sweep fetches it unconditionally. Restoring the same file twice adds
  nothing and leaves `feeds.json` byte-identical.
- **Preview writes nothing** and names the shows that would gain episodes.
- **Apply** first writes copies to `DATA_DIR/imports/pre-import-<time>/` — the
  replaced months, the whole `feeds.json`, and a manifest listing every episode it
  adds — then writes. Outside `stats/`, so the month listing can never read it.
- **Undo** saves the current state beside the copies (`undone-<month>.json`,
  `undone-feeds.json`), puts months back, **moves** added months aside, and takes out
  of the feed store exactly the episodes the restore added (a show it added goes
  if nothing else is left). Nothing is deleted.
- **Refused while WBAI's feeds are being checked** (409, "try again in a minute"): a
  harvest in flight holds each show's pre-restore record across its network await
  and would overwrite the merge when it lands.

Moving guide: [DEPLOYMENT.md](DEPLOYMENT.md) "Moving the app to another server".

## Tests

- `test/exports/export.test.js` (in `npm test`): CSV writer; listening, inventory
  and coverage builders; a real server on a seeded data dir — auth, span
  validation, titles (feed, show record, empty), totals against the seeded month
  and the dashboard, the 9:30 pm New York episode on its New York day, archive =
  dashboard episode count, coverage facts from each source, generic artwork, the
  report's figures equal to the CSVs, CSP-clean and escaped.
- `test/exports/backup.test.js` (in `npm test`): the validator's refusals incl. the
  feeds rules; the merge plan; two real servers — preview byte-identical, refusals
  write nothing, apply copies aside first, union with no duplicates, server wins a
  collision, untouched shows, fetch state, restore twice is byte-identical; undo
  restores `feeds.json` exactly and moves rather than deletes.
- `test/exports/dockerfile.test.js` (in `npm test`): every local `require()` of
  `server.js` is copied into the image — the port added `lib/`, which a named-path
  Dockerfile does not pick up by itself. Self-test removes `COPY lib`.
- **Planted and seen to fail** (2026-09-16): slug as title, UTC air dates, generic
  artwork counted, inline style in the report, backup winning a collision, no
  feeds copy before writing, unknown episode field accepted, undo leaving an added
  show, preview writing `feeds.json`, Dockerfile without `lib`.
- Browser: `test/studio/export-tests.js` (in `test/studio/run.sh`) — real clicks,
  finished files on disk, the preview with a crafted backup (never applies, safe
  against a live station), text-overflow fit checks, the report printed to PDF.
- **Not covered by a test:** the in-flight-harvest refusal (a harvest cannot be
  started offline); the Coolify deploy itself.
