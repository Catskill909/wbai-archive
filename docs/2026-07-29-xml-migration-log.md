# 2026-07-29 — the day the scrape stopped being the source

A working log. The reference docs say what the system *is*; this says what was
actually found, what was got wrong, and why the code looks the way it does.
Written the same day, so the numbers are a snapshot — re-measure before quoting
any of them.

Companions: [xml-feed-migration.md](xml-feed-migration.md) (the design),
[archive-source-audit.md](archive-source-audit.md) (upstream defects, including a
section written for Pacifica's developer).

## It started as "our site is showing episodes archive2 doesn't have"

It wasn't. The two held the *same* rows all along.

archive2's page is **not** air-date sorted: 532 of 539 consecutive row pairs
descend correctly, but records created since the last sort are **appended in
ingestion order** rather than merged into place. Record id 88879 — one of the
newest in the system — sat at document position **516 of 540**.

The practical effect is that yesterday's programming is invisible on their page.
Reading from the top you get Out-FM (Jul 28 21:00) followed immediately by
Democracy Now (Jul 28 08:00); the eleven shows between them are parked past the
April rows where nobody scrolls. Our site sorted by date and showed them, which
read as inventing shows.

**Lesson, and it cost hours: an ordering difference is not a data difference.**
Diff the row *sets* before concluding anything about the row *lists*. The
investigation started from a top-of-page comparison and that comparison was wrong
in both directions at once.

## Then: the feeds were alive

`UPSTREAM.md` recorded the per-show RSS feeds as **dead** — correct when written
on 2026-07-26, and wrong two days later. Every RSS link on the listing returned
valid, current podcast XML. That reopened the whole question and became the day's
work.

## What shipped

Content now comes from `archive2.wbai.org/xml/<slug>.xml`. The HTML scrape
supplies structure — identity, category, retention, artwork, page order — and
fills episodes older than a feed's window. Details in
[xml-feed-migration.md](xml-feed-migration.md).

The rogue rows this removed were never filtered for deliberately. They fell out:
archive2's scheduler invents rows (nine weekly "A Mansion for the Rat" entries
back to April, `daysToStay` counting 0, 7, 14, 21 …), and those shows had no
feed. **The invented rows and the feed-less rows were the same rows.**

## Four things I got wrong

Kept because each was plausible, and the reasoning that produced them will look
reasonable again.

**1. "`hasRSS` is a perfect predictor."** Measured across all 131 slugs that
morning: 98 true → 98 working feeds, 33 false → 33 404s, zero exceptions. So
`applyFeeds()` gated publication on it. By the afternoon archive2 was rendering
podcast-XML buttons on 21 shows whose feeds 404 — several of them music
programmes that *cannot* be podcast for copyright reasons — and 14 phantom
"Mansion for the Rat" rows walked back into production, one at position 2.

> A correlation measured once is not an invariant. This one was verified across
> 131 cases with no exceptions and broke the same day. **Trust the fetch, not the
> markup.**

**2. Gating per episode instead of per show.** Because a feed publishes only its
most recent five, this silently deleted 89 older episodes of shows whose feeds
were perfectly healthy. The item count is a display setting on WBAI's side, not a
statement about what exists.

**3. "A real broadcast starts on the :00 or :30."** Written against seven
fragments, all of which fit. As a rule it hid a 52-minute Democracy Now (08:07),
a 45-minute Early Morning Mondays (07:14), and "Living for the City" (11:13,
45m45s) — the last of which is how it was found, because it was missing from the
site. Length is the honest test: WBAI's shortest scheduled format is 30 minutes
and nothing falls between 5 and 15, so a 20-minute floor sits in empty space.

**4. Recommending `SHOW_RSS` be flipped on.** It reads `false` because episode
access deliberately stays inside the apps. The dead feeds were a parenthetical in
that decision, which I mistook for the reason. Advice to reverse a product
decision, dressed up as a cleanup.

## Two upstream surprises

**WBAI added 21 feeds while this was being written.** Live feeds went 98 → 101 →
122 within the hour. Newly-fed shows were invisible until the next harvest, which
is why `catchUpFeeds()` exists.

**A feed advertised is not a feed that exists**, and the gap moves in both
directions. `test/feed-scan/` now tracks the claim beside the reality
(`CLAIM_MISMATCH`, now `FEED_DELISTED`) precisely because nothing else would have
caught the regression above.

## Operational notes

- **Scheduling could not run locally.** This repo lives under `~/Desktop`, which
  macOS protects with TCC: a launchd or cron job cannot read it at all
  (`head: …/package.json: Operation not permitted`) without Full Disk Access
  granted to `/bin/sh` — a wildly disproportionate permission for a script that
  reads one public website. The scan runs on GitHub Actions instead, which also
  means it runs when no machine is awake.
- **A blind feed sweep is cheap per request and expensive in aggregate**: all 122
  feeds conditional = 16.7 KB, every one a `304`. At 5-minute cadence that is
  35,000 requests/day at a small station. The scrape already knows each show's
  newest air date, so only feeds that are *behind* get fetched — usually zero.
- **Mobile reload restored scroll position** into a list that renders 40 rows and
  appends on scroll, landing people in blank space. `history.scrollRestoration =
  'manual'`, set from the parser-blocking `<head>` script because `app.js` runs
  too late to prevent the jump.

## Still open

- **The 20-minute floor drops one real segment.** When the recorder fails
  mid-programme and resumes, one broadcast lands as two rows and a short first
  half is indistinguishable from a fragment. Three such splits exist; the floor
  costs 17 minutes of Katie Halper (2026-07-22). If it ever costs more, detect
  the pattern — two rows, same show, same day, the second starting near where the
  first ended — rather than lowering the number and letting real fragments back in.
- **Coverage is a dial WBAI controls.** Raising the episodes-per-feed setting and
  adding feeds for the remaining shows would retire the scrape entirely. The ask
  is drafted in [xml-feed-migration.md](xml-feed-migration.md).
- **The persistent volume still isn't mounted** in production
  (`storage.showinfoOnDisk: 0`). Costs nothing visible; noted in
  [DEPLOYMENT.md](DEPLOYMENT.md).
