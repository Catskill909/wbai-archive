# Past episodes in the show modal

The original episode rail was replaced by the internal **Past episodes** view on
2026-08-12. The test directory retains the name `test/episode-rail/` so existing
local commands continue to work.

The design rationale and broader exploration live in
[`show-modal-archive.md`](show-modal-archive.md).

## Why the rail was retired

The rail solved an important discovery problem: the archive listing is
episode-level, but a listener opening one broadcast had no way to find the other
episodes of that show. It also preserved listening progress and completion.

Its position in the pinned modal footer created a larger problem. A show profile,
date chips, expanded `All N` grid, primary Play action, alternate-selection
transport, and scrubber all competed vertically. With 20+ episodes or playback
active, the show information could be pushed out of view and the transport could
change shape as the listener browsed.

The functionality remains; the expanding layout does not.

## Current model

The show sheet is one dialog with two mutually exclusive body views:

1. **Show view** — artwork, title, host, description, links, and one dated
   selected-broadcast action.
2. **Past episodes view** — compact show identity followed by a scrolling list
   of every episode.

A separate player dock sits below either view whenever archive audio is loaded.
It controls the global archive audio element, even if the listener is browsing a
different episode or show. Its thumbnail, title and date always identify that
loaded audio rather than the browsing context.

## Grouping

A show is still grouped by its lowercased `sho` slug, not title. This avoids
folding distinct editions with similar titles into one archive. Episodes remain
newest first.

## Description ownership

The modal profile describes the program, not the individual feed item. It reads
`showInfo[r.sho].desc`, then the title-matched program-directory description,
then `showInfo[r.sho].shortdesc`. WBAI's XML commonly repeats one channel blurb
on every episode; the server retains a genuinely different `episodeDesc` when
one exists, but this modal does not silently present it as the program profile.

Switching dates within one slug therefore keeps the same description. Moving to
another show—including by tapping the in-modal player title—runs that show's
lazy `/api/showinfo/<altid>` lookup and repaints when richer show data arrives.

## Interaction rules

- Opening a front card or deep link always lands in Show view on that exact
  broadcast.
- The primary action always names the short date: `Play · Aug 12`, `Resume · Aug
  12`, `Pause · Aug 12`, or `Loading · Aug 12`.
- `Past episodes N` replaces the profile with the archive list. It never expands
  the profile footer.
- The visible Back control returns to Show view; Close/minimize leaves the modal.
- Tapping an episode row selects it and returns to Show view without playing.
- Tapping a row's explicit play icon starts that episode and leaves the archive
  browser in place.
- Selecting or browsing never hides, replaces, or moves the modal player dock.
- With no audio loaded, the selected action is solid orange. While a different
  episode is loaded it becomes a quieter orange outline and adds `instead`.
  When the selected episode is already loaded, the dock is its only transport.
- A show with one episode gets no dead Past episodes control.

## Listening memory

Resume storage remains keyed by MP3 URL. The interface uses progressive
disclosure:

- Show view reports only the selected broadcast: elapsed and remaining time,
  `Played`, or nothing for untouched audio.
- The Past episodes header summarizes completed and in-progress episodes.
- Each archive row writes `N% listened`, `Played`, `Playing`, `Paused`, or
  `Loading` when applicable.
- Partial progress also gets a thin teal bar. Completed episodes get written
  status. Untouched episodes remain visually quiet.
- Live playback temporarily outranks saved history on that row instead of
  stacking an equalizer, progress bar, completion check, and selection ring.

Orange remains the transport/action color, including play and pause glyphs in
archive rows and the dock's main toggle. Teal remains listening/playback state,
but color is never the only cue. The dock equalizer appears only while audio is
actually playing and stops moving when reduced motion is requested.

## Layout contracts

- Desktop sheet: up to 800px wide and 88dvh tall.
- Phone sheet: a compact bottom sheet capped below the safe top gap; it grows
  only as much as its content needs until reaching that cap.
- The route header, scroll body, profile footer, and player dock are separate flex
  regions.
- The archive list is the only growing/scrolling content in Past episodes.
- Starting audio does not resize the desktop modal.
- The player dock is outside the changing body/footer and reserves its own space.
- At short phone heights, profile artwork yields space through a viewport-height
  cap. A measured `More show information` or `More episodes` control appears
  only when the scroll body has undisclosed content below it.

## History and accessibility

- Episode selection uses `replaceState`, so selecting several dates does not
  turn browser Back into an undo stack.
- The dialog's accessible label follows the visible route title.
- Tab remains trapped inside the one dialog.
- Escape from Past episodes returns to Show view; Escape from Show view closes.
- Back, Close/minimize, row details, and row Play are distinct controls with
  distinct accessible names.
- Progress and completion always have a non-color cue.
- Dynamic `Playing`, `Paused`, and `Loading` state is reflected in an episode
  row's accessible name as it changes.
- Internal Back and player controls retain the 44px coarse-pointer target floor.

## Regression suite

Run:

```sh
test/episode-rail/run.sh
```

The suite derives fixtures from the current archive and checks desktop and phone
states. It covers:

- profile-first opening and dated Play labels;
- archive replacement rather than footer growth;
- complete episode counts and one-episode shows;
- selection without playback and explicit direct playback;
- persistent dock ownership while another episode is browsed;
- dock artwork and the primary/alternate/dock-owned action hierarchy;
- constant orange transport and truthful teal playing state;
- body/dock non-overlap and horizontal overflow;
- elapsed/remaining status, percentage status, Played status, and progress bars;
- phone target sizing, left-aligned selected action, short-phone artwork, an
  explicit overflow guide, and changing playback state in row accessible names.

The suite currently contains 65 checks.
