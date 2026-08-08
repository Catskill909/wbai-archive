# What WBAI actually exposes

A survey of every upstream endpoint this project could use, what it really
returns, and which ones are worth depending on. Everything here was tested
against the live hosts on **2026-07-26**; re-test before trusting it, because
none of it is a published contract.

## The short version

**There is no WBAI API.** Not a private one, not an undocumented one — the show
listing exists only as an HTML page, and the endpoints that *look* like an API
return base64-encoded HTML rather than JSON. "Switch to the real API" is not an
option available to us; it would have to be something WBAI builds.

What we have instead is a spectrum:

| Source | Shape | Verdict |
| --- | --- | --- |
| `_pl_current_ary.php` (on air / up next) | **Real JSON** | Depend on it freely |
| `_pa_get_show_info.php` (per-show info) | Base64 → HTML table | Stable enough to depend on; parse defensively |
| `archive2.wbai.org/` (the listing) | Full HTML page | Regex scrape. Fragile, and unavoidable |
| `xml/<slug>.xml` (per-show RSS) | **Real RSS** | **Revived 2026-07-28.** Good, but covers only 67% of the listing — see below |

## The listing — `https://archive2.wbai.org/`

The only source for "what shows are in the archive." ~765 KB of HTML holding
~530 `<tr name="show">` rows; `parseArchive()` in `server.js` regexes out id,
category, altid, air date, duration, days-to-stay, MP3 URL and RSS presence.

**This is the fragile part of the whole project and there is no alternative.**
If WBAI restructures that table, the parse yields zero rows, `getArchive()`
throws, and the server falls back to its last-good cache and then to
`public/data/shows-fallback.json`. That failure path is deliberate — see
[ARCHITECTURE.md](ARCHITECTURE.md) — but it degrades to a stale archive, so a
silent HTML change upstream is the single most likely way this site goes wrong.

Worth knowing: `parseArchive` currently anchors on a *very* specific attribute
order (`id="tt_…" cat="…" sho="…" dt="…"`). Whitespace or reordering breaks it.
A looser per-attribute parse would survive more upstream churn.

## On air / up next — `_pl_current_ary.php`

```
GET https://confessor2.wbai.org/playlist/_pl_current_ary.php
```

Genuine JSON, served as UTF-8 (note: the listing pages are ISO-8859-1 — see the
`opts.encoding` note on `fetchText`). Returns a global station block plus the
current and next show, with the richest per-show record WBAI publishes:
`sh_name`, `sh_djname`, `sh_desc`, `sh_shortdesc`, `sh_url`, `sh_facebook`,
`sh_med_photo`, keyed by `sh_altid`.

The catch that shaped this project: **it only ever describes two shows** — the
one on air and the one up next. There is no bulk form. That constraint is why
`showInfo` is a slowly-accumulating harvest rather than a lookup.

## Per-show info — `_pa_get_show_info.php` ⭐

The endpoint archive2's own front end calls when you pick a show from its
dropdown. **It works for any show, any time — not just what is on air.**

```
POST https://archive2.wbai.org/_pa_get_show_info.php
     sh_altid=<altid>
```

- **POST only.** A GET returns the literal string `bad` (3 bytes).
- Response is **base64**; decode it to get an HTML table.
- Unknown altid returns an **empty body** (0 bytes) — a clean, unambiguous miss.
- The `sh_altid` key is the same one archive rows carry as `sho`, so we already
  have it for every show.

Decoded shape:

```html
<table class="info_table">
  <tr class="info_heading">…</tr>
  <tr>
    <td class="info_category">Public Affairs</td>
    <td class="info_stmt">Economics Professor Richard D. Wolff and guests…<br><br>…</td>
    <td class="info_producer">Richard D. Wolff</td>
  </tr>
</table>
```

Three fields: `info_category`, `info_stmt` (the description, with `<br>` inside),
`info_producer`. Spot-checked against six shows absent from `seed/showinfo.json`:

```
shortwave           54 chars
econupsat          663 chars
blackagendareport  255 chars
drive              531 chars
resistanradio      373 chars
tcoyhealth           0 chars   (genuinely has no description upstream)
```

### Why it matters — **adopted 2026-07-26**

