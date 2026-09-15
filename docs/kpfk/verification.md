# KPFK verification and release evidence

Status: acceptance plan. “Required” below does not mean run or passed. Historical feed checks are in the [audit](../kpfk-json-migration-plan.md); implementation behavior is still unverified.

## Confirmed episode policy

**Display every episode in the accepted Pacifica JSON catalog, across all archive source groups.** There is no app-side five/six-episode cap, two-week cutoff, minimum-duration filter, or expiry-based play restriction. Pacifica controls its published availability, including the music window. `expires` may inform display text but never overrides catalog membership. Pagination may limit what is drawn at once, never which episodes can be reached.

The HTML archive and WBAI RSS are comparison evidence, not additional eligibility gates. Do not add page-only recordings to KPFK or remove JSON-only recordings because the page differs. On a successful valid catalog refresh, the current episode list follows that catalog; on a fetch/parse/validation failure, serve labeled last-known-good data. Keep show-directory records as metadata; a directory entry alone is not an episode or evidence of current programming.


## Evidence already available

- Eight public JSON files and HTTP headers captured September 14, 2026; checksum inventory in the fixture folder.
- Catalog count/join/key consistency, station-local date equivalence and schedule interval continuity inspected.
- Catalog conditional GET returned 304; four MP3 one-byte range requests returned 206.
- Current source traced through archive, fallback, show routes, studio, telemetry and desktop defaults.

Not yet established: real browser playback, all-file availability, polling cadence, program-transition correctness, cross-day/week rollover, long outage/restart recovery, DST/alternation behavior, desktop builds or deployment persistence.

## 1. Offline contract matrix

Implement meaningful fixtures that differ from the live happy path. Register new offline tests in `npm test`.

| ID | Input / fault | Required observable outcome |
| --- | --- | --- |
| C01 | Pinned catalog, both source groups | 184 directory records, 1,143 episode rows with no app-side retention filtering; 137 uploads retained; 109 shows with episodes and 75 without |
| C02 | Same slug in two sources; same numeric ID in two sources | Distinct canonical routes, show maps, analytics attribution and episode groups |
| C03 | Reordered object keys, corrected notes, corrected MP3 URL | Reordering leaves revision unchanged; each content correction changes it with count/latest unchanged |
| C04 | String IDs, underscore slug, long invalid slug | Deep-link/OG/show-info/studio agree on accepted IDs; malformed input is rejected without upstream fetch |
| C05 | Nested outer source/slug/date disagrees with episode fields | Candidate rejected with record path; last-good unchanged |
| C06 | Orphan or conflicting duplicate episode | No silently dropped episode; candidate rejected and diagnosed |
| C07 | Zero/negative/nonfinite duration | Zero remains unknown and playable; negative/nonfinite duration becomes unknown with a diagnostic, never silently substituted with slot length |
| C08 | Empty `pub`, two entries, both `notes` and `hotes` | Preserve every entry; nonblank `notes` precedence; conflict reported; all notes remain available in raw snapshot |
| C09 | Accents, repeated entities, HTML/script-like content | Readable escaped text, paragraph breaks, no executable DOM content |
| C10 | Missing/directory artwork; valid catalog image | Correct fallback; no directory-image requests or broken-image loop |
| C11 | Corrected show description cleared to empty | Old description does not reappear through legacy caches/seeds/program matching |
| C12 | Future upload; type disagreement; unknown category | Recording retained; dates labeled accurately; no invented release/genre/retention rule |
| C13 | Known/past expiry, music older than two weeks, >6 episodes, future upload, omitted/reappearing item | Every catalog episode remains reachable/playable regardless of those fields; successful catalog membership changes are reflected; no app-side caps |
| C14 | Browser timezone differs from Los Angeles | Archive dates, schedule today and time labels consistently use station timezone |
| C15 | Blank/null current/next; empty song after previous track | Valid unavailable metadata state; old song clears; live play remains available |
| C16 | Schedule with missing archive/show join | Published slot remains visible; no guessed archive link and no fabricated playable row |
| C17 | DST spring/fall, midnight span, alternating weeks | Exact epoch intervals/date labels; no fixed 24-hour-day or 604800-second-week assumptions; repeated local hour distinguishable |
| C18 | Gap, overlap, cancellation and malformed week | Gap is shown honestly; overlap diagnosed with both slots retained if valid; canceled slot disappears on revision; structurally invalid week keeps last-good |

