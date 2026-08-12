# Show modal and past-archive UX brainstorm

Status: routed redesign and playback refinements deployed from `main` at commit
`4b6f352` on 2026-08-12. A subsequent compact Past episodes affordance is local
and not yet deployed.

## Production checkpoint — 2026-08-12

Path A below is now the production interface: one modal, an internal Past
episodes route, and a persistent modal-level archive player dock.

The deployed refinement makes orange the permanent transport color and teal the
playback/listening state color. The dock includes the loaded show's artwork;
replacement actions say `instead`; clipped short-phone content gets a measured,
explicit guide.

- Deployed release: `4b6f352` on `main`/`origin/main`.
- Production `/app.js` and `/styles.css` SHA-256 values matched the files in that
  commit byte-for-byte during the audit.
- `https://wbai.supersoul.top/healthz` returned HTTP 200 and `ok:true`: storage
  was writable and mounted on the established named volume, `freshVolume:false`,
  with 110 show-info records, 127 feeds, no quarantined files, and no feed
  failures.
- The isolated browser suite passed **65/65 against production**, including
  desktop, phone, 320×568 short-phone overflow, real archive-media selection,
  dock identity, cross-episode browsing, and listening memory.
- The owner separately confirmed audible playback and the interface on the live
  site and a physical phone; headless Chrome is muted and cannot prove sound.
- Changed application files: `public/index.html`, `public/app.js`, and
  `public/styles.css`.
- The former rail regression at `test/episode-rail/` now tests the routed modal,
  listening memory, and persistent dock while keeping its established command.
- `docs/episode-rail.md` documents the implemented behavior.

The post-deploy styling follow-up centers **Past episodes**, its count, listening
summary, and chevron on one line inside a muted container while retaining the
full-width 44px tap target. The aggregate summary hides at 360px and below
rather than wrapping. The archive Back chevron is brighter than its label so the
return path reads immediately. Its local browser suite passes **72/72**;
production correctly remains on the 65-check deployed version until this
follow-up is pushed.

## Post-launch interface audit — 2026-08-12

### Outcome

No release-blocking hierarchy, overflow, transport-ownership, or responsive
layout problem remains in the audited paths. The important questions are now
answered in stable places: profile identity above, selected action in the
footer, and loaded audio in the dock. Making the desktop modal larger or adding
more always-visible controls would spend clarity without solving a current
problem.

### Fixed in the local follow-up

- **Past episodes looked quieter but slightly disconnected.** The label and
  chevron could read as separate weak marks across the width of a navigation
  row, and the listening summary looked like unrelated footer metadata. All four
  parts now form one centered, single-line intent inside a muted container. The
  route remains visually secondary to Play but is plainly one action.
- **The archive Back path lacked edge contrast.** Only its chevron now uses the
  brighter primary ink; `Show info` stays muted. This adds a clear return cue and
  subtle balance against the close/minimize control without creating a second
  primary button.

### Worth improving next

1. **Put the date in archive-row Play accessible names.** The visual row makes
   the target date obvious, but the icon-only button currently announces the
   show title rather than `Play Democracy Now! — Aug 12`. This is a small,
   high-confidence screen-reader improvement and does not require visual UI.
2. **Complete manual assistive-technology coverage.** The automated suite proves
   focus targets, names, written state, reduced-motion CSS, and reflow geometry;
   it cannot prove VoiceOver/TalkBack cadence, 200%/400% zoom, or Windows forced
   colors. Those remain the most valuable validation gaps.

### Observe before changing

- **`Show more` versus `More show information`.** One expands the description;
  the other scrolls toward clipped content. They are structurally and visually
  different, and current phone testing found the path clear. Change the cue to
  `Continue below` only if new listeners confuse the two; do not optimize away
  a successful affordance from one theoretical wording concern.
- **Return after tapping the dock identity.** Tapping the loaded show in the dock
  deliberately changes profile context. A `Back to [show] archive` trail would
  help only if listeners frequently use that jump and then feel stranded. It
  would also add state and chrome, so wait for evidence.
- **Archive density.** Retention, duration, listening status, and Play coexist in
  each row. Current rows scan well and untouched episodes stay quiet. Revisit
  only if real history-heavy accounts make rows noisy.

## Secondary audit — 2026-08-12

