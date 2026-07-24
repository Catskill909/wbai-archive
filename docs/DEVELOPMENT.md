# Development

Working notes for people changing this codebase. For *what the project is*, see
the [README](../README.md); for *why the server exists*, see
[ARCHITECTURE.md](ARCHITECTURE.md); for shipping it, see
[DEPLOYMENT.md](DEPLOYMENT.md).

## Setup

Node 18+ (for built-in `fetch`). There is **no build step and no dependencies** —
edit the files in `public/` and reload.

```bash
npm start                 # → http://localhost:8080
PORT=3000 npm start       # different port
```

Nothing is minified, bundled, or transpiled. If you find yourself wanting a
build step, that's a decision to make deliberately — the zero-dependency,
zero-toolchain property is a feature of this project, not an accident.

## Code map

| File | What lives there |
| --- | --- |
| `server.js` | Static file serving, the upstream proxies, in-memory + on-disk caching, CSP/security headers |
| `public/index.html` | All markup — one page, no templating |
| `public/styles.css` | All styles. Design tokens at the top, then sections in rough page order |
| `public/app.js` | All front-end logic, wrapped in one IIFE |
| `public/data/shows-fallback.json` | Offline snapshot served when the upstream scrape fails |
| `data/` | Runtime caches (`programs.json`, `showinfo.json`). Gitignored, rebuildable, safe to delete |

`app.js` is organized into commented sections. In source order:

1. Category table + state (search, filter, sort, list/grid view)
2. Infinite scroll (`PAGE_SIZE` pages appended via `IntersectionObserver`)
3. Rendering (`renderList` for the table, `renderCards` for the gallery)
4. **Persistent audio player** — the bottom bar for archived shows
5. **Header live stream + on-air metadata** — the appbar player
6. **Media Session** — lock screen, hardware keys, car displays
7. Now-playing poll, archive fetch
8. **Show info sheet** — the modal, its data merge, and title matching
9. Slide-out menu

## Conventions

- **Vanilla, ES5-flavored JS.** `var`, `function`, no arrow functions or
  template literals. It runs unprocessed in every browser we care about.
- **Design tokens over literals.** Colors, shadows, and elevation live as CSS
  custom properties in the four theme blocks at the top of `styles.css`
  (`:root`, `prefers-color-scheme: light`, and the two `[data-theme]` overrides).
  A new color or shadow belongs in **all four**, not inline in a rule.
- **Escape everything interpolated into HTML.** Rendering is string
  concatenation; `esc()` exists for this reason. Any show-supplied text
  (`title`, `host`) must go through it.
- **The server never trusts upstream shapes.** Parsers degrade to the snapshot
  rather than throwing.

### CSS gotcha: bare state-class selectors

`app.js` toggles state classes like `loading` and `playing` directly onto
buttons. A bare `.loading { … }` rule therefore matches *every* play button
mid-buffer, not just the panel you wrote it for. This shipped once: the archive
load panel's `.loading` rule carried `padding: 4rem`, which inflated the live
play button to ~128px the moment anyone pressed play.

**Rule:** state classes are only ever styled with a scoping prefix —
`.live-play.loading`, `.play-btn.loading`. Standalone components get their own
noun-y class (`.loading-panel`), never a bare state word.

## Show info sheet

The modal that opens from a show's title, its category line, or the **More**
link. Four things about it are load-bearing:

1. **Empty fields are not rendered.** Every block — host, description, each meta
   row, each link — is emitted only when its value is non-empty. WBAI documents
   its shows very unevenly; that one filter is why a thinly documented show gets
   a compact sheet instead of labelled blanks. Don't add a block that renders a
   placeholder or an em dash.
2. **Controls live outside the scroll area.** `.sheet-body` scrolls; `.sheet-foot`
   (Play/Pause, links, scrubber) is pinned. Democracy Now!'s description runs to
   a dozen paragraphs — before the split it pushed the Play button below the
   fold. The description itself is CSS line-clamped, and `setupDescClamp()` adds
   the *Show more* toggle only when the text actually overflows (measured after
   paint, not guessed from length).
3. **The sheet's scrubber is the player bar's scrubber.** `scrubs()` returns
   every scrubber currently in the DOM, and `applyDuration()` / `paintScrubTime()`
   / `resetScrubber()` / `bindRange()` all operate over that list. Adding a third
   one anywhere means adding it to `scrubs()`, nothing else. The sheet's copy is
   hidden unless its episode is the one loaded in the `<audio>` element.
4. **Buttons can't nest.** In list rows the title block is a `<button>` and the
   play control is its sibling. In gallery cards the artwork *is* the play button,
   so the title overlay and More link are siblings positioned on top of it inside
   `.card-wrap` — which is also why the card's hover states key off
   `.card-wrap:hover` rather than the card button's own `:hover`.

### Title matching

`programFor()` maps an archive row's title onto a wbai.org program record. The
two systems share no id, only the show's name, and they spell it differently
often enough that exact matching covers about three quarters of the archive. The
tiers — exact, ignore-spacing, qualifier prefix, equal word-sets minus filler
words, then Dice ≥ 0.72 — get it to ~477 of 535 rows with no false positives at
the time of writing.

