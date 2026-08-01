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

- **Full show archive** — hundreds of recent broadcasts, searchable by name and
  filterable by category, sortable however you like.
- **Built-in player** — listen to any archived show or the live 99.5 FM stream
  right in the app.
- **Picks up where you left off** — for long talk shows, playback resumes
  exactly where you stopped, with the option to start over.
- **Installable app** — add it to your phone or desktop home screen for a full,
  standalone listening experience.
- **Show details at a glance** — artwork, host, description, air date and
  links, one tap away for every show.
- **List or gallery view** — browse as a simple list or a visual gallery of
  show art, whichever you prefer.
- **On-air now, and what's next** — a full now-playing screen with artwork,
  host, air times and volume control; keep browsing while it plays.
- **Lock screen controls** — play, pause, skip and see artwork right from your
  phone's lock screen, car display or desktop media controls.
- **Keyboard shortcuts** — quick play/pause and skip controls for desktop
  listeners.
- **Easy navigation** — a quick way back to the top of a long list, and
  shareable links to any show or search.
- **Works on any device** — a clean, responsive design with light and dark
  themes.
- **Accessible to everyone** — built for keyboard and screen-reader use, with
  clear focus, readable contrast and touch-friendly controls.
- **Private station dashboard** — a password-protected view for staff: archive
  stats, listening figures, and one-click maintenance tools.
- **Listener insights, with privacy built in** — see how long people actually
  listen, plays, searches, and how far the station's reach extends — without
  ever tracking who anyone is.
- **Reliable behind the scenes** — the app keeps what it's learned even after
  updates, so nothing is lost.

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
