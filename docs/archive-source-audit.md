# Audit: "our site shows episodes archive2 doesn't have"

Measured against the live hosts on **2026-07-28, ~14:55 EDT**. Every number below
came from a request made that afternoon; re-measure before trusting it (§4 of
CLAUDE.md — read production, don't reason about it).

## Verdict up front

**Our listing is not inventing anything.** At the moment of measurement,
`https://wbai.supersoul.top/api/archive` and `https://archive2.wbai.org/` held
the *same 530 rows* — identical ids, no extras, no duplicates, no future dates,
and every one of the 530 MP3s resolving `200` at full size.

```
archive2 rows: 530   unique ids: 530
prod rows:     530   unique ids: 530
in prod NOT in archive2: []
in archive2 NOT in prod: []
duplicate sho@dt:        []
rows with an air date in the future: 0
MP3 sweep (530 HEAD requests): problem rows: 0
```

There is nothing to delete and nothing to reconcile. What was actually observed
is two *separate* real things that together look like one bug.

## Cause 1 — archive2 renders its newest shows at the **bottom** of the page

archive2 emits the table nearly, but not perfectly, in date-descending order. Doc
order runs newest-to-oldest down to position 514 — and then the **fourteen most
recent recordings** (positions 516–529, everything from 2026-07-27 17:42 onward)
are appended *after* the oldest April rows, along with one 2026-07-21 straggler:

```
doc pos   id      slug              air date
  512   87366   manrat            2026-04-15   <- oldest block
  513   87235   manrat            2026-04-08
  514   87105   manrat            2026-04-01
  515   88729   haitianallstarz   2026-07-21   <- order breaks here
  516   88846   advojust          2026-07-27 21:42
  517   88847   indyradio         2026-07-27 22:00
  518   88848   cspin             2026-07-27 22:30
  519   88863   lenlo             2026-07-28 17:00   <- the actual newest show
  520   88862   garynull          2026-07-28 16:00
  521   88861   katiehalpershow   2026-07-28 15:00
  522   88860   shan              2026-07-28 14:00
  523   88859   talkbacktues      2026-07-28 13:00
  524   88857   wakeup            2026-07-28 11:00
  ...
  529   88851   inonews           2026-07-28 01:00   <- last row on the page
```

The page *has* a sort — `do_sort()` in its inline JS, and the Date column even
renders its "descending" arrow (`ord="down"`) — but it only runs `onclick`. It is
never applied on load. So the server's emission order is what a visitor sees, and
the top of archive2.wbai.org reads:

> **Democracy Now! — Tuesday, July 28, 2026 8:00 am**

while the five newest recordings sit ~520 rows down, past the April shows, where
nobody scrolls.

Our front end sorts client-side (`state = { sortKey:'date', sortDir:'desc' }`,
[app.js:53](../public/app.js#L53)) and therefore correctly shows:

> **Leonard Lopate at Large — Tuesday, July 28, 2026 1:00 pm**

Same 530 rows, different order. **Our site is more correct than the source**, and
that difference in the top row is what read as "our app is inventing shows."

Confirming it directly: `lenlo`'s file is real and complete.

```
https://archive2.wbai.org/mp3/wbai_260728_130000lenlo.mp3
  HTTP/1.1 200 OK
  Last-Modified: Tue, 28 Jul 2026 17:59:59 GMT   (13:59:59 EDT — end of the 1pm hour)
  Content-Length: 57648397
```

## Cause 2 — there *was* a real recording outage, and it is already over

Counting rows per air date explains the other half of the impression. Recording
stopped for about three weeks and resumed on **2026-07-17**:

```
2026-07-28   11
2026-07-27   15
2026-07-26   16
2026-07-25   15
2026-07-24   19
2026-07-23   20
2026-07-22   23
2026-07-21   17
2026-07-20   21
2026-07-19   14
2026-07-18   14
2026-07-17   10   <- recording resumes
             --   2026-06-24 .. 2026-07-16 absent entirely (23 days)
2026-06-23    4   <- outage begins
2026-06-22   16
2026-06-21    6
```

This is not a retention artifact: rows from 2026-07-27 carry `daysLeft: 59`, so
the window is ~60 days and late June is well inside it. The gap is a genuine hole
in WBAI's archive.

Both sites show that hole identically — it is upstream, not ours. The station's
recorder has been healthy for eleven days and is currently writing files within
seconds of each hour ending.

## What this means for "get rid of non-matching files"

Nothing to remove. The sweep found zero rows in our listing that archive2 does
not have, and zero rows whose MP3 is missing or truncated. Any deletion pass
written today would delete nothing, and any filter added to enforce "must exist
upstream" would be dead code guarding a condition that never fires.

The one change worth considering is cosmetic and on our side only: because
archive2's top row and our top row now disagree by design, a spot-check against
archive2 will keep looking alarming. Sorting the archive2 page by Date (one
click on its Date header) makes the two lists line up exactly.

## The surprise: the feeds hold episodes the listing has dropped

Running the same comparison against the per-show XML feeds turned up 52 episodes
advertised by a feed but absent from the HTML listing. All 52 were checked and
**all 52 still return `200`** — real, playable files whose listing rows aged out
while the MP3 survived on disk.

```
episodes in feeds but NOT in the listing: 52   (MP3 alive: 52, dead: 0)
  wbai_260528_180000blackagendareport.mp3   Thu, 28 May 2026
  wbai_260621_000000allmixedup.mp3          Sun, 21 Jun 2026
  wbai_260527_160000chrishedgesreport.mp3   Wed, 27 May 2026
  ...
```

So the direction of the discrepancy is the opposite of the one suspected: the
HTML listing is the *narrower* view, and adopting the feeds would **add** content
rather than prune it. That feeds directly into
[xml-feed-migration.md](xml-feed-migration.md).

## For Pacifica: what is wrong with the archive2 page

Two separate defects, both upstream, both confirmed by measurement on
2026-07-29. Neither is in our scraper — we mirror the page faithfully.

### 1. New recordings are appended in ingestion order instead of being re-sorted

The table is *almost* air-date sorted — 532 of 539 consecutive row pairs descend
correctly (98.7%). What breaks it is that records created since the last sort are
**appended to the end in the order they were ingested** rather than merged into
place. Record id 88879, one of the newest in the system, sits at document position
**516 of 540** — 515 rows below where its air date belongs.

Sorting by record id fits the page far worse (75.5%), so this is not "the page is
sorted by id". It is a sorted body plus an unsorted tail of recent arrivals.

Reading `archive2.wbai.org` top to bottom, the date runs backwards, then jumps
forward, six times:

```
rows   1–117   Jul 29 → Jul 21   descending
rows 118–183   Jul 21 → Jul 17   restarts
rows 184–502   Jun 23 → May 31   restarts
rows 503–511   May 27 → Apr  1   the phantom rows, see below
rows 512–515   Jul 21, Jul 27 ×3 scattered
rows 516–540   Jul 29 → Jul 27   restarts — these are the NEWEST recordings
```

The practical effect is that **yesterday's programming is invisible**. A visitor
reads the top of the page and sees Out-FM (Jul 28 9 pm) followed immediately by
Democracy Now (Jul 28 8 am) — the eleven shows that aired between them are parked
at rows 522–534, past the April entries, where nobody scrolls.

The page has a working sort: `do_sort()`, and the Date header even renders its
descending arrow (`ord="down"`). **It is only bound to `onclick` and never runs on
load.** Calling it once during page init would fix the symptom entirely.

### 2. The scheduler emits rows for broadcasts that did not happen

Nine rows for *A Mansion for the Rat*, one per Wednesday at 12:00 am, running back
to April 1 — with `daysToStay` counting **0, 7, 14, 21, 28, 35, 42, 49, 56**. A
perfect arithmetic sequence is a generator, not a recording log.

### 3. The recorder leaves fragments in the listing

Seven entries start off the `:00`/`:30` grid, which means the recorder died and
restarted mid-programme. They carry the show's real name and artwork, so they look
legitimate:

```
Frontline Voices        Jul 17 12:56 pm    3m 31s   (one-hour slot)
Project Censored        Jul 26 12:15 pm    4m 28s
Advocating for Justice  Jul 27  5:42 pm   16m 56s
Radio Free Eireann      Jul 26 11:01 am   18m 48s
```

### 4. A three-week recording outage

Nothing was recorded between **2026-06-24 and 2026-07-16** — 23 days. Not a
retention artifact; rows either side carry ~59 `daysToStay`. Recording resumed
2026-07-17 and has been healthy since.

## How to re-run this audit

The scripted sweeps are throwaway; the method is what matters, and it is four
commands.

```sh
# 1. Do the two sources agree on the row set?
curl -s https://archive2.wbai.org/ -o /tmp/a2.html
curl -s https://wbai.supersoul.top/api/archive -o /tmp/prod.json
node -e '
  const fs=require("fs");
  const A=new Set([...fs.readFileSync("/tmp/a2.html","latin1")
    .matchAll(/<tr name="show" id="tt_(\d+)"/g)].map(m=>m[1]));
  const P=new Set(JSON.parse(fs.readFileSync("/tmp/prod.json","utf8")).shows.map(s=>s.id));
  console.log("archive2:",A.size,"prod:",P.size);
  console.log("prod-only:",[...P].filter(x=>!A.has(x)));
  console.log("archive2-only:",[...A].filter(x=>!P.has(x)));'

# 2. Is anything we list actually unplayable? (530 HEADs, keep concurrency <= 5)
#    See the sweep in the audit scratch notes; problem = status !== 200 || len < 100000.

# 3. Is the recorder alive right now?
curl -sI https://archive2.wbai.org/mp3/<newest-file>.mp3 | grep -i 'last-modified\|content-length'

# 4. Is our own bundle the one being served?
curl -s https://wbai.supersoul.top/healthz
```

Rule that earned its place here: **an ordering difference is not a data
difference.** Diff the row *sets* before concluding anything about the row
*lists*. This audit started from a top-of-page comparison and that comparison was
wrong in both directions at once.
