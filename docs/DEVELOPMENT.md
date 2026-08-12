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
- Opens a routed show modal: Show view restores artwork, host, show description,
  the selected broadcast and links; Past episodes replaces it with a listening-
  aware episode browser and an in-modal projection of whichever global audio
  source—live or archive—currently owns playback.
- Publishes to the OS media session — lock screen, macOS Now Playing, car
  displays — with working transport controls.
- Offers ±15s skip in the player bar, and Space / ←/→ keyboard shortcuts.
- Remembers where you stopped in each episode and offers to resume.
- Installs as a PWA: home-screen icon, standalone launch, category shortcuts.
- Puts search, category and the open show in the URL, so views are linkable and
  the Back button closes the sheet.
- Shows the station's week as a tabbed day view, derived from the archive's own
  broadcast times rather than fetched — see
  [Weekly schedule](#weekly-schedule) below.
- Keeps its caches across a redeploy, and can prove it — see
  [Durable storage](#durable-storage) below.
- Offers a password-gated station view at `/studio`, off unless configured — see
  [The studio](#the-studio).

## Setup

Node 18+ (for built-in `fetch`). There is **no build step and no dependencies** —
edit the files in `public/` and reload.

```bash
npm start                 # → http://localhost:8080
PORT=3000 npm start       # different port
npm test                  # storage + studio suites (no browser needed)

STUDIO_PASSWORD=local-dev-password npm start    # …with /studio enabled
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
| `public/studio.css`, `public/studio.js` | The studio's own layout and logic. Public files, inert without a session |
| `admin/login.html`, `admin/studio.html` | The studio's markup. **Outside `public/` on purpose** — anything under `public/` is served to anyone who asks, which would walk straight around the password gate |
| `public/track.js` | Usage beacons. Loaded separately from `app.js` and touches none of it |
| `data/` | Runtime caches (`feeds.json`, `programs.json`, `showinfo.json`) plus `.instance.json` and `stats/YYYY-MM.json`. Set by `DATA_DIR`. The caches are rebuildable; **`stats/` is not** |

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
10. **Show modal + Past episodes** — profile/archive routes, listening memory,
    persistent player dock, data merge, and title matching
11. Slide-out menu
12. **Back to top** — the direction-aware show/hide rule, and the observers that
    publish `--player-h` / `--resume-h` so the button can anchor to the bar

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

## Feature flags — what is switched off

One flag, at the top of `app.js`. It exists so a deliberate product decision can
be reversed in a single line if that decision changes.

### `SHOW_RSS` — off, by policy

**Why.** Access to episodes stays inside the web app and the native apps. No
feeds, no file handoffs — that is what Pacifica's tiered-content plan needs, and
it is a product decision rather than a technical one.

There is a second, smaller reason: WBAI's `getrss.php` answers **HTTP 200 with a
zero-byte body** for every show (checked across five `sho` ids on 2026-07-24), so
the badge and the sheet's *RSS feed* pill both led to a blank page. Nothing that
worked was taken away. But the policy is the operative reason and would hold even
if that endpoint were fixed tomorrow.

**What is still in place.** Everything except the flag:

| Piece | Where | State |
| --- | --- | --- |
| `hasRSS` / `rss` fields | `server.js` → `parseArchive()` | still parsed and served |
| `svgRss()` icon | `app.js` | still defined |
| `.rss-badge` styles | `styles.css` | still present, marked dormant |
| Row badge + sheet pill | `app.js`, both behind `showRss()` | rendered only when the flag is true |

Both surfaces go through the single `showRss()` gate on purpose: with two
independent `r.hasRSS` checks it would be easy to restore one and miss the other.
Verified in both directions — `false` renders 0 badges and 0 `getrss.php` links,
`true` renders 33 of each.

**If the policy changes**, set `var SHOW_RSS = true;` in `app.js`. That is the
whole change. Two things to settle first:

1. **Re-check the upstream**, because the flag was never the fix for it:

   ```bash
   curl -s "https://archive2.wbai.org/getrss.php?id=<sho>" | wc -c
   ```

   A working feed is several KB of XML. Zero bytes means it is still broken, and
   pointing users at it would be worse than offering nothing.

2. **Decide whether to serve our own feeds instead.** The archive data already
   carries everything a valid RSS 2.0 + iTunes feed needs, so a `/rss/<sho>.xml`
   route is roughly 120 lines and no dependencies. See ROADMAP.md § Won't do for
   why that was declined, and what it would take.

### A closed system is a product signal, not an access control

Worth being clear about the limit, so nobody mistakes this for enforcement. The
archive MP3s are served **directly by `archive2.wbai.org`**, never through this
app, and their URLs are necessarily in the page — on every play button's
`data-mp3`, and in the `<audio>` element's `src`. Anyone with devtools open can
read one. Hiding RSS removes the *convenient, subscribable* path to bulk
episodes; it does not and cannot prevent a determined download.

Real access control would mean the audio no longer coming straight from WBAI's
servers — signed or expiring URLs, or a token-checked proxy — which is a change
to their infrastructure, not to this front end.

## How each feature works

### Live Player, show profiles, and the archive

The Live Player keeps three states independent: the surface being viewed, the
source that owns the global player, and the show in browsing context. Opening a
show or Past episodes never changes audio; only a live Play or archive
Play/Resume action can do that.

- Artwork remains exclusively **Show info**. The current show's compact **Past
  episodes** pill resolves `current.altid` to the newest playable archive row and
  opens that exact slug's archive route. The **Up next** row resolves
  `next.altid` and opens that show's profile. Both fail quietly when there is no
  exact playable match; titles never manufacture a route.
- `/api/nowplaying` forwards both current and next `altid`. Client matching trims
  and lowercases only the ID; it does not use fuzzy title matching. Archive
  refresh and the 15-second now-playing poll repaint the routes in place.
- Rollover retargets the Live Player and global live identity, but never replaces
  an already-open show/archive context. The listener deliberately returns to the
  newly current Live Player through the visible player identity.
- Live ownership is written on every visible transport: `Live · WBAI 99.5 FM`
  in the full player, an inline **Live** source chip in the page bar (including
  phone widths), and the same source chip plus Playing/Paused/Connecting state in
  `#sheetPlayerDock`. The dock is a projection of the global transport, not a
  second audio element, and live mode has no scrubber or skip controls.
- Starting live still follows the one-connection/never-reuse contract in
  [live-audio-pattern.md](live-audio-pattern.md). Starting an archive episode is
  the only archive takeover path; when live or another episode owns the player,
  profile and compact archive actions visibly/accessibly say `instead`.

Regression coverage lives in `test/ui/live-archive-tests.js` (exact/no-match
routing, navigation/audio separation, and rollover), `test/ui/live-info-tests.js`
(artwork/About behavior), `test/episode-rail/` (72 show/archive checks), and
`test/live-stream/` (61 default-policy checks including the live modal dock and
explicit archive takeover; also run under strict autoplay policy).

### Show modal and Past episodes

**What it does:** clicking a show's title, category line, or **More** opens the
exact dated broadcast in Show view. Past episodes is an internal route in that
same dialog, not content appended below the profile. See
[show-modal-archive.md](show-modal-archive.md) for the UX audit and
[episode-rail.md](episode-rail.md) for the concise interaction contract.

These rules are load-bearing:

1. **One route owns the body.** `sheetView` is `show` or `archive`. Show view
   renders artwork, title, host, category and the clamped program description;
   Past episodes replaces both profile body and footer with a slug-grouped list.
   It never expands the modal underneath the profile.
2. **The selected broadcast is explicit.** Opening a front card or deep link
   preserves that row. Date, time, length and retention sit under **Selected
   broadcast**, and every primary label names its short date: `Play · Aug 12`,
   `Resume · Aug 12`, `Pause · Aug 12`, or `Loading · Aug 12`.
   On phones the action aligns with the left edge of the broadcast facts. With
   no loaded audio it is solid orange. If another episode is loaded it becomes
   an orange outline and says `Play · Aug 12 instead`; if this broadcast is
   already loaded, the primary action is hidden and the dock owns transport.
3. **Selection and playback stay independent.** Tapping an archive row selects
   it, returns to Show view, updates the URL with `replaceState`, and does not
   load audio. Only the row's separate Play button starts playback; it leaves
   the archive route and scroll position in place.
   `Past episodes`, count, listening summary, and chevron form one centered line
   in a muted pill directly below the show host (or title when host is absent).
   The pill remains a 44px navigation target without creating a third full-width
   footer band. At 360px and below the aggregate summary hides rather than
   wrapping the route.
4. **The modal player owns a stable third region.** `#sheetPlayerDock` is outside
   `.sheet-body` and `.sheet-foot` and mirrors the global source. For archive it
   shows the loaded show's artwork, title and date—not the profile currently
   being browsed. For live it shows current artwork, a persistent Live chip,
   written state, and the same non-seekable transport as the page bar. Browsing
   cannot hide, replace, or move it. Closing/minimizing hands transport back to
   the page player without stopping audio.
5. **Listening history uses progressive disclosure.** Show view reports only
   the selected episode's elapsed/remaining time or `Played`. Past episodes
   summarizes completed/in-progress counts and writes `N% listened`, `Played`,
   `Playing`, `Paused`, or `Loading` per row, with a thin progress bar for a
   partial episode. Untouched episodes remain quiet. Orange is transport/action
   everywhere, including archive play/pause icons and the dock toggle. Teal is
   playback/history state, always paired with text, an equalizer, a check, or a
   bar. The equalizer animates only while audio is actually playing and becomes
   static under reduced motion.
   The active archive row reinforces its written state with a teal edge and an
   11% teal surface wash; do not strengthen it into a filled action treatment.
6. **Descriptions remain program-level.** Priority is showinfo by `sho` slug,
   then the title-matched program directory, then `shortdesc`. Switching dates
   inside one slug intentionally keeps the program description. The feed's
   `episodeDesc` is not rendered as program prose because WBAI usually repeats
   one channel description across its items. Do not manufacture episode notes.
7. **Empty fields are omitted.** WBAI documents programs unevenly; a thin record
   stays compact rather than acquiring placeholders. `/api/programs` and
   `/api/showinfo/<altid>` repaint the currently open profile when their lazy
   lookups land.
8. **Back and Close have different promises.** Visible Back and the first Escape
   return Past episodes to Show view. Close/minimize leaves the modal; a second
   Escape from Show view follows that path. The dialog label follows the active
   route and focus remains trapped in the one dialog.
9. **The responsive information architecture does not fork.** Desktop is capped
   at 800px/88dvh. Phones use a compact intrinsic-height bottom sheet with the
   same routes, scroll body and optional dock. Internal Back and dock controls
   keep the project's 44px coarse-pointer floor.
   On short phones artwork is also capped by viewport height. A measured
   `More show information`/`More episodes` control appears only while content
   really remains below the scroll body, and disappears at the bottom.
10. **Buttons cannot nest.** Archive row details and Play are sibling buttons,
    just as list-row title and Play are. Gallery artwork is the Play button, so
    its title overlay and More link remain sibling controls in `.card-wrap`.

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
   finished, not paused. The early case deletes the entry. The tail stores a
   compact `{done:1}` record: there is no resume offset, but Show/Past episodes
   can honestly mark it `Played`.
3. **The restore is spent in `loadedmetadata`, not `playTrack()`.** `playTrack()`
   parks the offset in `pendingResume`; the handler applies it once a duration
   exists to sanity-check it against. Seeking before metadata lands is silently
   dropped, and a stored offset past the end would put the listener nowhere.
4. **Saves are throttled, but not only throttled.** `timeupdate` fires ~4×/sec
   and writes at most every 5s; `pause`, `pagehide` and the player bar's close
   button each force one. The close button in particular has to save *before*
   `audio.pause()`, because the `pause` event is async and by the time it fires
   `nowPlaying` is cleared and `load()` has reset `currentTime` to 0.

The affordance is in three places. The player bar floats a **resume toast** for
nine seconds after a restore — anchored to the bar's top edge, not added to its
flex row, so restoring a position never changes the bar's height. The info sheet
turns its Play button into a dated *Resume · Aug 12* (via `playLabelFor()`, which
`updatePlayButtons()` calls on every state change) and reveals a **Start over**
button beside it. That button is always rendered and toggled by
`syncSheetRestart()`, so pausing with the sheet open makes it appear in place
rather than on the next repaint. Show view also writes elapsed and remaining
time, while Past episodes exposes compact percentage/completion history.

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
category, and the system Back button closes the show modal instead of leaving
the app.

Search, category, and the open sheet live in the query string; the list/grid
view deliberately does not, because it is a per-device preference in
`localStorage` and a shared link should not impose the sharer's layout.

- **Filters replace; modal destinations push.** `syncUrl()` uses `replaceState` for
  category and search, so one press of Back means "close the sheet", not "undo
  six keystrokes of searching". `openSheetById()` and `openLivePlayer()` push
  their destinations. A show switch inside an already-open sheet still replaces
  rather than stacking entries.
- **Closing always goes through history.** `closeSheet()` calls `history.back()`
  and lets `popstate` run `dismissSheet()`, which does the real work. Closing by
  button without that would leave a live entry for Back to replay. Escape, the
  close button, and the scrim all route through `closeSheet()`.
- **Live → show/archive is a real two-step path.** The chosen sheet is pushed on
  top of `{live:1}`, and its state carries `liveOrigin`. Visible Back and
  browser/device Back therefore restore Live; Forward restores the exact archive
  view. Close/minimize is different from Back: it consumes both owned entries
  with `history.go(-2)` so it cannot reveal a stray Live modal. None of these
  view transitions touches live playback, which remains available in the dock.
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

Verify player UI by asserting on state instead: that `#sheetPlayerDock` appears,
that its scrubber follows the archive element, that `data-mp3` is on the action,
and that `updatePlayButtons()` swapped the glyph. Launch with `--mute-audio`, and kill the browser by its
`--user-data-dir` when you're done.

**The one sanctioned exception, and what it costs to earn.**
`test/episode-rail/rail-tests.js` ("the transport survives choosing another
date") really does click Play, because the bug it guards is *"the audio kept
playing and the listener lost every control for it"* — and there is no way to
assert that against a stopped element. §3a of `CLAUDE.md` is the stronger rule
here: the previous version of this behaviour had a green suite and a broken
screen. If you need the same, take all four precautions or take none of it:

1. `--mute-audio` on the browser (`run.sh` does).
2. A `trap cleanup EXIT` that `pkill`s by `--user-data-dir`, so an assertion
   failure mid-section still kills the stream. This is the one that matters —
   the incident above was a browser that outlived its script.
3. Pause **and** `removeAttribute('src')` at the end of the section, so the tab
   is silent and the Media Session entry is gone before the run even finishes.
4. Confirm afterwards: `ps aux | grep rail-chrome-profile` must be empty.

Everything that does *not* require real playback still asserts on state. Don't
widen this.

### Weekly schedule

**What it does:** shows the station's week as a tabbed day view — day strip on
top, a vertical timeline below it, the on-air show highlighted with a Listen
Live button. Opened from the drawer's Schedule item, and from an appbar chip on
tablet/desktop. Full design history, including every place the plan changed on
contact, is in [schedule-dev.md](schedule-dev.md); this is the code map.

**Nothing fetches it.** `deriveSchedule(rows)` in `app.js` buckets the archive
rows already in memory by (weekday, wall-clock slot) and keeps the most recent
row per normalised title in each bucket. Every broadcast carries its start time
and shows run consecutively, so the week is recoverable from data the app has
already downloaded — no endpoint, no scrape of wbai.org's pixel grid, and
nothing extra for a station deploying this template to run. It reads
`dateText`, which upstream already formats in the station's own wall clock, so
the client needs no timezone of its own.

Two constants carry the measurements behind it: `SCHED_WINDOW_SEC` (6 weeks —
4 and 6 derive identical templates, 8+ resurrects lineups that are off the air)
and `SCHED_SNAP_MIN` (20 — 529/535 rows start exactly on the :00/:30 grid and
the stragglers are 6–14 min late recorder starts).

**The pieces, and the traps in each:**

| | |
|---|---|
| `SCHED_DAYS` | the week, **Sunday-first**. Keys the derived template — rotating it mis-keys every slot. |
| `schedTabDays()` | **display order only**: rotated so today is the first tab. Arrow-key nav walks *this*, not `SCHED_DAYS`. |
| `schedApplyLiveHighlight()` | re-runs on each 15s now-playing poll and toggles the marker **in place** — a re-render would throw away the user's scroll position. |
| `schedScrollToLive()` | paint-time only (open, tab switch). Never on the poll: moving a reading user's scroll every 15s is a bug, not a feature. |
| `schedTitleMatches()` | the on-air feed and the archive spell shows differently, so this reuses the widening tiers `programFor()` uses. |

**Three rules it is easy to undo by accident:**

- **The docked player bar stays reachable underneath it**
  (`body.sched-open .player-bar{z-index:166}`, and the phone sheet stops at
  `bottom:var(--player-h)`). This is the one overlay you browse *while
  listening*; burying the transport strands the listener. Both breakpoints
  were broken here once, for two different reasons — schedule-dev.md §7.3.
- **A cross-modal handoff must transfer its history flag.** Listen Live replaces
  the schedule's `{sched:1}` entry with `{live:1}` before swapping surfaces;
  without that, a later Back either re-opens the schedule or lands on a duplicate
  page entry. §7.2.
- **It never touches an `<audio>` element.** Listen Live calls
  `openLivePlayer()` and nothing else. Keep it that way — see
  [live-audio-pattern.md](live-audio-pattern.md).

**Tests:** [test/touch/](../test/touch/) covers the overlay scroll lock, with a
self-test that strips the lock mid-run and requires the probe to notice. The
offline `deriveSchedule` suite is **still outstanding** — `deriveSchedule` is
not exported from app.js's IIFE, so there is nothing to `require` yet;
schedule-dev.md §6 Phase 3 spells out the two ways forward.

### Back to top

**What it does:** a 40px circle that appears once you're deep in the ~500-item
listing, gets out of the way while you're scrolling, and comes back when you stop.
Guarded by [test/to-top/](../test/to-top/) — 33 assertions, all driven by
synthesized scroll input.

**The show/hide rule is direction-aware, and that's the whole feel of it.** An
upward scroll already means "I'm heading back", so the button appears on that
frame rather than waiting out a timer; a downward scroll hides it; and the idle
timer only has to cover stopping mid-flight. `IDLE_MS` is 800 — the 1–2 seconds
that sounds right when you describe the behaviour out loud reads as broken when
you use it. The appearance threshold is 1.5 viewports rather than a flat 300px,
and crossing back *under* it hides the button with no idle grace, because that
isn't resting, it's arriving.

**Placement is decided by the 1180px content column, and it changes at 1360px:**

- **≥1360px** — out in the right gutter, its left edge pinned 1.4rem off the
  column's right edge so the gap to the listing is constant from 1360px to 4K.
  1360 is where that gutter first reaches ~90px, which is the narrowest margin a
  40px button can sit in with real air on both sides.
- **<1360px** — no gutter exists, so it overlays content, horizontally centred
  above the player bar. Centre is the only spot simultaneously clear of the
  transport cluster (left), the close ✕ (right), the resume toast (bottom left),
  and the listing's scannable left edge.

**It shares the right gutter with `.player-close`** — the ✕ that ends playback,
which is pulled to ~8px off the true right edge at every width above 1360. The two
boxes don't overlap, but only by 6px, and two circles that close read as one
cluster in which the wrong one stops your audio. The separation is bought
vertically instead: the `min-width:1360px` block lifts the button to 2rem above
the bar rather than the 0.9rem used elsewhere. **That override is the only thing
keeping them apart** — `test/to-top/` §8 measures the real gap between the two
rectangles (currently 40px) rather than trusting the arithmetic.

**Two heights are measured, not assumed,** and published as custom properties by
the same observer pair (`ResizeObserver` for size, `MutationObserver` for the
`hidden`/`class` flips):

- `--player-h` — the bar isn't a fixed height: phones stack the scrubber, live
  mode drops it, and its bottom padding carries the safe-area inset. CSS floors
  it with `env(safe-area-inset-bottom)` via `max()`, so the no-player case still
  clears the notch without double-counting the inset when the bar *is* up.
- `--resume-h` — the strip the resume toast occupies, height plus its own margin,
  0 while it's down. This started as a hardcoded 3.6rem and overlapped the toast
  by 9px on a 390px phone, where the toast wraps to two lines. Publishing 0 when
  the toast is hidden also let the `:has()` selector go away entirely: one
  expression now covers both states.

**Hidden means unreachable, not faint.** `[data-show="false"]` sets
`visibility:hidden` and `pointer-events:none`, not just `opacity:0`. Below 1360px
the button sits *on* the listing, so an opacity-only hide would go on eating row
taps and catching Tab forever — the highest-risk bug in the feature, and the
reason `test/to-top/` §5 fires a hit test at the parked coordinates and requires
it to land on the listing. `html.scroll-lock .to-top` hides it behind every
overlay for the same reason: the scrim covers z-index 70 visually, but the button
would still be in the tab order underneath it.

**The click.** Smooth under ~6 viewports, instant beyond — a smooth scroll across
the whole loaded list takes seconds and reads as a hang — and always instant under
`prefers-reduced-motion`, which is precisely what that setting exists to prevent.
Focus moves to `main#top` (`tabindex="-1"`, `preventScroll:true` so it doesn't eat
the animation), because a viewport that moves without focus leaves a keyboard user
on row 340 looking at row 1. A `gliding` flag suppresses the show/hide rule for
the duration, or the upward-scroll branch would instantly re-show the button and
ride it back up; it's released by any real input (`wheel`, `touchstart`,
`pointerdown`, `keydown`) so taking over mid-glide works, and by a 1.5s timeout so
an interrupted glide can't strand the button hidden.

### Casting — built, then removed

Not a feature. A Cast/AirPlay button shipped on 2026-07-29 and was removed the
same day on UX grounds: the player bar is already the busiest strip in the app.
[casting-dev.md](casting-dev.md) is the full record — worth reading before
anyone proposes it again, because two of its findings outlive the feature (what
headless Chrome structurally cannot test, and why the Google Cast SDK is the
wrong dependency for this repo).

### Durable storage

Everything the server persists lives under one directory, named by one env var:
`DATA_DIR` (default `/app/data` in the image, `./data` locally). The three
per-file overrides — `SHOWINFO_PATH`, `PROGRAMS_PATH`, `FEEDS_PATH` — still
work, but nothing needs them.

Three properties, all added on 2026-07-30 and all boring until the day they
matter:

- **Writes are atomic.** `writeJsonAtomic` writes a sibling `.tmp`, `fsync`s it,
  then renames — atomic within a filesystem. A plain `writeFileSync` truncates
  first, so a crash mid-write leaves valid-looking bytes that aren't valid JSON,
  which `readJsonFile` then discards silently at the next boot.
- **Pending writes are flushed on the way out.** `writeJsonSoon` debounces by
  ten seconds with an unref'd timer, so before this a `SIGTERM` simply dropped
  whatever was queued — on *every* Coolify redeploy. A `SIGTERM`/`SIGINT`/
  `beforeExit` handler now flushes synchronously and re-raises the signal, so the
  exit status stays 143.
- **The volume can prove itself.** `.instance.json` gives the data directory an
  identity. `/healthz` reports `mounted` (what the kernel says is attached at
  `DATA_DIR` — answerable on the *first* deploy) and `instanceId` (unchanged
  across two deploys = the same directory came back, which is the proof).

Why this got attention: none of it is testable locally. `./data` is an ordinary
directory with no container boundary, so every storage check passes by
construction — see [admin-page.md](admin-page.md) §5.1, and CLAUDE.md §4.

### The studio

A password-gated station view at `/studio`. **Unset `STUDIO_PASSWORD` and it
does not exist** — the routes are never registered, so the path falls through
like any other unknown one rather than showing a login form to whoever scans for
it. That is the default, and the right one for a template.

- Sessions are a signed cookie (`HMAC-SHA256`), **no server-side store** — this
  app's persistence was unreliable for months, and a session table on a volume
  that may not be mounted would sign people out at random. The key derives from
  the password, so rotating it revokes every session at once. The cost, accepted
  and pinned by a test: signing out clears your browser but cannot invalidate a
  cookie already copied off a device.
- Login is rate limited per `X-Forwarded-For` hop, with exponential backoff after
  two free tries. Reading the socket address instead would bucket the whole
  internet behind Traefik into one counter.
- `POST` is opened for the two auth routes only; everything else still 405s.
- Studio responses are `private, no-store` + `Vary: Cookie`.
- The pages share `styles.css` and `theme-boot.js` with the listener app, which
  is why the theme toggle and both palettes work with no extra code. `studio.css`
  is layout only — every colour is a token. Adding a colour literal there breaks
  the theming; don't.

Behind the gate is the stats dashboard: `GET /api/studio/stats` computes
everything from the feed cache the listener app already holds, so the two can
never disagree. Charts are hand-rolled — bars and meters as plain HTML (CSS
handles ellipsis, reflow and theme), SVG only for the 72-column histogram where
geometry is the job. Widths go through the CSSOM (`--pct`), which the CSP allows.

Three data facts shaped it, and each is a trap worth knowing before editing:

- **Ranked "top shows" is meaningless here.** Upstream caps every feed at five
  episodes and 83 of 122 shows sit at the cap, so a top-12 is a twelve-way tie.
  The panel shows the *thin* end instead, and a test pins the sort direction.
- **`programs` and `feeds` are different key spaces** — normalised title vs
  archive slug. Intersecting them directly yields 3, by coincidence. Coverage is
  three separate ratios, never a funnel.
- **`perDay` includes empty days.** The gaps are the finding; a sparse series
  would close them up.

One hue for every bar: these categories are nominal, so shading by value would
double-encode the bar's own length. The coverage meters are the one ordered case
and use a validated ramp whose steps differ per theme — fading toward a *dark*
surface loses contrast, so the dark steps stay much closer to full.

The operational half of the page (Feed harvest, Upstream, Process) is timed from
the requests the app already makes — there are no synthetic probes, because
monitoring a small station's server by adding traffic to it is self-defeating.
Note that a **404 is counted apart from a failure**: 33 of the slugs the listing
advertises have no feed behind them, so probing them 404s by design, and folding
that into an error count showed a permanently unhealthy upstream.

**Tests.** `test/studio/studio-tests.js` drives a real server process
(`npm test`), against a small fixed feed fixture so the stats assertions have
something real to be wrong about rather than passing vacuously on an empty
archive. Per CLAUDE.md §3a every refusal is paired with the same request
*succeeding* under a valid session — a suite of pure refusals passes perfectly
once the probe goes blind.

**Actions** are the only state-changing routes: re-check every feed, refresh the
program directory, re-probe the stream, drop the archive cache. Each is
idempotent, cooled down (a forced feed sweep is 122 requests to a small server),
coalesced with any in-flight run, logged, and guarded by a CSRF token derived
from the session cookie rather than stored. If you add one, keep those five
properties — they are the difference between a maintenance button and a way to
accidentally DoS WBAI.

`test/studio/run.sh` is the layout suite, and it exists because the dashboard
shipped with every panel clipped on the right at phone widths while **every**
non-visual check stayed green: HTTP tests, no console errors, no CSP violations,
and `scrollWidth === clientWidth`, because the overflow was hidden rather than
scrolled. Grid items default to `min-width: auto`, so the section holding the
122-row table would not shrink below the table's min-content width and sized the
whole column to 619px inside a 390px viewport. If you add a wide child to a grid
item here, `min-width: 0` is the thing you need.

### Feed harvest: two things that are easy to misread

**`notModified` alone means nothing.** WBAI regenerates *every* feed XML in one
batch — measured 2026-07-30, all 122 carried a `Last-Modified` inside a
four-second window. A full sweep landing just after a regeneration therefore
refetches all 122 and records **zero** 304s; the same sweep a minute earlier
records 122. Two consecutive production deploys reported exactly that, and both
were correct. A running total has no denominator, so `feedsDiag.lastSweep`
records one sweep's own `{at, asked, notModified, failed}` and that is what the
studio shows.

**The sweep clock is restored from disk.** `feedsHarvestedAt` used to start at 0,
making `Date.now() - 0 > FEEDS_TTL` trivially true, so a full 122-feed sweep ran
on *every boot* — including a redeploy seconds after the last one. Harmless while
the data directory was wiped each deploy (there was nothing to reuse), and real
waste once the volume began persisting: four redeploys in an afternoon is ~488
requests to a small station's Apache for feeds we already held. It is now seeded
from the oldest `fetchedAt` in the restored feed store, and `fetchedAt` moves
forward on a 304 — it means "last confirmed current", not "last changed", which
is what a freshness clock needs. A missing or ancient timestamp sweeps, so the
failure direction is the safe one. The boot log says which happened.

### Usage counters

The station can see how long people actually listened per show, plus plays, live
tune-ins, page views, searches and shares.

**Time listened is the number that means something**, and it is measured as
media *consumed*, not wall clock: `track.js` samples `currentTime` every 15s and
counts the delta. A pause contributes nothing (the position stops advancing), so
does a stall, and a **seek is excluded by an upper bound** — otherwise dragging
the scrubber would manufacture hours. The cost is that the one interval
containing a seek is discarded whole, so the figure under-reports slightly and
can never over-report, which is the right direction for something a station
might quote. Measured end to end: 50s of uninterrupted playback records 49s; 40s
either side of a 30-minute seek records ~24s and never the 1,800.

**Closing the window mid-episode is handled** — `pagehide` banks the last
partial interval and `sendBeacon` survives the document dying (measured: 40s
played, tab closed, 39s recorded). A *hard* kill — crash, OOM, swiping the app
away — fires nothing, so up to ~30s is lost. Undercount, never overcount.

**Cost.** The ingest endpoint measured **~6,800 beacons/sec** on a laptop. A
listener sends ~2 a minute, so that is headroom of a different order than this
station will ever need; the counters are increments on an in-memory object and
the write is debounced to 60s. `feedIndex()` is memoised against a version
counter because a play and every listen sample resolve a slug through it — it
used to rebuild ~474 entries per beacon, which cost no measurable throughput but
generated garbage on the hottest path (RSS 98 MB → 79 MB over 2,000 beacons).

**Adding a counter is a migration.** `statsDay()` backfills every field on
*every* access, not just when it creates a day. This shipped broken: a day
record written by an earlier build had `plays` but no `listenSeconds`, so
`+= 30` evaluated `undefined + 30` → NaN, `JSON.stringify` wrote `null`, and the
report's `|| 0` rendered a confident zero. Plays kept working because their key
existed, so the symptom was "the new metric doesn't work" with no error
anywhere — the hardest kind to notice and the easiest to misread as a client
bug. If you add a counter, add it to the `NUMBERS`/`MAPS` lists and nothing
else; `test/studio/` boots a server against a legacy stats file and fails if the
backfill regresses.

Two things that were wrong first time and are easy to reintroduce: the baseline
must be set at the `play` event (setting it on the first sample tick discards the
opening interval of every listen — a 50s listen measured 29s), and the `pause`
path must be allowed to sample even though the element is already paused, or the
final partial interval is thrown away. It cannot see who — and that is structural, not
a policy stated on top of a system that could do otherwise:

- **No event log.** A beacon increments a number in memory and is dropped. There
  is no per-visit record to leak or to be asked for.
- **No identifier at all** — no cookie, no session, no fingerprint, no stored or
  hashed IP. Nothing links two events, so *unique listeners* is not a number
  this app can produce.
- **No search terms.** Volume only; the words never leave the browser. They were
  collected briefly on 2026-07-31 behind a storage threshold and removed the
  same day, on product grounds rather than privacy ones: the box filters as you
  type, so people stop after two or three characters and what came back was
  mostly stems — fiddly to capture around pauses in typing and not worth the
  value. A test sends a term the way a stale cached page would and fails if it
  reaches the report or the disk. Old terms written by that build are stripped
  when a month file is loaded, so the removal is retroactive.

The search box filters as you type, so there is no Enter to hang an event on: a
search is counted after 1.2s of idle, and suppressed while a query is merely
being extended, so a pause mid-word is still one search rather than two.

`public/track.js` deliberately knows nothing about `app.js`. Media events do not
bubble but do propagate through the **capture** phase, so a single capturing
listener on `document` sees `play` from both the static archive element and the
live element that is built and discarded per connection. The show is resolved
**server-side** from the media URL against the feed index already in memory, so
the tracker never depends on how `app.js` represents the current episode. A URL
that does not resolve is an unattributed play, never a guess.

Rollups are `$DATA_DIR/stats/YYYY-MM.json`, aggregates only, flushed on a 60s
debounce and on `SIGTERM`. **This is the only data here that no upstream can
give back**, which is why it waited for the volume to be proven rather than
assumed — see [admin-page.md](admin-page.md) §5.
