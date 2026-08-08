# The episode rail

The row of date chips in the show sheet, under the facts line. Added 2026-08-06.

## Why it exists

The archive listing is **episode-level** — one card per broadcast — so tapping a
card opens the sheet on *that* broadcast and nothing in the UI acknowledged that
the show had others. The weekly schedule is worse: a slot can only hand over its
most recent row, so before the rail there was no path at all from "Frontline
Voices airs Wednesdays at noon" to last Wednesday's episode.

## The shape of the problem

Measured against a representative listing (536 rows / 125 shows, 2026-08-06),
grouped the way the app groups them:

| episodes | shows |
| --- | --- |
| 1 | 13 |
| 2–3 | 39 |
| 4–5 | 52 |
| 6–9 | 15 |
| 11–26 | 5 |

So the range is 1 → 26, not "music has 2 and talk has 5". Both ends have to look
deliberate: nothing at all for the 13 singletons, and something browsable for
Democracy Now!'s 26.

## Decisions, and what they are protecting

**A show is a slug, not a title.** `episodesFor()` groups by lowercased `sho`.
`showInfo` and the artwork are keyed by `sho`, so every row in a group renders a
byte-identical header — switching episodes visibly changes only the facts row and
what Play will play, which is what makes the swap feel like a selection rather
than a navigation. Grouping by title instead would fold *What's Going On!*'s
Monday, Tuesday and Wednesday editions — three slugs, three descriptions — into
one wrong list. Lowercased because *Talk Out of School* ships under two slugs
differing only in capitalisation.

**Choosing is not playing.** A chip calls `paintSheet(row, true)` and stops.
Play remains one deliberate tap on the control that has always meant play, and
the default (newest, or whatever card you came from) is still reachable in one
tap from a cold open. This is the rule most likely to be "simplified" away by
someone adding autoplay-on-select; the suite asserts it in capitals.

**Choosing is not playing — so the sheet owes a transport for what already is.**
This is the other half of the rule above, and it was missing until 2026-08-08.
The sheet sits at `z-index:180` and the docked player bar at `80`, so the sheet
*covers* the transport; the sheet's own scrubber was the only replacement, and
`syncSheetScrub()` hid it unless the selected episode was the one loaded. Tap a
second date while listening and the scrubber disappeared, Pause became
`Play · Jul 31`, and the episode still playing had no control anywhere on screen
— and no mark on its chip either, so it was not even findable. Three fixes, all
of which must stay:

- **The rail says which chip is the sound in the room.** `.ep.playing` draws an
  equaliser (teal, `--accent-2`), taking precedence over the progress bar and the
  tick — while an episode is playing, that is the only thing about it worth a
  mark. Selection stays orange. Two questions, two colours, never the same ink:
  teal is *what you hear*, orange is *what Play would play*.
- **The scrubber tracks the audio element, not the selection.** `sheetShowRow()`
  keeps it alive for any episode **of this show** (and only this show — a sheet
  open on show A while show B plays is the case the ✕ already describes).
- **A stand-in strip** appears only when the loaded episode is not the selected
  one: pause/resume, `Playing · Aug 7`, and the label is a button back to that
  episode, so a wrong chip tap costs one tap. It is outlined and teal on purpose.
  **There is exactly one filled orange button on screen at any time** — the strip
  reports a fact, the button makes the only offer. The suite counts them in
  painted colour.

Two things that were considered and rejected: a confirmation dialog (a fourth
stacked layer guarding an action that is one tap to undo and loses no position —
`playTrack()` calls `resumeRemember()` first), and autoplay-on-select, which
breaks the rule directly above and fires a multi-megabyte fetch from a tap that
reads as browsing.

**`replaceState`, never `pushState`.** Same reason the filters don't push (see
`urlFor`/`syncUrl` in `app.js`): Back must keep meaning "close the sheet", not
"undo six chip taps". The URL still follows the selection, so a shared link names
the exact episode.

**The rail is pinned in the footer, between the links and Play.** It shipped in
the scrolling body, under the facts, on the reasoning that the footer's height
should not vary with a show's episode count. On a real iPhone that was simply
wrong: the sheet opens with the rail **below the fold**, so the feature is
invisible unless you already know to scroll for it — which defeats the entire
point of adding it. Corrected the same day it shipped.

