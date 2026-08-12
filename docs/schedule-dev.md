# schedule-dev.md — a schedule view derived from data we already hold

**Status: SHIPPED (Phases 0–2), Phase 3 part-done.** The view is live: derived
weekly template, day tabs, on-air highlight, Listen Live. What is still open is
the offline `deriveSchedule` suite — see §6 Phase 3, and §7 for the decisions
that changed once it was in real hands.

Started 2026-08-05. Built 2026-08-06.

---

## 0. The idea, in one paragraph

WBAI's own schedule page (wbai.org/schedule) is the classic old-school radio
grid: a 7-column pixel-positioned table, unusable on a phone. We are **not**
wrapping or scraping it. The insight is that *our archive already is the
schedule*: every recorded show carries a start timestamp (`dt`), shows are
consecutive, and artwork / host / category / descriptions are all already
flowing through the app. Reshape the rows we already fetch into a weekly
template, present it as a clean tabbed mobile-first view in the app's own
aesthetic — modal off the hamburger menu for now, permanent placement decided
later once the design is proven.

---

## 1. Data audit — the schedule is recoverable from `/api/archive` alone

Measured 2026-08-05 against a live local server (535 rows, ~120 days of
history):

- **145 distinct (weekday, start-time) slots** fall out of bucketing `dt` by
  weekday + wall-clock time in `America/New_York`. Monday alone yields a
  complete 1 am–midnight day. Coverage is essentially the full week.
- **Every field the UI needs is already on the row**: `title`, `cat`, `sho`
  (slug), `host`, `photo`, `length`, `id` (which is exactly what
  `openSheetById` wants).
- `/api/nowplaying` gives the ON AIR / up-next marker; the showinfo + program
  directory + per-show-detail pipeline gives descriptions — all existing.

### 1.1 Wrinkles the derivation must handle (all observed in real data)

| Wrinkle | Evidence | Handling |
| --- | --- | --- |
| `dt` is the *recording* start, not the slot | Mon `07:14` Early Morning Mondays; CLAUDE-documented DN! at 8:07 | Snap starts to the :00/:30 grid within a tolerance (~20 min) |
| Alternating shows share a slot | Mon 18:00 is *BreakThrough News* some weeks, *Chris Hedges Report* others; same at 07:00, 12:00, 17:00, 21:00 | Keep every distinct show seen in a slot recently; present as "alternates", don't let most-recent-wins hide one |
| `durationSec` is 0 on `source:'listing'` rows | 101 of 535 rows | Parse the `length` string ("1:00:03") — always present |
| Feed-only rows are not part of WBAI's current listing | `source:'feed-only'` contract in server.js | Exclude from derivation |
| Specials / preemptions | `cat:'special'`, fundraising weeks | Recent-weeks window + snapping absorbs most; accept imperfection, this is a *derived* schedule |
| Split recordings (recorder died mid-show) | documented fragment handling in server.js | Two rows share a slot with short durations; slot start dedupe handles it |

### 1.2 Derivation sketch (pure function: rows → weekly template)

```
rows (source !== 'feed-only')
  → per row: weekday + wall-clock start in STATION_TZ, duration from `length`
  → snap start to 30-min grid
  → bucket by (weekday, slot)
  → within a bucket, group by show slug:
      one slug            → regular weekly show (carry most recent row)
      multiple slugs      → alternates (carry each slug's most recent row)
  → drop occurrences older than N weeks (open: N=6?) so lineup changes age out
  → sort each day by slot → a 7-day template
```

Each schedule entry keeps the **row `id` of its most recent episode**, which by
construction exists — so tapping an entry can open the existing show sheet with
zero new modal plumbing.

*Open:* exact snap tolerance and recency window need a spike against real data
(Phase 0), not guessing.

---

## 2. Where it computes: client, not server (for now)

The client already holds every row the derivation needs — it fetched
`/api/archive` to draw the front page. Deriving in `public/` means:

- **zero new endpoints, zero server.js changes, zero restarts** (§2 of
  CLAUDE.md never triggers);
- the schedule is never staler than the listing it sits next to;
- the derivation is a pure function, which makes it trivially testable offline.

A server-side `/api/schedule` only earns its keep if we later want history
longer than the retention window or cross-deploy memory of lineups. Noted as a
possible Phase 4+; not now.

---

## 3. UX shape

### 3.1 Entry point (decided for the building stage) — **SHIPPED, with a change**

