# Handoff: connecting Live Now Playing and the archive

**Status:** UX/product design handoff; no implementation for this task has started.  
**Date:** August 12, 2026  
**Repository:** `wbai-archive`, `main` only  
**Local checkpoint when this handoff was written:** `8bbc09f` (`feat: update deployment and development documentation with latest commit details and enhancements`) with a clean worktree before this file was added.

## Start here

The next task is to make movement between the clean **Live Now Playing** experience and the **show/archive** experience obvious, while preserving continuous live audio and the application's restrained visual hierarchy.

This is not primarily a styling problem. It is a state and navigation problem involving three independent things:

1. **What the user is looking at:** Live Player, Show profile, Past episodes, schedule/listing.
2. **What owns the audio:** nothing, live stream, or one archived episode.
3. **Which show is in context:** on air now, up next, or a show being browsed.

Do not collapse those into one state. Navigation must not change the audio. Only an explicit Play/Resume control may replace the current audio source.

## Product intent

- Keep the Live Now Playing view as clean and spacious as it is now.
- Give the current live show an understandable path to its archive.
- Give **Up next** an understandable path to that show's information and archive.
- Preserve the artwork interaction: its hover/focus hint says **Show info**, so tapping it must continue to mean show information—not past episodes.
- If live audio is playing, let it continue while the user browses a show or its archive.
- Make returning to live controls unmistakable without duplicating players everywhere.
- Make switching from live to an archived episode explicit. There must be no ambiguity about which audio is playing and which audio merely *can* be played.
- Preserve listening progress and the established orange-action/teal-state visual language.

## Existing behavior to preserve

### Live Player

- `#livePlayer` presents current artwork, category/show identity, host, times, Up next, optional song metadata, and the live transport.
- The artwork button `#lpInfoBtn` displays the **Show info** hover/focus hint and opens the layered **About this show** panel.
- Show information is joined using the current feed's `altid`; the artwork is disabled as a control when no additional facts exist.
- Closing/minimizing the Live Player does not stop live audio.
- The current and next-show metadata repaint on the approximately 15-second now-playing poll.

### Persistent player bar

- Live and archive audio share one global bottom player and one Media Session.
- When live owns the player, clicking the bar's artwork/title already reopens the Live Player.
- The bottom bar already creates a red **Live** status marker, but that marker lives in `.player-status`, which is hidden at phone widths. If song metadata replaces the fallback subtitle, a phone may have no persistent visible live-source label. The integration must fix that.
- Starting archive audio stops live audio; starting live audio stops archive audio. They never play simultaneously.
- Live stream connections follow the one-connection/never-reuse rule. Read `docs/big-audio-bug.md` and `docs/live-audio-pattern.md` before touching transport code.

### Show modal and archive

- A front-card/open action enters the Show profile.
- The compact muted **Past episodes** pill enters a full archive route inside the modal.
- The archive route has a strong **Show info** back control.
- Archive rows carry listening progress, played/playing state, retention, and explicit orange play controls.
- When archive audio owns the global player, the show modal replaces the obscured page player with its in-modal dock.

### Schedule precedent

The current live schedule card already handles the “two possible destinations” problem with an explicit chooser: **Listen Live** or **Past episodes**. That is useful evidence, but the Live Player should not gain another chooser if direct, labeled controls can express intent more simply.

## The current gaps

1. The current live show's artwork opens information, but there is no explicit route from the Live Player to its past episodes.
2. **Up next** is informative text, not a navigable show identity.
3. The server forwards `current.altid` but not `next.altid`, even though the upstream next-show object has `sh_altid`.
4. When live owns the player and the user browses an archive, the archived episode's button does not currently say that pressing it will replace live audio. The existing `… instead` wording only detects a *different archived episode*.
5. Rollover behavior needs a contract: live metadata may change while the user is browsing another surface.
6. The built-in now-playing snapshot has no stable show IDs, so a title-only match could navigate to the wrong show.
7. The Show/Archive modal covers the page player, and its internal dock currently renders only archive audio. When live owns the audio, the modal therefore lacks a visible live transport/source marker.