Validation distinction: negative/nonfinite durations degrade to unknown with a diagnostic; identity/timestamp errors reject the candidate. Test this distinction before wiring the service. September fixtures contain no DST transition; a passing September-only test does not cover C17.

## 2. HTTP/service and persistence matrix

Use a local fake Pacifica server with request capture and controlled responses. Tests must prove which endpoint was called and how often.

| ID | Scenario | Required outcome |
| --- | --- | --- |
| S01 | 20 clients request expired catalog together | One upstream refresh; consistent accepted revision for all; bounded concurrency |
| S02 | Valid 200, then 304 | Body/revision retained, validation time moves, generation time unchanged |
| S03 | 304 without stored body | One unconditional retry; clear unavailable result if no usable body |
| S04 | Timeout, DNS failure, 429/500 | Backoff/coalescing; last-good served as stale; no immediate request loop |
| S05 | HTML 200, truncated JSON, wrong root, oversize decoded body | Reject and diagnose; previous body and validators survive |
| S06 | New catalog but old live/week generation | Catalog still usable; each resource reports its own generation; no fabricated global transaction |
| S07 | Index unchanged, selected week file changes | Week revision detected and displayed |
| S08 | New index references temporarily unavailable week | Other weeks work; selected missing week has clear state; never another week relabeled as selected |
| S09 | Valid empty or sharply shrinking catalog | Accept all valid supplied episodes, including zero; counts are diagnostic only. Empty HTTP body/malformed JSON keeps last-good. |
| S10 | Disk full/write error during candidate acceptance | No claim of durable acceptance; preceding generation remains; readiness/status explains failure |
| S11 | Kill/restart after accepted snapshot; upstream unavailable | Same accepted data/revision recovers; no WBAI fallback; storage identity stable locally |
| S12 | Corrupt saved JSON / wrong station / unsupported schema | Preserve/quarantine evidence; recover compatible previous generation if available; otherwise unavailable |
| S13 | Feed reference redirects to unknown origin/path or loop | No uncontrolled fetch; bounded rejection; no expansion of origin allowlist |
| S14 | Public artwork token unknown or tries arbitrary URL | No open proxy; bounded image response; approved old token resolves across catalog refresh/restart |
| S15 | Force-refresh action during outage | Last-good remains; CSRF/auth/cooldown still enforced |
| S16 | Legacy calls attempted through startup, show-info, studio, OG or browser fallback | Request recorder sees zero WBAI upstream calls in JSON mode |
| S17 | Frozen now-playing body keeps returning 304 | Old program/track stops being labeled current after validity deadline; audio continues |
| S18 | Same canonical episode changes audio URL | New selection uses new URL; currently playing URL is not mutated; resume does not jump to a different recording |

Inspect durable files and restart behavior, not merely calls to a write helper. Test a positive control: the request recorder must detect an intentionally introduced legacy fetch, and outage tests must first prove the healthy path works.

## 3. User-facing regression matrix

Run against a fake station first, then sample real KPFK. Existing suites are starting points; their WBAI assumptions must be made configurable in the copy, not “fixed” by changing expected results until green.

