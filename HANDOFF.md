# HANDOFF — WBAI Archive

**Updated:** 2026-09-15, end of session.

## Status: maintenance-only

**Active development has moved to the KPFK Archive**
(`/Users/paulhenshaw/Desktop/kpfk-archive`, https://github.com/Catskill909/kpfk-archive,
live at https://kpfk-archive.supersoul.top). Start new work there and read its
`HANDOFF.md`.

This repo stays the **live WBAI app**. Change it only for WBAI fixes or deliberate
ports from KPFK. It is healthy and needs nothing right now.

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
