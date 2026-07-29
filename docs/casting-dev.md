# casting-dev.md — a Cast/AirPlay button, built and removed the same day

Researched, built, shipped and removed: **2026-07-29**.

**Status: REMOVED. Not a feature. Do not look for it in the app.**
The implementation is preserved in commit **`f1238fd`** and can be recovered
with `git show f1238fd`, so nothing here needs rebuilding from scratch if the
decision is ever revisited.

Kept because three of its findings outlive the feature:

1. **Why the Google Cast SDK is the wrong dependency for this repo** (§1) —
   the analysis stands whoever proposes it next.
2. **What headless Chrome structurally cannot test** (§4) — a green suite
   reported a broken feature as working, and that trap is not specific to
   casting.
3. **Why it was removed** (§5) — a UX judgment, not a technical failure, and
   the thing anyone reopening this has to solve *first*.

---

## 0. What happened, in order

| | |
| --- | --- |
| Asked | "how would we make the app Google TV compliant?" → [google-tv.md](google-tv.md) |
| Concluded | A native TV app means a second codebase. Casting reaches the same TVs for far less. |
| Built | A Cast/AirPlay button in the player bar, **standards only** — no SDK, no third-party script, no CSP change, no `server.js` change, no registration. ~120 lines. |
| Tested | 30 automated assertions, all green. Existing suites unaffected. |
| Reported | "Built and working." **This was wrong** — see §4. |
| Found | Works in Safari/AirPlay. Does nothing in desktop Chrome. |
| Removed | On seeing it on a real phone: the control costs more screen and attention than it returns. §5. |

---

## 1. Why not the Google Cast Web Sender SDK

The decision that stands regardless of the removal. Two routes existed:

| | **Cast Web Sender SDK** | **Remote Playback + AirPlay (what was built)** |
| --- | --- | --- |
| What it is | A Google-hosted script + a registered receiver | Two browser APIs on the media element |
| Third-party script | `gstatic.com/cv/js/sender/v1/cast_sender.js` | **none** |
| CSP | needs `script-src https://www.gstatic.com` | **unchanged** |
| Registration | app ID; $5 dev account for branding | **none** |
| Reaches iOS | **No — never.** Needs a native app. | **Yes**, via AirPlay |
| Works on desktop Chrome | Yes | **No** — §3 |
| New app state | a third playback destination to synchronise | **none** |

The SDK loses on this repo's terms: it is the first third-party script in
`public/`, it needs a CSP hole and a Google account, and it puts a third
playback destination into the subsystem with the worst bug history here
([big-audio-bug.md](big-audio-bug.md), [live-audio-pattern.md](live-audio-pattern.md)).
It also **cannot reach iOS at all**, so it would have been *additive* to the
AirPlay branch, never a replacement.

None of that changed. If casting is ever reopened, reopen it on standards.

---

## 2. The architecture, for whoever rebuilds it

Preserved because getting this shape right took the longest.

Remote playback is a property of a **media element**, and this app has two: the
stable archive element, and a live element **built and thrown away per play**.
So the module held no element reference of its own. It asked who owned the bar
right now — the same question `togglePlayback()` asks, answered the same way
(`barMode` first, because a live takeover can leave a paused archive track in
`nowPlaying`) — via a single seam, `refreshCast()`, called from `playTrack()`,
`showLiveBar()`, `stopLive()` and both branches of `playerClose`.

The non-obvious part: hooking **`showLiveBar()`** rather than `startLive()` is
what made a drift handover re-aim automatically, because it runs from the live
element's own `playing` handler. Anyone rebuilding this will otherwise leak a
watch onto a discarded connection.

The other rule worth keeping: the browser owned the remote transport entirely,
so nothing mirrored a remote clock, `barMode` stayed the only answer to what the
bar controls, and no live-audio rule had to move.

---

## 3. Platform reality — measured, not assumed

| | |
| --- | --- |
| **Safari / AirPlay** | ✅ **worked**, confirmed on device |
| **Desktop Chrome** | ❌ **nothing** — reports no devices |
| **Chrome on Android** | ❓ never tested |
| **Firefox** | ➖ no remote playback; button removed from the DOM |