The second pass traced the implementation against the older architecture,
development, accessibility, feature and test documentation rather than auditing
the new feature docs in isolation.

### Findings fixed locally

- **Cross-show player navigation now resolves show detail.** A normal card/deep-
  link open already called `/api/showinfo/<altid>`. Tapping the in-modal player's
  title can jump to a different show, but previously relied only on the show data
  already cached. That path now performs the same lazy show-specific lookup.
- **New phone controls meet the 44px target convention.** The internal Back
  control was 40px high and the dock toggle 38px. Back, the dock title and the
  dock toggle now use real 44px minimum boxes at every pointer type, without
  creating overlapping pseudo-targets.
- **Live row state reaches accessible names.** Past episode row labels were built
  at initial render, while the visible `Playing`, `Paused`, and `Loading` status
  could change later. The synchronization path now updates the row's accessible
  name along with its visible status.
- **Stale implementation comments were removed.** The focus-trap comment still
  referred to roving episode chips from the retired rail.

### Content-source conclusion

The profile is correctly show-specific, not episode-specific. Its description
priority is `showInfo` by `sho` slug, the title-matched program directory, then
the show's short description. WBAI's podcast feeds commonly repeat the channel
description on every item. The server preserves `episodeDesc` only when it is
actually different, but this prototype does not present that field as the show
profile or invent episode copy. Switching dates inside one show should retain
the program description; switching shows should resolve the new program.

### Deferred manual checks

- VoiceOver/TalkBack reading order and announcement cadence for route changes,
  playback state, and the seek slider.
- 200%/400% zoom, large text, phone landscape, and Windows forced-colors.
- The duplicate-transport question is resolved: when the selected episode is
  loaded, the dock alone owns Play/Pause.
- Whether following a different show's in-modal player needs a visible “return
  to the archive I was browsing” affordance. The current action is a deliberate
  context switch and browser history is not expanded.

### Intentional prototype divergence

The brainstorm proposed making browser/device Back unwind Past episodes to Show
view before closing. The prototype keeps the internal route out of browser
history: visible Back and Escape return to Show view, while browser/device Back
closes the one modal entry. This avoids a hidden history step for a route that
does not change the URL. It remains a user-testing question rather than an
accidental undocumented behavior.

## The historical problem in one sentence

The old show modal tried to be a show profile, an episode picker, a
selection confirmation, and an audio player in one vertically growing surface.
Each part works on its own, but their combined states compete for the same space
and can hide the information or transport the listener needs.

## What the screenshots reveal

### 1. The landing card has lost its hierarchy

The original show card has a clear order: artwork and identity, description,
broadcast facts, then an action. Adding links, an episode rail, an expanded
episode grid, an alternate-episode action, a now-playing strip, and a scrubber
turns the lower half into a changing stack. The show information is technically
still present, but it can be pushed above or behind the visible area without a
clear indication of where it went.

The interface therefore changes from “this is the show I opened” into “these are
all the controls associated with this show,” which is a much harder page to
scan.

### 2. Selection and playback are correctly different, but hard to read

The current colors encode two valid facts:

- Orange: the episode the primary Play button will act on.
- Teal: the episode currently producing audio.

That distinction should remain. The confusing part is that selecting another
date also adds another transport block below the primary action. The listener
must then reconcile the orange chip, teal chip, orange Play button, separate
pause button, and scrubber while the original show information moves away.

### 3. “All episodes” is an expansion when it should be navigation

Expanding 24 date boxes inside the profile does not feel like revealing a little
more detail. It changes the task from reading about one episode to browsing an
archive, but the layout still treats it as extra profile content. The episode
grid wins the visual hierarchy and the show profile becomes dim background
context.

### 4. The modal covers the global player but does not fully replace it

Once playback begins, the docked player behind the modal is inaccessible. The
modal adds substitute controls, but their size and position depend on which
episode is selected and whether it matches the episode playing. A browsing
choice can therefore rearrange or partially replace the transport.

Playback is global application state. Its controls should not appear and
disappear as a side effect of browsing state.

### 5. Date context is too easy to lose

The archive is episode-level and the front card already carries a date, so the
modal is opened with a specific broadcast in mind. On the newest episode the
button currently says only “Play episode”; the date appears elsewhere in a
facts row that can scroll away. The exact broadcast attached to Play should be
obvious at the action itself, for every episode rather than only an alternate
selection.

