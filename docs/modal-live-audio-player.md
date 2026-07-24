# Modal Live Audio Player — spec & plan

**Status:** proposal. Nothing here is built. This document specifies a redesign of
the header live-stream affordance and the modal player it opens. It follows the
conventions already in the codebase — the `.sheet` dialog pattern, the shared
`liveAudio` element, the on-air metadata pipeline, and the design tokens in
[`public/styles.css`](../public/styles.css). Read
[ARCHITECTURE.md](ARCHITECTURE.md) first for the data flow.

---

## 1. Goal

Replace the wide header **live-strip** with a compact **On Air** button that sits
beside Donate and matches its weight, and move the live listening experience into
a **beautiful, size-responsive modal audio player** — a full-feature player for
the live stream, with rich now-playing metadata lifted from the same data the
cards and the info sheet already use.

Today the strip does three jobs in one cramped control: it shows now-playing text,
shows the show photo, and toggles playback inline. That crowds the appbar on
desktop and collapses awkwardly on mobile. The redesign splits those jobs:

- **Trigger** — a small, self-contained *On Air* button (a live indicator + label).
- **Experience** — a modal overlay that presents the current show as a proper
  "now playing" screen with transport controls, artwork, up-next, and station
  links.

## 2. What changes, at a glance

| | Today | After |
| --- | --- | --- |
| Header control | `.live-strip` (~420px wide, art + 2 lines of text + play) | `.on-air-btn` compact pill next to Donate |
| Where you play | Inline, in the header | In the modal, with real transport |
| Now-playing detail | Two truncated lines | Full artwork, title, host, times, up-next, progress |
| Footprint on mobile | Competes with brand + donate | One pill; full detail on demand |

The underlying audio does **not** change: the modal drives the same
`#liveAudio` element and the same `toggleLive()`/media-session plumbing that the
strip drives today. This is a presentation redesign, not a new player.

## 3. Non-goals

- **No scrubbing / seek bar.** It is a live stream; there is no timeline to seek.
  "Progress" is only the elapsed position *within the currently airing show*,
  derived from its `start`/`end` times, and is read-only.
- **No change to the archive player** (`#mainAudio`, `.player-bar`). The two
  players already share one OS media session via `mediaMode`; that stays.
- **No new endpoints.** Everything the modal shows comes from `/api/nowplaying`
  (with the `NOWPLAYING_SNAPSHOT` fallback) and the station artwork already in
  `/assets`.
- **No feed / file handoff.** Consistent with the "won't do" policy in
  [ROADMAP.md](ROADMAP.md): the live stream stays inside the app; the only
  outbound link is the existing `wbai.org/listen-live/` fallback.

---

## 4. The trigger: the On Air button

Replaces `.live-strip` in `.appbar-actions`, placed **before** the Donate button
so the reading order is *listen → support*.

### Markup (proposed)

```html
<button class="on-air-btn" id="onAirBtn" type="button"
        aria-haspopup="dialog" aria-controls="livePlayer" aria-expanded="false"
        aria-label="Open live player — On Air now">
  <span class="on-air-dot" aria-hidden="true"></span>
  <span class="on-air-label">On Air</span>
  <!-- tiny state glyph: pulses when the stream is playing -->
  <span class="on-air-eq" aria-hidden="true"><i></i><i></i><i></i></span>
</button>
```

### Behavior

- **Idle:** red pulsing dot (`--accent`) + "On Air" label. Reads as a live badge,
  not a play button — the play decision happens in the modal.
- **While the stream is playing** (even with the modal closed): the three-bar
  equalizer animates, so the button doubles as a persistent "you are listening"
  indicator. `aria-label` updates to "Live stream playing — open player".
- **Click:** opens the modal (§5). **Never auto-starts audio** — the user presses
  play inside. Opening is inspection; playing is always a separate, deliberate tap.
- **`aria-expanded`** tracks modal open/closed; focus moves into the modal on open
  and returns to the button on close.

### Visual language

Match the Donate button's construction so the two read as a pair, but in the
**accent/on-air** family rather than the donate red-brown:

- Same pill geometry: `padding:.4rem .95rem`, `--font-display`, uppercase,
  `letter-spacing:.09em`, `font-size:.72rem`.
