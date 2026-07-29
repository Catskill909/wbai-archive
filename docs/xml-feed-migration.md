# Migrating to the XML feeds — what they can and cannot carry

The per-show RSS feeds that [UPSTREAM.md](UPSTREAM.md) recorded as **dead** on
2026-07-26 are **alive and working well**. This document is the survey that
should decide how far we move onto them. Field detail measured **2026-07-28**,
coverage numbers re-measured **2026-07-29**.

Read [archive-source-audit.md](archive-source-audit.md) first if you arrived here
from the "our site has extra shows" question — that turned out to be a sorting
artifact, not a data problem.

## The headline: respect the 5-episode limit, and never hard-code it

The feeds are healthy. Every RSS link on the listing was fetched and checked —
**98 of 98 valid, current, real episodes, none broken.** The five-episode window
is not a defect and this plan does not treat it as one. We take what a feed
offers and stay inside it.

What matters for planning is that **the cap is a setting in WBAI's archiver, not
a property of RSS.** So coverage is a dial, not a ceiling, and the only real
design rule that follows is: **nothing we build may assume the number 5.** Read
what each feed actually returns, merge it, move on. Then the day someone raises
the setting, our coverage grows on its own with no code change and no redeploy.

Measured **2026-07-29**, and these numbers move daily — re-run
[test/feed-scan/](../test/feed-scan/) rather than quoting them:

```
listing rows                              531
distinct shows in the listing             132
  with a feed (RSS icon on the page)       98
  with no feed at all                      34

feed items available                      408   (max 5 per feed)
listing rows the feeds can reproduce      356   (67.0%)
```

Two independent dials, each with a measurable payoff:

| Dial | Coverage becomes |
| --- | --- |
| today | **356 rows — 67%** |
| raise the episode cap 5 → ~60 | **452 rows — 85%** |
| …and add feeds for the 34 missing shows | **531 rows — 100%**, the scrape retires |

So the destination really is a full switch, and it is reachable without us
writing anything clever — it just isn't reachable *today*, and no work on our
side gets there alone. Until then this is a **merge, not a swap**: the feeds
enrich what the scrape already produces and give us a cross-check we have never
had, and the same code carries us all the way to 100% as the dials turn.

## Turning the dials — the ask, ready to send

Both dials live in the archiver tool that builds archive2, so only WBAI can turn
them. Turn both and the feeds fully replace the HTML scrape, which is the goal —
the scrape is the most fragile thing in this project.

One distinction that is easy to lose when writing to them: the 34 shows below are
**not shows with broken feeds**. They are shows with **no feed and no RSS icon on
the page at all**. A quick way to see it — The Katie Halper Show's row carries the
orange XML icon; Leonard Lopate's row carries nothing.

To whoever operates `Pacifica Archive archiver_7.1` (the KPFTx-built tooling
behind archive2):

To whoever operates `Pacifica Archive archiver_7.1` (the KPFTx-built tooling
behind archive2):

