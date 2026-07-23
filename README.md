# WBAI Archive

A modern, responsive, dark-mode redesign of the [WBAI 99.5 FM](https://wbai.org)
on-demand broadcast archive, backed by a **light, zero-dependency Node server**
that proxies WBAI's own systems for live show listings, on-air data, artwork,
and audio.

WBAI is Free Speech Radio — Pacifica Radio in New York City. The original
archive at `archive2.wbai.org` is a dense, unstyled HTML table with no search
and unclear retention windows. This project keeps the same job — find and play
an archived broadcast — but rebuilds it as an actual, usable tool.

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
- **Real show artwork** — thumbnails for each show, proxied from WBAI's schedule
  system, with a tasteful category-tinted placeholder when a show has no photo.
- **On-air / up-next** — the header shows what's playing now and what's next,
  refreshed from WBAI's now-playing feed.
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
| `GET /`            | The single-page app (`public/index.html`)                          | —      |
| `GET /api/archive` | Live scrape of `archive2.wbai.org` → JSON list of shows            | 10 min |
| `GET /api/nowplaying` | Proxy of WBAI's on-air / up-next feed → normalized JSON         | 15 s   |
| `GET /pix/<file>`  | Image proxy for show artwork (allow-listed `*_med_*.jpg` names)    | 1 day  |
| `GET /healthz`     | Health check for the container / load balancer                     | —      |

All upstream responses are cached in memory; if an upstream is briefly down, the
last good response (or a shipped snapshot at `public/data/shows-fallback.json`)
is served instead.

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
│   ├── app.js                    # front-end logic (fetches the API)
│   └── data/shows-fallback.json  # offline snapshot fallback
└── docs/
    ├── ARCHITECTURE.md
    └── DEPLOYMENT.md
```

## License

MIT — see [LICENSE](LICENSE). Content, branding, audio, and artwork belong to
WBAI / the Pacifica Foundation and are used here only to interface with their
public archive.
