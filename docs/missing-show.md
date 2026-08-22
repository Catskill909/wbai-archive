# A show is missing from the app — how to find out why

Written 2026-08-08, from the audit of **From The Soundboard** (Tuesdays midnight),
which was absent from the weekly schedule. Kept because the diagnosis path
generalises: every future "why isn't show X here?" is the same five questions in
the same order, and four of the five turned out to be dead ends here.

## Read this before you read any dates: the config cutover

**WBAI's own scheduling tools were misconfigured until late July 2026** — wrong
shows, wrong and new timeslots, wrong artwork. The records were then fixed by
hand, show by show, so the change is a smear rather than an instant.

Archive2 retains ~115 days of rows and `data/feeds.json` accumulates for ever,
so **most of what either source holds describes the OLD, broken setup** — on
2026-08-08 it was 302 of 554 rows, over half. Reading it as the station's current
intent produces confident wrong answers: "this slot has been empty for months"
when the slot did not exist until two weeks ago.

So: **anything older than the cutover is not evidence about how the station is
configured today.** `tools/schedule-audit.js` takes `CUTOVER=YYYY-MM-DD` (default
`2026-07-26`) and files those shows under `no-feed-old` — context, not a job.

The inverse is intentional too: after the schedule is corrected, a retired show
can disappear from archive2's current listing while its feed and earlier audio
remain live. The app keeps those recordings as `source:'feed-only'` archive
history, but excludes them from the derived weekly schedule. A `FEED_DELISTED`
scan notice therefore records lineup turnover; it does not mean those older
episodes should be removed. One retired show is normal context after an update.
Many disappearing at once still deserve investigation because they can indicate a
broken upstream listing or parser rather than a real programming change.

Since 2026-08-22 the scanner encodes that sentence: a scan with one or two
`FEED_DELISTED` changes reports them as routine (no failure mail), and three or
more in the same scan alarm as notable (`DELIST_ALARM_AT` in
`test/feed-scan/scan.js`). The change ended a run of single-retirement failure
mails — the tail of the late-July hand cleanup aging out of archive2's listing —
of which `demnoweve` on 08-22 was at least the third.

The default is inferred and should be confirmed: the Wednesday 3 am rebroadcast
recorded under `soundreb` on Jul 29 (old) and `ftsb` on Aug 5 (new), and `ftsb`
has no Tuesday Jul 28 recording though retention would still be showing one.

## The rule that makes this possible

**The feeds are the only content source** (`server.js`, "podcast feeds"). An
episode reaches the app if and only if a feed describes it; the archive2 scrape
is kept for discovery alone. A feed-less show is not served from the scrape as a
fallback — it is dropped. So "a show is missing" is nearly always "upstream
publishes no feed for it", and the interesting question is *why upstream doesn't*.

That rule is not negotiable to fix a missing show. It is what removes archive2's
invented phantom rows (nine weekly "A Mansion for the Rat" entries running back to
April, `daysLeft` climbing 0, 7, 14, 21…). Restoring a scrape fallback to recover
one show would bring all of those back.

## Don't do this by hand — run the tool

```sh
npm run audit:schedule          # human summary, saves a snapshot
node tools/schedule-audit.js --strict --no-save   # exit 1 only if something is NEW
```

`tools/schedule-audit.js` is this whole afternoon compressed into one command. It
reads three sources — wbai.org's weekly grid (what the station *says* airs),
archive2's listing (what was *recorded*, with the `private` and `getrss` flags),
and the running app's `/api/archive` (what a listener can actually *play*) — and
reports where they disagree, in five kinds:

| kind | meaning |
| --- | --- |
| `no-feed` | archive2 advertises a feed, the app holds nothing. **The Soundboard shape.** Names the likely confessor field. |
| `slot-unheld` | the station lists this slot, we hold no episode of the show |
| `leak` | we hold a show with no `getrss` link upstream — the feed-only rule has been softened somewhere |
| `feed-only` | historical episodes for a show archive2 no longer lists; expected after lineup changes, while a wave can mean a broken scrape |
| `slot-unmatched` | the grid names a show no archive2 row resembles — most often just a spelling difference, so it is reported as *unmatched*, never as *missing* |

It **remembers**: each run writes a snapshot (`data/schedule-audit.json`, atomic,
gitignored) and the next run prints a `NEW` / `RESOLVED` diff against it. That is
the week-to-week view — `RESOLVED` is how you learn a confessor fix actually
landed, without watching for it.

It is deliberately **not** in `npm test`: it hits the network and upstream state
changes hourly. Its parsers and matcher *are* tested offline
(`test/schedule-audit/selftest.js`, 29 checks, in `npm test`).

**What it cannot see:** confessor is password-gated, so nothing reads the
Podcast / Private / "# In Podcast" boxes that ultimately decide whether a feed is
written. The tool's job is to point at the exact show and say which fields to
open. The last step is a human with a login.

**It is polite to upstream:** two page fetches and one local API call, plus a
capped feed probe for anomalies only. Comparing slug *sets* answers "what is
missing" in one request; probing all 127 feeds would be 127 requests at a small
station's server, every run.

## The five questions, in order

1. **Does the app hold any episode of it?** `/api/archive`, group by `sho`.
2. **Does archive2 list it, and with a `getrss.php` link?** That link is what
   `hasRSS` keys off, and `hasRSS` decides which slugs are worth asking for.
3. **Does the feed actually exist?** `/xml/<slug>.xml` **and**
   `getrss.php?id=<slug>`.
4. **Does the audio exist?** The `mp3="…"` on the row's play button.
5. **What does confessor say about the show?** `confessor2.wbai.org/pl_sched.php`
   — the Status and Show Info checkboxes are the ground truth the rest derives
   from.

## What the answers were for `ftsb`