If you change a threshold or the `FILLER` list, **re-measure**: pull
`/api/programs` and `/api/archive`, run the matcher over every distinct title,
and read the fuzzy hits by eye. A wrong description on a show is worse than no
description.

## Media Session

Both the archive player and the live stream feed one OS-level media session
(lock screen on iOS/Android, Now Playing on macOS, the media hub in Chrome, and
the head unit over Bluetooth/CarPlay). The module owns four rules — breaking any
of them produces a session that looks fine on desktop and wrong on a phone:

1. **Publish metadata on the `play` event, not before.** iOS Safari can
   overwrite session metadata that was set before playback was initiated, so
   `activateArchiveSession()` is called from `audio`'s `play` handler rather
   than from `playTrack()`.
2. **Artwork must be same-origin.** Cross-origin artwork without CORS headers is
   dropped silently by the OS. Show photos qualify because they come through our
   own `/pix/` proxy. They're also small (`*_med_*.jpg` is ~191px), so
   `artworkFor()` always appends the 256px and 1024px station icons — the OS
   falls through to the next entry when one is missing or fails to decode.
3. **Position state is archive-only.** `setPositionState()` throws a `TypeError`
   on a non-finite duration or a position past the end, and a live stream has
   neither a duration nor a meaningful position. `updatePositionState()` clears
   the state entirely whenever the mode isn't `archive`, so the OS doesn't draw
   a scrubber that can't work.
4. **`mediaMode` owns handler binding.** Two `<audio>` elements share one
   session, so switching between live and archive re-binds every action handler,
   including **nulling** `seekto` / `seekbackward` / `seekforward` /
   `previoustrack` / `nexttrack` for live. Anything left bound from the previous
   mode keeps showing up in the OS UI.

`previoustrack` / `nexttrack` step through `filtered` — the list as currently
searched, filtered, and sorted — so a headset button follows what the user is
actually looking at, not the raw archive order.

The live session's metadata is refreshed from the now-playing poll (every 15s),
so the lock screen re-titles itself as the schedule rolls over mid-listen.

### Testing it

Media Session cannot be verified in a desktop devtools window alone. To test
properly:

```bash
PORT=8080 npm start
# find your LAN IP, then open http://<lan-ip>:8080 on a phone
ipconfig getifaddr en0        # macOS
```

- **iOS** (15+): start playback, lock the phone. Check title, host line,
  artwork, the scrubber (archive only, absent for live), and that the lock
  screen retitles when the on-air show changes.
- **macOS**: the Now Playing widget in Control Center mirrors the same data;
  the F8 key and AirPods stem exercise the action handlers.
- **Chrome desktop**: the media hub button in the toolbar shows metadata and
  seek controls without needing a device.
- **Android Chrome**: notification shade + lock screen.

Worth checking on each change: switching live → archive → live, and closing the
player bar (which must clear the session, not leave a dead entry on the lock
screen).

### Driving a browser to test UI — don't start audio

If you script a headless browser against this app (DevTools protocol, Playwright,
whatever), **do not pass `--autoplay-policy=no-user-gesture-required` and do not
script clicks on Play.** This app publishes Media Session metadata as soon as
playback begins, so a scripted click in a browser you can't see will start
streaming a WBAI episode *and* register a Now Playing entry in the macOS menu
bar — which keeps playing after the script exits, after the server is stopped
(the MP3s come straight from `archive2.wbai.org`, not through us), and long after
you've forgotten the window exists. This happened during development and was not
obvious to diagnose from the outside.

Verify player UI by asserting on state instead: that `.sheet-scrub` exists and
un-hides, that `data-mp3` is on the button, that `updatePlayButtons()` swapped
the glyph. Launch with `--mute-audio`, and kill the browser by its
`--user-data-dir` when you're done.

## Roadmap

Ordered by value, not effort. Each is independent.

### Resume position

Persist `currentTime` per mp3 in `localStorage`, restore on replay, and surface
a "resume / start over" affordance. These are 1–2 hour talk broadcasts —
losing your place is the most consequential gap left in the player.

### Playback rate

1× / 1.25× / 1.5× / 2× control on the archive player. Talk radio benefits
disproportionately. Feed the rate into `setPositionState({playbackRate})` or
the lock screen's remaining-time countdown goes wrong.

### PWA basics

There is no manifest, no `apple-touch-icon`, and no `theme-color` yet. Adding
them makes the app installable, gives it a real home-screen icon, and tints the
mobile browser chrome to match the appbar. Icons already exist in
`public/assets/`. A service worker is **not** part of this — the archive is a
live proxy and caching it offline would mostly serve stale listings.

### `navigator.audioSession`

Safari 17+ exposes `navigator.audioSession.type`. Setting it to `'playback'`
(feature-detected) tells iOS this is primary media rather than an incidental
sound, which improves background and silent-switch behavior. Small, guarded,
worth doing alongside the PWA work.

### Keyboard shortcuts

Space = play/pause, ←/→ = ±15s, in line with the `SKIP_SECONDS` constant the
Media Session handlers already use. Must not fire while focus is in the search
field.

### Skip buttons in the player bar

±15s controls in the UI itself, reusing `seekBy()`. Currently those actions
exist only on the lock screen, which is backwards.
