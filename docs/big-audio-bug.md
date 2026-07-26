# Big audio bug — live player pause/play loop

**Status: RESOLVED (2026-07-24), then superseded (2026-07-26) — read §0.5 first.**
§0 records the 2026-07-24 fix; §0.5 records the follow-on fix that replaced its
accepted trade-off. §1–§7 are the original post-mortem.

---

## 0.5 Follow-on — "it played the cache" (2026-07-26)

§0 accepted a trade-off: *"resuming may be a few seconds behind the live edge."*
**That estimate was wrong, and the trade-off was not survivable.** A live stream
has no timeline. An `<audio>` element that is paused and later resumed continues
from the byte it stopped on, so it plays what was in the buffer **at pause time**
and there is no seekable range to jump forward in. Leave the page sitting, press
play, and you hear the past — indefinitely far back, never catching up. Same
failure with no pause at all: a long stall, a throttled background tab, or a
sleeping laptop leaves the element playing a backlog forever.

**The fix (`public/app.js`, "ONE CONNECTION, NEVER REUSED"):** do what §0 itself
prescribed — make "go live" explicit, and keep it out of one element's pause/play
state machine. Every earlier attempt (rows 1–4 below) violated that by tearing
down and reconnecting **the same element**, which is what left
`readyState`/`networkState`/`paused` in transient states for the next click to
misread. So the element is never reused:

- **Stop** → tear the connection down and **throw the element away**
  (`pause()`, `removeAttribute('src')`, `load()`, remove from the DOM). Its dying
  events are ignored — every handler checks `el === liveAudio` first — and no
  branch ever reads its state again, so the transient values that caused the
  original cascade are unobservable by construction.
- **Play** → build a **brand-new** `<audio>`, set `src` on it once, `play()` it. A
  fresh element starts at `readyState 0` with an empty buffer, so a play can only
  open a new connection, at the live edge. `src` carries a `?_=<ts>` so no cache,
  proxy, or service worker can answer with the previous connection's bytes.
- **Branching is on `liveWanted`**, a flag we own — never on `element.paused`
  (this is hypothesis **H3** below, fixed). `liveAudio` is `null` when stopped.
- **There is no resume path**, therefore no stale buffer can be played. The UI
  still says "Paused"; the behavior is stop/retune, which is what every live
  radio app does.
- **Drift resync:** wall-clock elapsed minus audio elapsed since a connection's
  first frame measures how far behind live it has fallen. It is 0 on a healthy
  stream and grows 1:1 with any stall (measured — see §0.6). Past 45s, either
  returning to the tab (`visibilitychange`/`focus`/`online`/`pageshow`, or
  opening the modal) or recovering from the stall itself triggers a resync.
  Rate-limited to once per 30s and never while hidden.
- **The resync is a HANDOVER, not a restart**, and that distinction is load-
  bearing: there is no user gesture behind it, so `play()` on the replacement can
  simply be *refused* by autoplay policy. So the replacement must prove it plays
  before the working connection is dropped; on refusal the old connection is
  handed back, still audible, and the user's next tap gets them live the ordinary
  way. A background resync can never cost the listener their audio.

**Why this doesn't reopen the old bug:** the race was *reading a torn-down
element*. Now nothing does. There is exactly one way audio starts (`startLive()`)
and one way it ends (`stopLive()`), and they never share an element.

**Regression watch:** the 5-step repro in §1 must still pass, plus: play → wait
5+ minutes → play again must open a **new** connection (Network tab: a second
request to `streaming.wbai.org`, audio at the live edge, not where it left off).

---

## 0.6 What the tests measured (2026-07-26)

The fix was verified end to end against the real page in headless Chrome, with
Chrome's resolver pointed at a fake Icecast that behaves like a true live source
(one cursor advancing in real time; every client served from wherever it is
*now*, no rewind, no per-client backlog). The app ran unmodified — same URL, same
CSP. Because the fake station cannot replay the past, "did it reconnect?" is
decided by the station's own connection ledger rather than inferred from the app.

