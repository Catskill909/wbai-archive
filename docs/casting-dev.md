# casting-dev.md — playing to a TV or speaker, without a third-party SDK

Research date: **2026-07-29**. Implemented the same day.
Scope: `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui/cast-tests.js`.

**Status: built and working**, with one honest caveat — see §6. `server.js` was
**not touched**: no CSP change was needed, because nothing third-party is loaded.

Context: this came out of a Google TV investigation. A Play Store TV app means a
native Kotlin front end and a second codebase — a real departure for a
zero-dependency, no-build repo. Casting reaches the same TVs for a fraction of
that. Two ways to do it were on the table; we took the one that adds no
dependency at all.

---

## 0. TL;DR

| | |
| --- | --- |
| What shipped | A Cast/AirPlay button in the player bar, on **web standards only** |
| npm packages added | **0** |
| Third-party scripts loaded | **0** |
| CSP changes | **0** |
| `server.js` changes | **0** |
| Google accounts / registrations / fees | **0** |
| Lines of app code | ~120, one self-contained module in `app.js` |
| Seam into the rest of the app | **one function**, `refreshCast()`, called from 5 places |
| Automated assertions | 30 (`test/ui/cast-tests.js`) |
| Reaches | Chromium → Chromecast / Google TV · Safari → AirPlay |
| Does not reach | Firefox (no remote playback at all — button is removed) |

---

## 1. The decision: standards, not the Cast SDK

Two routes existed. They are not variations on a theme; they are different
products with different dependency profiles.

| | **Google Cast Web Sender SDK** | **Remote Playback + AirPlay (chosen)** |
| --- | --- | --- |
| What it is | A Google-hosted script + a registered receiver app | Two browser APIs on the media element |
| Third-party script | `gstatic.com/cv/js/sender/v1/cast_sender.js` | **none** |
| CSP | needs `script-src https://www.gstatic.com` | **unchanged** |
| Registration | app ID; $5 dev account for branding | **none** |
| Reaches iOS | **No — never.** Needs a native app. | **Yes**, via AirPlay |
| Control of the TV screen | full (title, art, branding) | none — the browser owns it |
| Transport control | ours to build | the browser's |
| New app state | a third playback destination to synchronise | none |
| Cost | ~250 lines + a state machine + a Google dependency | ~120 lines |

**We chose the standards route**, on the explicit instruction to avoid
third-party ties wherever they aren't forced. Two things make it more than a
cost saving:

1. **It reaches iOS, and the SDK structurally cannot.** The Cast Web Sender SDK
   does not work in iOS Safari at all — casting from iOS requires a native app
   with the Cast iOS SDK. The AirPlay branch is the only way a web page gets
   audio from an iPhone onto a TV. The "cheaper" option covers a platform the
   expensive one can't.
2. **It adds no state.** The browser takes the element and owns playback from
   there. There is no remote clock to mirror, so `barMode` remains the only
   answer to "what does the bar control", and none of the live-audio rules in
   [live-audio-pattern.md](live-audio-pattern.md) move. That mattered: the
   alternative put a third destination into the subsystem with the worst bug
   history in this repo ([big-audio-bug.md](big-audio-bug.md)).

What we gave up, stated plainly: **control of what the TV shows**. Title and
artwork on screen are the browser's business now. If that ever becomes
unacceptable, §7 has the way back.

---

## 2. The finding that made it cheap

A cast device **fetches the media itself**. The browser hands it a URL; the
device opens that URL over its own network connection. It cannot reach anything
the tab could reach privately.

That is normally where a proxy-based app dies, and this app is a proxy-based
app. But our audio is the one thing that **isn't** proxied:

```
mp3   →  https://archive2.wbai.org/mp3/wbai_260729_130000attitudarnearnesen.mp3
live  →  https://streaming.wbai.org/wbai_verizon         (app.js:15)
```

Both are absolute, public, HTTPS URLs served by WBAI. `mp3` arrives that way in
`/api/archive` and goes straight to `audio.src` without rewriting. So casting
works from `localhost:8080` with **no server change and no deployment** — not
true of most features here (see [CLAUDE.md](../CLAUDE.md) §4).

### 2a. …and the exception, so nobody loses an afternoon to it

**Artwork is proxied and relative** — `photo: "/pix/….jpg"`, a path on *our*
server. A cast device resolves that against nothing.

