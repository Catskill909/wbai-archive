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

`openSchedule()` pushes a `{sched:1}` history entry. Listen Live closed the
modal with `dismissSchedule()` — the *visual* close — which left that entry
behind still claiming the schedule was open. Open the schedule a second time
and there were two such entries stacked: **Back landed on the stale one and
re-opened the schedule instead of closing it.** Back looked dead.

Fixed by clearing the claim in place with `replaceState` at the moment of the
non-history close. Chosen over `closeSchedule()` (which does `history.back()`)
because that fires an async popstate whose `dismissSchedule()` would then steal
focus from the live player that had just taken it.

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
- **The live card stacks on phones**: thumb + title + pill never fit one line,
  so the pill drops to its own line, left-aligned to its own width rather than
  stretched.

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