| Question | Answer |
| --- | --- |
| In our app | **No** — 0 of 528 rows |
| Listed on archive2 | Yes — 2 rows, Tue Aug 4 12:00 am and Wed Aug 5 3:00 am, 2:00:03 each |
| Advertises `getrss.php` | **Yes** — so we ask for its feed on every harvest |
| `/xml/ftsb.xml` | **404** |
| `getrss.php?id=ftsb` | **200, zero bytes, `text/html`** |
| MP3 present | Yes — 115,255,000 bytes, HTTP 206, `audio/mpeg` |
| Audio actually recorded | Yes — 30 min in: mean −26.8 dB, max −7.5 dB (silence reads ≈ −90 dB) |
| Confessor | Archive ✅ · **Podcast ✅** · Delete File after Expire ✅ · **Private ✅** · Days to Live 14 · # In Podcast 2 |

Compare a healthy show, `dust`: `getrss.php?id=dust` and `/xml/dust.xml` both
return **the same 10,670 bytes** as `application/xml`, 5 items.

## The cause: `Private`, not `Podcast`

Podcast was already ticked. **`Private` was ticked**, and archive2 renders that
per row — the play button carries `private="1"`.

Across the whole 553-row listing there are **exactly two** such rows, and both
are `ftsb`. (A third textual match is a JS template, `if(private_flag) str += '
private="1"'`, which is itself the proof the attribute is conditional and
per-recording rather than boilerplate.) A single show being both the only one
flagged private and the only one with an empty feed is as clean a correlation as
this listing can offer.

The mechanism is consistent end to end: `getrss.php` is a **passthrough, not a
generator** — for `dust` it returns byte-identical content to the static
`/xml/dust.xml`. So a file has to be *written* by the recording pipeline. With
every retained episode of `ftsb` marked private, nothing is eligible, the file is
never written, `/xml/ftsb.xml` 404s, and the passthrough emits an empty body.
`# In Podcast: 2` against exactly 2 retained-and-private episodes fits.

## The two mechanisms, and which one is retroactive

This is the part worth remembering, because guessing it wrong costs a week of
waiting for nothing. Both halves were established from public data on 2026-08-08,
within an hour of each other.

**The podcast side is show-level and RETROACTIVE.** `soundreb` sat with an empty
feed and one Jul 29 recording. A confessor change published *that already-recorded
episode* the same afternoon — `getrss.php?id=soundreb` went from 0 bytes to 1,971,
and the app harvested it minutes later. So a podcast-side fix reaches back over
whatever is still in retention. **You do not have to wait for the next broadcast.**

**`Private` is per RECORDING and is not cleared retroactively.** At that same
moment `ftsb`'s two rows still carried `private="1"` — after the show's Private
box had been unticked — and its feed stayed empty. Nothing published because
nothing was eligible.

The consequence for `ftsb`: the next recording (Tue Aug 11) should be public and
publish normally, but the Aug 4 and Aug 5 episodes stay invisible unless the flag
can be cleared **on the recordings themselves**, and they expire on schedule
regardless (Days to Live 14; 9 and 10 left on 2026-08-08). Once upstream forgets
them nothing brings them back — `data/feeds.json` only accumulates what we
harvested while it was published.

*(An earlier version of this doc said the fix could not be retroactive at all.
`soundreb` disproved that within the hour. The distinction is which flag.)*

## Resolved: `soundreb`

**From The Soundboard - Rebroadcast** is a separate show record and was a
separate problem: one row (Wed Jul 29 3:00 am), a working mp3, a `getrss.php`
link, **not private**, and an empty feed. Private never explained it, and it is
now fixed — its feed serves 1,971 bytes and the app holds the episode. It is the
worked example of the retroactive half above.

Note the slug migration it reveals: the Wednesday 3 am rebroadcast recorded as
`soundreb` on Jul 29 and as `ftsb` on Aug 5. Both of the show's slots now record
under `ftsb`, so `ftsb`'s Private flag was suppressing the Tuesday *and* the
Wednesday broadcast.

## What the audit ruled out

Worth recording, because each was a plausible theory that the numbers killed:

- **Not a `deriveSchedule()` bug.** The schedule is derived from episodes in
  memory. Every other weekday has a midnight show (Groovelines, La Voz Latina,
  A Mansion for the Rat, Dustbin, Haitian All-StarZ, Midnight Ravers); Tuesday had
  no midnight row *in the data*, so there was nothing to place.
- **Not our harvester skipping it.** `server.js` builds the harvest list from
  every scraped row whose `hasRSS` is set. `ftsb` is in that list and is requested
  every cycle; it 404s. No code change or manual step is needed when the feed
  appears — it lands at the next harvest.
- **Not a recording failure.** The audio is on their server and audible.
- **Not a wider outage.** The slug sets reconcile exactly:

  ```
  archive2 slugs                 140
    advertise getrss             127
    no getrss                     13   → all 13 correctly absent, 0 leaked
  our app                        125   = 127 − 2 anomalies (ftsb, soundreb)
  feed-only slugs today            0
  ```

  Those two are the *only* shows missing. Nothing else was overlooked.

## Reproducing the audit

Parse rows by **splitting on `<tr name="show"` boundaries**, not by matching
`<tr …>(.*?)</tr>`. Each row embeds its own nested table, so a non-greedy match
stops at the inner `</tr>` and silently truncates the body before the play
button — which is exactly how the first pass of this audit reported "0 private
rows" while `private="1"` sat in the file three times. Same disease as
CLAUDE.md §3a: the measurement was clean and wrong, and only a raw
`grep -c 'private="1"'` on the whole document caught it.

Be sparing with upstream. Comparing slug *sets* against `/api/archive` answers
"what is missing" in one request; probing 127 feeds to find out is 127 requests
at a small station's server.