- Same elevation + inset-highlight recipe (`box-shadow` with an
  `inset 0 1px 0 rgba(255,255,255,.22)`), and the same diagonal sheen `::after`
  sweep on hover.
- Surface: a subtle dark gradient (like `.live-strip` today) rather than a filled
  accent, so it doesn't fight Donate for attention — Donate stays the one filled,
  loud button. The *dot* carries the color.
- `@media (prefers-reduced-motion:reduce)`: no sheen, no pulse, no equalizer
  animation — static dot, static bars.

The compact mobile rules that shrink `.btn-donate` (styles.css ~797) get a
sibling rule for `.on-air-btn`.

---

## 5. The modal player

A centered dialog reusing the **`.sheet` pattern** (scrim + focus-trapped dialog,
Escape to close, scroll-lock) so we inherit its a11y and animation for free. It is
a distinct element — `#livePlayer` — not the show-info `#showSheet`.

### 5.1 Layering

Slots into the existing z-index ladder (styles.css): scrim below dialog, both
above the header and the archive player bar.

| Layer | z-index | Note |
| --- | --- | --- |
| Header | 50 | sticky appbar |
| Archive player bar | 80 | `.player-bar` |
| Menu / drawer | 150–160 | existing |
| **Live-player scrim** | **170** | shared value with `.sheet-scrim` |
| **Live-player dialog** | **180** | shared value with `.sheet` |

Only one modal is open at a time; opening the live player closes the info sheet
and the menu if either is open.

### 5.2 Anatomy

```
┌─────────────────────────────────────────────┐
│  ● ON AIR · WBAI 99.5 FM              [ ✕ ]  │   header: live badge + close
│                                             │
│        ┌───────────────────────┐            │
│        │                       │            │
│        │     show artwork      │            │   large square art (station
│        │      (square)         │            │   mark fallback), soft glow
│        │                       │            │
│        └───────────────────────┘            │
│                                             │
│     Joy of Resistance                       │   title (--font-display)
│     with Fran Luck & Maretta Short          │   host / dj
│     11:00 AM – 12:00 PM                      │   airing window
│                                             │
│     ▓▓▓▓▓▓▓▓░░░░░░░░  ·  32 min in           │   read-only elapsed-in-show bar
│                                             │
│            ( ▶ / ⏸ )      🔊 ──●──           │   transport: play/pause + volume
│                                             │
│     Up next · Frontline Voices · 12:00 PM    │   up-next chip
│                                             │
│     ────────────────────────────────────    │
│     Support WBAI  →   Listen on wbai.org →   │   footer CTAs
└─────────────────────────────────────────────┘
```

### 5.3 Content mapping (reuse, don't reinvent)

Every field comes from the `renderNowPlaying(cur, nxt, isLive)` inputs already
flowing from `/api/nowplaying` / `NOWPLAYING_SNAPSHOT` (app.js ~949–987). We add a
consumer, not a new fetch.

| Modal element | Source field | Notes |
| --- | --- | --- |
| Artwork | `cur.photo` (via `/pix` proxy) | Fall back to `/assets/icon-256.png` — same fallback the strip and media-session artwork use. |
| Title | `cur.name` | |
| Host / DJ | `cur.dj` | Omit the line entirely if empty (matches sheet behavior). |
| Airing window | `cur.start` – `cur.end` | |
| Elapsed bar | derived from `start`/`end` | Read-only; see §5.4. |
| Up next | `nxt.name`, `nxt.start` | Hide chip if `nxt.name` empty. |
| "Snapshot" note | `isLive === false` | When the live fetch is CORS-blocked and we're on the snapshot, show a quiet "schedule may be delayed" hint, mirroring the strip's existing `title` caveat. |

`renderNowPlaying` gets a small extension: after it updates the strip/media-session
today, it also updates the modal's fields **if the modal has been built**. The
modal re-renders live on the existing 15s `setInterval(fetchNowPlaying, …)`, so
the "now playing" screen stays current while open.

### 5.4 The elapsed-in-show bar

Purely informational, since you can't seek a live stream:

- Compute `elapsed = now − showStart`, `total = showEnd − showStart`, both from the
  parsed `start`/`end` clock strings for *today*.
- Fill = `clamp(elapsed / total, 0, 1)`; label "N min in" / "N min left".
- Tick it once a minute (cheap `setInterval` while the modal is open; cleared on
  close), plus recompute whenever `renderNowPlaying` swaps in a new show.
