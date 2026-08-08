# CLAUDE.md — working rules for this repo

Guardrails that exist because we lost hours (and tokens) to them. Follow them.

## 1. NEVER-STALE RULE — you may have been testing code that wasn't loaded

The single biggest time-sink here: editing `public/app.js` / `styles.css`, then
judging the result against a **stale cached copy the browser never reloaded**. A
"fix that didn't work" was often a fix that never ran. See
[docs/big-audio-bug.md](docs/big-audio-bug.md).

**Technical guardrail (already in `server.js`):**
- `index.html` is served `Cache-Control: no-store` (always fresh) and its
  `app.js` / `styles.css` links are **version-stamped** with `?v=<size-mtime>`.
- Change either file → new stamp → new URL → the browser is forced to fetch it.
  Stale client code is now structurally impossible via a normal reload.
- The current bundle version is exposed two ways:
  - `curl -s localhost:8080/healthz` → `{"ok":true,"version":"<app>.<css>"}`
  - `X-App-Version` response header on `/`.

**Process rule — never conclude a client change did or didn't work without
proving the browser ran it:**
1. After editing `public/*`, `curl -s localhost:8080/healthz` and note the version.
2. Have the user **reload** (a normal reload now suffices; if ever in doubt,
   hard-refresh Cmd/Ctrl+Shift+R). The page's `X-App-Version` must match step 1.
3. Only then trust the observed behavior. If versions differ, it's stale — stop,
   don't "fix" anything.

Never edit files the browser loads and assume they're live. Verify the version.

## 2. SERVER-REBOOT RULE — when a restart is required, do it and verify

Node does **not** hot-reload. Know which changes need a restart:

| Changed | Restart the Node server? |
| --- | --- |
| `server.js` (or any backend `.js`, routes, headers, proxy, API shape) | **YES — required.** The running process holds the old code until restarted. |
| `public/*` (`app.js`, `styles.css`, `index.html`, assets) | **No.** Served fresh from disk per request (see §1). |

**When you change `server.js`, you MUST, in the same step:**
1. `node --check server.js` (syntax).
2. Stop the running server and start a fresh one:
   ```sh
   PID=$(lsof -nP -tiTCP:8080 -sTCP:LISTEN); [ -n "$PID" ] && kill $PID; sleep 1
   node server.js &
   ```
3. **Verify it came up on the new code:** `curl -s localhost:8080/healthz` returns
   200 with the expected `version`, and spot-check the endpoint you changed
   (e.g. `curl -s localhost:8080/api/nowplaying`).
4. A backend change is **not done** until the running server has been restarted and
   verified. Do not report success against a server still running old code.

Port is **8080**. A background server may already be running; kill it before
starting a new one (`EADDRINUSE` means one is up).

## 3. DEBUGGING DISCIPLINE (learned the hard way)

- **Change one variable at a time.** If the symptom *moves* with each edit, you're
  perturbing a race — stop guessing and get evidence.
- **Don't swallow errors while debugging.** `.catch(function(){})` on
  `audio.play()` hid the real failures for hours. Log rejections.
- **Prefer the boring standard model.** The live player broke every time it
  deviated from what the archive player does (`pause()` / `play()`, `src` set
  once). Match the thing that already works.

## 3a. ASSERT THE EFFECT, NOT THE DECLARATION

Same disease as §1 — trusting something you never proved ran — but in test code,
where it's worse, because a green suite actively argues you're fine.

`test/touch` asserted `getComputedStyle(document.body).overflow === 'hidden'`
and passed for months while the page scrolled behind **every** overlay. The
style was set. It just never reached the viewport (`html{overflow-x:clip}` had
quietly made `<html>` the scroll container — see `docs/touch-dev.md` F7). The
declaration was present and the behaviour was absent, and only one of those was
being measured.

So:

1. **Assert what the user experiences, not what the code declares.** "Is
   `overflow` hidden?" is not the question. "Does the page move when you drag
   it?" is. Prefer synthesized input (`Input.synthesizeScrollGesture`,
   `Input.dispatchMouseEvent`) over reading styles or calling DOM APIs.
2. **Beware APIs that bypass the thing you're testing.** Assigning `scrollTop`
   moves a *correctly* locked page — `overflow:hidden` blocks input scrolling,
   not programmatic scrolling. The obvious probe was as wrong as the one it
   replaced, in the opposite direction.
3. **One probe point is not a measurement.** Whether a drag reaches the document
   depends on what's under the finger; a panel with `overscroll-behavior:contain`
   swallows it. `pageScrolls()` in `test/live-stream/cdp.js` sweeps five points
   for this reason — a single mid-screen probe called a real leak a pass.
4. **Know what your harness does to the page.** `p.click()` calls
   `scrollIntoView()` first. A test measuring scroll position around a click
   measures the harness. Use `p.clickInPlace()`, which throws instead.
5. **Make "not X" assertions prove they can still see X.** A suite full of "the
   page did NOT move" passes perfectly once the probe goes blind. Section 4 of
   `touch-tests.js` strips the lock mid-run and *requires* the probe to notice.
   Any assertion of absence deserves that self-test.