## Recommended interaction model

```text
Live Player
  artwork / “Show info” ───────────────> About this show overlay
  “Past episodes N  ›” ───────────────> Current show's Past episodes
  “Up next: Show · time  ›” ──────────> Next show's Show profile

Current/next show modal
  Show profile ── “Past episodes” ─────> Past episodes
  Past episodes ── “Show info” ───────> Show profile
  Close ───────────────────────────────> Listing; live audio continues

Visible live transport (one projection at a time)
  page bar outside modal ──────────────> Live Player / controls live audio
  modal dock inside Show/Archive ──────> Live Player / controls same live audio

Archive Play/Resume
  explicit “… instead” action ────────> Stops live, starts archive audio
```

### 1. Keep artwork dedicated to Show info

Do not overload the artwork with archive navigation. Its visible promise and accessible name must remain aligned with what tapping it does. This is especially important on touch devices, where the hover hint is not persistent.

### 2. Add one compact current-show archive pill

Add a muted, content-width pill in the Live Player's identity area, visually related to the successful Show profile control:

> **Past episodes** `N` `›`

It should sit near the show identity/host/times rather than near the primary live transport. It is navigation, not a competing playback button.

Recommended destination: go directly to that show's **Past episodes** route. The label says exactly where it leads, and the Live Player has already supplied the current-show identity and basic information. Opening the Show profile first would add a redundant tap.

The destination should be the latest playable archived row for the exact current `altid`/`sho` match. This may be yesterday's or last week's broadcast; do not imply that the program currently on air is already available as an archived recording.

### 3. Make Up next a quiet, explicit button

Keep it to one existing row/pill—do not add another large panel. Add a trailing chevron and make the full element interactive:

> **Up next** Show name · start time `›`

Recommended destination: the next show's **Show profile**, not directly to Past episodes. Here the primary object is a show identity, so the profile is the honest landing point; its existing Past episodes pill provides the next step.

Suggested accessible name:

> Show information and past episodes for [show], up next at [time]

### 4. Let live audio continue during archive browsing

Opening either destination must not pause, reconnect, replace, or otherwise alter live audio. Outside a modal, the persistent bottom bar remains the return path to live controls:

- Click/tap its artwork or title → reopen Live Player.
- Use its transport → pause/resume live.
- Close the archive/show modal → return to the listing with live still loaded.

Inside the Show/Archive modal, the page bar is covered. Extend the existing `#sheetPlayerDock` to represent live mode as well as archive mode. This is not a second player: it is a visible projection of the same global transport in the surface currently covering it, exactly as the dock already works for archive audio.

The live version of that dock should be compact and should contain:

- current-show artwork;
- a persistent red/orange **Live** source chip;
- the live show title;
- a state word such as **Playing**, **Paused**, or **Connecting**;
- the same orange Play/Pause transport;
- no scrubber and no ±15-second controls, because a live stream is not seekable;
- an identity action that returns to the full Live Player.

Only one transport is visible at a time: the page bar outside the modal or the modal dock inside it. Both control the same state and connection.

### 5. Make source replacement explicit

Generalize the current “different player” test. If *any other source* owns the visible player—including live—the selected archive action should say:

- **Play · Aug 12 instead**, or
- **Resume · Aug 12 instead**

Only pressing that orange action switches the source. Merely opening the profile, entering Past episodes, selecting an episode for details, or closing a modal must leave live untouched.

Orange remains the action color. Teal remains status/progress/playing state, not the dominant invitation to start different audio.

## Live-source identity contract

The interface needs to communicate two related but different facts:

1. **This source is live:** always visible anywhere the live transport is represented.
2. **The listener is currently hearing it:** represented by motion/state only when playback is actually running.

