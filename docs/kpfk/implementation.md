# KPFK implementation work packages

Status: planning only. No task below is marked implemented. The [architecture](architecture.md) defines the contracts; [verification](verification.md) defines required evidence.

## Confirmed episode policy

**Display every episode in the accepted Pacifica JSON catalog, across all archive source groups.** There is no app-side five/six-episode cap, two-week cutoff, minimum-duration filter, or expiry-based play restriction. Pacifica controls its published availability, including the music window. `expires` may inform display text but never overrides catalog membership. Pagination may limit what is drawn at once, never which episodes can be reached.

The HTML archive and WBAI RSS are comparison evidence, not additional eligibility gates. Do not add page-only recordings to KPFK or remove JSON-only recordings because the page differs. On a successful valid catalog refresh, the current episode list follows that catalog; on a fetch/parse/validation failure, serve labeled last-known-good data. Keep show-directory records as metadata; a directory entry alone is not an episode or evidence of current programming.


## Phase numbering

Keep the original audit's phase numbers: **0 evidence, 1 isolated copy, 2 configuration/adapters, 3 archive, 4 live, 5 schedule, 6 release preparation**. The brief conversational summary grouped these differently; this is the stable work breakdown. Phase 6 is split into web readiness and desktop packaging to avoid making installer work block useful web testing.

Dependencies:

```text
0 evidence ─► 1 isolated copy ─► 2 profile + offline contracts ─► 3 archive/directory
                                      │                             │
                                      └────────► 4 live ─────────────┤
                                                                    ▼
                                                          5 published schedule
                                                                    │
                                                     6A web readiness/staging
                                                                    │
                                                     6B desktop packaging
```

Each numbered phase ends with a runnable or inspectable result. Within a phase, keep commits small enough to revert without overwriting persistent data. No implementation commit belongs in the original WBAI working tree by default.

## Phase 0 — Evidence and design readiness

### P0.1 Pin the starting point

- Record WBAI source commit and working-tree delta, including untracked planning documents and snapshots. Current reviewed commit: `f2ea8e886c8afd22a53f2ba16f62c1b6388d7585`.
- Preserve public raw samples with checksums; keep the legacy PHP configuration block out of version control.
- Record source host, fetch time, HTTP status/headers and which checks were actually performed. See [fixture provenance](../fixtures/pacifica-kpfk-2026-09-14/README.md).
- Do not replace the September baseline with a newer sample; add a dated fixture set when behavior changes.

### P0.2 Resolve assumptions by impact

| Question | Can code proceed? | What waits? |
| --- | --- | --- |
| `hotes` typo / `pub` ordering | Yes, support observed aliases and preserve all entries | Removing alias support |
| Bad schedule/live artwork | Yes, catalog/local fallback | Relying exclusively on context artwork |
| Catalog cadence | Yes, provisional conditional-request policy | Final freshness claims and tuning |
| Expiry, omission, future uploads | Yes: display all catalog episodes; membership follows successful refresh | Nothing: no local retirement policy is required |
| Multiple confessors / identity scope | Yes, namespace identities now | Implicit cross-source show merging |
| `fp` schedule stamp | Yes, poll index and selected week | Stamp-only invalidation |
| WPFW endpoint intent | Yes, KPFK JSON identifies KPFK | Adding PHP fallback |
| Deployment URL / branding/signing | Yes, local fixture/adapter work | Public release and installer distribution |

Draft engineer questions remain in the main audit. No email is sent as part of planning.

**Exit:** contracts and conservative interim behavior are written; every unanswered question has a named dependent step. Long-duration observations remain explicitly pending rather than blocking unrelated work.

## Phase 1 — Isolated Desktop project copy

### P1.1 Prepare a source-only copy without launching it

Target: `/Users/paulhenshaw/Desktop/kpfk-archive`. If that directory already exists, inspect it and use a distinct destination; do not merge over an unknown project.

Preferred method at execution time: a local Git clone with independent object storage (`--no-hardlinks`) for tracked history, then an explicit overlay of reviewed uncommitted source/docs. Enumerate `git status` first: a clone alone omits the new plan and fixtures. Do not copy the working `.git` directory with an unrestricted filesystem copy.

