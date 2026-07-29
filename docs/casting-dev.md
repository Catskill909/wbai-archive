# casting-dev.md — playing to a TV or speaker, without a third-party SDK

Research and implementation: **2026-07-29**.
Scope: `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui/cast-tests.js`.

**Status: shipped, and it works on some platforms and not others.** Read §5
before believing anything about a given browser. `server.js` was **not touched**
— no CSP change was needed, because nothing third-party is loaded.

Context: this came out of the Google TV investigation in
[google-tv.md](google-tv.md). A Play Store TV app means a native Kotlin front
end and a second codebase. Casting reaches the same TVs for a fraction of that.

---

## 0. TL;DR

| | |
| --- | --- |
| What shipped | A Cast/AirPlay button in the player bar, on **web standards only** |
| npm packages · third-party scripts · CSP changes · `server.js` changes | **0 · 0 · 0 · 0** |
| Registrations, fees, Google accounts | **0** |
| App code | ~120 lines, one self-contained module in `app.js` |
| Seam into the rest of the app | **one function**, `refreshCast()`, called from 5 places |
| **Safari / AirPlay** | ✅ **confirmed working** (macOS, 2026-07-29) |
| **Desktop Chrome** | ❌ **does nothing** — Chrome reports no devices. §5. |
| **Chrome on Android** | ❓ untested — the platform this API is actually built for |
| **Firefox** | ➖ no remote playback; the button is removed from the DOM |

---

## 1. The decision: standards, not the Cast SDK

Two routes existed. Different products, different dependency profiles.

| | **Google Cast Web Sender SDK** | **Remote Playback + AirPlay (chosen)** |
| --- | --- | --- |
| What it is | A Google-hosted script + a registered receiver | Two browser APIs on the media element |
| Third-party script | `gstatic.com/cv/js/sender/v1/cast_sender.js` | **none** |
| CSP | needs `script-src https://www.gstatic.com` | **unchanged** |
| Registration | app ID; $5 dev account for branding | **none** |
| Reaches iOS | **No — never.** Needs a native app. | **Yes**, via AirPlay |
| Works on desktop Chrome | **Yes** | **No** — see §5 |
| Control of the TV screen | full (title, art, branding) | none — the browser owns it |
| New app state | a third playback destination to synchronise | none |

**We chose the standards route**, on an explicit instruction to avoid
third-party ties wherever they aren't forced. Two things still justify it after
the desktop finding:

1. **It reaches iOS, and the SDK structurally cannot.** The Cast Web Sender SDK
   does not work in iOS Safari at all. The AirPlay branch is the only way a web
   page gets audio from an iPhone to a TV — and it is the branch that is
   confirmed working.
2. **It adds no state.** The browser takes the element and owns playback from
   there, so `barMode` remains the only answer to "what does the bar control",
   and nothing in [live-audio-pattern.md](live-audio-pattern.md) moved.

What we gave up: **control of what the TV shows**, and **desktop Chrome**. §7
has the way back if either becomes unacceptable.

---

## 2. The finding that made it cheap

A cast device **fetches the media itself** — the browser hands it a URL and the
device opens it over its own connection. It cannot reach anything the tab could
reach privately.

That is normally where a proxy-based app dies, and this app is a proxy-based
app. But our audio is the one thing that **isn't** proxied:

```
mp3   →  https://archive2.wbai.org/mp3/wbai_260729_130000attitudarnearnesen.mp3
live  →  https://streaming.wbai.org/wbai_verizon         (app.js:15)
```

Both are absolute, public, HTTPS URLs. `mp3` arrives that way in `/api/archive`
and goes straight to `audio.src`. So casting works from `localhost:8080` with no
server change and no deployment.