Use one restrained visual grammar on all three surfaces:

| Surface | Always visible in live mode | Playing treatment | Paused/loading treatment |
| --- | --- | --- | --- |
| Full Live Player | `Live · WBAI 99.5 FM` with small station-red dot | Soft dot glow or tiny equalizer | Static dot; explicit Paused or Connecting near transport |
| Show/Archive modal dock | Compact station-red `Live` chip beside show identity | Tiny equalizer or soft glow; orange Pause | Static dot + Paused, or spinner + Connecting |
| Bottom page player | Inline station-red `Live` chip inside the always-visible identity block | Tiny equalizer or soft glow; orange Pause | Static dot + Paused, or spinner + Connecting |

The current full player already has an **On Air · WBAI 99.5 FM** badge and the bottom bar has a live status marker, so this should refine and unify existing language rather than add a large new banner.

Recommended behavior:

- A small saturated dot and the word **Live** do the semantic work.
- A slow, soft halo or three tiny equalizer lines may animate only while audio is actually playing.
- When paused, retain **Live** because the source type has not changed, but stop the motion and say **Paused**.
- While connecting, retain **Live**, show the existing spinner, and say **Connecting**.
- Do not rely on color or animation alone; the word **Live** must remain visible.
- Do not hide the only live label at mobile breakpoints. Place it inside the title/identity region rather than the optional right-side status slot.
- When song metadata is present, it may occupy the descriptive sub-line but must never replace the Live source chip.
- Respect `prefers-reduced-motion`: use a static saturated dot and text with no loss of meaning.

This should feel like a quiet pilot light, not an alarm: one marker per visible player surface, low-radius/low-opacity glow, no flashing, and no large filled red container.

## Data and routing contract

### Stable identity

- Primary join: live `altid` === archive row `sho` after the same conservative normalization already used by the app.
- Choose the newest playable archive row for that exact show as the modal context.
- Use the existing grouped episode logic/count rather than creating a second definition of an episode.
- Do not use fuzzy title matching as the primary path. A wrong-show archive is worse than no link.

The server's `/api/nowplaying` payload currently needs one small addition:

```js
next: {
  name: unescapeHtml(nxt.sh_name),
  altid: clean(nxt.sh_altid),
  start: nxt.nxt_start || '',
  end: nxt.nxt_end || ''
}
```

The upstream next-show record is already passed to `recordShowInfo(nxt)`, so this forwards an identity already present rather than inventing a match.

### No-match behavior

Show an archive/profile action only when an exact matching playable row exists.

- Current show with no archive rows: omit the pill, or show quiet noninteractive **No recent episodes** if testing shows that omission looks broken.
- Next show with no archive match: Up next may remain plain text; it must not look clickable.
- Snapshot/stale fallback without `altid`: hide/disable archive navigation rather than guessing from the title.
- Retention expiry and recording gaps are expected states, not errors.

### Suggested helpers

Names are illustrative; reuse existing conventions:

- `latestArchiveRowForShow(altid)` — exact ID, newest playable row.
- `openLiveShowArchive(altid, trigger)` — open that row and then route to `archive`.
- `openLiveShowProfile(altid, trigger)` — open that row in the normal Show profile.
- A generalized source-conflict predicate replacing or extending `sheetHasDifferentPlayer(mp3)` so live ownership also produces `instead` labels.

Keep history behavior consistent with existing modal rules: one browser-history entry per modal opening, internal Show/Archive navigation inside that entry, and no unexpected walk through every show visited.

## Rollover rules

When the schedule advances while the Live Player is visible:

- Repaint the current show's identity and retarget its Past episodes pill to the new current `altid`.
- Repaint and retarget Up next to the new `next.altid`.
- Preserve current live playback; a metadata rollover is not a transport restart.
- If the About this show overlay is open, keep the existing behavior of repainting it rather than closing it mid-read.

When the user is already browsing a Show profile or Past episodes:

- Do **not** replace or yank that browsing context to the newly current live show.
- The visible live transport—page bar or modal dock—may update its title/art as usual.
- Tapping that transport's identity is the deliberate way back to the newly current Live Player.

## Visual hierarchy

1. **Primary audio action:** orange live Play/Pause or archive Play/Resume.
2. **Live source identity:** a compact station-red Live chip and restrained playing motion.
3. **Archive/current audio state:** teal equalizer/status/progress and modest active-row tint.
4. **Navigation:** muted compact pills with adjacent labels and chevrons.
5. **Secondary facts/links:** quiet text and outline controls.

The new controls should consume as little vertical space as possible. On phones, they must not push the live transport or current identity below the useful viewport. Avoid full-width containers unless the touch-target requirement truly needs them; a content-width pill can still have a minimum 44px hit height.

Any intentionally clipped description or scrollable region must retain the application's established visible overflow/fade cue. Do not create a new silent cutoff.

## Accessibility requirements

- Use real `<button type="button">` elements for both navigable controls.
- Preserve visible keyboard focus and a minimum 44×44 CSS-pixel touch target.
- The label, chevron, and count should be one hit target—not separate tiny controls.
- Update accessible names whenever current/up-next metadata rolls over.
- Disabled/no-match states must not stay in the Tab order or advertise a destination.
- Every live transport must expose its source and state in its accessible name/status, for example **Live stream playing**, **Live stream paused**, or **Live stream connecting**.
- The live indicator cannot depend on red, glow, or equalizer motion alone; persistent text is required.
- Opening a destination should use the existing modal focus/inert/history lifecycle.
- Back and close must restore focus to a sensible surviving control; rollover may remove the original trigger, so use the same defensive focus approach as the live-info overlay.
- Respect reduced motion.

## Edge cases to test

- Live is playing; open current Past episodes; browse rows; close; live never stops.
- While that archive is open, its modal dock visibly and accessibly says that the global source is Live and controls that same live stream.
- Live is paused but loaded; follow the same route; it remains paused and recoverable.
- Archive is playing; open Live Player without pressing live Play; archive continues until an explicit live start.
- Live is playing; archive primary action reads `… instead`; press it; exactly one source plays and the UI/Media Session switches to archive.
- An archived episode has saved progress; `Resume … instead` and Start over remain correct.
- Current show has no archived episodes.
- Up-next show has no archive row.
- Built-in/fallback snapshot has names but no stable IDs.
- Current show rolls over while Live Player is open.
- Current show rolls over while Show profile/Past episodes is open.
- Archive retention/count changes between polls/page loads.
- Long show/host names, missing host, missing artwork, and four common viewport classes: small phone, large phone, tablet, desktop.
- Song metadata is present on a phone; the bottom player still visibly says Live.
- Playing, paused, connecting, errored, and reduced-motion states retain correct live-source identity without misleading animation.
- Keyboard-only navigation, VoiceOver/TalkBack naming, focus return, reduced motion, and 200% zoom.
- Browser Back from Show/Past episodes returns predictably without stopping audio.

## Test plan

Run existing suites before and after the change:

- `test/episode-rail/` — current modal/archive contract (72 checks at this checkpoint).
- `test/schedule/` — live schedule chooser/history contract (32 checks at this checkpoint).
- `test/ui/live-info-tests.js` — artwork/About this show behavior (54 assertions according to current docs).
- `test/live-stream/` — real live-state transitions using its fake true-live source; include strict mode.

Add cross-surface coverage for:

1. exact current and next `altid` resolution;
2. no-match/snapshot behavior;
3. current Past episodes direct routing and Up next profile routing;
4. unchanged live playback during every navigation-only action;
5. explicit `instead` copy and source takeover;
6. rollover retargeting without hijacking an open archive;
7. global player identity returning to Live Player;
8. the same visible/accessibly named Live state in the full player, modal dock, and page bar at every responsive breakpoint.