Set a local development branch. Label the inherited local source remote as the WBAI baseline; do not create a publishing remote or push until the destination repository is established. Record baseline commit, copied working changes and excluded paths in the new project's migration log.

Exclusions from new runtime/worktree where appropriate:

- Original `data/`, local `.env*` except `.env.example`, logs, secrets and editor session state.
- `node_modules`, Rust targets, generated installer/build artifacts, Chrome/test profile directories and scanner state. Some browser profile files are tracked: explicitly inventory and remove them in the copy; `.gitignore` is not proof they are absent.
- WBAI `seed/showinfo.json` and `public/data/shows-fallback.json` from the KPFK runtime. Preserve legacy fixtures/history if useful for regression, but never expose them as KPFK data.
- Do not clone a production volume or overwrite WBAI's `.instance.json`.

### P1.2 Install isolation checks before first server start

- Make the KPFK launch path fail clearly until a valid station profile/provider is present. Explicit `PORT=8081` and clone-local `DATA_DIR` are required in the local run instructions.
- Disable/guard startup `refreshProgramsIfStale()` for JSON mode. Audit `require()` side effects, not only `server.listen()`.
- Run the first startup against a fixture server or unavailable network, and confirm zero unexpected WBAI requests. A source copy by itself is not a converted application.
- Keep the WBAI server on its existing port. Do not follow a generic “kill 8080” restart instruction while working on KPFK; restart only the verified KPFK process on 8081.
- Record the WBAI data identity and listening process read-only before/after the first KPFK run; use explicit process identity instead of killing anything occupying a port.

**Exit:** independent source, data path and port are demonstrated. A missing KPFK configuration cannot collect or display WBAI data. No deployment is involved.

## Phase 2 — Station configuration and offline adapters

### P2.1 One station profile, one public projection

Files: proposed `stations/kpfk.json`, `lib/station-config.js`; `server.js`, `.env.example`, `public/index.html`, manifest, browser initialization and tracker initialization.

- Validate station/provider/timezone/origins at startup. Add explicit script or documented environment launch; do not imply `.env` auto-loading exists.
- Serve public settings from `/api/station`; derive server-rendered branding/manifest from the same profile. Use temporary clearly labeled KPFK local assets until final artwork is supplied.
- Set capabilities for JSON schedules, show directory and RSS-hidden policy. Keep secrets entirely server-side.
- Preserve `?v=<size-mtime>` asset invalidation and no-store HTML. Show a retry state when public configuration fails.

**Acceptance:** browser, server and tracker agree on KPFK identity; no WBAI first paint, fallback stream, data seed or localStorage namespace. Tests can supply another station profile without modifying source code.

### P2.2 Pure adapters and validation

Files: proposed `lib/pacifica/normalize.js`, `test/pacifica/` fixtures/tests; `package.json` test registration.

- Implement exact-key identity and all four shapes: catalog, channels, now-playing, schedule index/week.
- Normalize UTF-8 text, all published entries, relative file references, zero duration and missing artwork.
- Establish deterministic order and revisions. Preserve original IDs/source group/date/type and diagnostics.
- Keep data validation independent of fetch and persistence; inject current time where needed.

**Acceptance:** the September catalog accounts for all 184 directory records and 1,143 episodes; every expected exception is explained. Offline tests cover corruption and synthetic identities/DST; they do not depend on whatever is on air today.

### P2.3 Provider and index interfaces

Files: `server.js`, proposed service module.

- Select legacy or JSON provider once; all data consumers use selected provider operations.
- Define neutral lookup interfaces for show key, episode key and exact MP3 URL. Include previous-snapshot lookup separately from current listing lookup.
- Keep legacy behavior available without a broad extraction rewrite.

**Acceptance:** JSON mode cannot reach legacy scraping through archive, show-info, studio, share preview or startup routes. Merely skipping the main XML sweep is insufficient.

## Phase 3 — Catalog service, archive and show information

