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

- **Live archive listing** — ~500 recent broadcasts scraped on demand from
  `archive2.wbai.org`, with search, category filters, and sortable columns
  (show, air date, retention, duration).
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
- **Linkable views** — search, category and the open show live in the URL, so a
  view can be shared and the Back button closes the info sheet instead of
  leaving the app.
- **Responsive** — a multi-column table on desktop/tablet that collapses to
  stacked cards on phones. Light and dark themes both supported (follows the
  system preference).

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
| `GET /api/archive` | Live scrape of `archive2.wbai.org` → JSON list of shows            | 10 min |
| `GET /api/nowplaying` | Proxy of WBAI's on-air / up-next feed → normalized JSON         | 15 s   |
| `GET /api/programs` | wbai.org's program directory → host, description, links per show  | 10 min |
| `GET /api/showinfo` | Richer per-show records harvested from the on-air feed over time  | 1 min  |
| `GET /pix/<file>`  | Image proxy for show artwork (allow-listed `*_med_*.jpg` names)    | 1 day  |
| `GET /healthz`     | Health check for the container / load balancer                     | —      |

All upstream responses are cached in memory; if an upstream is briefly down, the
last good response (or a shipped snapshot at `public/data/shows-fallback.json`)
is served instead.

Static source files (`.html`, `.js`, `.css`, `.json`, `.webmanifest`) are served
`no-cache` with an ETag — the browser still caches them, it just revalidates and
usually gets a bodiless 304. There is no build step and so no content-hashed
filenames, which makes a plain `max-age` on `app.js` a correctness bug rather
than an optimisation. Files under `/assets/` keep a real one-day TTL.

The two show-info caches also persist to `data/` (`programs.json`, `showinfo.json`)
so a restart doesn't start cold. That directory is a **cache, never a source of
truth** — delete it and the server rebuilds it from WBAI. If the path isn't
writable the server logs one line and runs memory-only. `docker-compose.yml`
mounts a named volume there; override the paths with `PROGRAMS_PATH` /
`SHOWINFO_PATH`.

## Run locally

Requires Node 18+ (uses the built-in `fetch`). No `npm install` needed.

```bash
npm start
# → WBAI Archive server listening on :8080
# open http://localhost:8080
```

Override the port with `PORT=3000 npm start`.

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
  desktop builds. Scaffolded and wired to CI, but not yet compiled.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the server and its
  proxies fit together, and why they're needed.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — container build and Coolify.

To exercise the mobile layout and lock-screen player, open the dev server from a
phone on the same network (`http://<your-lan-ip>:8080`) — Media Session behavior
can't be verified in a desktop devtools viewport.

## Project layout

```
.
├── server.js                     # zero-dependency Node server (static + proxies)
├── package.json                  # metadata + start script (no dependencies)
├── Dockerfile                    # node:20-alpine, runs as non-root
├── docker-compose.yml            # local + Coolify compose reference
├── public/
│   ├── index.html                # markup
│   ├── styles.css                # all styles (design tokens, light/dark)
│   ├── app.js                    # front-end logic (API, players, Media Session)
│   ├── manifest.webmanifest      # PWA metadata (name, icons, colors, display)
│   ├── assets/                   # station logo (header.png) + app icon
│   └── data/shows-fallback.json  # offline snapshot fallback
├── data/                         # runtime caches (gitignored, rebuildable)
│   ├── programs.json             # wbai.org program directory
│   └── showinfo.json             # records harvested from the on-air feed
├── desktop/                      # Tauri shell (optional; the only build step)
│   ├── package.json              # Tauri CLI only
│   └── src-tauri/                # Cargo.toml, main.rs, tauri.conf.json, icons
├── .github/workflows/            # Windows desktop build
└── docs/
    ├── ARCHITECTURE.md           # how the server and proxies fit together
    ├── DEVELOPMENT.md            # code map, conventions, each built feature
    ├── ROADMAP.md                # what doesn't exist yet
    ├── TAURI.md                  # desktop build steps
    └── DEPLOYMENT.md
```

## License

MIT — see [LICENSE](LICENSE). Content, branding, audio, and artwork belong to
WBAI / the Pacifica Foundation and are used here only to interface with their
public archive.