6. **The CSP silently voids injected `<style>` tags — and inline `style=""`
   attributes.** The app is served `style-src 'self'` with no `unsafe-inline`,
   so a probe that appends a `<style>` element to change something at runtime
   has *no effect* — and says nothing about it. The same rule discards a
   `style="--x:…"` attribute written into `innerHTML`, which is how the weekly
   schedule's category colour spent months rendering its fallback with nobody
   noticing (found and fixed 2026-08-06 — see `docs/episode-rail.md`). Set
   custom properties through CSSOM. This burned two separate measurements on 2026-08-06: one
   reading label widths behind a `display` toggle, one self-test trying to
   disable a fix to prove the probe still had teeth. Both read as clean passes.
   Go through CSSOM instead (`el.style.zIndex = '80'`), which CSP allows, and
   distrust any injected-stylesheet result that looks too tidy.

A test that has never failed has never been shown to work.

## 4. PROD IS NOT YOUR LAPTOP — read its state, don't infer it

Local runs write `DATA_DIR` (`./data`) straight to disk and keep it forever.
Containers don't: their filesystem is rebuilt from the image every deploy, and a
volume declared in `docker-compose.yml` is a *request*, not proof one is mounted.
Coolify has been observed ignoring it (confirmed 2026-07-26 — see
`docs/DEPLOYMENT.md`). A Dockerfile `VOLUME` line is worse than useless here: with
no explicit mount it creates a fresh anonymous volume per container, which looks
like persistence until the next deploy. It has been removed for that reason.

**Storage is the one area where a local pass is not weak evidence — it is no
evidence.** There is no container boundary on your laptop, so nothing that can
fail in production exists to fail locally: every storage check passes by
construction. Local proves the code path runs. Only a redeploy proves the
storage. Both belong in every definition of done, on separate lines.

This bit us once already: descriptions worked locally and were blank in
production, because `/api/showinfo` is harvested only while a show is on air and
prod's cache started empty every deploy. Diagnosis took a while because every
obvious number looked fine.

**So when local and production disagree, measure production — don't reason about
it.** `curl -s https://<host>/healthz` reports the live bundle version and the
data dir's identity:

- `version` must change after a deploy, or the old image is still serving.
- `storage.instanceId` **unchanged across a redeploy** is what proves persistent
  storage works — same id, same directory. A new id means the volume was
  replaced. One reading proves nothing; compare two deploys.
- `storage.freshVolume` is true when the boot found an empty data dir. Correct
  exactly once, on the first deploy; true later means it isn't persisting.
- `storage.showinfoOnDisk` is supporting detail, not the diagnostic — it counts
  records, and counts move for unrelated reasons. `storage.showinfoNow` reads
  healthy either way (the seed fills it) and diagnoses nothing at all.

Same instinct as §1: don't conclude anything about code you haven't proven is the
code that ran.

## 5. Project shape (orientation)

- Zero-dependency Node server (`server.js`) = static files + a proxy for WBAI
  listings / now-playing / artwork. No build step; filenames are stable.
- Front end is vanilla JS in `public/` (`app.js`, `styles.css`, `index.html`).
- Two `<audio>` elements share one bottom player bar via `barMode`
  (`'archive' | 'live'`). The archive side is the reference implementation; keep
  the live side as close to it as possible.
- Docs live in `docs/`. Before touching live audio read
  `live-audio-pattern.md` (the model and why), then `big-audio-bug.md` (the
  history of getting it wrong). The live element is built and thrown away per
  play — never reuse it, never branch on `element.paused`.
- Live-audio changes have a real regression suite: `test/live-stream/` drives
  the unmodified app in headless Chrome against a fake station. Run **both**
  `./run.sh` and `./run.sh --strict` — the strict pass is the one that catches
  autoplay-policy regressions.