**But artwork is proxied and relative** — `photo: "/pix/….jpg"`, a path on *our*
server, which a cast device resolves against nothing. It doesn't affect us today
(the browser supplies the TV's artwork), but it is the first thing that would
bite a move to the SDK, and **a cast device cannot reach `localhost`**.

---

## 3. How it works

One module in `app.js`, marked `---- Remote playback: Cast and AirPlay ----`.

**Feature detection, never UA sniffing.** Chromium exposes
`HTMLMediaElement.remote`; Safari exposes `webkitShowPlaybackTargetPicker()`.
Where neither exists the module **removes the button from the DOM** and returns.

**Gated on availability, not just support.** Both APIs report whether a device is
actually on the network. No device → no button. A picker with nothing in it is
worse than no button, and Apple warn that watching costs battery — which is why
only **one** element is ever watched.

**Which element?** Remote playback is a property of a *media element*, and there
are two: the stable archive element and a live element **built and thrown away
per play**. So the module holds no reference of its own. It asks who owns the
bar right now — the same question `togglePlayback()` asks, answered the same way
(`barMode` first, because a live takeover can leave a paused archive track in
`nowPlaying`) — and re-asks whenever `refreshCast()` says so:

| called from | because |
| --- | --- |
| `playTrack()` | the bar now points at the archive element |
| `showLiveBar()` | a live connection is playing — **and this also catches a drift handover**, since it runs from the live element's own `playing` handler |
| `stopLive()` | the element we were aimed at has been destroyed |
| `playerClose` (both branches) | nothing is playing any more |

A watch handed back after its element is gone is cancelled rather than leaked —
`resyncLive()` can replace a live element while `watchAvailability()`'s promise
is still in flight. Errors are logged, not swallowed (CLAUDE.md §3); only
`NotAllowedError` from a dismissed picker is ignored, because that is a user
saying no.

---

## 4. Where the button sits, and why

In `.player-transport`, after the ±15s pair.

The obvious home was beside `.player-close` on the right, where media sites put
it. Rejected: `.player-close` carries three breakpoint-specific
absolute-positioning rules and a negative-margin hack to sit outside the 1180px
column, and a sibling would have had to reproduce all of it. The transport group
is a plain flex row — the boring choice, and it survives every breakpoint.

Deliberately **not** hidden with `.player-skip` below 420px: the phone is the one
place this button is the only route to a TV, and it costs nothing there because
the ±15s pair has just vacated 88px at exactly that width.

---

## 5. Platform reality — measured, not assumed

### ✅ Safari / AirPlay — works

Confirmed on macOS, 2026-07-29. This is the branch the Cast SDK could never have
provided at any price.

### ❌ Desktop Chrome — the button never appears

Measured on a real network with multiple cast devices present, using a **real
(non-headless) Chrome**:

```
bare <audio>   : false
bare <video>   : false
app #mainAudio : false
```

`watchAvailability()` resolves successfully and reports **no devices**. Critically
`<video>` behaves identically to `<audio>`, so **this is not an audio-only
limitation** — it is Remote Playback not being wired to Cast discovery on
desktop. Chromium's own tracker carries this as
[issue 41389531](https://issues.chromium.org/issues/41389531), and the API is
generally described as a Chrome-for-Android feature, with desktop Chrome routing
Cast through the **Presentation API** instead (which is what the Cast SDK uses
underneath).

**Caveat on that evidence:** a follow-up probe meant to confirm desktop Chrome
*can* see the devices through the Presentation API hung and was abandoned, so
"Chrome sees them but Remote Playback ignores them" is strongly indicated, not
proven. It does not change the outcome — the button does not appear either way.

**This costs users little.** Desktop Chrome can already cast a tab from its own
⋮ menu, complete with audio. It was never the gap this was built for.

### ❓ Chrome on Android — untested, and the one that matters

This is the platform Remote Playback is actually implemented for, and the one
where the alternative (screen mirroring) is genuinely bad for a two-hour
broadcast. **Until this is tested, the Chromium half of this feature is
unproven.**

### ➖ Firefox — no support, and that is handled

No remote playback at all; the button is removed from the DOM rather than left
behind dead. This is asserted by the test suite.

---

## 6. Testing — what is covered and what cannot be

`test/ui/cast-tests.js`, wired into `test/ui/run.sh` (`./run.sh cast`).
**30 assertions.** Full state at time of writing:

| suite | result |
| --- | --- |
| `test/ui` (all, incl. cast) | 30 passed, 0 failed |
| `test/live-stream` `./run.sh` | 40 passed, 0 failed |
| `test/live-stream` `./run.sh --strict` | 39 passed, 0 failed |
| `test/touch` | 40 passed, 0 failed |

It asserts, per CLAUDE.md §3a: that the button is **removed from the DOM** when
remote playback is absent (the Firefox path, and the one that can rot silently);
that it takes no space with no device present, measured as rendered geometry;
that the probe is **self-tested** against a revealed button before its report of
absence is trusted; and that the bar lays out at 360 / 414 / 768 / 1400px.

> **The self-test earned its keep on the first run.** It failed immediately: the
> probe was measuring the button inside a `hidden` player bar, where
> `display:none` on an ancestor zeroes every descendant. The "correctly hidden"
> assertion beside it was therefore passing for entirely the wrong reason. Both
> were fixed to bring the bar up first.

### 6a. The blind spot the suite cannot fix — read this

**Headless Chrome has no Media Router.** It discovers no cast devices, ever. So
this suite is *structurally incapable* of distinguishing "correctly hidden
because no device is present" from "permanently invisible because this browser
never reports devices at all."

That is not hypothetical. **It is exactly what happened here**: 30 green
assertions were reported as "built and working" while the feature did nothing in
desktop Chrome. The suite was not wrong about anything it measured — it simply
could not see the thing that was broken.

The lesson is narrower than "tests lie" and worth stating precisely: *a suite
that can only ever observe one branch of a condition has not tested that
condition.* Anything device-dependent here needs a real browser on a real
network, and no amount of CI will substitute.

### 6b. Manual checklist

Automated tests cannot prove audio reached a TV. On a network with devices:

- [x] **macOS Safari → AirPlay** — button appears, confirmed 2026-07-29
- [ ] **Chrome on Android** — the open question (§5)
- [ ] **iPhone Safari → AirPlay**
- [ ] **Does playback resume at the current position, or restart from 0?**
      Unverified, and worth knowing — resume position is a real feature here
      ([DEVELOPMENT.md](DEVELOPMENT.md) § Resume position).
- [ ] Stop casting → audio returns to the browser
- [ ] Cast the **live** stream → plays, and shows no nonsense duration
- [ ] Behaviour inside the installed PWA (`display: standalone`)
- [x] **Firefox → no button at all** (asserted in CI)

---

## 7. If desktop Chrome or the TV screen ever has to work

The two things this route gives up, and the cost of buying them back:

1. **Google Cast Web Sender SDK** — restores desktop Chrome and gives us the TV
   screen. Costs the gstatic script, a CSP hole, a registered app ID, and a
   third playback destination to synchronise. Still cannot reach iOS.
2. **Styled Media Receiver** — $5 one-time [Cast developer registration](https://developers.google.com/cast/docs/registration)
   plus a CSS file, on top of (1), for WBAI branding on the TV.
3. **Custom Web Receiver** — self-hosted HTML on the TV. Buys nothing we need.

Note that (1) is **additive, not a replacement**: the AirPlay branch would stay,
because the SDK cannot serve iOS. Recorded so it isn't re-derived.

---

## 8. Won't do

- **Google Cast Web Sender SDK** — §1 and §7. Reopen if Android testing fails
  *and* desktop Chrome matters enough to pay for it.
- **Casting the tab instead** — already works in desktop Chrome with no code
  (⋮ → Cast → Cast tab), which is why the button was aimed at phones. Mobile
  Chrome only offers *screen mirroring*: screen stays on, audio re-encoded —
  the wrong mechanism for a two-hour broadcast.
- **A native TV app** — see [google-tv.md](google-tv.md). Casting is quality
  requirement **TV-CT** for that app anyway, so nothing here is wasted.