**40/40 under Chrome's default autoplay policy, 39/39 under the strictest one**
(`user-gesture-required`, standing in for iOS). Covered: fresh connection per
play; stop actually closing the socket; play after a 25s idle joining the live
edge 25s further on; archive takeover; an outside pause treated as a stop; rapid
stop/play not misreporting `AbortError`; a 60s stall; a dead station and retry.

Two things the tests found that reasoning had not:

1. **Drift is real and linear.** During a 60s stall Chrome does *not* error — it
   fires `waiting`/`stalled`, holds `currentTime`, and resumes playing the
   backlog permanently behind. Drift tracked the stall 1:1 (10s→60s). Nothing
   triggered a check while the tab stayed in the foreground, which is why the
   `playing` handler now checks drift on stall recovery.
2. **The first version of the resync was itself a bug.** It hard-cut to a new
   connection, and under the strict autoplay policy `play()` was refused — the
   working (stale) audio was destroyed and the listener landed on "Your browser
   blocked playback". That is what the handover in §0.5 exists to prevent, and
   the strict-policy run now asserts the failure is free: audio keeps playing,
   no error card, no orphaned socket.

---

The live stream, once playing and controlled from the bottom player bar, would not
reliably pause/resume. Every fix traded one broken symptom for another. This
catalogs every attempt, audits the architecture, isolates what was non‑standard,
and records the resolution.

---

## 0. Resolution — what fixed the pause/play loop (superseded by §0.5)

**Two things were wrong at once, and they compounded each other:**

**(A) The live control was non-standard and racy.** Trying to make play always
"fetch the live edge," the code implemented pause as a teardown
(`pause(); removeAttribute('src'); load()`) and play as a reconnect
(`src = …; load(); play()`, sometimes with a `?_=timestamp` cache-buster). On a
live stream those `load()`/teardown operations leave `readyState`/`networkState`/
`paused` in transient states and the swallowed `play()` promise hid the failures.
That is why the symptom *moved* with every edit.

**The fix:** treat `#liveAudio` exactly like the archive's `#mainAudio`, which
always worked — two verbs, nothing else:
- **Pause** → `liveAudio.pause()`
- **Play** → set `src` once (if unset), then `liveAudio.play()`

No `load()`, no `removeAttribute`, no cache-buster, no reconnect. `resetLive()` was
deleted and every teardown call site reverted to plain `liveAudio.pause()`.
**Trade-off accepted:** resuming may be a few seconds behind the live edge. That
"always fetch latest" feature is exactly what caused the cascade; it was removed.
If it's ever wanted again, it must be a **separate, explicit** control — never
folded into the pause/play path.

**(B) Browser caching masked which version was running.** `app.js` has no build
hash, so the browser reloads the same filename. The server does the right thing
(`Cache-Control: no-cache` + ETag → revalidate), but in practice, during rapid
successive edits the browser (Safari especially) kept running **stale cached JS**
until a hard refresh. The bug "came back working" only after **~5 hard refreshes** —
i.e. once the current code actually loaded. This means some earlier fixes may have
been judged against old code, which is a large part of why the loop was so
maddening.

**Lesson for next time:** when iterating on unhashed JS, **hard-refresh
(Cmd/Ctrl+Shift+R)** before concluding a change did or didn't work — otherwise you
are debugging a version that isn't running.

**Diagnostic:** during the fix an opt-in on-screen logger (`?debug=audio`) traced
every `liveAudio` event + control branch. It was removed once the bug was fixed;
re-add a similar gated logger if this class of bug ever recurs.

---

---

## 1. The reproduction (constant across every attempt)

1. Open the **On Air** modal.
2. Press **play** in the modal — audio starts. ✅ (this step has always worked)
3. **Close** the modal. The bottom player bar is visible and playing.
4. Press **pause** on the bottom bar.
5. Press **play** on the bottom bar.

Step 4 or 5 is where it breaks. The *nature* of the break changes per attempt
(below), which is itself the clue: we are perturbing a timing/state-machine
problem, not fixing a logic bug.