The original worry doesn't survive contact either: the rail is *one row of
chips* whether a show has 2 or 26, so it adds a fixed ~78px, not a variable
amount. The one case that does vary is "All N" expanded, and that is capped
(`min(30dvh, 190px)`) precisely because growing the footer now shrinks the body
above it.

Order within the footer is deliberate: links (least important, furthest from the
thumb), then the choice, then the action the choice feeds.

**Play carries the chosen date, but only when it isn't the default.** Once the
rail has scrolled out of view behind a long description, the pinned Play button
is the only place the choice can be read, so it says `Play · Jul 28`. On the
newest episode it stays `Play episode`: a date there would put a label on 125
shows to serve the few where it means anything. `sheetEpAlt` drives this, and
only the sheet renders a `.play-label`, so no card button can pick it up.

**One layout at every width.** A single horizontally scrolling row: with four
chips on a desktop it simply reads as a row of chips and never scrolls; with
twenty-six it swipes. Above six it also offers "All N", which wraps *the same
chips* into a grid — one unit to learn, no second markup mode. Two behaviours
behind a breakpoint would be a second thing to reason about for no gain.

**What you have already heard** is the reason this is a rail and not a dropdown.
A teal bar shows how far into an episode you got; a tick means you finished it.
A closed `<select>` can show neither.

## The `done` marker

Finishing an episode used to call `resumeForget()`, which made a show you had
heard indistinguishable from one you had never opened. It now writes
`{t:0, d, at, done:1}` instead (`resumeDone()`). `resumeFor()` still reads 0 for
it — `t` is below `RESUME_MIN` — so nothing about resuming changed. "Start over"
clears it via `resumeForget()`, because starting over is a claim to be listening
again. Entries count toward `RESUME_MAX` like any other.

## Two traps that were live in this code

**`offsetTop`/`offsetLeft` are measured from the nearest *positioned* ancestor.**
`scrollEpIntoView()` reads them, and without `position:relative` on `.eps-rail`
they resolve against `.sheet` — which scrolled the expanded grid to the wrong
row. The first version of this suite checked visibility with `offsetLeft` too and
therefore passed while the bug was on screen. It now measures with
`getBoundingClientRect()`, which is an independent instrument. (CLAUDE.md §3a.)

**The CSP voids inline `style=""` attributes**, not just injected `<style>` tags.
The app is served `style-src 'self'` with no `unsafe-inline`, so the percentage
on each progress bar goes through CSSOM (`el.style.setProperty`). Verified in the
browser on 2026-08-06: a `style` attribute setting `color` computes to the
inherited value, i.e. it is discarded silently. The same check found that the
weekly schedule's `style="--cat:…"` had *never* applied — its category hover edge
was rendering the fallback colour since the feature shipped. Fixed in the same
commit (`schedApplyCatColour()`).

## The scroll hint

Pinning the rail made the body shorter, which made an old problem visible: on a
phone the facts row and the retention badge sit just under the fold, and a
silently clipped line reads as *missing* rather than as scrolled-away. So
`syncSheetFade()` fades whichever edge still has content past it, and only that
edge — `.fade-top` / `.fade-bottom` on `.sheet-body`.

The mask goes on the **scroll box**, not on the content, so it stays at the
box's edges while the content moves under it. It is recomputed on scroll, on
resize, on every paint, when the description clamp is toggled, and when "All N"
expands — all five change what is hidden. Through classes, never a `style`
attribute, which this app's CSP discards (see below).

## Tests

`test/episode-rail/run.sh` — headless Chrome against the running app, 82 checks
at desktop and phone widths. The transport section streams a real episode with a
synthesized click (a programmatic one would be refused by the autoplay policy)
and asserts what reaches the viewport: rendered box heights, the audio element's
own `paused`/`currentSrc`, and the count of buttons *painted* `--accent`. Fixtures are **derived** from whatever the listing
currently holds (`pickFixtures()`), never hardcoded: every episode id rotates out
within its retention window, so a written-down id is a test that fails for the
wrong reason in two months. Includes a self-test that strips the mark classes and
requires the probe to notice, because a suite full of "this mark is absent"
assertions passes perfectly once the probe goes blind.
