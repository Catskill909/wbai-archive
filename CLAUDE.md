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

## 4. Project shape (orientation)

- Zero-dependency Node server (`server.js`) = static files + a proxy for WBAI
  listings / now-playing / artwork. No build step; filenames are stable.
- Front end is vanilla JS in `public/` (`app.js`, `styles.css`, `index.html`).
- Two `<audio>` elements share one bottom player bar via `barMode`
  (`'archive' | 'live'`). The archive side is the reference implementation; keep
  the live side as close to it as possible.
- Docs live in `docs/`. Read `big-audio-bug.md` before touching live audio.