The hamburger drawer's **Schedule** item currently opens
`https://wbai.org/schedule/` in a new tab (index.html, Listen group). It
becomes the trigger for the in-app schedule modal — same pattern as the Donate
item: intercept the click, open the modal, **keep the real href** as the
fallback if the listener never runs and so open-in-new-tab / copy-link keep
working. Permanent placement (own URL? hero link? tab?) is deliberately
deferred until the design is proven in use.

**What shipped:** exactly that, plus a second entry point — a **Schedule chip in
the appbar**, next to Listen Live and styled as its peer (`.on-air-btn
.sched-open-btn`, calendar glyph where Listen Live has its status dot).

It is **desktop/tablet only**: below 480px it is `display:none` and the drawer
is the only way in. Two reasons, in order — an icon-only chip (the only version
that fits a 320px row; a labelled one overflowed it by ~55px, measured) tells a
first-time visitor nothing, and the appbar is about to carry more than one new
destination. Phones wait for a real navigation design rather than getting a
mystery glyph now. **The touch suite depends on this**: it opens the schedule
via the drawer, because at 390px a `p.click('#scheduleBtn')` would throw.

### 3.2 The modal, mobile-first

*(Shipped. Where reality diverged from this plan, the divergence is marked and
explained in §7 — read that before "fixing" anything back to the plan.)*

- **Day tab strip**, today preselected. Horizontal, thumb-reachable,
  the tab pattern that replaces the 7-column grid. **Not Sun–Sat as planned:
  it starts at today and runs forward** — see §7.1.
- Below it, a **vertical timeline of that day**: time on the left, show
  artwork + title + host on the right — the same row aesthetic and category
  colours the listing already uses. No pixel grid anywhere.
- **ON AIR NOW**: on today's tab, the current show (from `/api/nowplaying`)
  gets a live marker, and opening the modal scrolls to it — "what's on right
  now" is the #1 question a schedule answers. Shipped, and it **re-resolves on
  every 15s now-playing poll**, so the highlight walks from show to show while
  the modal sits open. The scroll-to only runs on paint (open, tab switch),
  never on the poll — yanking a reading user's scroll position every 15s would
  be its own bug. It stops ~56px short so the previous slot peeks in and the
  list doesn't look like it starts there. Marker and Listen Live are toggled
  **in place**, never by re-rendering, so scroll position survives.
- **Alternates** render stacked in their slot ("alternates weekly"), both
  tappable.
- **Tap a show → the existing show sheet** (`openSheetById` with the carried
  row id): description, host, artwork, play — all free. A schedule-specific
  card (airtimes, next broadcast) is a possible later phase, not Phase 1.
- Desktop: same component, wider — either the day-tab view centered, or a
  7-column week at ≥ some breakpoint. *Open; mobile is the design target.*

### 3.3 Overlay mechanics — follow the house rules, all of them

This is an overlay in an app with a documented history of overlay bugs. It
must behave like the sheet does:

- scroll lock + `refreshOverlayState()` (and read **touch-dev.md** before
  touching any of it — assert the *effect*, not the declaration);
- a history entry so Back closes it, same shape as the sheet's
  push/replace/popstate dance;
- focus moved in on open, restored on close, Escape closes;
- `aria-modal` dialog semantics, day tabs as a proper `tablist`;
- **no interaction with the audio elements whatsoever.** The schedule reads
  `nowplaying` and opens sheets; it never touches playback. (Playing live from
  the ON AIR row would go through the existing live-player entry point if we
  ever add it — see live-audio-pattern.md — *open, not Phase 1*.)

**Still true after Listen Live shipped, and it must stay true.** The button on
the on-air card calls `openLivePlayer()` — the existing entry point, exactly as
anticipated above. It does not construct, reuse, or touch an `<audio>` element,
and it must never start doing so; the live element is built and thrown away per
play (live-audio-pattern.md). The schedule's whole audio surface is that one
call.

Two overlay rules this feature had to learn the hard way — both were real bugs,
see §7.2 and §7.3:

- **A modal that closes without going through history must clear its own
  history flag.** Otherwise the entry survives, still claiming the modal is
  open, and a later Back re-opens it.
- **The docked player bar stays reachable under this overlay** — it is the one
  overlay you browse *while listening*, so it must not bury the transport.

---

## 4. What we are explicitly NOT doing

- **Not scraping `pub_sched.php`** (the upstream grid). The server already
  fetches it once for artwork-id harvesting (`fetchPhotoMap`), and that is all
  it is good for: day = pixel `left` offset, time = pixel `top`. Parsing
  geometry to recover semantics is the kind of upstream coupling UPSTREAM.md
  exists to warn about, and it adds nothing our own timestamps don't have.
- Not adding a database, an endpoint, or an env var. (This repo is a template;
  a derived client-side view is the cheapest thing every station gets for
  free.)