This does not affect us today (the browser supplies the TV's artwork, not us),
but it is the first thing that would bite a move to the Cast SDK, and it is why
you should not be surprised by blank art on a TV while audio plays perfectly
from a laptop. **A cast device cannot reach `localhost`.** Note it, move on.

---

## 3. How it works

One module in `app.js`, marked `---- Remote playback: Cast and AirPlay ----`.

**Feature detection, never UA sniffing.** Chromium exposes
`HTMLMediaElement.remote`; Safari exposes `webkitShowPlaybackTargetPicker()`.
Where neither exists, the module **removes the button from the DOM** and
returns. A browser that can't cast never sees a control that can't work.

**The button is gated on availability, not just support.** Chromium's
`watchAvailability()` and Safari's `webkitplaybacktargetavailabilitychanged`
both report whether a device is actually on the network. No device → no button.
A picker with nothing in it is worse than no button, and Apple explicitly warn
that watching costs battery — which is why we only ever watch **one** element.

**Which element?** That is the only wrinkle this app has. Remote playback is a
property of a *media element*, and there are two: the stable archive element and
a live element **built and thrown away per play**. So the module holds no
reference of its own. It asks who owns the bar right now — the same question
`togglePlayback()` asks, answered the same way (`barMode` first, because a live
takeover can leave a paused archive track in `nowPlaying`) — and re-asks
whenever `refreshCast()` says the answer may have changed:

| called from | because |
| --- | --- |
| `playTrack()` | the bar now points at the archive element |
| `showLiveBar()` | a live connection is playing — **and this also catches a drift handover**, since it runs from the live element's own `playing` handler |
| `stopLive()` | the element we were aimed at has been destroyed |
| `playerClose` (both branches) | nothing is playing any more |

A watch handed back after its element is gone is cancelled rather than leaked —
`resyncLive()` can replace a live element while `watchAvailability()`'s promise
is still in flight.

**Errors are not swallowed** (CLAUDE.md §3). Dismissing the picker rejects with
`NotAllowedError` and is ignored because that is a user saying no; everything
else is logged.

---

## 4. Where the button sits, and why

In `.player-transport`, after the ±15s pair.

The obvious home was beside `.player-close` on the right, which is where media
sites put it. Rejected: `.player-close` carries three breakpoint-specific
absolute-positioning rules and a negative-margin hack to sit outside the 1180px
column, and a sibling would have had to reproduce all of it. The transport group
is a plain flex row — the boring choice, and it survives every breakpoint.

It is deliberately **not** hidden with `.player-skip` below 420px. The phone is
the one place this button is the only route to a TV, since desktop Chrome can
already cast a tab from its own menu — and it costs nothing there, because the
±15s pair has just vacated 88px at exactly that width.

---

## 5. What is tested

`test/ui/cast-tests.js`, wired into `test/ui/run.sh` (`./run.sh cast`).
**30 assertions, all passing**, alongside the existing suites:

| suite | result |
| --- | --- |
| `test/ui` (all, incl. cast) | 30 passed, 0 failed |
| `test/live-stream` `./run.sh` | 40 passed, 0 failed |
| `test/live-stream` `./run.sh --strict` | 39 passed, 0 failed |
| `test/touch` | 40 passed, 0 failed |

The suite asserts, per CLAUDE.md §3a:

1. **The regression that matters** — with remote playback stripped before any
   page script runs, the button is **removed from the DOM**, not left behind
   dead. This is the path every Firefox user takes, and it can rot silently.
2. With no device on the network, the button takes **no space** — measured as
   rendered geometry, not the `hidden` attribute.
3. **A self-test that the probe is not blind**: the button is revealed and the
   probe is *required* to report it as visible with real size before its
   report of absence is trusted.
4. Layout at 360 / 414 / 768 / 1400px: the bar gains no horizontal overflow, the
   button stays on screen and clear of play/pause, the title keeps its room.

> **This pattern earned its keep on the first run.** §2's self-test failed
> immediately: the probe was measuring the button inside a `hidden` player bar,
> where `display:none` on an ancestor zeroes every descendant. §1 was therefore
> passing for entirely the wrong reason — it would have reported "correctly
> hidden" no matter what the button's own styles said. Both were fixed to bring
> the bar up first. An assertion of absence that has never been shown to fail is
> indistinguishable from a blind one.

---

## 6. What is NOT tested — the honest caveat

**No assertion here proves audio reached a TV.** Headless Chrome discovers no
cast devices and there is no fake receiver to point it at. Device behaviour is
manual-only, and pretending otherwise with a `typeof cast !== 'undefined'` check
would be exactly the mistake CLAUDE.md §3a exists to prevent.

Manual checklist, on a network with a Chromecast or Google TV:

- [ ] Play an archive show → the button appears (a beat after playback starts,
      once availability resolves)
- [ ] Press it → picker opens → pick a device → audio moves to the TV
- [ ] Glyph turns accent-coloured while connected
- [ ] **Does playback resume at the current position, or from 0?** Unverified.
      If it restarts, that is worth knowing before anyone calls this finished.
- [ ] Stop casting → audio returns to the browser
- [ ] Play the **live** stream → cast it → confirm it plays and doesn't show a
      nonsense duration
- [ ] iPhone + Safari → the same button offers **AirPlay**
- [ ] Firefox → **no button at all**

Also unverified: behaviour inside the installed PWA (`display: standalone`).

---

## 7. If the TV screen ever needs to be ours

The one thing this route gives up. The way back, in order of cost:

1. **Styled Media Receiver** — $5 one-time [Cast developer registration](https://developers.google.com/cast/docs/registration)
   and a CSS file (colours, logo, background). Requires adopting the Cast Web
   Sender SDK, i.e. the gstatic script and the CSP hole.
2. **Custom Web Receiver** — self-hosted HTML on the TV. Buys nothing we need:
   no DRM, no image gallery, no business logic on the TV.

Neither is worth it for a radio archive today. Recorded so the option isn't
re-derived from scratch.

---

## 8. Won't do

- **Google Cast Web Sender SDK** — see §1. Reopen only if control of the TV
  screen becomes a requirement, and read §7 first.
- **Casting the tab instead** — already works in desktop Chrome with no code
  (⋮ → Cast → Cast tab), which is exactly why the button is aimed at phones.
  Mobile Chrome only offers *screen mirroring*, which keeps the screen on and
  re-encodes the audio: the wrong mechanism for a two-hour broadcast, and the
  reason building anything at all was worth it.
- **A native TV app** — the Google TV route. Separate decision, much larger:
  Kotlin, Gradle, a second UI, Play Store obligations. Casting is listed as
  quality requirement **TV-CT** for that app anyway, so nothing here is wasted.
