# A show is missing from the app — how to find out why

Written 2026-08-08, from the audit of **From The Soundboard** (Tuesdays midnight),
which was absent from the weekly schedule. Kept because the diagnosis path
generalises: every future "why isn't show X here?" is the same five questions in
the same order, and four of the five turned out to be dead ends here.

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

**Ticking the box off does not fix the episodes already recorded.** The flag is
per-recording, and a fetch taken *after* the setting was saved still shows
`private="1"` on both existing rows. Expect the fix to take effect on the **next
recording** (Tue Aug 11, 12:00 am ET), not retroactively — and the two existing
episodes to age out unharvested (Days to Live 14; they had 9 and 10 days left on
2026-08-08). Once upstream forgets them nothing brings them back, because
`data/feeds.json` only accumulates what we harvested while it was published.

## Still open: `soundreb`

**From The Soundboard - Rebroadcast** is a *separate* show record and a separate
problem. One row (Wed Jul 29 3:00 am, 2:00:04, 3 days left), a working mp3, a
`getrss.php` link — and **not private**, yet its feed is empty too. Private does
not explain this one. Check its own confessor record: most likely its Podcast box
or its `# In Podcast` count, neither of which is visible from outside.

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