- Not building a second modal system. One sheet, one drawer, one live player,
  one schedule modal — all obeying the same overlay rules.

---

## 5. Open questions — 1–3 ANSWERED by the Phase 0 spike (2026-08-05)

1. **Window = 6 weeks, snap tolerance = 20 min.** Measured: 529/535 rows start
   *exactly* on the :00/:30 grid; the other 6 are 6–14 min off, so a 20-min
   snap captures everything. 4w and 6w windows produce identical templates
   (135 slots, 21 alternate slots); 8w+ resurrects stale lineups (34 alt
   slots). 6w is the same answer as 4w with more headroom for preemption weeks.
2. **No meaningful holes.** Every weekday derives ≥ 1380 of 1440 minutes; the
   one real gap is Wed 3–5 am (2h). The UI simply lists the next entry — gaps
   need no rendering.
3. **Midnight: assign to start day, never split.** Every late show observed
   ends exactly at 24:00.
4. Desktop layout: wide single-day vs full week. *(still open)*
5. "Alternates" copy — what does the listener-facing label actually say?
   *(still open)*
6. Does the ON AIR row offer a Listen Live button in Phase 2+ (via the existing
   live entry point) or stay informational? *(still open)*

Two extra spike findings that became derivation requirements:

- **Duplicate-slug shows**: "Talk Out of School" airs under two slugs differing
  only in capitalisation, so slug-grouping alone reports a false alternate.
  Dedupe alternates by normalised title as well as slug.
- Upstream encodes alternation *in titles* ("Eco-Logic alternates with Green
  Street Radio") — evidence the structural alternates model matches how the
  station actually schedules.

---

## 6. Phases

### Phase 0 — spike the derivation (no app code) — **DONE 2026-08-05**
A throwaway script against live `/api/archive` ran the §1.2 sketch, printed the
full week, listed every alternate slot and every gap. Findings recorded in §5;
the derived week read as a correct WBAI schedule by inspection. Script deleted.

### Phase 1 — derivation module + modal shell — **DONE 2026-08-06**
- `deriveSchedule(rows)` as a pure function in `public/` (loaded with app.js;
  it must never affect playback, but it is UI, not tracking — it belongs in
  the main bundle, unlike track.js).
- Modal markup in `index.html`, opened from the drawer's Schedule item (href
  kept as fallback), full overlay mechanics per §3.3.
- Day tabs + vertical day list, today preselected. Tap → existing sheet.
- **Done means:** derivation matches Phase 0 output; modal obeys scroll-lock /
  history / focus rules; `healthz` version checked after every `public/` edit
  (CLAUDE.md §1).