- `npm test` runs the suites that need no browser: `test/feed-scan/`
  (the upstream scanner's diff and notable/routine split, entirely offline),
  `test/feed-merge/` (episodes that rotate out of upstream's 5-item window must
  survive the next harvest), `test/photomap/`, `test/storage/` (the mount-probe
  parser), `test/studio/` (the auth gate, against a real server process) and
  `test/usage/` (a counter must reach the disk before the process is killed).
  The browser suites are per-directory
  `./run.sh` scripts. Add new offline suites to `npm test` in the same commit
  that writes them — `test/feed-scan/selftest.js` sat outside it until
  2026-08-05 and therefore had never once run in anger.
- **Every dialog shares one motion recipe**, and it lives in the `--ov-*` token
  block at the top of `styles.css` rather than in six hand-copied declarations —
  the info sheet, live player, donate modal, schedule, on-air chooser and menu
  drawer all resolve their transitions from it, so they cannot drift apart the
  way they had. Arrivals land on a real spring (`--ease-panel`, a `linear()`
  curve behind an `@supports` guard — an unparseable `linear()` inside a
  `transition` shorthand unsets every longhand, duration included, so the
  fallback must be a real value); dismissals are faster and use `--ease-exit`.
  Suite: `test/motion/run.sh`. It exists because §3a applies double here — the
  first version read the stylesheet back and would have passed a spring that was
  mathematically perfect and 0.4px tall. Panels used to travel 4% of their
  height, which is too little for *any* curve to be felt; if you retune this,
  check the distance before blaming the easing.
- **Everything persisted lives under `DATA_DIR`** (default `./data`). Writes go
  through `writeJsonAtomic` and are flushed on `SIGTERM` — if you add a new file
  here, use `writeJsonSoon`/`writeJsonAtomic` rather than `fs.writeFileSync`, or
  it will be lost on every redeploy and truncated by any crash.
  **A show missing from the app is almost never our bug** — it is upstream
  publishing no feed, and `docs/missing-show.md` is the diagnosis path (five
  questions, in order) plus the audit that reconciles archive2's slugs against
  ours. Read it before touching the harvest: the feed-only rule is what keeps
  archive2's phantom rows out, so "restore a scrape fallback" trades a
  correctness guarantee for one show.
  **Since 2026-08-07 `data/feeds.json` is irreplaceable.** It used to be a cache
  — upstream serves five episodes per show, we held those five, and a wiped
  volume cost one harvest. It now *accumulates* the episodes that fall out of
  that window (`mergeFeedItems`), so it is the only copy of the station's older
  listings anywhere: delete it and no re-harvest brings them back, because
  upstream has already forgotten them. This raises the stakes on §4 from
  "annoying" to "lossy" — verify `storage.instanceId` across deploys, and take a
  copy before anything that might replace the volume.
- **`/studio` is a password-gated station view** (`STUDIO_PASSWORD`; unset means
  the routes do not exist). Its markup is in `admin/` — *deliberately* outside
  `public/`, because anything under `public/` is served to anyone who asks and
  would walk around the gate. Its CSS/JS are in `public/` and are inert without
  a session. Read `docs/admin-page.md` before extending it; the phases and the
  reasoning are all there.
- **The weekly schedule is derived, never fetched** — `deriveSchedule()` in
  `app.js` reshapes the archive rows already in memory. Read
  `docs/schedule-dev.md` before extending it; §7 is the list of things that were
  wrong once and should not be reintroduced. Three that bite:
  `SCHED_DAYS` is Sunday-first because it *keys* the template — the today-first
  tab order is display only (`schedTabDays()`); the docked player bar must stay
  reachable **under** this overlay, because it is the one you browse while
  listening; and a close that bypasses history must clear the `{sched:1}` flag,
  or Back re-opens it. It must never touch an `<audio>` element — Listen Live
  calls `openLivePlayer()` and stops there. The **on-air row asks** rather than
  guessing: the whole card opens a chooser (live / past episodes / cancel),
  because a card with two destinations and one label is how a listener ends up
  somewhere they didn't ask for (§7.4b). Suite: `test/schedule/run.sh`.
- **The show sheet's episode rail** is how a listener reaches a show's *other*
  broadcasts — the listing is episode-level and the schedule only ever hands over
  a slot's most recent row, so without it there is no path. Read
  `docs/episode-rail.md` before extending it. Two rules it must not lose:
  choosing a chip **never** starts playback (play stays one deliberate tap), and
  selection uses `replaceState`, so Back still means "close the sheet". A third
  joined them on 2026-08-08: because the sheet **covers** the docked player bar,
  it owes a transport for whatever is loaded — the scrubber tracks the audio
  element rather than the selection, the playing chip carries an equaliser, and a
  quiet teal strip appears when the two diverge. Exactly one filled orange button
  is on screen at any time. Its
  suite is `test/episode-rail/run.sh` (headless Chrome, 82 checks, fixtures
  derived from the live listing rather than hardcoded ids that rotate out).
- **Usage counters** live in `public/track.js` (loaded separately from `app.js`
  so counting can never affect playback) and `POST /api/ev`. They carry **no
  identifier of any kind** — no cookie, no session, no stored or hashed IP — and
  the words typed into the search box are never sent at all. The README states
  this publicly and a test enforces it; if you change what is collected, change
  the README in the same commit or the app starts lying to its listeners.
- **The studio's actions are the only state-changing routes.** Keep them
  idempotent, rate limited, coalesced, logged and CSRF-guarded — "re-check every
  feed" is 122 requests at a small station's server.
- **This repo is a template.** Other Pacifica stations deploy it with the same
  tools, so prefer one env var over three, plain JSON over a database, and a
  setting over a code edit. `.env.example` is the list; keep it current.
  Stations on a *newer* archiver than WBAI's publish a ready-made JSON catalog
  (shows + episodes + now-playing) that would replace the scrape and the whole
  `/xml/` sweep for them. Nothing reads it yet; the measured analysis and the
  adopt-in-order plan are in `docs/pacifica-json-dev.md`. WBAI itself cannot use
  it — its archive and confessor are too old — so that path is for the clones.