## What is already good and should be protected

- Opening a front card preserves the exact episode the listener chose.
- Browsing an episode does not silently start a large audio download.
- Orange selection and teal playback communicate different states.
- Listening memory is a genuinely useful product feature: progress, completed,
  loading, playing, paused, and resume states already exist and must survive a
  redesign. The goal is to clarify them, not simplify them away.
- Play/pause, seeking, “Start over,” sharing, external links, retention, and
  long descriptions all have a home.
- One show can have 1 episode or more than 20; both extremes need to feel
  intentional.
- Closing while audio is active hands playback to the docked player rather than
  stopping it.
- A selected episode can update the shareable URL without filling browser
  history with every intermediate selection.

## Recommended direction: one modal, two views, one player dock

Keep the compact modal frame, but give it internal navigation:

1. **Show view** is the restored landing card and always opens first.
2. **Past episodes view** replaces the show body; it is not appended below it.
3. **Now playing dock** occupies one reserved region at the bottom whenever
   audio is loaded, in either view.

This is still one modal, not a modal on top of another. The frame, close action,
focus trap, and responsive behavior stay stable while the content route changes.

### The five pieces of state must stay independent

| State | The question it answers | Suggested presentation |
| --- | --- | --- |
| Modal view | Am I learning about the show or browsing its archive? | “Show” or “Past episodes” internal route |
| Context episode | Which broadcast did I open or choose? | Date beside the primary action |
| Playing episode | What audio is in the player right now? | Persistent dock with loaded artwork, title and date |
| Playback state | Is the loaded audio loading, playing, paused, or errored? | Persistent dock glyph, wording, and scrubber |
| Listening memory | What have I heard before, and how far did I get? | Quiet per-episode progress or completion status |

The context episode and playing episode are allowed to differ. That is a normal
state, not an exception that should grow an extra box.

## Proposed show view

The landing view should feel very close to the original show card. It restores
the program identity as the dominant content and gives the selected broadcast a
small, explicit action block.

```text
┌──────────────────────────────────────────  × ┐
│  [ artwork ]   CATEGORY                     │
│                Show title                   │
│                with Host                    │
│                                             │
│  Short show description…       Show more    │
│                                             │
│  SELECTED BROADCAST                         │
│  Wed, Aug 12, 2026 · 5:00 am · 1:00:03     │
│  18:42 listened · 41:21 left   ━━━━━──────  │
│  [ Resume Aug 12 ]  [ Start over ]          │
│                                             │
│  [ Past episodes 24 → ]                     │
│  6 played · 1 in progress                   │
│  Website · RSS · Share                      │
├─────────────────────────────────────────────┤
│  [art] Playing now · Show · Aug 5  [Pause]  │
│          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
└─────────────────────────────────────────────┘
```

Important details:

- Use one stable label such as **Selected broadcast** or **Episode** above the
  date. “Aired” is still useful metadata, but it does not explain that Play is
  aimed at this particular broadcast.
- Put the short date in the primary action every time: `Play Aug 12`, `Resume
  Aug 12`, `Loading Aug 12`, or `Pause Aug 12`. Do not make the newest episode a
  special exception.
- Keep the full date and airtime immediately above the button. The user should
  never have to find a colored date chip to verify what Play will do.
- If the selected episode is partly heard, show one quiet progress line directly
  above the action and change Play to `Resume Aug 12`. If it is finished, use a
  check and `Played`; if untouched, omit the status line rather than adding
  `Not started` noise.
- Replace the pinned episode rail with one clear navigation row: `Past episodes
  24 →`. For a show with only one available episode, omit it or label it
  `Only available episode`; do not show a dead browser affordance.
- The Past episodes row may carry a subdued summary such as `6 played · 1 in
  progress`. This preserves the satisfying sense of listening history without
  bringing every episode marker back into the landing card.
- Keep external links visually secondary and compact. They should not determine
  the position of Play.
- The description can remain clamped, but expanding it scrolls only the show
  body; it never moves the modal header or player dock.

## Listening history without visual noise

Listening history may be the hardest piece because it is both archival data and
live player state. It should remain prominent enough to be useful while staying
subordinate to the two immediate questions: “What will I play?” and “What am I
hearing?”

The cleanest model is progressive disclosure:

- **Show view:** show listening status only for the selected broadcast, plus an
  optional one-line summary beside Past episodes.
