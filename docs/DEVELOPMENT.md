# Development

How this codebase works. **Everything described in this file is built and
running** — if the text disagrees with the app, the text is wrong and should be
fixed. For things that don't exist yet, see [ROADMAP.md](ROADMAP.md); nothing
proposed or rejected is documented here.

See also: [README](../README.md) for what the project is, [ARCHITECTURE.md](ARCHITECTURE.md)
for why the server exists, [DEPLOYMENT.md](DEPLOYMENT.md) for shipping it, and
[TAURI.md](TAURI.md) for the desktop builds (scaffolded, not yet built).

## What the app does today

- Lists ~500 recent WBAI broadcasts with search, category filters, sorting, and
  a list or gallery layout.
- Plays archived shows in a persistent bottom player, and the 99.5 FM live
  stream from the header.
- Opens a show info sheet with artwork, host, description, air date, retention,
  and the show's own links.
- Publishes to the OS media session — lock screen, macOS Now Playing, car
  displays — with working transport controls.
- Offers ±15s skip in the player bar, and Space / ←/→ keyboard shortcuts.
- Remembers where you stopped in each episode and offers to resume.
- Installs as a PWA: home-screen icon, standalone launch, category shortcuts.
- Puts search, category and the open show in the URL, so views are linkable and
  the Back button closes the sheet.

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
| `public/manifest.webmanifest` | PWA metadata — name, icons, colors, `display` |
| `public/data/shows-fallback.json` | Offline snapshot served when the upstream scrape fails |
| `data/` | Runtime caches (`programs.json`, `showinfo.json`). Gitignored, rebuildable, safe to delete |

`app.js` is organized into commented sections. In source order:

1. Category table + state (search, filter, sort, list/grid view)
2. **URL state** — query-string reflection, history, deep links
3. Infinite scroll (`PAGE_SIZE` pages appended via `IntersectionObserver`)
4. Rendering (`renderList` for the table, `renderCards` for the gallery)
5. **Persistent audio player** — the bottom bar for archived shows
6. **Resume position** — per-episode `localStorage` offsets and the restore UI
7. **Header live stream + on-air metadata** — the appbar player
8. **Media Session** — lock screen, hardware keys, car displays
9. Now-playing poll, archive fetch
10. **Show info sheet** — the modal, its data merge, and title matching
11. Slide-out menu

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
- **Check every feature against rotation.** The archive is a moving window:
  broadcasts arrive daily and leave on retention timers between roughly 3 and 60
  days, and the row `id` belongs to upstream. Anything keyed to a specific
  episode goes stale on its own — the failure mode isn't a crash, it's something
  that quietly becomes wrong weeks after you verified it. Either key on
  something durable (resume position uses the mp3 URL and prunes) or give it an
  explicit fallback (`?show=` has `#linkNotice`). This is why manifest
  `screenshots` aren't shipped: they would bake dated broadcasts into the repo.

### Caching gotcha: no build step means no cache busting

`app.js` is always `app.js` — there is no build step, so there are no
content-hashed filenames. That makes browser caching a correctness problem, not
a performance one: a plain `max-age` on the source files lets a browser keep
running the *previous* version for the length of the timer, and nothing makes it
visible, because `index.html` revalidates and so the page looks current while
the behaviour is a version behind.

`serveStatic()` therefore sends `no-cache` **plus an ETag** for `.html`, `.js`,
`.css`, `.json` and `.webmanifest`, and a real TTL only for `/assets/`. This is
not "don't cache" — it is "ask first", answered by a 304 with no body.

**If you are debugging a front-end change that appears to do nothing, hard-reload
before you debug the code.** This cost an afternoon once: the resume-position
feature was verified working in a fresh browser while the machine that reported
it broken was running an hour-old `app.js` that had never contained it.

### CSS gotcha: bare state-class selectors

`app.js` toggles state classes like `loading` and `playing` directly onto
buttons. A bare `.loading { … }` rule therefore matches *every* play button
mid-buffer, not just the panel you wrote it for. This shipped once: the archive
load panel's `.loading` rule carried `padding: 4rem`, which inflated the live
play button to ~128px the moment anyone pressed play.

**Rule:** state classes are only ever styled with a scoping prefix —
`.live-play.loading`, `.play-btn.loading`. Standalone components get their own
noun-y class (`.loading-panel`), never a bare state word.

## How each feature works

### Show info sheet

**What it does:** clicking a show's title, its category line, or **More** opens
a modal with artwork, host, description, air date, retention, the show's links,
and its own play button and scrubber.

The modal that opens from a show's title, its category line, or the **More**
link. Six things about it are load-bearing:

1. **Empty fields are not rendered.** Every block — host, description, each
   fact, each link — is emitted only when its value is non-empty. WBAI documents
   its shows very unevenly; that one filter is why a thinly documented show gets
   a compact sheet instead of labelled blanks. Don't add a block that renders a
   placeholder or an em dash.
