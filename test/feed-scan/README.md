# feed-scan — watching archive2 for XML feeds that appear, vanish, or change shape

Answers one question on demand: **what is different about WBAI's per-show XML
feeds since the last time we looked?**

Background and the numbers this was built from:
[docs/xml-feed-migration.md](../../docs/xml-feed-migration.md).

## Why it exists

The feeds are not a published contract. They returned `200 OK` with a zero-byte
body for an unknown stretch of July, then revived on 2026-07-28 without notice.
The episodes-per-feed cap is a **setting in WBAI's archiver** — they can raise it,
and if they do, the "feeds reproduce only 67% of the listing" conclusion that the
whole migration plan rests on stops being true.

So neither "the feeds work" nor "the feeds are capped at 5" is a fact worth
remembering. Both are facts worth **re-measuring**, which is what this does.

## Use

```sh
node scan.js            # scan, diff against the last run, print a report
node scan.js --json     # same, machine-readable
node scan.js --no-save  # dry run, leave the snapshot alone
node scan.js --full     # ignore stored Last-Modified, re-fetch every feed
node selftest.js        # offline: prove the detector can still see changes
```

Exit status is the point: **0 = nothing changed, 1 = something changed, 2 = the
scan itself failed.** Cron it and only hear from it when it has something to say.

```
scan 2026-07-28T19:13:32.297Z
  slug sources: dropdown 132, rows 132, schedule 101, remembered 133 -> 133 candidates
  feeds live: 98   no feed: 35   max items/feed: 5   304s: 98

  no changes since 2026-07-28T19:11:40.068Z
```

`state.json` is the snapshot, and it is gitignored — it is machine-local. The
first run on a new machine has nothing to diff against and says so.

## How new shows get found

There is **no feed index** — `/xml/` returns `403`, so a slug has to come from
somewhere else. Four sources, deliberately overlapping, because each goes blind
differently:

| Source | Catches | Blind to |
| --- | --- | --- |
| `<select id="sh_altid">` on the listing | every show archive2 knows about | shows not yet in the archive |
| `<tr name="show">` rows | same set, via a different parse | — kept as a **cross-check**, not for coverage |
| `pub_sched.php` artwork preloads | shows scheduled but never yet archived | shows off the current schedule |
| `state.json` | everything ever seen | nothing — it only grows |

The dropdown and the rows agreed exactly on 2026-07-28 (132 each). They are both
scanned anyway: if they ever *disagree*, one of the two parses has drifted, and
the scan says so on its own line. That warning is the real product of scanning
both — the second source is there to catch the first one lying, not to find more
slugs.

Observed ordering, which is why the schedule source earns its place: a show
appears on the **schedule** first, then gets **archive rows**, and only then gets
a **feed**. On 2026-07-28 `breakthrnewsradio` was scheduled with no rows and no
feed, and `thomhart` appeared in the listing with no feed yet. Neither would have
been visible from the feed directory, because there isn't one.

## What it reports

| Change | Meaning |
| --- | --- |
| `NEW_FEED` | a slug we had never seen, already serving episodes |
| `NEW_SLUG` | a new show, no feed yet — the one to watch |
| `FEED_APPEARED` | a known 404 slug started serving. **This is the migration signal.** |
| `FEED_LOST` | was serving, now isn't — including `200`-with-zero-bytes |
| `ITEM_COUNT` | a feed's episode count moved |
| `NEW_EPISODE` | newest `pubDate` advanced (routine; the healthy heartbeat) |
| `SLUG_GONE` | a remembered slug is no longer offered anywhere |
| `CAP_CHANGED` | **max episodes-per-feed moved — the migration plan is now out of date** |

## Load

98 feeds, ~500 KB on a cold run, then near-zero: the feeds honour
`If-Modified-Since` and answered **98/98 as `304`** on the second run. No `ETag`,
no gzip upstream, so conditional GET is the whole optimisation.

Concurrency is pinned at **5** and should stay there. This is a small station's
Apache, and the full sweep at 5-wide takes about ten seconds.

## `selftest.js`, and why it is not optional

This scanner will print "no changes" almost every time it runs, which is exactly
what a scanner that has quietly gone blind prints. So `selftest.js` synthesizes
every change kind and asserts it is detected — and asserts that *unchanged* input
produces nothing, so the suite cannot pass by firing on everything (CLAUDE.md
§3a).

It earned its keep on the first run: it caught `CAP_CHANGED` firing spuriously
whenever feeds died, because `maxItems` is a max across live feeds and collapses
toward zero during an outage. An outage was being reported as a config change.
That bug would have been invisible in production until the day it mattered most.
