# WBAI Archive

A modern, responsive, dark-mode redesign of the [WBAI 99.5 FM](https://wbai.org)
on-demand broadcast archive, backed by a **light, zero-dependency Node server**
that proxies WBAI's own systems for live show listings, on-air data, artwork,
and audio.

WBAI is Free Speech Radio — Pacifica Radio in New York City. The station's
archive at `archive2.wbai.org` is the source of truth this project reads from:
it publishes every broadcast, with retention windows and artwork, and it has
kept doing so reliably for years. What it doesn't carry is a browsing
layer — search, category filters, and a player that persists while you navigate.
That's the part this project adds, keeping exactly the same job: find and play
an archived broadcast.

> Unofficial project. Not affiliated with or endorsed by WBAI or the Pacifica
> Foundation. All data and media are proxied live from WBAI's public systems,
> and every station link points to the real `wbai.org`.

## Features

- **Live archive listing** — ~500 recent broadcasts read from WBAI's own podcast
  feeds (`archive2.wbai.org/xml/<show>.xml`), with search, category filters, and
  sortable columns (show, air date, retention, duration).
- **Working audio** — a persistent bottom player for archived shows and a
  header live player for the 99.5 FM stream, each with a loading spinner that
  resolves to a pause control once connected.
- **Remembers where you stopped** — these are 1–2 hour talk broadcasts, so the
  player keeps your position in every episode you've started and picks it up on
  replay, with a *Start over* control whenever you'd rather not. Positions live
  in the browser, not on the server; nothing is uploaded and no account exists.
- **Installable** — a web app manifest, real home-screen icon, and browser
  chrome tinted to match the appbar, so *Add to Home Screen* (iOS) or *Install
  app* (Android/desktop Chrome) gives a standalone player. Deliberately **no**
  offline mode: the listing is a live view of an archive that rotates, and a
  cached copy would mostly serve shows that are already gone.
- **Show info modal** — clicking a show's title (or its **More** link) opens a
  clean dark sheet with large artwork, host, full description, air date, length,
  retention, and the show's own website and social links. Playback controls
  and a scrubber stay pinned at the bottom of the sheet, and any field WBAI
  doesn't publish for a show is simply left out rather than shown empty.
- **Real show artwork** — thumbnails for each show, proxied from WBAI's schedule
  system, with a tasteful category-tinted placeholder when a show has no photo.
- **On-air / up-next** — the header shows what's playing now and what's next,
  refreshed from WBAI's now-playing feed.
- **Lock screen & hardware controls** — full Media Session support: show title,
  host, and artwork on the iOS/Android lock screen, macOS Now Playing, and car
  head units, with play/pause, ±15s skip, scrubbing, and next/previous show from
  headset buttons. The live stream publishes the current on-air show and
  re-titles itself as the schedule rolls over.
- **Keyboard and transport controls** — ±15s buttons in the player bar, plus
  Space for play/pause and ←/→ to skip, which stay out of the way while you're
  typing in the search field.
- **Back to top** — the listing runs ~500 shows deep, so a quiet circle appears
  once you're well into it, ducks out of the way while you're scrolling, and
  returns when you stop — instantly if you were already scrolling back up. It
  sits in the page margin on desktop and centres above the player bar on tablets
  and phones. Clicking it moves keyboard focus as well as the viewport.
- **Linkable views** — search, category and the open show live in the URL, so a
  view can be shared and the Back button closes the info sheet instead of
  leaving the app.
- **Responsive** — a multi-column table on desktop/tablet that collapses to
  stacked cards on phones. Light and dark themes both supported (follows the
  system preference).
- **Accessible, and audited rather than assumed** — a skip link, semantic
  landmarks, visible focus rings, and a focus trap that returns focus where it
  came from on every overlay (info sheet, live player, menu, lightbox), each
  closable with `Escape`. The category dropdown is a real keyboard listbox
  (Arrow/Home/End/`Escape`, `role="listbox"`, `aria-selected`), loading and
  search results are announced through live regions, decorative icons are hidden
  from screen readers and duplicate controls are kept out of the tab order,
  touch targets meet WCAG 2.2 § 2.5.8, and 23 `prefers-reduced-motion` blocks
  mean the animation-heavy parts stand down when asked. The theme is applied
  before first paint, so a light-mode reader on a dark phone never gets a flash.
  The standing audit — including what is still open — is
  [docs/accessibility.md](docs/accessibility.md).
- **A private station view at `/studio`** — password-gated, off entirely unless
  `STUDIO_PASSWORD` is set (unset, the routes are never registered, so it is
  indistinguishable from any unknown path). Same design language and the same
  light/dark control as the app. It holds:
  - **the archive in numbers** — shows, episodes, hours, size, the category mix,
    a per-day air-date histogram that shows the empty days rather than closing
    them up, episode lengths, and which shows have the *least* in the window
    (the top is a flat tie, because upstream caps every feed at five episodes);
  - **listening figures** — plays by show, live tune-ins, page views, searches;
  - **operational health** — storage persistence, feed harvest with failures
    named rather than counted, per-host upstream latency timed from real
    traffic, and process/cache stats;
  - **four maintenance actions** — re-check every feed, refresh the program
    directory, re-probe the stream, drop the archive cache. Idempotent, rate
    limited, CSRF-guarded, and all operating on *our* caches; nothing writes to
    WBAI.

  Charts are hand-drawn SVG and CSS with no charting library — the app's CSP
  forbids a CDN script, and the marks inherit the same design tokens, so both
  themes work with no extra code. Sessions are signed cookies with no
  server-side store, so a restart never signs anyone out. See
  [docs/admin-page.md](docs/admin-page.md).
- **Counts, without tracking anyone** — the station can see **how long people
  actually listened**, per show, alongside plays, live tune-ins, page views,
  searches and shares. Time is the honest number: a play is a click, and the two
  rankings genuinely differ — a show people open and abandon should not outrank
  one they sit through. It is measured as media *consumed* (sampling the
  player's position, so pauses, buffering and scrubbing forward are all
  excluded), which under-reports slightly and can never over-report. It cannot see *who*, and that is structural rather than a promise:
  there is **no event log, no cookie, no session, and no stored or hashed IP**.
  A request increments a number in memory and is dropped, so
  nothing links two events to the same person — which means "unique listeners"
  is a number this app cannot produce. Search *volume* is counted; **the words
  someone types never leave the browser**. One coarse attribute is collected:
  a page view sends **the timezone the browser reports**, which the server files
  under one of three buckets — the station's own timezone, elsewhere in the US,
  or international — before anything is written, so what reaches the disk is a
  count with nothing attached to it. It answers whether the station reaches past
  its own signal without ever reading an address. A timezone is not a location
  (most browsers in the eastern US say `America/New_York` wherever they are) and
  it is not a fingerprint here, because there is nothing to join it to — but it
  is the one visitor attribute this app looks at, which is why it is named here
  rather than left to be discovered. Set `STATION_TZ` to your own zone.
  Counters live in plain monthly JSON
  under
  `DATA_DIR/stats/`, a few KB a month, readable by anyone who opens the file.
  The tracker is a 100-line file loaded separately from the app, so it can never
  affect playback. A test sends a search term anyway — the way a stale cached
  page would — and fails if it reaches the report or the disk, so the promise
  cannot quietly stop being true. Set `USAGE_TRACKING=off` to count nothing at
  all.
- **Keeps what it learns across deploys** — show descriptions are harvested only
  while a show is on air, so the cache accrues slowly and is worth protecting.
  Writes are atomic and flushed on shutdown, and `/healthz` reports whether the
  data volume is genuinely persisting rather than leaving it to be inferred —
  this deployment ran for weeks silently rebuilding from scratch every deploy
  before that was measurable.

## Why a server?

A purely static page can't reach WBAI's data from the browser: the now-playing
endpoint sends no `Access-Control-Allow-Origin` header, so browsers block it
cross-origin. The server solves this by fetching everything **server-side** and
re-serving it same-origin. It also lets the app use WBAI's real artwork without
running into cross-origin image or content-security-policy limits.

The server has **no third-party dependencies** — only the Node standard library
and the built-in `fetch`. That keeps the container tiny and the supply-chain
attack surface at zero.

## Endpoints

| Route              | Description                                                        | Cache  |
| ------------------ | ------------------------------------------------------------------ | ------ |
| `GET /`            | The single-page app (`public/index.html`)                          | revalidate |
| `GET /api/archive` | Episodes from WBAI's per-show podcast XML, structured by the `archive2.wbai.org` listing → JSON | 5 min  |
| `GET /api/archive/head` | Freshness probe: `{updated, count, latest}` from the same cached scrape, minus the rows (~57 B) | 5 min  |
| `GET /api/nowplaying` | Proxy of WBAI's on-air / up-next feed → normalized JSON         | 15 s   |
| `GET /api/programs` | wbai.org's program directory → host, description, links per show  | 10 min |
| `GET /api/showinfo` | Richer per-show records harvested from the on-air feed over time  | 1 min  |
| `GET /api/showinfo/<altid>` | One show, resolved on demand from archive2's per-show endpoint — works for any show, not just what's on air | 1 hr |
| `GET /pix/<file>`  | Image proxy for show artwork (allow-listed `*_med_*.jpg` names)    | 1 day  |
| `POST /api/ev`     | Usage beacon from the page — an event name, and for a play the media URL, and for a page view the browser's timezone (bucketed to one of three labels and discarded). No identifier of any kind; answers `204` to everything. Not registered at all when `USAGE_TRACKING=off` | — |
| `GET /studio`      | Password-gated station view. **Only exists when `STUDIO_PASSWORD` is set** — otherwise the route is never registered and the path falls through like any other unknown one | — |
| `GET /healthz`     | Health check for the container / load balancer, plus the bundle version, storage identity (`storage.mounted` and `storage.instanceId` are what tell you a persistent volume is really mounted — see below) and feed state (`feeds.held: 0` with `lastHarvest` set is the one condition that empties the listing) | —      |

All upstream responses are cached in memory; if an upstream is briefly down, the
last good response (or a shipped snapshot at `public/data/shows-fallback.json`)
is served instead.

Static source files (`.html`, `.js`, `.css`, `.json`, `.webmanifest`) are served
`no-cache` with an ETag — the browser still caches them, it just revalidates and
usually gets a bodiless 304. There is no build step and so no content-hashed
filenames, which makes a plain `max-age` on `app.js` a correctness bug rather
than an optimisation. Files under `/assets/` keep a real one-day TTL.

Everything the server persists lives under one directory, named by one env var:
**`DATA_DIR`** (default `/app/data` in the image, `./data` locally). It holds the
feed, program and show-info caches — a **cache, never a source of truth**; delete
it and the server rebuilds it from WBAI. If the path isn't writable the server
logs one line and runs memory-only.

Writes are atomic (temp file + `fsync` + rename) and pending writes are flushed
on `SIGTERM`, so a redeploy cannot truncate a file or drop the last few seconds
of harvest.

**Whether a volume is really mounted is a question you ask the server, not one
you infer.** `/healthz` reports `storage.mounted` (what the kernel says is
attached at `DATA_DIR` — readable on the very first deploy) and
`storage.instanceId` (unchanged across two deploys means the same directory came
back, which is the only thing that proves persistence). Declaring a volume in
`docker-compose.yml` is *not* proof — Coolify has been observed ignoring it. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Run locally

Requires Node 18+ (uses the built-in `fetch`). No `npm install` needed.

```bash
npm start
# → WBAI Archive server listening on :8080
# open http://localhost:8080
```

Override the port with `PORT=3000 npm start`. Run the browser-free suites with
`npm test`. To try the station view locally:

```bash
STUDIO_PASSWORD=local-dev-password npm start   # → http://localhost:8080/studio
```

Every setting has a working default; [`.env.example`](.env.example) is the full
list. This repo is used as a **template by other Pacifica stations**, so
configuration is deliberately one env var per decision rather than a code edit.

## Run with Docker

```bash
docker compose up --build
# open http://localhost:8080
```

## Deploy (Coolify)

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: point Coolify at this
repo, use the **Dockerfile** build pack, expose port **8080**, and let Coolify
terminate TLS in front of it.

## Development

No build step, no dependencies, no toolchain — edit the files in `public/` and
reload the page. `npm start` serves them directly.

- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — how the app works today.
  Code map, conventions, each built feature, and how to test lock-screen
  behavior on a real device. Everything in it is shipped and running.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what doesn't exist yet: proposals,
  and ideas that were considered and rejected, with reasons.
- **[docs/TAURI.md](docs/TAURI.md)** — step-by-step for the macOS and Windows
  desktop builds: one build per station, code signing on both platforms, and the
  installer artwork. Everything is committed and wired to CI, but **nothing has
  been compiled yet**, so treat it as untested.
- **[docs/casting-dev.md](docs/casting-dev.md)** — a Cast/AirPlay button, built
  and then removed on the same day. Kept for three findings that outlive it: why
  the Google Cast SDK is the wrong dependency here, what headless Chrome
  structurally cannot test, and why the player bar couldn't afford the control.
- **[docs/google-tv.md](docs/google-tv.md)** — what a Google TV / Android TV app
  would really cost: why the PWA can't be wrapped, which quality requirements we
  already meet, and why casting was built instead. Research only.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the server and its
  proxies fit together, and why they're needed.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — container build and Coolify.
- **[docs/UPSTREAM.md](docs/UPSTREAM.md)** — what WBAI actually exposes: which
  endpoints are real JSON, which are base64'd HTML, which are dead, and which
  lie. Read before changing any upstream call.
- **[docs/xml-feed-migration.md](docs/xml-feed-migration.md)** — why episodes come
  from per-show podcast XML rather than the HTML scrape, what the scrape still
  supplies, and how feeds are kept fresh without hammering a small station's
  server. Read before touching `applyFeeds()` or the feed harvest.
- **[docs/archive-source-audit.md](docs/archive-source-audit.md)** — measured
  defects in `archive2.wbai.org` (rows appended out of order, invented scheduler
  entries, recorder fragments, a 23-day outage), with a section written for
  Pacifica's developer.
- **[docs/2026-07-29-xml-migration-log.md](docs/2026-07-29-xml-migration-log.md)** —
  the working log of that migration: what was found, what was got wrong, and why
  the code looks the way it does.
- **[docs/live-audio-pattern.md](docs/live-audio-pattern.md)** — why a live
  stream can't be paused and resumed like a file, and the pattern that fixes it
  (one connection, never reused). Written to be portable to any project with a
  browser-based live player. Read before touching live audio; the regression
  suite that guards it is [test/live-stream/](test/live-stream/).

Regression suites are zero-dependency too — headless Chrome over the DevTools
protocol, driving the unmodified app. Each needs the server running on :8080:

```sh
./test/live-stream/run.sh            # live audio; also run with --strict
./test/touch/run.sh                  # coarse-pointer affordances, overlay scroll locks
./test/to-top/run.sh                 # back-to-top: show/hide rule, geometry, hit tests
./test/ui/run.sh                     # listing, rows, reload, clock
./test/share/run.sh                  # Open Graph / share cards (no browser needed)
node test/feed-scan/scan.js          # upstream feed drift vs a stored snapshot
```

To exercise the mobile layout and lock-screen player, open the dev server from a
phone on the same network (`http://<your-lan-ip>:8080`) — Media Session behavior
can't be verified in a desktop devtools viewport.

## Project layout

```
.
├── server.js                     # zero-dependency Node server (static + proxies)
├── package.json                  # metadata + start script (no dependencies)
├── Dockerfile                    # node:24-alpine, runs as non-root
├── docker-compose.yml            # local + Coolify compose reference
├── public/
│   ├── index.html                # markup
│   ├── styles.css                # all styles (design tokens, light/dark)
│   ├── app.js                    # front-end logic (API, players, Media Session)
│   ├── manifest.webmanifest      # PWA metadata (name, icons, colors, display)
│   ├── studio.css, studio.js     # the studio's layout and logic (inert without a session)
│   ├── assets/                   # station logo (header.png) + app icon
│   └── data/shows-fallback.json  # offline snapshot fallback
├── admin/                        # the studio's markup — NOT under public/, which
│   ├── login.html                #   is served to anyone; these need a session
│   └── studio.html
├── data/                         # DATA_DIR: runtime caches (gitignored, rebuildable)
│   ├── feeds.json                # per-show podcast XML, cached
│   ├── programs.json             # wbai.org program directory
│   ├── showinfo.json             # records harvested from the on-air feed
│   └── .instance.json            # volume identity, so persistence can be proven
├── seed/                         # committed, shipped in the image
│   └── showinfo.json             # starting set for the harvest above (npm run seed)
├── desktop/                      # Tauri shell (optional; the only build step)
│   ├── package.json              # Tauri CLI only
│   ├── installer/                # installer artwork generator (HTML -> PNG/BMP)
│   └── src-tauri/                # Cargo.toml, main.rs, tauri.conf.json, icons
│       ├── stations/             # one profile per station: name, identifier, copy
│       └── installer/<slug>/     # that station's rendered DMG + NSIS artwork
├── .github/workflows/            # Windows desktop build
├── test/                         # zero-dependency suites (headless Chrome over CDP)
│   ├── live-stream/              # live audio + fake station; cdp.js lives here
│   ├── touch/                    # coarse-pointer affordances, overlay scroll locks
│   ├── to-top/                   # back-to-top show/hide, geometry, hit tests
│   ├── ui/                       # listing, rows, reload, clock
│   ├── share/                    # Open Graph / share cards (no browser)
│   ├── storage/                  # mount-probe parser (no browser)
│   ├── studio/                   # the /studio auth gate (no browser)
│   └── feed-scan/                # upstream feed drift vs a stored snapshot
└── docs/
    ├── ARCHITECTURE.md           # how the server and proxies fit together
    ├── DEVELOPMENT.md            # code map, conventions, each built feature
    ├── ROADMAP.md                # what doesn't exist yet
    ├── admin-page.md             # the studio: design, phases, storage rules
    ├── TAURI.md                  # desktop build steps
    ├── casting-dev.md            # Cast/AirPlay: built, removed, and why
    ├── google-tv.md              # what a native TV app would cost (research)
    └── DEPLOYMENT.md
```

## License

MIT — see [LICENSE](LICENSE). Content, branding, audio, and artwork belong to
WBAI / the Pacifica Foundation and are used here only to interface with their
public archive.