2. **The footer is two rows, links above transport.** Secondary links sit in
   `.sheet-links` (small pills) *above* `.sheet-actions` (Play/Resume and Start
   over), so the primary control keeps a fixed position however many links a
   show happens to have. Before the split, a well-documented show pushed Play
   onto a second line while a thin one left it first.
3. **Facts are one wrapping row, not stacked pairs.** `.sheet-facts` renders
   Aired, Length and the retention pill inline. As three labelled rows they
   pushed availability under the pinned footer on a long title, where it read as
   missing rather than scrolled-away. The retention pill says "59 days left" on
   its own, so it carries no label, and `shortDateText()` abbreviates the
   weekday and month that upstream spells out in full.
4. **Controls live outside the scroll area.** `.sheet-body` scrolls; `.sheet-foot`
   (Play/Pause, links, scrubber) is pinned. Democracy Now!'s description runs to
   a dozen paragraphs — before the split it pushed the Play button below the
   fold. The description itself is CSS line-clamped, and `setupDescClamp()` adds
   the *Show more* toggle only when the text actually overflows (measured after
   paint, not guessed from length).
5. **The sheet's scrubber is the player bar's scrubber.** `scrubs()` returns
   every scrubber currently in the DOM, and `applyDuration()` / `paintScrubTime()`
   / `resetScrubber()` / `bindRange()` all operate over that list. Adding a third
   one anywhere means adding it to `scrubs()`, nothing else. The sheet's copy is
   hidden unless its episode is the one loaded in the `<audio>` element.
6. **Buttons can't nest.** In list rows the title block is a `<button>` and the
   play control is its sibling. In gallery cards the artwork *is* the play button,
   so the title overlay and More link are siblings positioned on top of it inside
   `.card-wrap` — which is also why the card's hover states key off
   `.card-wrap:hover` rather than the card button's own `:hover`.

#### Title matching

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

### Resume position

**What it does:** the player remembers how far into each episode you got and
picks up there on replay, with *Start over* available whenever you'd rather not.

Where you stopped in a two-hour talk broadcast is worth more than anything else
the player remembers, so positions survive reloads in `localStorage` under
`wbai-resume`. Four decisions are load-bearing:

1. **Keyed by mp3 URL.** The archive hands out no stable episode id, and the URL
   is both unique per episode and gone from the listing at the moment the episode
   rotates out. Nothing upstream ever tells us an entry is dead, so the map is
   pruned to the `RESUME_MAX` most recently touched entries as it grows.
2. **Two thresholds decide what counts as a place.** Under `RESUME_MIN` (30s) is
   not yet a place worth returning to; within `RESUME_TAIL` (60s) of the end is
   finished, not paused. Both cases *delete* the entry rather than storing it, so
   an episode heard to the end offers Play, not Resume, next time.
3. **The restore is spent in `loadedmetadata`, not `playTrack()`.** `playTrack()`
   parks the offset in `pendingResume`; the handler applies it once a duration
   exists to sanity-check it against. Seeking before metadata lands is silently
   dropped, and a stored offset past the end would put the listener nowhere.
4. **Saves are throttled, but not only throttled.** `timeupdate` fires ~4×/sec
   and writes at most every 5s; `pause`, `pagehide` and the player bar's close
   button each force one. The close button in particular has to save *before*
   `audio.pause()`, because the `pause` event is async and by the time it fires
   `nowPlaying` is cleared and `load()` has reset `currentTime` to 0.

The affordance is in two places. The player bar floats a **resume toast** for
nine seconds after a restore — anchored to the bar's top edge, not added to its
flex row, so restoring a position never changes the bar's height. The info sheet
turns its Play button into *Resume 42:15* (via `playLabelFor()`, which
`updatePlayButtons()` calls on every state change) and reveals a **Start over**
button beside it. That button is always rendered and toggled by
`syncSheetRestart()`, so pausing with the sheet open makes it appear in place
rather than on the next repaint.

### PWA

**What it does:** the app installs to a phone or desktop home screen with a real
icon, launches standalone without browser chrome, and offers category shortcuts
from its icon.

`manifest.webmanifest` plus `theme-color`, `apple-touch-icon` and the
`mobile-web-app-capable` pair. This gives a real home-screen icon, a standalone
launch, and mobile browser chrome tinted to match the appbar in both themes.

- **No service worker, deliberately.** The listing is a live proxy of an archive
  that rotates constantly; a cached copy would mostly serve shows that are gone.
  The cost is that Chrome on Android won't fire its automatic install prompt —
  the browser menu's *Install app* / *Add to Home screen* still works, and iOS
  Add to Home Screen is unaffected. Don't add one to chase the prompt.
