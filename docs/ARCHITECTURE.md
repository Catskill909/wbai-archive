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
      │             │  GET /api/showinfo  → harvested records  │      │  (now-playing +    │
      │             │  GET /api/programs  → directory scrape ──┼─────▶│   artwork /pix)    │
      │             │  GET /pix/<file>    → image proxy ───────┼─────▶│                    │
      │  <audio>    │  GET /healthz                            │      │ wbai.org           │
      └─────────────┼──────────────────────────────────────────┘      │  (program pages)   │
        live stream │  (media plays directly from WBAI hosts,  │      └────────────────────┘
        + archive    │   allowed by the page's media-src CSP)  │
        mp3s ────────┼──────────────────────────────────────────▶  streaming.wbai.org / archive2
                    │  data/  ← on-disk caches (rebuildable)   │
                    └──────────────────────────────────────────┘
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

### `GET /api/programs`

The archive rows carry no description and no reliable host, so the info sheet's
prose comes from wbai.org's own program pages.

1. Scrape `wbai.org/programlist/` for every `program.php?program=<id>` link, with
   the title and "Hosted by …" line beside it (~149 programs).
2. Fetch each program page through a 4-at-a-time worker pool and parse the
   `pagetitle`, airtime, host, Web Site / Facebook / Twitter links, and the
   `.description` block. Description HTML is flattened to text — some of those
   pages carry third-party `<script>` tags alongside the prose, and none of it is
   ever rendered as markup.
3. Key the result by a **normalised title** (lowercased, non-alphanumerics
   collapsed): the archive and wbai.org share nothing else. The front end matches
   rows against those keys through widening tiers — exact, ignore-spacing,
   qualifier prefix, equal word-sets once filler words like "show"/"radio" are
   set aside, then a Dice coefficient ≥ 0.72. That covers ~477 of 535 rows; the
   remainder are shows wbai.org simply doesn't list.
4. Refresh at boot and every 24h, in the background — a cold cache never blocks a
   request, it just means the first visitor sees a sheet without a description.

### `GET /api/showinfo`

WBAI's schedule database exposes its richest per-show record (`sh_desc`,
`sh_djname`, `sh_url`, `sh_facebook`, artwork) only for the show **on air** and
the one **up next**. Every now-playing poll therefore donates its two records to
a map keyed by `sh_altid` — the same altid the archive rows carry — so coverage
fills in as the schedule rotates. It is strictly additive: an empty upstream
field never overwrites a value already held.

These fields arrive as **HTML, not text** — descriptions carry `<br>` and
typographic entities, names carry entities alone — so they are flattened with
the same `htmlToText` / `unescapeHtml` the program directory uses. The front end
renders everything through `textContent` and `esc()`, so anything not flattened
here reaches the sheet as a literal `&ldquo;`. Because a record is only rewritten
when its show rotates back on air, the cache is also normalised once at boot;
that pass is idempotent and writes nothing when the data is already clean.

`data[0]` of that feed is a station configuration block rather than schedule
data, and is treated as sensitive: never read, never forwarded, never logged.

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

The two show-info caches additionally persist to disk (`data/programs.json`,
`data/showinfo.json`, overridable via `PROGRAMS_PATH` / `SHOWINFO_PATH`) because
one is expensive to rebuild and the other accrues slowly. Writes are debounced
and every read and write is wrapped: an unwritable `data/` logs a single line and
degrades to memory-only. Deleting the directory is always safe.

## Front-end data merge

The info sheet reads three sources, most specific first:

| Field | Archive row | `/api/showinfo` | `/api/programs` |
| --- | --- | --- | --- |
| title, air date, length, retention, mp3, RSS | ✅ | | |
| host | ✅ when present | `sh_djname` | "Hosted by" |
| description | | `sh_desc` / `sh_shortdesc` | program page |
| website, Facebook, Twitter | | `sh_url`, `sh_facebook` | program page |
| artwork | `/pix/…` | `/pix/…` | |

Every block is rendered only when its value is non-empty — that single filter is
what keeps the sheet from showing labelled blanks for shows WBAI documents
thinly. `/api/programs` is fetched lazily on the first sheet open (it's the
largest payload in the app), and the open sheet repaints itself when it lands.

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
