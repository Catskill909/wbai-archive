# HANDOFF — WBAI Archive

**Updated:** 2026-09-16 — next job: port the studio exports from KPFK (below).

## Status: maintenance-only

**Active development has moved to the KPFK Archive**
(`/Users/paulhenshaw/Desktop/kpfk-archive`, https://github.com/Catskill909/kpfk-archive,
live at https://kpfk-archive.supersoul.top). Start new work there and read its
`HANDOFF.md`.

This repo stays the **live WBAI app**. Change it only for WBAI fixes or deliberate
ports from KPFK. It is healthy and needs nothing right now.

## NEXT JOB: port the studio Export features from KPFK (Paul, 2026-09-16)

A **deliberate port** into this app only. WBAI stays a separate app: its own code,
data, commits, deploy (port **8080** locally, https://wbai.supersoul.top live).
Nothing is shared with KPFK at runtime; KPFK is only the reference implementation.

### What to port (built and verified live on KPFK, 2026-09-16)

Reference: `/Users/paulhenshaw/Desktop/kpfk-archive` — read its `docs/exports.md`
(spec, decisions and an "as built" section per phase) and
`docs/exports-for-pacifica.md`. KPFK commits, in order: `85f20e1` listening export ·
`c109440` date spans · `3579191` Export dialog + fetch-then-save downloads ·
`909afe8` backup/restore/undo · `1448dfe` archive + coverage · `84ea825` printable
report · `918d498` profile (**not for WBAI**) · `0f0ad11` studio title/System-panel
cleanups (check which apply to WBAI's XML build).

1. **Export button in the studio header → dialog**, tabs *Reports* and *Backup & restore*.
2. **Reports:** *Listening* (daily / per show / reach CSV, JSON, read-me; any from/to
   span, UTC days), *Archive* (episodes / shows, by local air date in
   `America/New_York`), *Coverage* (every show and its gaps), *Printable report*
   (`/studio/report`, browser Save as PDF). Presets: this month, last month, this
   year, all time.
3. **Backup & restore:** download a backup; restore = preview (writes nothing) →
   apply (copies aside first) → undo (never deletes).

Most of KPFK's `lib/export/*.js` are pure modules (csv, common, listening,
inventory, coverage, report, backup) and should carry over; `server.js` routes,
`admin/studio.html`, `public/studio.js|css`, `public/report.css|js` and the tests
need adapting. **Compare before copying** — the apps diverged (see below).

### Decisions already made — do not re-ask

- **A WBAI backup = usage `stats/` months + `data/feeds.json`.** `feeds.json` holds
  episodes WBAI accumulated beyond the ~5 per show upstream still serves; it cannot
  be re-fetched (CLAUDE.md §4), so a move without it loses archive depth. KPFK's
  backup has no feeds because Pacifica's JSON can be re-fetched — WBAI's cannot.
- **Restoring a WBAI backup onto a WBAI server MERGES episodes per show** with this
  app's own `mergeFeedItems` (keep every episode, no duplicates; restoring twice
  changes nothing). Usage months **preview, then replace**, with copies saved aside
  and Undo — as on KPFK. ("Merge" here means within WBAI's own data only.)
- **No published schedule on WBAI** (the schedule is derived from archive rows): the
  coverage column `in_published_schedule` does not apply — drop it.
- **No station profile on WBAI:** do not offer the profile export.
- Station timezone setting: on hold (KPFK HANDOFF item 2) — not part of this port.

### WBAI data to map onto (checked 2026-09-16)

- `feeds.json` / `feedStore`: `{ slug: { lastModified, fetchedAt, channel: { title },
  items: [{ mp3, bytes, title, dt, durationSec, desc, category }] } }` — 128 shows,
  ~7 items each locally. `episodeRecords()` does not exist here; the studio reads
  `feedStore` directly.
- `showinfo.json` (descriptions, per show), `programs.json` (scraped program
  directory), `photomap.json`, `known-slugs.json`, `stats/` (same month-file format
  as KPFK — the usage code originated here).
- WBAI files **do** carry byte sizes (KPFK's do not).

### Lessons from the KPFK build — keep them

- **Downloads: fetch, then save as a Blob**, and show the result or the error in the
  dialog. Plain `<a download>` links "started but downloaded nothing" on the live
  KPFK site and failed silently.
- **Browser tests must use real clicks and assert a finished file on disk**
  (`Page.setDownloadBehavior`), not `fetch()` of the URL. Layout checks must measure
  overflowing *text* (`scrollWidth` vs `clientWidth`, text-node rects), not just
  element boxes. Plant each bug and see the test fail (CLAUDE.md §3a).
- **CSP** (`style-src 'self'`): no inline style or script anywhere, including the
  printable report; SVG charts drawn with attributes.
- **CSS specificity:** `.studio-table td { white-space: nowrap }` silently overrode
  the export card rules — scope them as `.studio-table.export-plan …`.
- **Titles in exports are never slugs** (empty cell if nothing names a show); on
  screen the slug is the last resort.
- **All writes to `stats/` or `feeds.json` via `writeJsonAtomic`;** the storage-safety
  pre-commit guard blocks raw writes and deletes. Undo moves files, never deletes.
- **Read the generated PDF / files yourself** — on KPFK that found a feed change and a
  "0m for 14 seconds" bug that every test passed.

## State at a glance (checked 2026-09-15)

| | |
| --- | --- |
| Live | https://wbai.supersoul.top — Coolify, persistent named volume |
| Deployed code | Matches `main`: all four bundle size stamps in `/healthz` `version` equal the files at `f2ea8e8`. The one later commit, `5ccfda5`, is docs only |
| Storage | `mounted:true`, `freshVolume:false`, `instanceId` `0f623981-b387-4b60-a048-db9efdbcf1a1`, nothing quarantined |
| Feeds | 128 held, 0 failed (XML per-show feeds; `data/feeds.json` is irreplaceable — see CLAUDE.md §4) |
| Repo | `main` only, clean, pushed |
| Local | `PORT=8080 node server.js` (see CLAUDE.md §2) |

## What's in this repo that isn't WBAI

`5ccfda5` (Codex, 2026-09-15) committed the **KPFK planning set** here before the
KPFK folder existed: `docs/kpfk-json-migration-plan.md`, `docs/kpfk/*.md`, and
`docs/fixtures/kpfk-page-2026-09-14/` + `docs/fixtures/pacifica-kpfk-2026-09-14/`.
They are **frozen copies**. The maintained versions, with everything built since,
live in `kpfk-archive`. Nothing in WBAI's code reads them.

## The two apps have diverged

KPFK was copied from WBAI at `f2ea8e8`, then its data layer was replaced (Pacifica
JSON feeds through a station profile). Front-end fixes can port either way, but
compare first — don't copy files wholesale:

- **Player, sheet, touch, accessibility:** same code in both; a bug fixed in one
  probably exists in the other.
- **Schedule:** WBAI derives it from archive rows (`deriveSchedule`); KPFK renders
  published slots (`paintPublishedSchedule`). The UI markup is shared.
- **Side menu:** hand-written in WBAI's `index.html`; built from the station
  profile in KPFK (`lib/station-view.js`).
- **Data, `/healthz`, storage contents:** different by design (XML + `feeds.json`
  here; JSON snapshots + usage stats there).

No WBAI bugs were found during the KPFK work that need porting back. The KPFK
fixes (scheduled-only archive, WBAI branding leftovers, compose naming, `/healthz`
warm-up, profile-driven menu) were all KPFK-specific.

## Older handoffs

The 2026-08-12 UX handoff for connecting Live Now Playing and the archive (formerly
`@handoff.md`) was implemented in `0e2ac3c`, `e2e42aa` and `32031e1`. It is kept as a
design record at [docs/history/2026-08-12-live-archive-ux-handoff.md](docs/history/2026-08-12-live-archive-ux-handoff.md).
