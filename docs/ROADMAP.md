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
| 3 | Desktop app — first real build | M | Config, station profiles, RGBA icons and installer artwork are all committed and self-checked, but **nothing has been compiled**. Needs a Rust toolchain locally for macOS, and a `STATION_URL` repo variable for the Windows CI job. The first build is what proves NSIS and Finder accept the artwork. See [TAURI.md](TAURI.md). |
| 4 | Station profiles for the web app | M | **Partly done as of 2026-07-30.** Deployment-level settings are now env vars with working defaults — `STATION_ID`, `DATA_DIR`, `STUDIO_PASSWORD` (see [`.env.example`](../.env.example)) — so two stations no longer differ by a code edit *there*. What remains is content: the `UPSTREAM` object in `server.js` (each station has its own archive, schedule, artwork and stream hosts), the station name/logo/links and non-affiliation notice across `public/`, and the WBAI-specific `seed/showinfo.json`. Still the thing a second station needs before it needs anything else. |
| 5 | The studio, phases 2–5 | M–L | The gate at `/studio` is built and running; what is behind it is deliberately plain. Phase 2 is the stats dashboard proper (KPI row, top shows by hours, category mix, air-date histogram, the 149/122/115 coverage funnel), then operational health, actions, and privacy-first listener analytics. Full design and phasing in [admin-page.md](admin-page.md). |
| 6 | Settle the "unofficial" framing | S | **A decision, not a task.** The desktop app now signs as the Pacifica Foundation and claims `org.wbai.archive`, while [README.md](../README.md) and the menu note in `public/index.html` still tell users this is unofficial and unaffiliated. Both can't be true. Those disclaimers are a public promise, so rewriting them is Pacifica's call to make explicitly — not a side effect of a commit. Until they do, the disclaimers stay. |

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
- **Casting to a TV or speaker — built, shipped and removed on 2026-07-29.**
  A standards-only Cast/AirPlay button (no SDK, no third-party script, no CSP
  change) worked in Safari and did nothing in desktop Chrome. It was removed on
  **UX grounds, not technical ones**: the player bar is already the busiest
  strip in the app, the control was small and awkward at phone sizes, and the
  bottom of the screen is the most expensive real estate there is. The whole
  record is in [casting-dev.md](casting-dev.md) — read it before proposing this
  again, and note that reopening means solving the *layout* problem first, not
  the API one. The **Google Cast Web Sender SDK** was already declined
  separately: a gstatic script, a CSP hole, a registered app ID, a $5 developer
  account for branding, a third playback destination to synchronise — and it
  still cannot reach iOS at all.
- **A native Google TV / Android TV app.** Researched in full
  ([google-tv.md](google-tv.md)) and declined for now. The PWA cannot be
  wrapped — TWA does not work on TV (no Chrome on the device) and a WebView
  wrapper fails both the D-pad requirement and Play's minimum-functionality
  policy. That leaves a Kotlin/Compose-for-TV front end: our `/api/*` backend
  survives unchanged, but the entire UI is rebuilt for a 10-foot D-pad screen,
  plus Gradle, a second codebase and permanent Play Store obligations. Casting
  reaches the same TVs and is quality requirement **TV-CT** for the app anyway,
  so nothing is wasted if this is reopened.
- **Service worker** — the listing is a live view of a rotating archive; caching
  it offline would mostly serve shows that are already gone. The cost of not
  having one is that Chrome on Android won't fire its automatic install prompt.
- **Push notifications** — the most listener-valuable idea here ("your show is
  on in ten minutes") and the biggest departure: needs a service worker, VAPID
  keys, a subscription store and a scheduler, so server-side state and almost
  certainly a dependency.
- **Manifest `screenshots`** — would bake dated broadcasts into the repo as
  binary assets nobody will regenerate. If revisited, shoot chrome (appbar,
  search, category dropdown), not a wall of episode rows.
- **Playback rate** — 1×/1.5×/2× on the archive player. Dropped, not deferred.
- **Share Target, Badging, Periodic Background Sync, File Handling** — nothing
  to receive, nothing to count, contradicts the live-proxy design, no file types.