Do not start the real WBAI stream in automated or production smoke tests. Use the fake live-stream harness with muted browser audio. Human device testing should verify actual sound separately.

## Relevant files

- `public/index.html` — Live Player, About this show panel, Show modal, modal archive dock, global player bar.
- `public/app.js` — live metadata paint/routing, player ownership, show/archive routing, source labels, history and focus.
- `public/styles.css` — Live Player, compact pills, responsive modal/player behavior, state hierarchy.
- `server.js` — `/api/nowplaying`; forward `next.altid` here.
- `docs/show-modal-archive.md` — completed archive-modal design and UX decisions.
- `docs/modal-live-audio-player.md` — useful background, but parts describe older behavior; verify claims against current code.
- `docs/big-audio-bug.md` and `docs/live-audio-pattern.md` — authoritative live transport constraints.
- `docs/schedule-dev.md` — current/up-next schedule and chooser behavior.
- `docs/ARCHITECTURE.md`, `docs/UPSTREAM.md`, `docs/DEVELOPMENT.md` — data identities, feeds, and development workflow.

## Non-goals for the first pass

- Do not redesign the spacious Live Player wholesale.
- Do not merge live shows and archived episodes into one long feed.
- Do not autoplay audio because the user navigated.
- Do not introduce two visible transports for the same live source.
- Do not make the artwork's “Show info” promise ambiguous.
- Do not use title similarity to manufacture links.
- Do not change the proven live connection lifecycle while adding navigation.
- Do not branch, push, or deploy unless the user explicitly requests it. Development in this repository stays on `main`, with Git as the rollback point.

## Acceptance criteria

- A user can identify and open the current show's Past episodes from Live Player in one clear action.
- A user can open the up-next show's profile from its existing compact row.
- Artwork still opens only About this show.
- Live audio continues through Show profile and Past episodes navigation.
- The page bar and the modal's projection of it provide a clear route back to Live Player.
- Full Live Player, Show/Archive modal dock, and bottom page player all show a restrained but unmistakable text-based Live identity whenever live owns the transport.
- Playing may use a soft glow/equalizer; paused and reduced-motion states remain equally understandable without animation.
- Archive playback warns with `instead` when it will replace live audio.
- No navigation action starts, pauses, or replaces audio.
- Current/up-next rollover updates Live Player links but never hijacks a modal being browsed.
- Exact IDs determine show routing; unavailable or ambiguous routes fail quietly and honestly.
- Listening progress, active/played states, retention, focus, history, responsive overflow cues, and Media Session remain correct.
- Existing suites pass and new cross-surface tests cover the integration.

## Recommended order of work

1. Confirm current UI and transport baselines locally; record screenshots at phone/tablet/desktop sizes.
2. Add `next.altid` to the API contract and exact-ID archive-row lookup helpers with unit/UI tests.
3. Add the compact current **Past episodes** pill and interactive **Up next** row without changing audio.
4. Unify the station-red Live marker across the full player and page bar, then extend the existing modal dock to project that same live transport while the page bar is covered.
5. Generalize `instead` source-conflict copy to include live ownership.
6. Exercise rollover, modal history, focus, visible-transport return, and all source transitions.
7. Run the full relevant local suites and a production-safe smoke audit only when deployment is requested.
8. Update the relevant feature/development docs with the final behavior and verified counts.

## Decision summary

The cleanest solution is not a larger navigation system. It is two small, semantically precise routes inside Live Player, plus one stronger audio invariant:

- artwork = **Show info**;
- current-show pill = **Past episodes**;
- Up next row = **next show's profile**;
- visible page bar or modal dock = **the same live transport and return to full live controls**;
- compact station-red **Live** marker = **source identity on every player surface**;
- orange archive action with **instead** = **the only source switch**.

That division keeps the interface calm while making every destination and every playback consequence explicit.