On desktop Chrome, measured on a real network with multiple cast devices
present, in a **real (non-headless) browser**:

```
bare <audio>   : false
bare <video>   : false
app #mainAudio : false
```

`watchAvailability()` resolves successfully and reports no devices. `<video>`
behaves identically to `<audio>`, so **this is not an audio-only limitation** —
Remote Playback simply isn't wired to Cast discovery on desktop. Chromium tracks
this as [issue 41389531](https://issues.chromium.org/issues/41389531); the API is
generally a Chrome-for-Android feature, with desktop Chrome routing Cast through
the **Presentation API** instead (which is what the Cast SDK uses underneath).

A follow-up probe intended to confirm that desktop Chrome *can* see the devices
via the Presentation API hung and was abandoned, so that half is strongly
indicated rather than proven.

This mattered less than it sounds: desktop Chrome can already cast a tab from
its own ⋮ menu, audio included. **Mobile was the only real gap** — and mobile
Chrome offers only screen mirroring, which keeps the screen on and re-encodes
the audio.

---

## 4. The testing lesson — the part worth keeping most

`test/ui/cast-tests.js` carried **30 assertions and they all passed** while the
feature did nothing in desktop Chrome. The suite was not wrong about anything it
measured. It could not see the thing that was broken.

**Headless Chrome has no Media Router.** It discovers no cast devices, ever. So
the suite could only ever observe *one branch* of "is a device present" — which
means it never tested that condition at all. It could not distinguish:

- *correctly hidden, because no device is on this network*, from
- *permanently invisible, because this browser never reports devices*.

Stated generally, because it is not about casting: **a suite that can only ever
observe one branch of a condition has not tested that condition.** It is the
same family as the `overflow:hidden` failure in CLAUDE.md §3a — a green
assertion that had never been shown capable of failing.

A related, smaller instance from the same day, which the suite *did* catch: the
self-test in §2 of that file failed on its first run because the probe was
measuring the button inside a `hidden` player bar, where `display:none` on an
ancestor zeroes every descendant — so the "correctly hidden" assertion beside it
was passing for entirely the wrong reason. That is precisely why assertions of
absence need a self-test. It worked. The larger blind spot had no such guard,
and nothing in CI could have given it one.

---

## 5. Why it was removed

**A product decision, not a technical one.** It worked in Safari. It was removed
anyway, on seeing it on a real phone:

- **The player bar is already the busiest strip in the app** — artwork, title,
  subtitle, scrubber, elapsed/duration, play/pause, ±15s, status, close. It is
  also pinned to the bottom, the most expensive real estate on a phone screen.
- **The control was small and awkward** at phone sizes even at a 44px touch
  target, competing with controls people actually use.
- **The screen-space cost was paid by everyone**, while the benefit reached only
  users with a cast device, in some browsers.

The app was cleaner before. That was the whole argument, and it is sufficient.

**If this is reopened, the layout problem has to be solved first, not the API
problem.** The API side is done and recoverable from `f1238fd`. Somewhere other
than the player bar — or a different interaction entirely — is the actual
prerequisite.

---

## 6. Loose ends, deliberately left

Never answered, and no longer worth answering unless this is reopened:

- Does a hand-off resume at the current position or restart from 0?
- Does Chrome on Android work — the one platform the Chromium half exists for?
- Behaviour inside the installed PWA (`display: standalone`).

---

## 7. One thing that stayed true

A cast device **fetches the media itself**, and our audio is the one thing this
app doesn't proxy — `mp3` arrives as an absolute `https://archive2.wbai.org/…`
URL and goes straight to `audio.src`; the live stream is
`https://streaming.wbai.org/…`. So casting needed no server change and worked
from `localhost`.

**Artwork is the exception** — `photo: "/pix/….jpg"` is a path on *our* server,
and a cast device resolves it against nothing and cannot reach `localhost`
regardless. Anything that ever hands media to an external device will hit this.