- **Past episodes view:** show listening status for every episode, because
  comparing listening history is part of the browsing task.
- **Now-playing dock:** show only the live position of the loaded track. It is a
  transport, not a history report.

### Use a small, consistent status vocabulary

| Episode state | Plain-language text | Visual treatment |
| --- | --- | --- |
| Never started | No status text | No mark; untouched should be the quiet default |
| In progress | `18:42 listened · 41:21 left` or `31% listened` | Thin teal progress bar |
| Finished | `Played` | Teal check; no full-row fill |
| Playing now | `Playing · 18:42` | Teal pause/equalizer icon in the play-control position |
| Loaded and paused | `Paused · 18:42` | Static teal pause/status mark |
| Selected for a future action | Date and `Play`/`Resume` action | Orange action emphasis, not a progress color |

Time remaining is usually more actionable than percentage for a one-hour radio
program, while percentage is easier to scan across many rows. A useful starting
point is elapsed + remaining time in Show view and a compact percentage or
progress bar in the archive list. Both should derive from the same saved
position.

### Do not treat “heard” as a show-level binary

A listener may finish one broadcast of a daily program and never hear the other
23. The UI can summarize `6 played` or `3 episodes heard`, but should not stamp
the whole program “Listened” after one episode. Listening memory belongs to
episodes; show-level wording is only an aggregate.

### Color must not carry history alone

Orange means an action that controls audio: play, pause, resume, or replace the
loaded episode. Teal means playback/listening state. Every teal state also gets
text, an equalizer, a check, a bar, or a combination, so a listener does not
need to remember a color legend. An animated equalizer is reserved for actual
playback; loading and paused states are static. The same mark should mean the
same thing in the modal, archive list, and page cards.

### Current playback temporarily outranks saved history

While an episode is actively playing, show `Playing` and its live position. When
it is paused or unloaded, its saved in-progress or Played status remains. This
prevents an episode from trying to display an equalizer, progress bar, check,
and selection ring at once.

## Proposed past episodes view

Opening Past episodes changes the body to a real browser. It should use list
rows rather than a large grid of date boxes: a row has room to explain date,
time, length, progress, retention, and action without making the listener decode
marks.

```text
┌──────────────────────────────────────────  × ┐
│  ← Show info      Past episodes             │
│  [art] Shenu Living                  3 total │
│        1 played · 1 in progress              │
│─────────────────────────────────────────────│
│  Wed, Aug 12 · 5:00 am          [▶]         │
│  1:00:03 · 59 days left · 20% listened      │
│  ━━━━━────────────────────────────────       │
│                                             │
│  Wed, Aug 5 · 5:00 am           [Ⅱ] Playing│
│  1:00:02 · 52 days left                      │
│                                             │
│  Wed, Jul 22 · 5:00 am           [▶]        │
│  1:00:01 · Played                            │
├─────────────────────────────────────────────┤
│  [Pause] Playing · Aug 5        0:12 / 1:00 │
│          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
└─────────────────────────────────────────────┘
```

Recommended interaction rules:

- A row tap chooses that episode and returns to Show view, where its full date
  and primary action are visible. Choosing still does not play.
- The explicit play icon at the end of a row does play immediately. It is an
  unambiguous playback command, so this does not violate “choosing is not
  playing.” It also makes rapid archive listening possible without a round trip.
- Starting an episode from the list leaves the archive view open. The row and
  persistent dock update in place; the interface does not yank the listener
  back to the profile.
- The playing row uses a teal edge/status and plain language (`Playing` or
  `Paused`), while its transport glyph stays orange. Do not fill an entire row
  in either color.
- Progress and completion should be written as well as drawn. A thin progress
  bar can remain, but `20% listened` and `Played` remove the need to learn a
  hidden legend. Untouched rows get no extra label.
- A quiet header summary such as `6 played · 1 in progress` makes the feature
  discoverable and gives the listener a sense of continuity without adding
  badges to every corner of the Show view.
- All episodes are already in this view, so there is no `All 24` expansion and
  no footer growth. The list alone scrolls.
- Keep the show’s artwork and title in a compact identity row so the listener
  knows whose archive they are browsing without spending profile-scale space.

## The persistent now-playing dock

This is the structural fix for the player being covered.

- Reserve its space in the modal layout. It must never overlay the final archive
  row or unexpectedly shrink/grow when a different episode is selected.