A description used to be learnable only while its show was on the air, which was
the root of a whole chain of workarounds: the `showInfo` harvest, the
`seed/showinfo.json` shipped in the image, and the persistent-volume requirement
in [DEPLOYMENT.md](DEPLOYMENT.md). This endpoint removes that constraint — any
show, on demand, from a cold start.

It now backs `GET /api/showinfo/<altid>`, called by the front end when someone
opens a sheet for a show nothing else describes. Verified against a server booted
with no seed and an empty data dir: it began with 2 records and resolved every
show asked of it.

Note the two sources can carry *different* prose for the same show — the harvest
had 808 characters for `wbaisports`, this endpoint 1357. Neither is wrong. The
merge keeps whatever is already held, so adopting this changed nothing that was
already rendering; it only fills gaps.

### What it does *not* give you

It is narrower than the on-air feed, so it complements rather than replaces it:

| Field | `_pa_get_show_info.php` | On-air feed | Elsewhere |
| --- | --- | --- | --- |
| Description | ✅ | ✅ | — |
| Producer / host | ✅ | ✅ (`sh_djname`) | also `/api/programs` |
| Category | ✅ | — | also the archive row (`cat`) |
| Artwork | ❌ | ✅ | ✅ already covered by the schedule photo map |
| Website / Facebook | ❌ | ✅ | ✅ `/api/programs` for listed shows |
| Short description | ❌ | ✅ | — |

So: use it as the **primary** description source, and keep the on-air harvest for
the link fields it alone supplies. Artwork is unaffected — that comes from
`pub_sched.php`'s image preloads, independently of all this.

## Per-show RSS — `xml/<slug>.xml` ⭐ **revived 2026-07-28**

```
GET https://archive2.wbai.org/xml/<slug>.xml      <- canonical
GET https://archive2.wbai.org/getrss.php?id=<slug> <- thin wrapper, same bytes
```

**This section said "dead" on 2026-07-26 and was correct then.** Two days later
every feed returned real RSS. Treat the state of these feeds as a thing to
measure, never to remember.

Valid RSS 2.0 with iTunes extensions, generated by `Pacifica Archive
archiver_7.1`. Prefer the `/xml/` path: it is what the feed names in its own
`<atom:link rel="self">`, and it 404s cleanly on a miss, where `getrss.php`
answers `200` with a zero-byte `text/html` body. There is **no index** —
`/xml/` is `403`, so you must know the slug.

The two constraints that decide everything:

- **5 items per feed, hard cap.** 77 feeds carry 5, two carry 2, 19 carry 1.
- **98 of 131 show slugs have a feed at all.** The other 33 return `404`.

⚠️ **"5 items" is a per-show setting, not one global rule.** Feed length is
configured per programme in Pacifica's tools, and *retention of the audio* is a
separate axis again: storage pressure means some shows' mp3s are deleted soon
after they rotate out, while others stay reachable long after, and some are
archived well beyond their feed. Confirmed by the station 2026-08-08. Treat any
single number here — including the 77/5 tally above — as a snapshot of a mixed
population, never as a policy.

**We now keep what falls out of the window.** Until 2026-08-07 `fetchFeed`
replaced `items` with whatever the feed currently listed, so the app could never
hold more than a show's feed length and forgot every episode past it the day it
rotated out. It now unions the fresh window with what is already held
(`mergeFeedItems`), keyed on the `mp3` URL.

**How much that is worth, measured properly on 2026-08-08.** An earlier version
of this note claimed the audio outlives the listing, citing 2026-05-20 files
still returning `200`. **That was bad evidence** — every item in `feeds.json`
was, by construction, still listed in its feed, so it only showed that listed
episodes are playable. The real test needs URLs that are in *no* feed. Built 60
of them by stepping one and two broadcast cycles back from each feed's oldest
listed item, using that show's own filename pattern:

| | |
|---|---|
| still `200` (playable, unlisted) | **44** |
| `404` | 16 |

So audio *commonly* outlives its listing — which is what makes accumulating
worth doing — but not universally. And the failures are mostly not deletions:
**10 of the 16 fall inside the 2026-06-24 → 07-16 recorder outage**, where
nothing was ever recorded to delete. The remaining 6 are ambiguous between
deletion, preemption and a week the show simply did not air, and this method
cannot separate those.

