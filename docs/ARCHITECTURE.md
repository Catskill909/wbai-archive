# Architecture

## Overview

```
                    ┌──────────────────────────────────────────┐
   Browser          │            wbai-archive server           │        WBAI upstreams
 ┌──────────┐       │  (Node, zero deps, static + proxy)       │      ┌────────────────────┐
 │ index.html│──────┤                                          │      │ archive2.wbai.org  │
 │ app.js    │ GET / │  GET /              → public/*           │      │  (show table HTML) │
 │ styles.css│──────▶│  GET /api/archive   → scrape + parse ───┼─────▶│                    │
 └──────────┘       │  GET /api/nowplaying → proxy + normalize ┼─────▶│ confessor2.wbai.org│
      │             │  GET /pix/<file>    → image proxy ───────┼─────▶│  (now-playing +    │
      │  <audio>    │  GET /healthz                            │      │   artwork /pix)    │
      └─────────────┼──────────────────────────────────────────┘      └────────────────────┘
        live stream │  (media plays directly from WBAI hosts,
        + archive    │   allowed by the page's media-src CSP)
        mp3s ────────┼──────────────────────────────────────────▶  streaming.wbai.org / archive2
```

## Why the server exists

Everything the app needs lives on WBAI's servers, but two things make a
browser-only version impossible:

1. **CORS on the now-playing feed.** `confessor2.wbai.org/playlist/_pl_current_ary.php`
   returns JSON with **no `Access-Control-Allow-Origin` header**, so any browser
   blocks a cross-origin `fetch()` to it — from any site, not just ours.
2. **Cross-origin data & images under a strict CSP.** Serving artwork and JSON
   through our own origin keeps a tight `Content-Security-Policy` simple
   (`default-src 'self'`) instead of allow-listing third-party hosts for scripts,
   images, and XHR.

The server fetches these upstreams **server-side** (no CORS applies between
servers) and re-serves them same-origin. The browser only ever talks to us.

Audio is the exception: `<audio>` elements can load cross-origin media without
CORS, so the live stream and archive MP3s play **directly** from WBAI's hosts.
The page's `media-src` CSP explicitly allows those hosts; we don't proxy tens of
megabytes of audio through the app.

## Request flow

### `GET /api/archive`
1. Fetch the archive front page (`archive2.wbai.org`) as latin1 (it's declared
   ISO-8859-1).
2. Fetch the schedule grid (`pub_sched.php`) and extract the `altid → photo id`
   map from its image preloads (`pix/<altid>_med_<id>.jpg`).
3. Regex-parse each `<tr name="show" …>` row into a structured object: title,
   category, host, air date/time, duration, days-to-stay, MP3 URL, RSS feed, and
   a `/pix/…` artwork path when the show has a photo.
4. Cache the result in memory for 10 minutes.

### `GET /api/nowplaying`
1. Fetch the now-playing feed and `JSON.parse` it.
2. Normalize to `{ current: {name, dj, start, end, photo}, next: {name, start, end} }`.
3. Rewrite the upstream artwork URL to our own `/pix/…` proxy path.
4. Cache for 15 seconds (the upstream itself suggests a ~10s reload cadence).

### `GET /pix/<file>`
- The filename is validated against `^[A-Za-z0-9_]+_med_\d+\.jpg$` before any
  upstream request — this prevents the proxy from being used as an open relay
  (SSRF) for arbitrary URLs.
- The image bytes are streamed back with a 1-day cache header.

## Caching & resilience

Each proxied resource has a small in-memory TTL cache. On an upstream failure the
server serves the **last good** cached value if it has one; `/api/archive`
additionally falls back to the shipped snapshot at
`public/data/shows-fallback.json`, and the front-end falls back to that same file
if `/api/archive` itself is unreachable. The archive is never a blank page.

## Front-end

`public/app.js` is plain ES5-style browser JavaScript, no build step. On load it
fetches `/api/archive`, renders the table, and wires up search/filter/sort. It
polls `/api/nowplaying` every 15 seconds for the header live strip. Two `<audio>`
elements are used: one for the live stream (header) and one for archived shows
(bottom player); starting one pauses the other.

## Security posture

- **Zero third-party dependencies** — nothing to audit or patch beyond Node.
- **Non-root container** — runs as the built-in `node` user.
- **Method allow-list** — only `GET`/`HEAD` are served.
- **Path traversal guard** — static paths are resolved and confirmed to stay
  inside `public/`.
- **SSRF guard** — the image proxy only accepts the exact WBAI artwork filename
  pattern.
- **Security headers on every response** — `Content-Security-Policy`,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
