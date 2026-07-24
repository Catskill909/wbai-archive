# Roadmap

**Nothing in this file is finished.** It is a list of proposals, work that is
started but unproven, and ideas that were rejected — kept separate from
[DEVELOPMENT.md](DEVELOPMENT.md) so the two can never be confused: that file
documents only what is built and working.

## Next up

Ordered most valuable first. Each is independent; none blocks another.

| # | Item | Effort | What it gets you |
| --- | --- | --- | --- |
| 1 | Window Controls Overlay | M | `display_override: ["window-controls-overlay"]` lets the appbar draw into the desktop title bar. Costs a second layout keyed on `env(titlebar-area-*)`, maintained alongside the normal one. |
| 2 | iOS launch images | M | Removes the white flash on launch, jarring for a dark app. Needs a matrix of exact per-device `apple-touch-startup-image` sizes — iOS ignores any that don't match. Worth it once the design settles. |
| 3 | Desktop app — first real build | M | `desktop/` is scaffolded and its config validates, but nothing has been compiled. Needs a Rust toolchain locally for macOS, and a `WBAI_APP_URL` repo variable for the Windows CI job. See [TAURI.md](TAURI.md). |

## Won't do

These were considered and rejected. Reopen one only if its reason has changed.

- **RSS feeds, and anything else that hands out episode files.** A product
  decision, not a technical one: access stays inside the web app and the native
  apps, which is what Pacifica's tiered-content plan needs. Upstream's
  `getrss.php` also returns an empty body for every show, so nothing is being
  taken away that currently works — but that is the lesser reason and the
  decision would stand either way. The code is intact behind `SHOW_RSS` in
  `app.js` (see DEVELOPMENT.md § Feature flags), so this is reversible if the
  policy changes.
- **Generating our own feeds.** Considered and declined for the same reason.
  It is entirely buildable — the archive data already carries title, air date,
  duration, enclosure URL and artwork for all 531 episodes across 112 shows, so
  a valid RSS 2.0 + iTunes feed is about 120 lines and no dependencies. Declined
  on policy, not difficulty. Revisit only if the content model changes.
- **Service worker** — the listing is a live view of a rotating archive; caching
  it offline would mostly serve shows that are already gone. The cost of not
  having one is that Chrome on Android won't fire its automatic install prompt.
- **Push notifications** — the most listener-valuable idea here ("your show is
  on in ten minutes") and the biggest departure: needs a service worker, VAPID
  keys, a subscription store and a scheduler, so server-side state and almost
  certainly a dependency.
- **Manifest `screenshots`** — would bake dated broadcasts into the repo as
  binary assets nobody will regenerate. If revisited, shoot chrome (appbar,
  search, chips), not a wall of episode rows.
- **Playback rate** — 1×/1.5×/2× on the archive player. Dropped, not deferred.
- **Share Target, Badging, Periodic Background Sync, File Handling** — nothing
  to receive, nothing to count, contradicts the live-proxy design, no file types.