> First, to be clear: **the feeds work well.** We tested every RSS link rendered
> on `archive2.wbai.org` — 98 of 98 return valid, current podcast XML. Nothing is
> broken. These are two requests to widen what they cover.
>
> 1. **Could the episodes-per-feed limit be raised from 5 to around 60?** Each
>    feed currently exposes the last five episodes, while the archive itself keeps
>    roughly 60 days. A daily show like Democracy Now therefore offers five days
>    by feed and about sixty on the website. Matching the two would let podcast
>    clients see the same archive the site does.
>
> 2. **Could feeds be added for the shows that don't have one?** 98 of the 132
>    shows in the listing render an RSS icon; 34 render none at all. Several are
>    among the most-listened — Leonard Lopate (`lenlo`), Rising Up With Sonali
>    (`sonali`), Rise Up with Shanixa (`shan`), Waking Up (`wakeup`), Latin Roots
>    (`salsasho`), Haitian All-Starz (`haitianallstarz`) and the WBAI Evening
>    News (`indyradio`).
>
> All 34, with the titles as they appear in the listing:
>
> ```
> anymonda            Any Monday                    lenlo               Leonard Lopate at Large
> backstagestories    Backstage Stories             lenredo             Leonard Lopate at Large
> burnbabyburn        Burn Baby Burn                manrat              A Mansion for the Rat
> city                Living for the City           mraverscreative     Midnight Ravers
> consabor            Con Sabor Latino              musicalchairs       The Sweet Spot
> demnow              counterspin                   oldisnewagain       Everything Old is New Again
> dust                Dustbin of History!           salsasho            Latin Roots
> earthriotradio      Earth Riot Radio              shan                Rise Up with Shanixa
> folkradiorewinda    Folk Radio                    sonali              Rising Up With Sonali
> ftsb                From The Soundboard           soulcs              Soul Central Station
> groovelines         Groovelines                   tbd                 TBD
> haitianallstarz     Haitian All-Starz Radio       thomhart            The Thom Hartmann Program
> harlemconnectio     The Harlem Connection         voice               Voices of Resistance
> heavywaits          Heavy Waits                   wakeup              Waking Up With J. Forlano
> indyradio           WBAI Evening News             wbairadipopupshop   WBAI Radio Pop Up Shop
> irsay_sun           Morning Irsay
> katiehalpershowb    The Katie Halper Show
> kwave               K-Wave
> laughionsundaymorn  Laughing On Sunday Morning
> ```
>
> A few of those look like rebroadcast or alternate slugs for shows that already
> have a feed under another name — `katiehalpershowb` alongside `katiehalpershow`,
> `lenredo` alongside `lenlo`. If those are intentional duplicates, feeds for them
> may not be wanted; we'd rather ask than assume.
>
> Also worth flagging, unrelated to the feeds: the listing page at
> `archive2.wbai.org` emits its **newest** rows at the *bottom* of the table
> rather than the top, so the most recent recordings appear last unless a visitor
> clicks the Date header.

Until one of those lands, [test/feed-scan/](../test/feed-scan/) watches for both
and reports `CAP_CHANGED` or `FEED_APPEARED` the day they do.

## What the feeds actually are

`getrss.php?id=<slug>` is a thin wrapper over a static file:

```
https://archive2.wbai.org/getrss.php?id=dn   ->   https://archive2.wbai.org/xml/dn.xml
```

Both return the same 5,396 bytes for `dn`. Prefer `/xml/<slug>.xml` — it is the
canonical path the feed names in its own `<atom:link rel="self">`, and it gives a
clean `404` for a miss where `getrss.php` returns a `200` with a zero-byte body
and a `text/html` content type. Directory listing at `/xml/` is `403`, so there
is **no index** — you must know the slug.

Feed generator: `Pacifica Archive archiver_7.1`. All 98 feeds carried a
`Last-Modified` from the day of measurement, so the generator is running for every
one of them. Thin feeds are thin because the show stopped airing, not because the
feed is stale.

```
items-per-feed histogram:  5 items × 77 feeds,  2 × 2,  1 × 19   (408 items total)
```

### Per-item fields

```xml
<item>
  <title><![CDATA[Democracy Now!  - Tuesday, July 28, 2026]]></title>
  <link>https://archive2.wbai.org/mp3/wbai_260728_080000dn.mp3</link>
  <guid>https://archive2.wbai.org/mp3/wbai_260728_080000dn.mp3</guid>
  <pubDate>Tue, 28 Jul 2026 08:00:00 -0400</pubDate>
  <description><![CDATA[Hard-hitting coverage of war and peace…]]></description>
  <itunes:summary><![CDATA[…]]></itunes:summary>
  <itunes:duration>3604</itunes:duration>
  <itunes:explicit>no</itunes:explicit>
  <category>Public Affairs</category>
  <enclosure url="…/wbai_260728_080000dn.mp3" length="57661728" type="audio/mpeg" />
</item>
```

`<guid>` is the MP3 URL, which is also what our archive rows carry as `mp3`. That
is the join key, and it is exact — no date-rounding or slug-matching needed.

### Channel fields

`title`, `link`, `description`, `language`, `lastBuildDate`, `ttl` (60),
`category`, `managingEditor`, `webMaster`, `itunes:owner`, `itunes:author`,
`itunes:summary`, `itunes:image`.