**The practical consequence: a retained item may be a dead link, and there is
nothing in the XML path that says which.** No `expires`, no retention hint. That
is exactly the field Pacifica's JSON catalog publishes per episode (see
[pacifica-json-dev.md](pacifica-json-dev.md) §4), and it is the strongest single
argument for that source. Until then, assume some accumulated rows will `404` on
tap and make sure that fails gracefully rather than silently.

Together those reproduce **67% of the 530-row listing**, so the feeds are a
supplement, not a replacement for the scrape.

⚠️ **The listing's `hasRSS` flag is a hint, not evidence.** It matched feed
existence across all 131 slugs on the morning of 2026-07-29 and had stopped
matching by the afternoon — archive2 began rendering the podcast XML button on
`manrat` rows while `/xml/manrat.xml` still answered `404`. Use `hasRSS` to
decide which slugs are worth *fetching*; decide what to publish from what the
fetch actually returned. See
[xml-feed-migration.md](xml-feed-migration.md#hasrss-selects-what-to-fetch-it-must-never-select-what-to-publish).

Worth having: `itunes:duration` in seconds, `enclosure length` in bytes,
`itunes:author` (fills `host` for 91 slugs the listing leaves blank), and 52
still-playable episodes that have aged out of the HTML listing. Feeds honour
`If-Modified-Since` (`304`, 0 bytes); they do **not** gzip.

⚠️ **They are all regenerated in one batch, so `Last-Modified` moves on every
feed at once.** Measured 2026-07-30: all 122 held feeds carried a `Last-Modified`
inside a four-second window (`23:04:54`–`23:04:57 GMT`). A conditional sweep is
therefore close to all-or-nothing — run it just after a regeneration and every
feed answers `200`; run it a minute earlier and every feed answers `304`.

Two consequences worth designing around:

- **A "how many were unchanged" counter is meaningless without its denominator.**
  Two consecutive production deploys reported 122 and then 0, and both readings
  were correct. `feedsDiag.lastSweep` exists for this reason.
- **A sweep costs either ~16 KB or the full set** — nothing in between. That
  makes *when* you sweep matter more than how cheap a 304 is, which is why the
  harvest clock is restored from disk rather than reset on every boot. See
  DEVELOPMENT.md § Feed harvest.

`SHOW_RSS = false` in `public/app.js` is **not** affected by this revival. It is
off by policy — episode access stays inside the apps — and the dead feeds were
only ever a parenthetical in that decision. Reviving feeds is not a reason to
flip it.

Full survey and a phased plan: [xml-feed-migration.md](xml-feed-migration.md).

## Also present, unused

- **`_srch_show.php`** — POST `str=<query>`; the page decodes the reply with
  `Base64.decode()` then `eval()`, so it returns base64'd JSON (a list of row
  ids). We filter client-side over the full listing instead, which is faster and
  needs no round trip. No reason to adopt it.
- **`_sn_get_cur_show.php`** — archive2's own current-show poll. Redundant with
  the richer `_pl_current_ary.php` we already use.
- **`_pa_dodown.php`** — download handler; we link MP3s directly.
- **`wbai.org/programlist/` + `program.php`** — the program directory behind
  `/api/programs`. Covers 149 programs, but **not all of them**: "WBAI Sports",
  for instance, is absent, which is why it can't be the description source on its
  own.

## Rules of thumb

1. **Assume none of this is stable.** No endpoint here is documented or
   versioned. Every parser must fail to a cached or empty value, never a crash.
2. **Prefer the JSON feed, then the base64 endpoints, then the page scrape** —
   in that order, by fragility.
3. **Cache aggressively and re-fetch politely.** A full listing scrape is ~765 KB
   plus ~182 KB for the schedule; that is real load on a small station's server.
   See the TTL and single-flight notes in [ARCHITECTURE.md](ARCHITECTURE.md).
4. **Re-test before relying on anything in this file.** Dates matter here: the
   RSS feeds presumably worked once.
5. **Count requests per deploy, not just per request.** A conditional fetch is
   cheap; 122 of them on every container start is not, and that is easy to ship
   without noticing — it stayed invisible here until persistent storage made the
   re-fetching pointless rather than necessary. `FEED_CONCURRENCY` carries the
   same warning: this is a small station's Apache.