- Show it for any loaded archive episode, even if the open modal belongs to a
  different show. Its label must then include enough identity, for example
  `Playing · Shenu Living · Aug 5`.
- Include the loaded show's artwork beside that identity. The thumbnail is a
  fast cross-show discriminator and must follow the player rather than the
  profile currently being browsed.
- Keep the dock's main transport orange. Use teal for written state and a small
  equalizer that appears only while the audio is truly playing.
- Give it pause/resume and a scrubber. Keep skip and volume in the global player
  unless user testing shows they are essential here; the dock should remain
  compact.
- Tapping its title opens the playing episode in Show view. If that changes the
  show currently being browsed, preserve a small internal return path such as
  `← Back to Democracy Now! archive`.
- Closing/minimizing the modal moves control back to the existing docked page
  player without interrupting audio.
- When nothing is loaded, the region should not leave a large blank space; the
  modal can use that height for content. Once it appears, it has one fixed
  height for all playback states.

## Back, Close, and browser history

These actions need separate promises:

- **Back** means “return to the previous view inside this modal.” It appears in
  Past episodes and when temporarily viewing the currently playing show.
- **Close / minimize** means “leave the modal.” An `×` is correct with no active
  handoff; a downward chevron can continue to signal that audio remains in the
  player below.
- **Browser/device Back** should first move Past episodes → Show view. From Show
  view it closes the modal. Episode-row exploration should not create a long
  history trail.
- **Escape** should follow the same hierarchy: leave the internal archive view
  first, then close the modal on the next press, unless testing shows users
  strongly expect Escape to dismiss the entire modal immediately. This is one
  behavior to prototype rather than assume.

The most important rule is that an arrow never closes the whole modal and an `×`
never masquerades as internal Back.

## Responsive frame

Use the same information architecture at every width. Layout details can adapt,
but phones should not have a different navigation model from desktop.

### Desktop

- A modest increase from the current 680px width to roughly 760–820px is worth
  testing. It gives date/action rows and archive metadata room without turning
  the modal into a page.
- Cap height around 82–88dvh. The top navigation and bottom player dock remain
  fixed; only the active view body scrolls.
- Avoid a permanent two-column profile/archive layout. It is visually tempting
  on desktop but recreates competition for attention and cannot translate
  cleanly to phones.

### Tablet

- Use nearly the same centered frame, limited by comfortable side gutters.
- Keep touch targets at least 44px and do not depend on hover for progress or
  play-state explanations.

### Phone

- Keep the current tall bottom-sheet character: full width, a small visible
  strip of scrim at the top, and safe-area padding.
- The modal has three rows: fixed top navigation, one flexible scroll body, and
  an optional fixed now-playing dock. The footer should not contain a growing
  set of unrelated sections.
- Artwork can be smaller than the current 60vw when that is what keeps the
  selected date and primary Play action visible on first open. Program identity
  matters more than maximizing the image.
- Test at 360×640 and in landscape, not only modern tall phones.

## Other viable paths

### Path A — Internal archive route (recommended)

The two-view model described above. It best matches the user’s mental tasks,
restores the landing card, gives Back a real job, and creates a stable home for
global playback. It requires a small internal navigation state and more careful
history/focus handling.

### Path B — Show / Episodes tabs

Use two tabs at the top of the same modal with the same persistent player dock.
This is simpler and makes both destinations continuously visible. The downside
is that tabs describe peer categories, while the real flow is hierarchical: the
listener starts with one episode and drills into that show’s archive. Tabs also
give browser Back and the return from Now Playing less obvious behavior.

This is a credible fallback if a prototype shows that users do not notice the
Past episodes navigation row.

### Path C — Responsive split view

On larger desktops, show profile information on the left and episodes on the
right; collapse to routed views on phones. It enables comparison and fast play,
but it makes the desktop modal substantially larger, creates two responsive
mental models, and risks rebuilding the same “everything at once” problem with
more horizontal room. It does not fit the stated preference for a compact
overlay as well as Path A.

### Path D — Nested archive drawer or second modal

Slide an episode drawer over the show card. This visually matches the idea of an
overlay, but a true modal-on-modal stack complicates focus, Escape, Back,
screen-reader isolation, and player ownership. If explored, it should be an
internal animated route inside one dialog element, not a second `aria-modal`
dialog.