## First: what the app already does. Most of this is solved.

**This was the mistake in the first draft of this document** — it costed the
feeds' fields as if they were arriving on an empty app. They are not. The info
sheet already merges three sources, and between them they cover **all 132 shows**,
which is more than the feeds' 98:

| Already in the app | Source | Coverage |
| --- | --- | --- |
| Description, host, links | `/api/programs` — wbai.org's program directory | 149 programs |
| Description, artwork, links, short desc | `/api/showinfo` — harvested from the on-air feed | grows as the schedule rotates |
| **Description for any show, on demand** | `/api/showinfo/<altid>` → `_pa_get_show_info.php` | **all 132, from a cold start** |
| Episode duration text (`1:00:04`) | the archive row's `length` | all 531 rows |
| Real playback duration | the `<audio>` element itself | every episode |
| Artwork + lightbox | `pub_sched.php` photo map (`r.photo`) | 101 shows |
| Host | the archive row's `host` + `showInfo` | all rows that have one |

So the honest read: **a feed harvester would re-fetch descriptions the app
already resolves on demand, for fewer shows, and mostly get the same channel-level
blurb back.** `/api/showinfo/<altid>` is strictly better at the job — it answers
for all 132 shows including the 34 with no feed, and it needs no harvest, no
cache, and no hourly sweep.

That leaves a much shorter list of things the feeds genuinely add:

| Genuinely new | Size | Worth it? |
| --- | --- | --- |
| **Per-episode** description | 89 items differ from the show blurb | The one real gain. The app shows a per-*show* description; this is per-*episode*. |
| `enclosure length` (bytes) | 408 items | Nothing in the app displays file size. |
| 52 orphan episodes | still playable, dropped from the listing | A product call, not a data gap — see Phase 3. |

Everything else in the table below is already covered. It is kept for reference,
not as a to-do list.

## Field-by-field reference (mostly already covered)

Honest accounting, because most of the tempting fields turn out to be things we
already have.

| Field | Coverage | Verdict |
| --- | --- | --- |
| `itunes:duration` (seconds) | 408 items | **Real gain.** The listing gives `"1:00:04"` as text; this is an integer, and it is what an `<audio>` preload check wants. |
| `enclosure length` (bytes) | 408 items | **Real gain.** Lets us show size and detect a truncated recording without a HEAD. |
| per-episode `description` | 89 items differ from the channel text | **Modest gain.** Most items just repeat the show blurb; 89 carry something episode-specific. |
| `itunes:author` | 93 of 98 feeds | **Real gain.** 128 of 132 slugs have no `host` in the listing; a feed supplies one for 91 of them. |
| channel `description` | 98 of 98 | **Overlaps** `_pa_get_show_info.php`, which already answers for any show on demand and covers all 132. Use as a fallback, not a replacement. |
| `category` | 408 items | Redundant — the listing's `cat` attribute already maps cleanly. |
| `itunes:image` | 98 of 98, but **12 are the generic `WBAI_it_.jpg` placeholder** | **Marginal.** 31 slugs have no schedule photo; feeds supply real artwork for only **3** of them. Not worth a pipeline on its own. |

Plus the finding from the audit: **52 episodes appear in feeds but not in the
listing, and all 52 still play.** Merging the two sources grows the archive rather
than shrinking it.

## The one flag that makes this cheap

