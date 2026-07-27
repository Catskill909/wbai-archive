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

A test that has never failed has never been shown to work.

## 4. PROD IS NOT YOUR LAPTOP — read its state, don't infer it

Local runs write `data/` straight to disk and keep it forever. Containers don't:
their filesystem is rebuilt from the image every deploy, and a volume declared in
`docker-compose.yml` is a *request*, not proof one is mounted. Coolify has been
observed ignoring it (confirmed 2026-07-26 — see `docs/DEPLOYMENT.md`).

This bit us once already: descriptions worked locally and were blank in
production, because `/api/showinfo` is harvested only while a show is on air and
prod's cache started empty every deploy. Diagnosis took a while because every
obvious number looked fine.

**So when local and production disagree, measure production — don't reason about
it.** `curl -s https://<host>/healthz` reports the live bundle version and what
was on disk at boot:

- `version` must change after a deploy, or the old image is still serving.
- `storage.showinfoOnDisk` is the *only* field that proves persistent storage
  works. `storage.showinfoNow` reads healthy either way (the seed fills it) — it
  diagnoses nothing.

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
