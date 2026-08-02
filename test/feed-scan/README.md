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
node scan.js --any-change  # exit 1 on routine churn too
node selftest.js        # offline: prove the detector can still see changes
```

Exit status is the point: **0 = nothing notable, 1 = something notable changed,
2 = the scan itself failed.** Cron it and only hear from it when it has something
to say.

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

Every change is printed. Only the **notable** ones set the exit status, which is
what decides whether the scheduled workflow fails and mails you.

| Notable | Meaning |
| --- | --- |
| `CAP_CHANGED` | **max episodes-per-feed moved — the migration plan is now out of date** |
| `CLAIM_MISMATCH` | the listing advertises a feed that isn't there — the 2026-07-29 regression |
| `FEED_UNFETCHED` | a live feed with no XML button: the harvest will never fetch it |
| `FEED_LOST` | was serving, now isn't — including `200`-with-zero-bytes |
| `FEED_APPEARED` | a known 404 slug started serving. **This is the migration signal.** |
| `SLUG_GONE` | a remembered slug is no longer offered anywhere |

| Routine | Meaning |
| --- | --- |
| `NEW_EPISODE` | newest `pubDate` advanced — the healthy heartbeat |
| `ITEM_COUNT` | a feed's episode count moved |
| `NEW_SLUG` | a new show, no feed yet — worth watching, not worth waking for |
| `NEW_FEED` | a slug we had never seen, already serving episodes |
| `CLAIM_RESOLVED` | a standing mismatch cleared — an alarm switching *off* |

The split exists because it was got wrong first. The workflow's fourth run failed
on 79 changes, 77 of them new episodes and item counts across three days: the
archive working exactly as it should. Exiting `1` on any difference means a
failure mail every single day, and a daily failure mail is one nobody opens on the
day the feeds actually die. `--any-change` restores the old behaviour if you want
it.

## Load

122 feeds, ~500 KB, **every run** — assume a full sweep and no savings.

The scan sends `If-Modified-Since` and upstream honours it (verified 2026-08-02:
a stored timestamp replayed against `/xml/dn.xml` returns `304`). It still almost
never hits, because **archive2 rebuilds every feed in one batch**. Five unrelated
shows, including ones with no new episode, all carried `Last-Modified` within a
second of each other:

```
dn           Sun, 02 Aug 2026 13:04:43 GMT
techtonic    Sun, 02 Aug 2026 13:04:44 GMT
kwave        Sun, 02 Aug 2026 13:04:44 GMT
salsasho     Sun, 02 Aug 2026 13:04:44 GMT
dream        Sun, 02 Aug 2026 13:04:43 GMT
```

So any scan that runs hours after the last rebuild — which is every scheduled
one — holds a timestamp older than the batch and gets a full body back. Live runs
report `304s: 0`.

An earlier note here claimed **98/98 `304`** and "near-zero after the first run".
That was measured from two runs minutes apart, inside a single rebuild window. It
was a true measurement of the wrong thing, and it does not describe the daily job.
Conditional GET is kept because it costs nothing and pays off on back-to-back runs.

Concurrency is pinned at **5** and should stay there. This is a small station's
Apache, and the full sweep at 5-wide takes about ten seconds — comfortably inside
the workflow's 10-minute timeout, with the full sweep as the assumption rather
than the exception.

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