| Feature | Existing suite / checks | New KPFK acceptance |
| --- | --- | --- |
| Archive/list/search | `test/ui/run.sh` | Broadcast and uploads, deterministic sorting, unknown duration, metadata-only update, clear first-boot error |
| Episode sheet/rail | `test/episode-rail/run.sh` | Correct exact-source episodes; selection does not play; loaded audio survives refresh |
| Live transport | `test/live-stream/run.sh` and `--strict` | KPFK stream, fresh tune-in after pause/sleep, archive/live exclusivity, autoplay blocked/retry behavior |
| Live profile routes | `test/ui/live-info-tests.js`, `live-archive-tests.js` via UI harness | Directory profile works without recording; current/up-next exact join and stale state |
| Weekly schedule | `test/schedule/run.sh` | Three real dated weeks, 444 slots, synthetic DST/alternation, missing week, no-recording show |
| Sharing | `test/share/run.sh` | String episode IDs and new program routes produce matching title/artwork; no WBAI defaults |
| History/navigation | UI/schedule/rail suites | Back/Forward closes/reopens expected view; audio uninterrupted; unknown/removed episode clearly handled |
| Touch/focus/motion | `test/touch/run.sh`, `test/motion/run.sh`, manual keyboard/screen-reader smoke | Background remains locked, focus returns, schedule controls and player reachable |
| Usage/studio | `npm test` usage/studio suites; `test/studio/run.sh` | Plays/listening seconds attributed to namespaced source; live not counted as an archive play; authenticated actions work |
| Branding/config | Inspect initial HTML, manifest, dialogs, tracker/storage and desktop | No WBAI first paint, fallback links, artwork, stream or runtime data |
| Casting/Media Session | Manual device checks guided by `docs/casting-dev.md` | Real receiver can reach configured audio URL; title/artwork and transport match loaded recording/live station |

Server changes require syntax check, restart of the **KPFK** process and `/healthz` verification. Frontend observations must record the served bundle version after reload. Do not modify/restart WBAI on 8080 to validate KPFK on 8081.

## 4. Staging observation plan

Proposed minimum observation: one full local broadcast-day boundary and one real program transition, plus at least 24 hours of ordinary operation. A Sunday index rollover should be observed when available; if timing prevents it, exercise the rollover in the fixture harness and explicitly record the remaining live check. Synthetic DST tests remain mandatory regardless of staging date.

Capture a compact per-resource ledger: observation time, response status, source `updated`, validators, normalized revision/counts, accepted/rejected state and duration. Do not retain listener-level telemetry or sensitive PHP configuration. Catalog polling is conditional and bounded; no mass MP3 download is necessary.

Check:

- New completed recording appears within the measured upstream publication delay plus configured refresh windows. State the measured delay, not an assumed five-minute guarantee.
- Metadata reflects an actual program transition; scheduled versus actual identity is distinguishable.
- A changed schedule is picked up without requiring the filename/index to change.
- Catalog/live/schedule outages each leave the other features usable.
- Restart recovers accepted catalog/directory and selected-week information.
- Redeploy preserves production `storage.instanceId`, accepted data and aggregate usage. Local disk survival alone does not satisfy this.
- A real rollback to a compatible KPFK build/data snapshot restores service. Record restore time and data revision.

## 5. Release checklist

All items start pending; evidence must be recorded in the implementation log.

- [ ] Clone provenance, clean runtime data and independent port verified.
- [ ] All adapter and service contract cases pass, including negative controls.
- [ ] Current fixture counts reconciled exactly against normalized current episodes; directory count remains separate.
- [ ] Archive, live and schedule browser matrices pass on supported target browsers/devices.
- [ ] No-recording program profile, unknown episode link and metadata-only refresh verified.
- [ ] No WBAI network/runtime fallback in captured KPFK traffic.
- [ ] Correct station content/links/assets and configured security origins reviewed.
- [ ] All JSON episodes are reachable; no local episode cap, music-date cutoff, minimum-duration or expiry-based play filter exists.
- [ ] Studio actions, source health and usage attribution verified without changing privacy semantics.
- [ ] Staging generation/transition/day-boundary evidence captured; unobserved live checks named.
- [ ] Persistent volume identity survives redeploy; backup and rollback rehearsed.
- [ ] Real deployment host configured and readiness passes.
- [ ] Desktop artifacts target that host, identify as KPFK and coexist with WBAI (for desktop release).
- [ ] Signing/distribution prerequisites satisfied (for public installer distribution).

## 6. Evidence log format

For each work package record:

```text
Work package / commit:
Station profile and fixture set:
Behavior changed:
Commands/suites run and exit results:
Observed API and bundle revisions:
Observed listener behavior / screenshots where useful:
Storage identity before/after (where relevant):
Live upstream observations versus simulated checks:
Remaining blocker or explicit limitation:
Rollback artifact and matching data schema:
```

Documentation quality is not implementation evidence. Do not mark a phase complete because its code compiles or because the adapter's output superficially resembles the existing rows.