### P3.1 Fetch and durable last-good snapshots

Files: proposed `fetch-json.js`, `service.js`, persistence integration in `server.js`.

- Implement conditional HTTP, size limits, timeouts, constrained URLs/redirects, single-flight and request-driven backoff.
- Validate complete candidates; atomically persist catalog/directory together before promoting accepted generation.
- Recover from saved raw data on restart. Keep previous generation and reject incompatible station identity or unsupported disk schema.
- Replace the current list with every accepted catalog episode; keep last-good on errors. Do not port XML accumulation, per-show feed caps, fragment filtering or page eligibility checks.
- Add resource diagnostics/readiness before wiring production data into the UI.

### P3.2 Archive/API compatibility

Files: `getArchive`, archive routes/head, show-info routes, `ogTags`; frontend `ingest`, freshness pill, fallback handling and show metadata cache.

- Use string IDs; implement exact `sho` lookup and updated route validation.
- Disable browser fallback to WBAI `shows-fallback.json` in JSON mode. Rely on server last-good data or a clear first-boot unavailable state.
- Update head freshness to content revision; metadata-only changes refresh both rows and directory. Do not block on live metadata to fetch show descriptions.
- Label deterministic sorting honestly; handle unknown duration/expiry without “0:00” or “Last day” defaults.
- Preserve playing audio/scroll/selection when accepted data changes.

### P3.3 Existing consumers beyond the listener archive

Files: `studioStats`, `ingestEvent`, `showHistory`, `/api/studio/*`, `public/studio.js`, `public/track.js`.

- Read provider-neutral indexes for totals and attribution. Canonical show keys work through all validators.
- Preserve usage payload/privacy semantics. Fix live classification from public configuration.
- Replace legacy feed/program/cache-clear actions with JSON-safe refresh operations, retaining auth, CSRF, coalescing and cooldowns.
- Report counts using correct denominators: 184 directory entries versus 109 shows with recordings in the pinned sample; XML feed count is irrelevant.

**Exit:** archive/search/sheet/rail/resume/share work for broadcast and uploaded episodes; metadata-only revisions propagate; restart during upstream outage serves the accepted snapshot; studio/usage are attributed correctly. A failed refresh leaves accepted data intact. Initial integration uses fixture servers, followed by bounded real-feed checks.

## Phase 4 — Live stream and now-playing

Files: `getNowPlaying`, `probeLiveStream`, profile media origins/CSP; frontend live metadata rendering and existing transport references.

- Configure the verified KPFK stream, including port 9000 in allowed origins. Verify redirects before widening policies.
- Map JSON current/next/track into the existing client contract, with epoch-based validity and catalog artwork fallback.
- Clear stale or empty track values and synthetic Talk/Talk. Missing live metadata cannot disable the configured live play button.
- Preserve fresh audio element per tune-in, one transport owner and Media Session behavior. Do not add a new player state machine.
- Keep live detail navigation usable even before archive fetch completes; full program-only routing arrives in Phase 5.

**Exit:** normal and strict autoplay suites pass; actual audio matches KPFK and metadata transitions correctly; archive/live switching, sleep/resume, track clearing and live-probe failures are checked. Save evidence of a real transition rather than inferring it from a single feed sample.

## Phase 5 — Published schedule and program-only profiles

### P5.1 Schedule service

Files: schedule adapter/service, proposed schedule APIs.

- Validate discovery/index references, fetch selected/current weeks independently, and poll mutable week files even when filenames do not change.
- Persist each accepted week; support stale selected-week data and explicit unavailable weeks.
- Identify dates in `America/Los_Angeles`; no timestamp arithmetic based on fixed-length weeks.

### P5.2 UI route model and rendering

Files: `deriveSchedule` call sites, `paintSchedule`, `schedApplyLiveHighlight`, chooser, sheet routing/history/OG metadata.