### Phase 2 — the "now" layer + polish — **DONE 2026-08-06**
- ON AIR marker from `/api/nowplaying`, auto-scroll to now on today's tab.
- Alternates presentation, category colours, reduced-motion, dark/light theme
  pass, empty/failed-fetch state (schedule derives from rows already in
  memory, so the failure mode is the listing's failure mode).
- Plus, not originally planned: Listen Live on the on-air card, the appbar
  entry point, and the phone-width layout pass in §7.

### Phase 3 — tests, same commit discipline — **HALF DONE**
- **STILL OPEN — `test/schedule/`: offline suite for `deriveSchedule`** — feed
  it a frozen rows fixture (including a :14 start, an alternate slot, a
  listing-source row with `durationSec:0`, a feed-only row) and assert the
  template. Added to `npm test` **in the same commit that writes it**
  (CLAUDE.md learned this the hard way on 2026-08-05).
  **Blocker to know about before starting:** `deriveSchedule` lives inside
  app.js's IIFE and is not exported, so there is nothing for an offline suite
  to `require` yet. Either lift it into its own `public/` file that app.js
  consumes (mind the version-stamping in server.js — index.html stamps
  `app.js`/`styles.css` only), or drive it in-page over CDP. The first is
  cleaner and is what §6 Phase 1 originally imagined ("a pure function in
  `public/`"); it just was not done that way.
- **DONE** — overlay assertions in the touch suite: the page must not scroll
  behind the open schedule, and a self-test strips the lock mid-run and
  requires the probe to notice, so the PASS cannot go quietly blind
  (touch-dev.md §3a). Opened via the drawer — see §3.1 for why not the chip.

### Phase 4 — placement decision
Live with it, then decide: stays a modal, gets its own URL, or joins the main
nav. Also revisit whether a server-side `/api/schedule` (longer memory,
cross-deploy lineups) earns its complexity. Out of scope until the design has
been used. **Partly forced early:** the appbar chip is desktop-only precisely
because this decision has not been made — see §3.1.

---

## 7. What changed once it was real (2026-08-06)

The plan above survived contact mostly intact. These are the places it didn't,
each with the reason, so nobody "corrects" the shipped behaviour back to the
plan without knowing what it cost.

### 7.1 Day tabs start at TODAY, not Sunday

§3.2 said "Sun–Sat, today preselected". Shipped: the strip is rotated so today
is the **first** tab, labelled **"Today"**, with the rest of the week running
forward from it.

A calendar-shaped strip buries today mid-row on five days out of seven and
spends its leading, most thumb-reachable slots on days that have already
aired. Nobody opens a radio schedule to find out about last Sunday.

Two things this must not break, both easy to get wrong:

- `SCHED_DAYS` stays **Sunday-first**. It keys the derived week
  (`deriveSchedule`), and rotating it would silently mis-key every slot. The
  rotation lives in `schedTabDays()` and is *display only*.
- **Arrow-key nav walks the displayed order**, not `SCHED_DAYS`. Left/right
  that jumped across the visible strip would be its own bug.

### 7.2 The Back button could strand you

`openSchedule()` pushes a `{sched:1}` history entry. Listen Live once closed the
modal with `dismissSchedule()` — the *visual* close — which left that entry
behind still claiming the schedule was open. Open the schedule a second time
and there were two such entries stacked: **Back landed on the stale one and
re-opened the schedule instead of closing it.** Back looked dead.

The current handoff transfers that entry in place from `{sched:1}` to `{live:1}`
before swapping surfaces. Back remains exactly one press from Live to the page,
there is no stale schedule claim, and no duplicate plain-page entry is left
under Live. This is still chosen over `closeSchedule()` because its asynchronous
popstate would interfere with the focus handoff.

**The general rule, worth applying to any future overlay here:** if you close a
modal *without* going through history, clear its history flag in the same
breath, or the entry outlives the modal and lies about it.

### 7.3 The schedule must not bury the player bar

Every other overlay in this app is a task you finish and leave, so covering the
docked bar is fine. The schedule is the one you browse **while listening** —
so burying the transport strands the listener, and "minimize" in the live
player or the info sheet hands back a bar that cannot be seen or reached.

Measured before fixing, and it was worse than it looked — the bar was
unreachable on *both* breakpoints, for two different reasons:

| | before | after |
|---|---|---|
| phone | the sheet physically covered the bar | sheet ends at `bottom:var(--player-h)` |
| desktop | modal already cleared the bar, but the `inset:0` **scrim** ate the clicks | bar lifted above the scrim |

So: `body.sched-open .player-bar{ z-index:166 }` — above the modal (165), still
below the info sheet (170/180), which is opened *from* the schedule and should
keep covering it. `--player-h` is app.js's measured bar height and is `0px`
when no bar is up, so the phone rule needs no separate no-player case.

The desktop CSS had been *reaching* for this all along (`body.has-player
.sched-modal` shortens the modal to leave the bar's strip clear); it simply
never worked, because nothing had ever hit-tested the bar.

### 7.4 One live marker per card, not two

The card briefly carried both a "LIVE" badge next to the title *and* a Listen
Live pill. Two competing live markers on one row, and on a phone they squeezed
the title down to a single letter ("E" for *Equal Rights and Justice*). The
badge lost: the pill's own pulsing dot already says on-air, and it is the one
you can act on.

### 7.4b The on-air row asks now, instead of guessing *(2026-08-06, later)*

§7.4 settled on the Listen Live pill as the row's single live marker. Real use
found the harder half of that decision, which the pill had not solved: the
on-air card had **two destinations and only one of them was named.** The pill
said Listen Live; tapping anywhere else on the same card silently opened the
archive sheet instead. Same surface, two outcomes, an invisible boundary
between them — and the archive one entirely unlabelled.

The first fix was to name both: a second "Past episodes" pill beside the first,
with the card body doing exactly what that pill did, so every invisible target
duplicated a visible one. It worked, and it was wrong — two pills in a row that
§7.5 had *already* had to stack for lack of width.

**What shipped instead: the row asks.** The on-air card wears a small Live
badge and the WHOLE card opens a chooser — "Listen Live", "Past episodes",
"Cancel". Every other row still goes straight to the sheet, because a single
destination has nothing to ask about.

Three things to keep if you touch this:

- **The badge is a badge, not a button.** The whole card is the target. A second
  control inside it would re-draw exactly the invisible boundary this removed.
- **The chooser carries no history entry.** It is a question, not a place, so
  Back still belongs to the schedule. That means it must close itself on
  `popstate` and in `dismissSchedule()`, or it is left floating over a dialog
  that has gone.
- **The Live answer transfers `{sched:1}` to `{live:1}`** on its way out
  (§7.2). Clearing without transferring would leave Live without its Back route;
  failing to replace would revive the original stale-schedule bug.

`test/schedule/` holds all of it — 32 checks, including that a tap anywhere on
the card opens the chooser and that nothing in this dialog ever starts audio.

### 7.5 Phone widths, measured rather than guessed

- **Day-name breakpoint was wrong.** Three-letter names cut over to single
  letters at 420px — which lands *between* the two current iPhone Pro sizes, so
  a 402px Pro showed "M T W" while a 440px Pro Max showed "Mon Tue Wed", for no
  reason a user could see. The widest label ("Today") needs 32px and a tab has
  41px of room at 402px: it fits comfortably. Cut moved to 344px, with slightly
  tighter tab padding below 430px for margin.
- **Time column** was 4.6rem + 0.9rem gap — right for a 680px desktop modal,
  dead space on an edge-to-edge phone sheet. Now sized to "12 PM", the widest
  label it can hold.
- **The live card no longer has to stack on phones.** Thumb + title + pill never
  fit one line, so the pill used to drop to its own. The pill is a small badge
  now (§7.4b) and shares the line, which is most of why the chooser was the
  better answer than a second pill.

### 7.6 A testing trap specific to this app

**The CSP is `style-src 'self'` with no `unsafe-inline`, so an injected
`<style>` element is silently ignored.** Two separate measurements here were
quietly wrong because of it — a probe that toggled `display` to measure label
widths, and a self-test that tried to disable the fix to prove the probe still
had teeth. Both *looked* like passes.

If you need to change styles at runtime from a test, go through CSSOM
(`el.style.zIndex = '80'`), which CSP does not block. And treat a suspiciously
clean result from an injected stylesheet as a bug in the test until proven
otherwise.

### 7.7 "Alternates weekly" was also how a REPLACED show looked *(2026-08-07)*

`deriveSchedule` buckets six weeks of rows by (weekday, slot) and keeps every
show that appeared in each bucket. Two shows in one bucket was rendered as
**"alternates weekly"** — which is true for a fortnightly slot, and completely
wrong for a slot whose lineup simply *changed*. Nothing in the derivation could
tell those apart, so every show WBAI dropped or moved went on haunting its old
slot with a label claiming it still airs there.

WBAI's schedule changed in late July 2026 and made this impossible to miss —
**21 of the derived slots carried two shows.** Sunday is the clean proof, three
consecutive weeks in the data:

| | 07-19 | 07-26 | 08-02 |
|---|---|---|---|
| 09:00 | Radio Forum | Animal Matters | Animal Matters |
| 13:00 | Any Day | WBAI Sports | WBAI Sports |
| 18:00 | Deadline NYC | Rick Smith Show | Rick Smith Show |
| 24:00 | All Mixed Up | Groovelines | Groovelines |
| 02:00 | — | All Mixed Up | All Mixed Up |

One lineup, then two straight weeks of a different one. That is a cutover, not
an alternation — and All Mixed Up is the tell: it kept Sun 00:00 on the strength
of a single airing on 07-19, having since aired twice at 02:00.

**`schedDropStale()` drops a challenger** (never `shows[0]`, the incumbent) on
any of three tests:

- **moved** — the show has aired *more recently in a different slot*. A real
  alternate's newest airing is the one in this slot; a show that moved has a
  newer one in its new home. This is what catches a move in the same week it
  happens.
- **stale** — it trails the incumbent by `SCHED_STALE_SEC` (14 days). A
  fortnightly alternate trails by exactly 7 and survives. A replaced show falls
  a further week behind every week, so this **self-heals**: there is no list of
  dead shows to maintain, and none to forget to update.

- **once** — it has aired in this slot exactly once. One observation is not a
  pattern; a fortnightly alternate airs ~3 times inside the six-week window.

This third test was deliberately **left out** at first, reasoning that a real
alternate whose feed retained a single post-outage episode is indistinguishable
from a dropped show, and that deleting a live show is the worse failure. §7.10
is what changed that: the station's own calendar shows no alternating slot
anywhere, and no slot in our data holds two shows that have *each* aired more
than once. "Seen once" was carrying every false alternate and no true one.

It stays self-correcting: a slot that genuinely begins alternating shows its
second airing two weeks later and returns on its own. **Keep that property.** The
moment this needs a hand-maintained list of dead shows, it is wrong.

Result on the live data, measured in the browser across five builds:
**21 shared slots → 10 → 3 → 1 → 0** as `stale`/`moved`, then odd-day exclusion
(§7.10), then `once`, then shared identity (§7.11) each landed. Zero is the
correct answer: it matches WBAI's published schedule exactly. Day slot counts
were unchanged throughout (16/22/22/21/20/19/15), so nothing was emptied — only
the duplicate stacking removed.

### 7.8 How little evidence the derivation actually has

Upstream serves **at most five items per feed** (84 of 125 feeds sat at exactly
five on 2026-08-07). Until that same day `fetchFeed` *replaced* `items` on every
fetch, so the app held five episodes per show and nothing older — §7.7's rules
were designed against exactly that. It accumulates now (`mergeFeedItems`, see
[UPSTREAM.md](UPSTREAM.md)), but the depth it has accumulated only starts from
the day the merge shipped, so treat the notes below as live for a good while yet.

Three consequences for this file:

1. **A six-week window does not mean six weeks of evidence** — not yet. A daily
   show's five items cover five days; a weekly show's cover five weeks *if it
   aired every week*. Any rule that counts airings is still counting feed
   retention as much as it is counting broadcasts.
2. **This gets better on its own, and §7.7 gets sharper with it.** Once the
   store holds several months, "did this show air here last fortnight or not"
   becomes an answerable question rather than an inference from five items, and
   the `stale` heuristic could be replaced by actually looking. Don't tighten
   those thresholds until the history is there — check how far back
   `data/feeds.json` really reaches before assuming it is.
3. **There is a real hole in the data: 2026-06-24 → 2026-07-16**, zero episodes
   across all 125 feeds. WBAI's archive recorder was down for ~3½ weeks. It is
   not a harvest failure and it is not recoverable — the proof is that feeds
   fetched on 2026-08-07 still listed June episodes (Black Star News: 06-02,
   06-09, 06-16, 07-21, 08-04), which a five-item feed could not do if anything
   had aired in between. Expect it in the studio's air-date histogram forever;
   it is not a bug report.

### 7.9 There is a published schedule grid, and we read only its pictures

*(measured 2026-08-08 — analysis, nothing adopted)*

`UPSTREAM.schedule` → `confessor2.wbai.org/playlist/pub_sched.php` is fetched
already, on the photo-map refresh. `fetchPhotoMap()` runs one regex over it for
`pix/<slug>_med_<id>.jpg` and throws the rest away. The rest is **WBAI's actual
weekly schedule grid**, 190 KB of it.

It is far more machine-readable than "pixel grid" suggests. Each cell:

```
class="cat_14" style="position:absolute;left:220px;top:720px;height:80px;..."
  tooltip=' 03:00 PM<br><b>Black Star News</b><br><br><full description>
            <img class="dj_img" src=".../pix/blackstarnews_med_NNN.jpg">Milton Allimadi'
  ><div>Black Star News</div><div class="cat_host_16">Milton Allimadi</div>
```

- **day** = `left / 110` (Sunday 0 … Saturday 6)
- **start** = `top / 40` half-hours from 06:00, station wall clock
- **duration** = `height / 40` half-hours
- **category** = `cat_NN`, the *same numeric vocabulary* as `CAT_MAP`
- plus title, host, host photo and **the full show description**

The pixel arithmetic is checkable against the page's own printed time in each
tooltip: **135 cells, 0 mismatches**, on each of three weeks. Do that check in
any parser built on this — it is free and it is the difference between a layout
change breaking loudly and breaking silently.

`?dte=<sunday-epoch>&op=next|prev` walks weeks, **including future ones**
(the week of 8-09 was already published on 8-07).

#### What it would fix

- **Descriptions for every show, in a file we already download.** This is the
  `/api/showinfo` on-air-only harvest problem (CLAUDE.md §4) solved outright.
- **Next week.** Air-time derivation cannot know the future, by construction.
- **The §7.7 ambiguity.** The grid never puts two shows in one cell — so
  alternation, if represented at all, is different shows in different weeks, and
  two fetches settle what currently takes two weeks of waiting.

#### Why it has not been adopted, and must not be adopted naively

**It is a schedule, not a record of what aired, and the two disagree.** Measured
for the week of 2026-08-02, grid vs. what the feeds show actually broadcast:

| | |
|---|---|
| both present, agree | **29** |
| both present, disagree | **5** |
| in grid, nothing aired (mostly 5-item feed retention) | 101 |
| aired, absent from grid | 2 |

~85% on slots where both exist, and **all five disagreements are overnight**
(Thu 00:00/03:00/04:00, Fri 00:00/02:00) — the replay hours, where a station
departs from its published grid most.

Worse for our purposes: **past weeks re-render under the current template.**
Asked for the week of 7-26, it answers with today's lineup, not the lineup that
aired. At Tue 05:00 all three fetched weeks name *Shenu Living*, a show that
appears nowhere in what actually broadcast (that slot aired Equal Time For Free
Thought, then Aware Show). The schedule was edited shortly before this project
began, and the grid shows the edit applied backwards.

So the two sources answer different questions, and this app mostly asks the
second one:

- **grid** — what the station *intends* to broadcast. Authoritative for "what's
  on", and the only source for "what's on next week".
- **air times** — what actually exists as playable audio. Authoritative for an
  *archive*, which cannot offer a listener a recording that was never made.

`deriveSchedule` should therefore keep deriving. The grid is a candidate
**second** signal — best used for descriptions, for future weeks, and as a
cross-check whose *disagreements are themselves the useful output* (a slot where
grid and air times diverge for weeks is either a stale schedule entry or a show
that quietly stopped, and both are worth surfacing in `/studio`).

⚠️ And it is a scrape of positioned HTML, which is the class of dependency this
project spent 2026-07-29 moving away from (see `docs/xml-feed-migration.md`).
Anything built here needs the tooltip self-check above, and must degrade to the
derived schedule rather than to an empty week.

### 7.10 Two broadcast days that did not run the schedule

*(2026-08-08 — the reason §7.7's first pass left ten false alternates behind)*

§7.7 shipped and still showed "alternates weekly" on ten slots. Checking
**WBAI's own calendar** (`wbai.org/schedule`, a FullCalendar week view whose
next/prev buttons walk forward) settled whether any of them were real:

> One show in every one of those ten slots, **every week, six weeks forward**,
> across ~134 events a week. **No alternating slot anywhere.**

So all ten were false. The cause was not ten independent mistakes — measure
each broadcast *date* by the share of its slots held by someone other than that
slot's current occupant:

| date | slots | displaced | rate |
|---|---|---|---|
| **2026-07-19** | 7 | 5 | **71%** |
| **2026-07-28** | 10 | 10 | **100%** |
| every other date in the window | | | 0–23% |

On 2026-07-28 *every single slot* aired something else. That is **one event** —
a replay block, special programming, a mislabelled batch of recordings — not
ten shows that independently began alternating fortnightly in perfect phase.
`schedDropStale` could never have caught it: each ghost aired exactly once,
exactly 7 days behind its incumbent, which is precisely the signature of a
genuine fortnightly alternate.

`schedOddDates()` finds these days and removes them from the derivation before
bucketing. Thresholds: ≥60% displaced, ≥5 slots (below that a "rate" is noise).

Two properties worth keeping:

- **A real lineup change also looks displaced** — and that is harmless, because
  a change displaces every *older* day, and those are exactly the days that
  should stop contributing. It degrades to the behaviour §7.7 already wanted.
- **A genuinely alternating slot moves one or two slots on its B week**, nowhere
  near 60% of the day. The test cannot fire on real alternation without the
  whole day alternating at once.

### 7.11 A renamed show is not two shows

The last stubborn slot, Monday 07:00, survived every rule above because both of
its "shows" had genuinely aired there more than once:

```
whatsgoingonmoralm  "Early Morning Mondays - Moral Monday"  06/22, 07/20, 07/27
whatsgoingonmoralm  "What's Going On!"                      08/03
```

**Same slug.** The show was renamed, and grouping by normalised title reported
the old name and the new one alternating with each other.

The original code grouped by title *on purpose*, to handle the mirror case noted
right there in the comment: "Talk Out of School" airs under two slugs differing
only in capitalisation, and is one show. So neither key is sufficient alone —
title splits a rename, slug splits a re-slugging.

`schedIdentity()` takes the **transitive closure of "same slug" OR "same
normalised title"** (union-find over both), which collapses either split without
privileging the listing's naming over the feed's. Its key is then used by
everything that has to agree on show identity: bucketing, `showLast`,
`seenCount`, and §7.10's displacement test — a rename must not read as a
displaced slot either.

⚠️ If you add a third source (see [pacifica-json-dev.md](pacifica-json-dev.md)),
it arrives with its *own* naming, and this is the function that has to hear
about it. It is also the reason the schedule can survive a station renaming a
show mid-week, which is otherwise indistinguishable from a lineup change.

### 7.12 "Today" was yesterday for the first hours of every day

*(reported 2026-08-08 at 12:08 am, from the live site)*

`schedToday()` answered with **the newest archived row's weekday**, on the
reasoning recorded right there in the comment: a show is archived within the
last few hours, so its weekday is today's. That holds for most of the day and
fails in exactly the window where someone is most likely to be looking at a
radio schedule — **after midnight, before the first show of the new day has
finished and been archived.**

Measured at 00:10 on Saturday:

| | |
|---|---|
| station clock | **Saturday** 2026-08-08 00:10 |
| on air (`/api/nowplaying`) | Midnight Ravers, 12:00–2:00 am — a *Saturday* show |
| newest archived row | Friday, August 7, 10:00 pm |
| `schedToday()` | **Friday** |

Two visible symptoms, one cause. The tab marked "Today" showed **yesterday's**
line-up, and the on-air highlight vanished — `schedApplyLiveHighlight()` gates on
`schedDay === schedToday()`, and even past that gate the playing show was not in
the day being drawn, so nothing could match it. The bug reads as "the live
highlight broke", which is why the day is the thing to check first.

The window is roughly midnight until the first show of the day is archived —
one to two hours, every single day.

**The fix keeps the client timezone-free**, which is a template concern and the
reason `schedWall` parses `dateText` rather than reaching for an Intl formatter
(§0). A row carries the same instant twice — `dt` (epoch) and `dateText` (the
station's own wall clock) — so *the difference between them is the station's
current UTC offset*. `schedStationOffsetMs()` takes it from the newest row,
`schedToday()` shifts the real clock by it and reads the weekday off that. It is
correct at every hour and follows the station across DST on its own, because the
offset is re-derived from a row that is at most a few hours old.

It falls back to the old newest-row heuristic if `dateText` ever stops parsing:
a format change upstream should degrade to the previous behaviour, not to an
empty schedule.

⚠️ **Anything else that wants "now" at the station belongs on this offset too.**
Do not add a second mechanism, and do not reach for `Intl` with a hardcoded zone
— the whole point is that a station deploying this template configures
`STATION_TZ` on the server and the client never learns it.

### 7.13 The day strip did not roll over either

*(2026-08-08, found by asking the right question rather than by a bug report:
"the live highlight moves in real time — does the same happen to the day tabs?")*

No, it did not. §3.2 got the highlight right — `schedApplyLiveHighlight()` runs
on every 15s now-playing poll and walks the marker from show to show in place.
But that function only toggles classes on `.sched-show-wrap`. **The tab strip is
drawn by `paintSchedule()`, which runs on open, on a tab tap, or when rows
change — and none of those is a clock.**

So a modal left open across midnight kept drawing yesterday and labelling it
"Today". Worse than cosmetic: once §7.12 made `schedToday()` track the real
clock, `schedDay` (still yesterday) and `schedToday()` (now today) disagreed, and
`schedApplyLiveHighlight()` gates on exactly that equality — so **the highlight
disappeared altogether** and did not return until the reader touched a tab. Same
family as §7.12, one layer up: something that derives from "now" but is only
recomputed when something else happens to change.

`schedRollDay()` runs on the same poll and compares `schedToday()` against
`schedPaintedToday`, the weekday the strip was last drawn for. The two cases are
deliberately not the same:

| what the reader is looking at | what happens at midnight |
| --- | --- |
| **today** | selection follows to the new day, full `paintSchedule()`. The scroll-to-live it brings is *correct* here — the new day's first show is what is on air. |
| **another day** | `schedPaintTabs()` only. The "Today" pill moves to the right tab; their chosen day and scroll position are untouched. |

That split is the whole point, and it is why the tab strip had to be split out of
`paintSchedule()` into `schedPaintTabs()`. **`schedScrollToLive()` opens with
`schedBody.scrollTop = 0`**, so repainting the body under someone reading
Wednesday would throw them back to the top of Wednesday for no reason they
could see — precisely the yank §3.2 refuses to do on the 15s poll.

Verified by moving the page's clock rather than waiting for midnight
(`Date.now` shifted +24h, then one poll cycle):

```
CASE 1 — watching today
  before  selected=Saturday  todayTab=Saturday  scrollTop=0
  after   selected=Sunday    todayTab=Sunday
CASE 2 — watching another day
  before  selected=Tuesday   todayTab=Saturday  scrollTop=400
  after   selected=Tuesday   todayTab=Sunday    scrollTop=400
```

⚠️ **If you add anything else to this dialog that depends on "now"** — a
next-up row, a progress bar, a countdown — it belongs on this poll too, and it
needs the same two-case answer about whose scroll position it is allowed to
move. The pattern to copy is `schedRollDay()`: recompute from the clock, and
repaint the smallest thing that can be wrong.