## 2. Attempt log (symptom per version)

| # | What the live control did | Symptom reported |
|---|---|---|
| 0 | *Original (header strip):* `pause()` / `play()` on one element, `src` set once. | Worked for play/pause. Only issue: after being away, resume played **stale buffer**. This is the request that started the cascade. |
| 1 | **"fetch latest":** on every play `src = URL+?_=ts; load(); play()`. Pause = `pause()`. | Play ✅, pause ✅, **play-again does nothing**. No console error. |
| 2 | **pauseLive teardown:** pause = `pause(); removeAttribute(src); load()`. Play = cache-buster + `load()` + `play()`. | **Stuck on pause; audio starts after ~20s then stops.** |
| 3 | **revert-ish:** pause = `pause()`. Play = `src = URL+?_=ts; play()` (no explicit load). | **Same original issue** — pause stops audio, play-again does nothing. |
| 4 | **resetLive:** pause = `pause(); removeAttribute(src); load()`. Play = `src = LIVE_URL; play()` (no load, no query). | **Stuck on the pause icon; audio keeps playing then stops ~10s after pressing pause.** |
| 5 ✅ | **Standard model:** pause = `pause()`. Play = set `src` once, then `play()`. No teardown, no reconnect. | **WORKS** — after ~5 hard refreshes to clear stale cached JS. |

**Pattern:** the *symptom moved* with every change to the reconnect/teardown
logic — the signature of an async media-state race — while browser caching made it
unclear which code was even running. Removing the reconnect logic entirely (row 5)
and hard-refreshing to load it resolved both.

## 3. Architecture (what actually exists)

Two separate `<audio>` elements, **one** shared bottom player bar UI:

- `#mainAudio` (var `audio`) — the **archive** player. Seekable files. Full
  scrubber, ±15s, resume-position memory. **This works everywhere.**
- `#liveAudio` (var `liveAudio`) — the **live** stream. No scrubber.

Which one the bar represents is tracked by **`barMode`** (`'archive' | 'live' | null`).

**Entry points that drive `liveAudio`:**
- Modal play button: `lpToggle → toggleLive()` (app.js:959)
- Bottom bar play/pause: `playerToggle → togglePlayback()` → if `barMode==='live'` → `toggleLive()` (app.js:659, 666, 669)
- Bottom bar Close: `playerClose` → if `barMode==='live'` → `resetLive()` + teardown bar
- Media Session (lock screen): play → `toggleLive()`, pause/stop → `resetLive()`
- Archive takeover: `playTrack()` calls `resetLive()` before playing an mp3
- `audio` 'play' event: calls `resetLive()` if live was playing

**Icon ownership (two different updaters):**
- Bottom bar icon (`#playerIcon`) is set **only** by `refreshToggleIcon()`
  (app.js:512), which computes "playing" from `barMode==='live' ? (liveLoaded && !liveAudio.paused) : (!audio.paused && !audio.ended)`.
- Modal button icon (`#lpIcon`) + On Air button are set by `setLiveIcon()`.
- These are **different DOM nodes** updated by **different functions** off the
  **same** `liveAudio` events. (Non-standard — see §4.)

**State that gates the toggle logic:** `liveLoaded`, `liveErrored`, `barMode`,
`liveAudio.paused`. A wrong value in any one silently sends `toggleLive()` down the
wrong branch.

## 4. What we are doing that is NOT standard

1. **Two audio elements, one UI.** A conventional player has one `<audio>`. Ours
   multiplexes archive + live through one bar via `barMode`. Every control has to
   ask "which element am I?" first. More branches = more race surface.
2. **Pause implemented as teardown (`resetLive`).** Standard pause is `pause()`.
   We do `pause(); removeAttribute('src'); load()` to force a fresh live edge on
   the next play. `load()` on a live element mid-stream is exactly the operation
   that behaves differently across browsers.