- **`any` and `maskable` are different files, and must stay that way.** The
  station mark is a full-bleed square with the letters W/B/A/I running to its
  edges. Declared `maskable` it would be cropped by Android's mask, so the
  maskable entries point at `icon-maskable-*.png`: the same mark scaled to ~59%
  and padded to the canvas with `--surface-0`, which keeps it inside the central
  safe zone. Regenerate them with `sips` if the mark ever changes:

  ```bash
  cd public/assets
  sips -Z 512 app_icon_1024.png --out icon-512.png
  sips -Z 192 app_icon_1024.png --out icon-192.png
  sips -Z 300 app_icon_1024.png --out /tmp/m.png
  sips -p 512 512 --padColor 14100F /tmp/m.png --out icon-maskable-512.png
  ```
- **192 and 512 are the sizes that matter.** Chrome's install dialog and the
  Android launcher reach for exactly those; anything else gets rescaled.
- **`.webmanifest` needs its MIME entry in `server.js`.** Browsers reject a
  manifest served as `application/octet-stream`, and the failure is quiet — the
  page works, the install affordance just never appears.
- `theme-color` ships twice, once per `prefers-color-scheme`, matching the
  appbar's `--surface-1` in each theme. A new appbar color means updating both.
- **Two names, on purpose.** The app title is *WBAI 99.5 FM Archive* — the
  manifest's `name` and the `<title>`. `short_name` and
  `apple-mobile-web-app-title` stay *WBAI Archive*, because those are the
  home-screen labels and both platforms truncate them to roughly twelve
  characters. Renaming one without the others is what makes an icon read
  "WBAI 99.5 F…".

### URL state and deep links

**What it does:** any view can be linked or shared, manifest shortcuts land on a
category, and the system Back button closes the info sheet instead of leaving
the app.

Search, category, and the open sheet live in the query string; the list/grid
view deliberately does not, because it is a per-device preference in
`localStorage` and a shared link should not impose the sharer's layout.

- **Filters replace, the sheet pushes.** `syncUrl()` uses `replaceState` for
  category and search, so one press of Back means "close the sheet", not "undo
  six keystrokes of searching". Only `openSheetById()` pushes — and only when the
  sheet wasn't already open, so switching shows from the player bar replaces
  rather than stacking entries.
- **Closing always goes through history.** `closeSheet()` calls `history.back()`
  and lets `popstate` run `dismissSheet()`, which does the real work. Closing by
  button without that would leave a live entry for Back to replay. Escape, the
  close button, and the scrim all route through `closeSheet()`.
- **This is the whole back story in standalone mode.** Installed, there is no
  browser chrome, so Android's system Back is the only back affordance. Before
  this, it exited the app while the sheet was open.
- **`cat` is validated against `CAT_BY_KEY`, never trusted.** An unknown value
  falls back to "all" rather than filtering to nothing.

#### Deep links are perishable — by design

`?show=<id>` names an upstream archive row, and rows leave the archive when
their retention window closes (3–60 days). A shared link is therefore valid for
days, not forever. `openDeepLink()` runs once, after `ingest()`:

- **Episode still present** → the landing entry is rewritten to the plain
  listing and the sheet is pushed on top, so Back lands on the archive rather
  than leaving the site.
- **Episode gone** → `#linkNotice` explains that it rotated out, and the dead id
  is dropped from the URL so a reload is clean. It does not error, and it does
  not show an empty sheet.

Share links are built bare — `?show=<id>` only, without whatever category or
search the sharer had applied. The recipient wants the episode, not the filters.
The Share button is rendered only where `navigator.share` exists, following the
sheet's rule that nothing appears as an inert placeholder.

### Media Session

**What it does:** the current show's title, host and artwork appear on iOS and
Android lock screens, macOS Now Playing, and car head units, with play/pause,
±15s, scrubbing and next/previous.

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

#### Transport controls and shortcuts

The same `seekBy()` and `SKIP_SECONDS` back three surfaces, so they can never
drift apart: the lock screen handlers, the player bar's ±15s buttons, and the
keyboard. `togglePlayback()` is likewise shared by the bar's play button and the
Space key, and picks whichever player currently owns the bar — archive if a
track is loaded, otherwise the live stream.

The keyboard handler must refuse three cases, and does:

1. **Typing.** `INPUT`, `TEXTAREA`, `SELECT` and `contenteditable` return early,
   so Space in the search field types a space. This also covers the scrubber,
   which is an `<input type="range">` and keeps its own arrow-key behaviour.
2. **Modifier combinations**, which belong to the browser or the OS.
3. **Space or Enter on a focused button or link**, which belongs to that control.

Space calls `preventDefault()` only once it has decided to act — otherwise it
would swallow the page scroll it is supposed to leave alone.

Below 420px the skip buttons are hidden; the bar runs out of room before they
stop being worth their width, and the lock screen still has them.

#### `navigator.audioSession`

Safari 17+ only. `claimAudioSession()` sets `.type = 'playback'`, which tells
iOS this is primary media rather than an incidental sound — the difference
between continuing in the background and being ducked or stopped, and whether
the ringer switch silences it. Feature-detected, wrapped in try/catch, and
re-asserted on every `play` on both elements, because a session claimed before
any playback has begun does not reliably survive.

#### Testing it

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

#### Driving a browser to test UI — don't start audio

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