- Render published dated slots rather than reconstructed archive recurrence. Add visible week selection and date labels.
- Introduce a real program profile independent of episode selection; no manufactured archive row.
- Keep exact show joins. Preserve slot-specific published context without overwriting a show's default profile or selecting an unrelated recording.
- Test route precedence, Back/Forward, closing nested sheets, refresh and no-recording profiles while either audio mode is active.
- Represent disagreement between scheduled and actual programming explicitly; future weeks never show a current “Live” badge merely by weekday/time match.

**Exit:** all 444 fixture slots are accounted for, exact times and ordering verified, and synthetic alternating/DST/overnight/cancellation cases render correctly. A program with zero recordings opens usable information without a play affordance. Archive-only outages do not hide the published schedule.

## Phase 6A — Web readiness, station content and staging

- Finish KPFK assets, site title/copy, categories, station menu, show/social/donation/privacy links and media/share fallbacks. Confirm actual URLs rather than mechanically replacing `wbai` with `kpfk`.
- Verify complete JSON episode coverage with no count, duration, type or expiry filter. Retention is governed by Pacifica publishing; no separate retirement feature or engineer approval is needed for this rule.
- Audit `public/theme-boot.js`, manifest, all localStorage keys, admin headers, CSP/frame origins, analytics classification, server startup text and shared metadata.
- Review `.github/workflows/feed-scan.yml`: it currently monitors WBAI and can create GitHub issues. Disable or replace its scheduled behavior in the KPFK copy before enabling repository automation; do not carry over station monitoring accidentally.
- Update Docker/compose data settings and health checks. Do not assume `STATION_ID` alone changes upstreams, branding, timezone or browser behavior.
- Run the verification matrix and documented staging soak. Record source revision, normalized data revisions, browser bundle version and persistence identity.

**Exit:** release checklist has evidence or explicit unresolved blockers. Staging redeploy preserves `storage.instanceId` and accepted data. Release candidate and rollback are concrete; no public deployment has been implied by writing this plan.

## Phase 6B — Desktop build and distribution readiness

- Add KPFK profile under `desktop/src-tauri/stations/`, KPFK installer art/icons and separate bundle identifier. Select identifier ownership deliberately rather than implying station ownership without agreement.
- Add the real KPFK deployment URL to `desktop/stations.json`; use explicit `STATION_URL=http://localhost:8081` for local shell testing. The Rust default still points at 8080 and would otherwise open WBAI.
- Update `.github/workflows/desktop-windows.yml`: manual/default/tag station selection currently defaults to WBAI. Verify KPFK config, station name, artifact labels and baked-in URL together.
- Build Windows installer and locally signed/notarized macOS artifacts as appropriate to the intended distribution. Record signing prerequisites as external release dependencies, not code-completion claims.
- Install alongside WBAI. Verify separate application identity, window name, target host, webview storage, archive/live playback and uninstall isolation.

**Exit:** artifacts demonstrably load KPFK and coexist with WBAI. A successful compilation alone is not a desktop acceptance check.

## Rollback boundaries

| Checkpoint | Rollback action | Preserve |
| --- | --- | --- |
| Before first accepted KPFK data | Revert clone source to prior reviewed commit | WBAI entirely untouched |
| Adapter/API failure | Restore preceding KPFK build and compatible last-good snapshot | Candidate evidence and previous snapshots |
| New disk schema | Back up before migration; reject newer schema in old builds; restore matching data copy | Original newer-format copy for forward recovery |
| Bad upstream publication | Keep serving labeled last-good data; inspect held candidate | Previous accepted generation and validators |
| Staging/production deployment | Redeploy previous KPFK artifact with its compatible config/data backup | Volume identity and current backups |
| Desktop-only regression | Redistribute previous KPFK shell; web release evaluated separately | KPFK/WBAI distinct app identities and storage |

A Git revert is not a data rollback. Never delete the KPFK data directory to make a failed test pass, and never use WBAI's data as a KPFK fallback.

## Suggested implementation handoff

Begin with P1.1/P1.2 and P2.1 only after this planning review. Each work package should report changed files, user-visible behavior, exact verification performed and remaining dependencies. No time estimate is promised before the first fixture-backed integration establishes the real scope.