- If times can't be parsed, hide the bar rather than guess.

### 5.5 Transport controls

Drive `#liveAudio` through the **existing** `toggleLive()` path so all the current
guards (pause the archive player first, error → open wbai.org, loading spinner)
are reused unchanged.

- **Play / pause** — big primary control (`--accent` fill, like `.live-play`).
  Bound to `toggleLive()`. Icon reflects `liveAudio.paused`, reusing the swap
  in `setLiveIcon()` (generalize it to update both the strip glyph — if kept —
  and the modal glyph).
- **Volume** — an `<input type="range">` bound to `liveAudio.volume`, persisted to
  `localStorage`. This is genuinely new (the strip has no volume). Hidden on
  iOS/touch where `HTMLMediaElement.volume` is a no-op — feature-detect and drop
  the control there rather than show a dead slider.
- **Loading** — reuse the `.spinner` + `.loading` class approach from `.live-play`.
- **Error** — reuse the `liveErrored` branch: swap the transport for a single
  "Playback blocked — open on wbai.org" button (the existing fallback link).
- **No ±15s skip** — those are archive-only (they act on `#mainAudio`); a live
  stream has nothing to skip to.

### 5.6 States

| State | Trigger | Modal shows |
| --- | --- | --- |
| Idle (not yet played) | modal opened, `!liveLoaded` | Art + metadata, big Play, "Tap play to tune in" |
| Connecting | after play, before `playing` | Spinner in the play button, "Connecting…" |
| Playing | `liveAudio` `playing` event | Pause icon, elapsed bar ticking, equalizer live |
| Paused | `liveAudio` `pause` event | Play icon; metadata stays |
| Error / blocked | `liveAudio` `error` | Fallback CTA to wbai.org (§5.5) |
| Snapshot (offline sync) | `isLive === false` | Quiet "schedule may be delayed" note |

---

## 6. Responsiveness

The overlay must be comfortable from a 320px phone to a wide desktop.

- **Sizing:** `width:min(92vw, 460px)`; `max-height:min(88dvh, 720px)` with the
  body scrolling if content overflows (short landscape phones). Use `dvh`, as
  `.sheet` already does, so mobile browser chrome doesn't clip it.
- **Artwork:** scales with the dialog — `width:min(64vw, 300px)`, `aspect-ratio:1`.
  On very short viewports (`max-height` landscape), switch to a **side-by-side**
  layout (art left, metadata + transport right) via a container query / height
  media query, so the controls stay above the fold.
- **Bottom-sheet on mobile:** reuse the `.sheet` mobile treatment (styles.css
  ~766) — on narrow widths the dialog docks to the bottom and slides up, which is
  the natural place for a player thumb-reach-wise.
- **Reduced motion:** honor `prefers-reduced-motion` for the open animation, the
  equalizer, and the dot pulse (the `.sheet` transitions already gate on it).

---

## 7. Open / close & focus

Follow the `.sheet` lifecycle exactly:

- Open: add `.show` to scrim + dialog, `body` scroll-lock, move focus to the close
  button (or the play button), set `aria-hidden="false"`, `aria-expanded="true"`
  on the trigger.
- Close: Escape, scrim click, or the ✕; restore focus to `#onAirBtn`.
- **Audio keeps playing after close** — closing the modal is *not* stop, so you can
  keep listening while browsing the archive. The On Air button's equalizer keeps
  animating to show the stream is live.
- **The On Air button has two jobs.** While the stream is playing it is a one-click
  **pause** (stop without reopening the modal); while stopped it **opens** the
  modal. Trade-off, accepted: you can't reopen the modal while it's playing — pause
  first, then reopen to see now-playing. The button, when open, sits under the
  scrim, so its click only ever fires with the modal closed.
- **History:** optionally push a history entry on open so Android Back closes the
  modal (matches how the info sheet handles Back). Open question below.

**No auto-streaming.** Opening the modal never starts audio. Playback only begins
when the user taps Play inside the modal — a deliberate, separate gesture from
opening. No surprise sound on open or re-open, ever.

---

## 8. Accessibility

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the modal's
  title (the live badge / show name), focus trap — all inherited from the `.sheet`
  pattern.