## Implemented state rules

These invariants would prevent the current ambiguity from returning:

1. Exactly one modal body view is visible: Show or Past episodes.
2. With no loaded audio, Show view has one solid-orange primary playback offer.
   With different audio loaded it has one quieter orange `instead` offer. With
   the selected episode loaded, the dock is the only transport.
3. Exactly one persistent dock represents the audio element when a track is
   loaded.
4. Selecting context never changes audio; pressing a play control always does.
5. Playback changes never navigate unless the listener taps the dock title.
6. Navigation changes never stop, replace, or hide playback controls.
7. The date affected by a primary action is visible adjacent to that action.
8. Expanding a description cannot change the size or position of the player
   dock.
9. A 1-episode show and a 24-episode show open to the same-sized Show view.
10. Loading, playing, paused, resumed, completed, and error states keep the same
    layout footprint.
11. Untouched episodes are visually quiet; history marks appear only when they
    communicate real listening activity.
12. Every listening-history color also has a text, icon, or progress-shape cue.
13. Playing state temporarily replaces historical marks for that row rather
    than stacking on top of them.

## Questions worth prototyping

- Does a Past episodes row tap return to Show view, or should only a secondary
  “Details” target do that? The recommendation is row = details, play icon =
  direct play, because it gives the entire row one predictable non-audio action.
- Should the dock include the full scrubber on the smallest phones, or show
  time/progress with a tap to expand? Start with the scrubber; hiding seek behind
  another state may recreate the original transport problem.
- **Resolved in the second refinement:** when the selected episode is already
  loaded, the primary action is removed and the dock is the single transport.
  The selected-broadcast status says `Playing now` or `Paused`. When a different
  episode is loaded, the browsed action remains available as `Play … instead`.
- Should Escape leave Past episodes first or close the modal immediately? Test
  this with keyboard users while keeping on-screen Back and Close unambiguous.
- How much program identity is needed in the archive header: art + title, or
  title alone on very short screens?
- Which progress wording is clearest in each view: `31% listened`, `18 min
  listened`, or `41 min left`? Test comprehension rather than choosing only by
  character count.
- Should a completed episode say `Played`, `Finished`, or `Listened`? `Played`
  matches the existing feature and is shortest; `Finished` makes the completion
  claim clearest.
- Should the Past episodes summary count only completed episodes or all episodes
  started? The recommendation is two honest counts (`6 played · 1 in progress`)
  rather than one ambiguous “7 listened.”

## Prototype and evaluation plan

First prototype only the frame and state transitions with real fixture lengths;
do not tune animation or final color before the layout survives the hard cases.

Test these scenarios:

1. Open the newest episode from a front card; verify its full date and Play date
   are visible without scrolling.
2. Open an older episode from the listing/deep link; verify that exact date is
   preserved.
3. Start playback, enter Past episodes, and scroll to the oldest item; transport
   must remain visible and no row can sit under it.
4. Play a different episode directly from the archive list; the list should not
   jump and the dock should update in place.
5. Select a different episode without playing; the dock must continue to name
   and control the actual audio.
6. Open a show with 24+ episodes and a long description; its Show view must be
   the same height as a 1-episode show.
7. Open another show while audio is active; the dock must keep naming and
   controlling the original track.
8. Use a fixture with untouched, partly heard, completed, paused, and currently
   playing episodes. Each state must be identifiable without relying on color,
   and no row should display competing state marks.
9. Resume a partly heard episode and finish it; verify the wording and mark
   change in the Show view, Past episodes view, and summary without a layout
   jump.
10. Exercise Back, Close/minimize, browser Back, Escape, and focus restoration in
   both views.
11. Repeat at 360×640, phone landscape, tablet portrait, and desktop.
12. Repeat with large text, reduced motion, and a non-color visual check.

Success is not merely that every control remains technically reachable. On each
screen a listener should be able to answer, without scrolling or decoding color
alone:

- What show am I looking at?
- Which dated episode will this action play?
- What episode am I hearing right now?
- Which episodes have I already heard, and where did I stop?
- How do I get back, and how do I leave?

## Decision

Keep **Path A: the internal Past episodes route with a persistent now-playing
dock**. It restores the show card, prevents the
archive from pushing the profile away, and gives browsing and playback stable,
separate homes while preserving the compact modal character.