We already parse it. `parseArchive()` sets `hasRSS` by looking for `getrss.php` in
the row body ([server.js:154](../server.js#L154)), and that flag is a **perfect**
predictor of feed existence:

```
hasRSS=true  & feed exists : 98
hasRSS=true  & feed missing:  0
hasRSS=false & feed exists :  0
hasRSS=false & no feed     : 33
slugs whose rows disagree with each other: 0
```

No 404-probing and no slug guessing **for shows already in the listing**. The
listing tells us exactly which 98 feeds to fetch, and it has never been wrong.

### But the show list moves, so discovery is still a live problem

`hasRSS` only answers for shows that already have archive rows. New shows arrive,
and the caps and coverage above are settings in WBAI's archiver, not constants.
Treat every count on this page as a reading, not a constant. On 2026-07-28 the
slug count moved **within a single hour**: `thomhart` appeared in the listing with
no feed, and `breakthrnewsradio` sat on the schedule with neither rows nor a feed.
The listing itself went 530 rows → 531 overnight. This is normal, and it is why
the coverage table is dated.

Observed ordering, which is what a scanner has to be built around:

```
scheduled  ->  archive rows appear  ->  hasRSS goes true  ->  /xml/<slug>.xml exists
```

There is **no feed index** to enumerate (`/xml/` is `403`), so slugs must come
from the listing dropdown, the rows, and `pub_sched.php`. That scanner exists:
[test/feed-scan/](../test/feed-scan/). It diffs against a stored snapshot and
exits non-zero when anything moved, so it can be cron'd; `FEED_APPEARED` is the
signal that a previously feed-less show became migratable, and `CAP_CHANGED` is
the signal that the 67% number at the top of this document needs re-deriving.

## Fetch economics

The full harvest is **98 requests, ~500 KB**, and after the first pass it is
nearly free, because the feeds honour conditional GET:

```
$ curl -H "If-Modified-Since: Tue, 28 Jul 2026 18:04:43 GMT" .../xml/dn.xml
304, 0 bytes
```

No `ETag`, and **no gzip** (`Accept-Encoding: gzip` returned the same 5,396
bytes) — so `Last-Modified` + `If-Modified-Since` is the entire optimisation, and
it is enough. Store the `Last-Modified` per slug alongside the parsed result.

For comparison, one listing scrape is ~765 KB and we do it every 5 minutes. A
daily conditional feed harvest is a rounding error against that. Keep concurrency
at **5** — this is a small station's Apache, and the whole sweep at 5-wide took
well under a minute.

## SHIPPED 2026-07-29

Built, running, verified. The phases below are the record of how the design got
here; what landed is simpler than any of them.

### The rule: gate on the SHOW, enrich per EPISODE

`applyFeeds()` in [server.js](../server.js):

```
show has no podcast XML button (hasRSS false)  -> drop the row entirely
episode starts off the :00/:30 grid            -> drop it (recorder fragment)
episode is inside its feed                     -> serve the feed's record
episode is outside its feed's item window      -> serve the listing row
```

```
scraped rows          : 540
  dropped, no feed    :  88
  dropped, fragments  :   9
PUBLISHED             : 443
  source: feed        : 354
  source: listing     :  89
```

**Gate per show, not per episode.** This was got wrong once and is worth stating
plainly: gating per episode also deleted 89 older episodes of shows whose feeds
are perfectly healthy, purely because a feed publishes only its most recent five.
Those episodes are listed, playable and real — the item count is a display setting
on WBAI's side, not a claim about what exists. `source` records which branch each
episode took, so the share still riding on the scrape is a number you can read,
and it goes to zero on its own as that setting rises.

### Display order is archive2's, not ours

Rows carry `ord`, their position in archive2's own page, and the client's default
`sortKey` is `'archive'`. The two listings therefore read alike top to bottom.
Their page is *not* air-date sorted — recent recordings are appended in ingestion
order — so this deliberately reproduces "most recently added to the archive"
rather than imposing a date sort. Clicking any column header switches to a real
sort; a reload returns to the archive order.

### What the scrape still does — it is not gone

Worth being exact, because "we don't scrape any more" is not true:

| Supplied by the scrape | Used for |
| --- | --- |
| `hasRSS` | **which feeds to harvest** — the entire discovery mechanism |
| `ord` | the default display order |
| `id`, `cat`, `daysLeft`, `dateText`, `length` | identity, category filter, retention badge |
| `photo` (via `pub_sched.php`) | artwork on 379 of 443 episodes |
| whole rows | the 89 episodes outside their feed's window |

The feeds carry no artwork worth having, no category the listing doesn't already
give, no retention data, and no index of themselves. So the scrape stays
load-bearing until WBAI ships a feed index and raises the item count — at which
point the row-level dependency drops out and only discovery remains.

### Free wins

- **The 9 phantom *A Mansion for the Rat* rows vanished** without a date filter.
  `manrat` has no feed, so the invented rows and the feed-less rows turned out to
  be the same rows.
- **Real structure per episode** — `durationSec` as an integer rather than the
  string `"1:00:03"`, `bytes`, and a per-episode description where one differs
  from the show blurb.
- **`public/data/shows-fallback.json` regenerated** from the filtered output (443
  episodes, with `ord`). It was a stale 528-row unfiltered scrape from 2026-07-23,
  so the offline path would have rendered every phantom row and fragment in the
  wrong order.

### Operational

`/healthz` reports `feeds: { held, lastHarvest, notModified, failed }`.
`held: 0` with `lastHarvest` set is the one state that empties the site — exposed
rather than inferred, same lesson as `showinfoOnDisk`.

## Proposed shape

**Feeds first, scrape as the fallback.** Structured XML is the source of truth
wherever one exists; the HTML scrape covers only what the feeds cannot reach.

An earlier draft recommended waiting until the dials turn. That was wrong, and
for a reason worth writing down: it judged the feeds purely on the *metadata
fields* they add, and concluded they were redundant with
`/api/showinfo/<altid>`. That misses the actual point. The reason to move to
feeds is **not** richer fields — it is getting off a 765 KB regex scrape of an
HTML table whose attribute order we depend on. Every episode served from a feed
is an episode that no longer depends on that parse holding.

So the plan is a **source swap**, not an enrichment layer:

```
for each episode:
    feed has it?  -> use the feed's record      (structured, parsed XML)
    otherwise     -> use the scraped row        (regex over HTML)
union by MP3 URL, which both sides carry exactly
```

Today that puts **~2/3 of the catalogue on structured data** and leaves the
scrape carrying the rest. Every dial WBAI turns moves rows from the second branch
to the first, automatically, with no code change — and when the last one lands,
the scrape drops out on its own and Phase 4 is a deletion rather than a project.

Each phase below is shippable and independently reversible; do not start phase
_n+1_ before _n_ is in production and verified per §4 of CLAUDE.md.

Phase 0 is not a step at all — it is a correction, kept because the mistake it
records is an easy one to make twice.

### Phase 0 — `SHOW_RSS` is a **policy decision, not a code fix**. Leave it alone.

An earlier draft of this document said to flip `SHOW_RSS = false` in
[app.js](../public/app.js) because it "exists solely because the feeds returned 0
bytes." **That was wrong.** Read the comment at the flag:

> `SHOW_RSS` — off by policy, not by accident. Access to episodes stays inside
> the web app and the native apps: no feeds, no file handoffs. (Upstream's
> `getrss.php` also returns a zero-byte body for every show, so nothing that
> worked was removed — but the policy is the operative reason and **holds
> regardless**.)

The dead feeds were a parenthetical. The feeds reviving changes nothing about
the reason the flag is off, and flipping it would hand users a route to the MP3s
that deliberately bypasses both apps.

**Nothing in phases 1–3 needs this flag.** They all consume feeds server-side and
never expose a feed URL. Turning `SHOW_RSS` on is a separate product call for
whoever owns that policy — not a step on the way to anything here.

### Phase 1 — a feed harvester, writing to a cache nothing reads yet

New module, same discipline as the existing caches: TTL, single-flight, on-disk
persistence through `readJsonFile`/`writeJsonSoon`, failure degrades to memory.

- Input: **every** `hasRSS: true` slug in the current archive payload — read the
  count, never a constant. It was 98 on 2026-07-29 and it moves.
- Refresh: hourly, conditional, concurrency 5.
- Output: `data/feeds.json` keyed by MP3 URL →
  `{ durationSec, bytes, description, author, category, feedSlug }`.
- Expose at `GET /api/feeds/head` (counts + newest `lastBuildDate`) for eyeballing.

**Take however many items a feed offers — never 5, never a `slice()`, no cap of
our own.** The whole point of keying on MP3 URL and merging is that the day WBAI
raises the episodes-per-feed setting, this harvester picks up the extra episodes
on its next run and coverage climbs from 67% toward 100% with no code change and
no redeploy. A hard-coded 5 anywhere in here silently forfeits that.

Ship it reading-only. Nothing in the UI changes. Watch it for a few days and
confirm the 304 rate is what this document predicts.

**Verify:** `storage`-style facts in `/healthz` (feed count on disk, last harvest
time) — the same lesson as `showinfoOnDisk`; a field that reads healthy whether or
not persistence works diagnoses nothing.

### Phase 2 — merge feed metadata into archive rows

**Scope note, given what the app already has:** this phase is *not* a description
pipeline. `/api/showinfo/<altid>` already resolves a description for any of the
132 shows on demand, including the 34 with no feed, and it stays the source. The
feed contributes only what that endpoint cannot: a **per-episode** description
where one differs from the show blurb, and `enclosure length`. Duration, artwork
and host are already covered — do not re-plumb them.

In `getArchive()`, after `parseArchive()`, left-join the feed cache on `mp3`.
Enrichment only — a row never disappears or changes identity because a feed did
or didn't have it.

- `durationSec` and `bytes` become new optional fields.
- `host` fills from `itunes:author` **only when the listing left it empty**.
- Episode description fills the show sheet **only when** it differs from the
  channel blurb and we have nothing better from `_pa_get_show_info.php`.

Merge precedence, explicitly: **listing > `_pa_get_show_info.php` > feed.** The
listing is the identity source; the feed is the last word, never the first. This
mirrors the merge rule already documented for `showInfo` ("keeps whatever is
already held").

**Verify:** row count before and after the merge is identical — 531 in, 531 out.
Assert it in a test. This is the phase where a join bug could silently delete
shows, and a count assertion is the cheapest possible tripwire.

### Phase 3 — decide about the 52 orphan episodes (needs a product call)

The feeds expose 52 playable episodes the listing has dropped. Adding them means
our archive is a **superset** of archive2's, which is defensible but is exactly
the thing that triggered this whole investigation. Options:

1. **Ignore them.** Our list stays a mirror. Simplest, and no explaining to do.
2. **Include and label them** ("no longer in WBAI's index"). Most content, most
   honest, some UI work.
3. **Include silently.** Don't — it recreates the confusion this audit resolved,
   and next time the evidence trail will be colder.

Recommendation: **(1) for now, (2) if anyone asks for it.** The value is 52
episodes from shows that stopped airing; the cost is permanently owning the
difference between us and the source.

### Phase 4 — reassess, do not pre-build

Revisit replacing the scrape only if WBAI ships **an index of feeds** or **raises
the 5-item cap**. Both are single questions to whoever runs `archiver_7.1`, and
worth asking — a feed index plus a deeper window would change the answer at the
top of this document completely. Until then the scrape stays load-bearing.

## Risks specific to this move

- **The feeds can go dead again.** They did once, silently, `200 OK` with a
  zero-byte body — the failure mode that looks like success. Any harvester must
  treat "0 bytes" and "0 items" as failure and keep the previous value, and
  `/healthz` must expose the count so the failure is visible from outside.
- **`hasRSS` is a scrape artifact.** It comes from the same fragile HTML as
  everything else. If the listing parse breaks, feed discovery breaks with it —
  the two sources are less independent than they look.
- **Slug ≠ show.** `dn` has a feed; `demnow` does not, and `dn3` is separate
  again. Do not normalise or alias slugs to "improve" coverage; join on the MP3
  URL, which is unambiguous.
- **Item cap is a cliff, not a slope.** A show that airs daily exposes 5 days.
  Any UI that implies "all episodes of this show" would be wrong for every
  five-item feed.

## Re-test before trusting any of this

Same rule as UPSTREAM.md: nothing here is a published contract, and the feeds
already proved they can die and revive without notice.

```sh
# feed exists and is fresh?
curl -sI https://archive2.wbai.org/xml/dn.xml | grep -i 'HTTP\|Last-Modified\|Content-Length'

# how many items does it really carry?
curl -s https://archive2.wbai.org/xml/dn.xml | grep -c '<item>'

# does the 5-item cap still hold across the board?
#   -> re-run the coverage sweep; the number that matters is
#      "rows reproducible from the feeds" as a share of the listing.
```

If that share ever approaches 100%, reopen phase 4. It was **67.0%** on
2026-07-28.