3. **Reconnect on every play.** We reassign `src` (and previously `load()`/cache-
   buster) each play to avoid stale buffer. Standard is `play()` to resume.
4. **Icon state derived, not commanded.** `refreshToggleIcon()` *infers* play/pause
   from `liveAudio.paused` at the moment an event fires. If the element reports a
   transient/late `paused` value (during teardown/reconnect), the icon lands wrong
   and **stays** wrong until the next event.
5. **Two icon updaters for one logical state** (`refreshToggleIcon` for the bar,
   `setLiveIcon` for the modal). They can disagree.
6. **The `play()` promise rejection is swallowed** (`.catch(function(){})`),
   everywhere. Any AbortError/NotAllowedError is invisible — a prime reason
   "nothing happens, no console error."

## 5. Leading hypotheses (to be confirmed by logs, not argued)

- **H1 — teardown/reconnect race (most likely).** `load()` during/after a live
  stream leaves `readyState`/`networkState`/`paused` in a transient state; the
  next `play()` (or the icon logic) reads a stale value. Explains why the symptom
  *moves* every time we change the teardown.
- **H2 — Safari/live-stream specific.** If the user is on Safari (likely, macOS
  app context), `pause()` on a continuous HTTP stream and `load()` teardown are
  known to behave differently than Chrome (buffer keeps draining ~10s → matches
  attempt #4's "audio keeps playing then stops ~10s later"). Needs UA confirmed.
- **H3 — wrong branch in `toggleLive`.** `liveLoaded && !liveAudio.paused` picks
  the branch. If `liveAudio.paused` is briefly `false` right after a teardown, a
  "pause" click re-enters the **play** branch (reconnect) instead of pausing —
  which would look like "stuck on pause icon, audio keeps going."
- **H4 — swallowed `play()` rejection.** Second play rejects with AbortError and
  we never see it. Explains "play does nothing, no console error."

## 6. Plan — instrument first, fix second

**Step 1 (this change): add a debug logger. No behavior change to audio.**
Gated behind `?debug=audio` (or `localStorage.wbaiAudioDebug=1`). When on, render
a fixed on-screen overlay (so it works on any device, screenshot-able) that logs,
with millisecond timestamps:
- Every `liveAudio` event: `loadstart, loadedmetadata, canplay, playing, waiting,
  pause, ended, emptied, abort, stalled, suspend, error`.
- On each event and each control call, a state snapshot:
  `paused, readyState, networkState, currentTime, hasSrc, barMode, liveLoaded, liveErrored, mediaMode`.
- Entry logs for `toggleLive` (which branch), `resetLive`, `togglePlayback`
  (which branch), `showLiveBar`, and the `play()` promise result (resolved /
  rejected+name).
- The User-Agent string (to settle H2).

**Step 2: user reproduces** the 5-step repro with `?debug=audio`, screenshots the
overlay at the moment of the failing click. That log tells us exactly which branch
ran, what `paused`/`readyState` were, and whether `play()` rejected.

**Step 3: fix from evidence.** Candidate end-states, chosen by what the log shows:
- **Simplest standard model (fallback we can trust):** one behavior, no teardown,
  no reconnect — `pause()` to pause, `play()` to resume, `src` set once. Accept
  that resume may be a few seconds behind live. Re-add "go live" *only* if the log
  proves resume is unacceptably stale, and do it with a **separate, explicit**
  mechanism, not inside the pause/play path.
- If the log shows H3 (wrong branch): command the icon explicitly instead of
  deriving it, and gate the branch on an explicit `liveIsPlaying` flag we set,
  not on `liveAudio.paused`.
- If H2 (Safari buffer): stop using `load()` teardown; use `pause()` + set
  `liveAudio.src=''` guarded, or accept buffer.

## 7. Ground rules to break the loop

- **No more changes to the pause/play path without a log** that shows the current
  behavior first.
- **Change one variable at a time.**
- **Unswallow errors** while debugging (log the `play()` rejection).
- Keep `#mainAudio` (archive) untouched — it works; the bug is live-only.