- The elapsed bar is decorative/informational: expose the "N min in" as text, not
  as a slider role (it isn't operable).
- Volume slider: proper `aria-label`, keyboard-operable.
- Equalizer and dot are `aria-hidden`; playing state is conveyed in the play
  button's `aria-label` / `aria-pressed`, not by the animation.
- Announce show changes politely: an `aria-live="polite"` region on the title so a
  screen-reader user hears when the airing show rolls over while the modal is open.

---

## 9. Implementation plan

Vanilla JS, no dependencies — same as the rest of `app.js`. Estimated **M**.

**Files touched:** `public/index.html`, `public/app.js`, `public/styles.css`.
Docs: link this file from [ROADMAP.md](ROADMAP.md) "Next up"; on ship, fold the
built behavior into [DEVELOPMENT.md](DEVELOPMENT.md).

### Steps

1. **Markup — trigger.** Replace `.live-strip` (index.html ~34–47) with
   `.on-air-btn`. Keep `#liveAudio` where it is.
2. **Markup — modal.** Add the `#livePlayer` dialog + its scrim near `#showSheet`
   (index.html ~194), mirroring that structure (close button, body, footer).
3. **Styles — button.** Add `.on-air-btn` styles modeled on `.btn-donate`
   (styles.css ~217) but in the on-air/dark-gradient family; add the dot pulse and
   3-bar equalizer keyframes (guarded by reduced-motion).
4. **Styles — modal.** Add `.live-player*` styles reusing `.sheet` scrim/dialog
   mechanics and the responsive rules in §6; large artwork, transport row, footer.
5. **JS — wire the trigger.** `#onAirBtn` opens the modal; manage `aria-expanded`,
   focus, and the equalizer class off the existing `liveAudio` play/pause events.
6. **JS — render into modal.** Extend `renderNowPlaying()` to also paint the modal
   fields when it's built; add the elapsed-bar computation + its 1-min tick
   (start on open, clear on close).
7. **JS — transport.** Bind the modal play/pause to `toggleLive()`; generalize
   `setLiveIcon()`/`setLiveLoading()` to update both surfaces; add the volume
   slider (feature-detected, persisted).
8. **JS — lifecycle.** Open/close/Escape/scrim/focus-return; optional history
   entry; decide the §7 auto-play behavior.
9. **A11y pass + reduced-motion pass.** Verify focus trap, live-region
   announcement, keyboard on volume, and that every animation has a static
   fallback.
10. **QA** across: desktop wide, phone portrait, phone landscape (short height),
    stream playing vs. paused, CORS-blocked snapshot path, and the error/blocked
    fallback.

### Reuse checklist (don't duplicate)

- `toggleLive()` and all its guards — app.js ~733.
- `setLiveIcon`, `setLiveLoading`, `setLivePhoto` — generalize, don't fork.
- `renderNowPlaying` + `fetchNowPlaying` + the 15s interval — app.js ~956–987.
- Media-session / `mediaMode` handling — untouched; both players still share it.
- `.sheet` scrim, focus trap, scroll-lock, mobile bottom-sheet — pattern to copy.
- Design tokens (`--accent`, `--elev-*`, `--font-display`, shadows) — no new colors.

---

## 10. Edge cases

- **Nothing playing + snapshot data:** modal still opens and shows the snapshot
  show; play attempts the real stream (which is what the strip does today).
- **Show rolls over while modal is open:** the 15s poll swaps title/art/times and
  the elapsed bar resets — announced via the live region.
- **Archive track was playing:** pressing live play pauses `#mainAudio` first
  (existing `toggleLive` behavior); no double audio.
- **iOS volume:** slider hidden (OS owns volume); play/pause + lock-screen
  controls still work through the media session.
- **Blocked autoplay / stream error:** fall through to the wbai.org listen-live
  link, reusing `liveErrored`.
- **Reduced motion:** everything animated has a static state.

## 11. Success criteria

- On Air button reads as a peer of Donate, at a fraction of the strip's width.
- Opening the modal shows the current show as richly as a card/info-sheet does.
- Play, pause, and volume work; the button indicates playback with the modal
  closed; audio survives close.
- Looks correct and reachable-by-thumb from 320px up, in light and dark, with and
  without reduced motion.
- No new network endpoints, no new dependencies, no change to archive playback.
