# Live audio in a browser — the pattern that works

**Written 2026-07-26, after fixing "it played the cache."** This is the portable
version: nothing here is specific to WBAI, and the failure it describes is one
every browser-based live-radio player hits eventually. For this repo's own
history — the attempt log, the earlier pause/play cascade — see
[big-audio-bug.md](big-audio-bug.md). For what to do when something breaks
again, jump to §7.

---

## 1. The failure

**Symptom:** leave the page sitting, press play on the live stream, and hear
audio from minutes ago. Users describe it as "it played the cache."

**Cause:** a live stream has no timeline. An `<audio>` element that is paused and
later resumed continues *from the byte it stopped on*, so it plays whatever was
in its buffer at pause time. There is no seekable range to jump forward in, so
it can never catch up — it just plays the backlog and falls further behind.

The same thing happens with no pause at all. Any of these leave a playing element
permanently behind live:

- the connection stalls for a while and then recovers
- the tab is backgrounded and throttled
- the laptop sleeps

**The trap:** the natural fix ("just resume where we were") is what everyone
writes first, and it is *correct for files and wrong for streams*. An archive
player and a live player look like the same problem and are not.

---

## 2. Why the obvious fixes make it worse

The instinct is to force a fresh connection on each play by mutating the same
element: `removeAttribute('src')`, `load()`, reassign `src`, maybe a cache-buster.

**Do not do this.** `load()` and teardown on a live element leave
`readyState` / `networkState` / `paused` in transient states, and the *next*
click reads those transient values and takes the wrong branch. In this repo that
produced four successive "fixes" where the symptom moved every time — stuck play
buttons, audio continuing after pause, play doing nothing with no console error.
That is the signature of a state-machine race, not a logic bug.

Two rules fall out of that:

- **Never branch on `element.paused`.** Own an explicit intent flag.
- **Never read an element you have torn down.** The cheapest way to guarantee
  that is to not have one.

---

## 3. The pattern: one connection, never reused

```js
let el = null;        // current connection's element, or null when stopped
let wanted = false;   // user intent — every branch and icon reads THIS

function start() {
  stop();                              // no-op when nothing is connected
  wanted = true;
  el = document.createElement('audio');
  wire(el);                            // listeners belong to this element only
  document.body.appendChild(el);
  el.src = URL + '?_=' + Date.now();   // defeat any cache between here and the station
  el.play().catch(onFailure);
}

function stop() {
  const dying = el;
  el = null;                           // dying's remaining events are now ignored
  wanted = false;
  if (!dying) return;
  dying.pause();
  dying.removeAttribute('src');        // the spec's way to stop the download
  dying.load();                        // safe: nothing will ever read this again
  dying.remove();
}

function wire(node) {
  const current = fn => () => { if (node === el) fn(); };   // ignore dead elements
  node.addEventListener('playing', current(onPlaying));
  node.addEventListener('error',   current(onFailure));
  node.addEventListener('ended',   current(onFailure));     // a live stream has no end
  node.addEventListener('pause',   current(() => { if (wanted) stop(); }));
}
```

Why this is safe where §2 was not: the transient states still happen, but they
happen on an element that is already garbage. **Nothing can observe them.**

Consequences worth stating out loud:

- **There is no resume path**, so a stale buffer cannot be played. By
  construction, not by care.
- **Stop means stop** — the socket closes, which also stops burning the
  listener's bandwidth and the station's connection slot.
- **An outside pause is a stop.** An OS interruption, a headset unplug, another
  app taking the audio session — that connection is dead to you; the next play
  must open a new one.
- The UI can still say "Pause". Every live radio app does. The user-visible
  contract is "play = tune in now," which is what they already expect.

---

## 4. Drift: staying at the live edge while playing

Stopping and restarting fixes play-after-idle. It does not fix a connection that
is *still running* and has fallen behind. Measure that directly:

```js
// stamp ONCE per connection, on its first 'playing'
function markEdge(node) {
  if (node._wall) return;              // a stall must not reset the baseline,
  node._wall = Date.now();             // or the lag it caused disappears
  node._time = node.currentTime;
}

function driftMs() {
  if (!el || !el._wall) return 0;
  return (Date.now() - el._wall) - (el.currentTime - el._time) * 1000;
}
```

Drift is 0 on a healthy stream and grows 1:1 with any stall. **Measured, not
assumed:** during a 60s server stall, Chrome fired `waiting` then `stalled`, held
`currentTime` frozen, and drift tracked the stall exactly — 10s, 20s, … 60s. When
bytes resumed, it carried on playing the backlog, permanently a minute behind.

Check drift at the moments the answer can change:

- returning to the tab — `visibilitychange`, `focus`, `pageshow`, `online`
- opening the player UI
- **on `playing` after a stall** — easy to miss, and it is the one case where the
  user never leaves the tab, so no visibility event ever fires

Rate-limit it (once per 30s here) and skip it while the tab is hidden — a
reconnect nobody is listening to just churns the station's server.

---

## 5. A reconnect with no user gesture must be a *handover*

This is the part that is easy to get wrong, and it will not show up in casual
testing.

A drift reconnect has **no user gesture behind it**, so `play()` on the new
element can simply be refused by autoplay policy. If you hard-cut — tear down the
old connection, then start a new one — a refusal destroys working audio and
strands the listener on an error card. Confirmed in Chrome under
`--autoplay-policy=user-gesture-required`; the same rule applies on iOS.

So the replacement must prove itself first:

```js
const prev = el;
const next = newElement();
el = next;                             // events follow the new one
next.src = freshUrl();
next.play()
  .then(() => { if (next === el) destroy(prev); })   // only now is prev expendable
  .catch(() => { if (next === el) { el = prev; destroy(next); } });  // hand back
```

A refused handover then costs nothing: the old connection keeps playing (stale,
but audible), no error card appears, and the user's next tap gets them live the
ordinary way. Also give the handover its own timeout — a replacement that never
starts must be abandoned, or you sit on two connections with the silent one
nominally in charge — and make `stop()` tear down *both* elements, or a stop
mid-handover orphans one that keeps playing.

---

## 6. Error UI: don't put it inside a scrolling modal

Unrelated to audio, found while testing, and worth knowing generally.

A `position: fixed` element **with a `transform` on it** becomes the containing
block for its descendants. Combine that with `overflow: auto` and every child is
clipped at its edge — including `position: fixed` children, which normally escape.

Here the stream-failure card lived inside such a modal, and its "Try again"
button was clipped at *every* window height from 740px to 1200px, because the
modal was capped at 720px tall. Worse, clicking where the button appeared to be
hit the backdrop behind and closed the whole player.

**Fix:** make the alert its own dialog layer, a sibling of the modal rather than
a child, with a higher `z-index`. Then nothing can clip it. If you do that,
remember it no longer inherits the modal's visibility, focus trap, or Escape
handling — wire those by hand (`inert` on the layer behind, focus the primary
action, Escape closes the alert only).

---

## 7. Testing it for real

You cannot verify "did it reconnect at the live edge?" by reading the app's own
state — that is the thing under test. Ask the *station*.

**The key design choice: a fake Icecast that is a true live source.** One cursor
advances in real time; every client is served from wherever that cursor is *now*.
No rewind, no per-client backlog. Because the fake station physically cannot
replay the past, "the client received bytes" *is* the proof it reconnected live.
The server's connection ledger then answers everything: how many connections,
when each opened, where in the live timeline it joined, when it closed.

Run the **real, unmodified app** against it — point the browser's resolver at the
fake station rather than editing the app:

```
--headless=new --mute-audio --remote-debugging-port=9222
--host-resolver-rules="MAP stream.example.org 127.0.0.1:8443"
--ignore-certificate-errors --window-size=1400,1000
```

Same URL, same CSP, same code path. Drive it over the DevTools Protocol.

**Gotchas that cost time here — all of them real:**

| Gotcha | What happens |
| --- | --- |
| **Headless Chrome still plays audio out of the speakers.** | A 440 Hz test tone, at volume, unannounced. **Always pass `--mute-audio`.** |
| Serving MP3 from arbitrary byte offsets | ffmpeg tolerates it; Chrome will not start. Index the file into frames and serve whole frames — real Icecast aligns for this reason. |
| `Emulation.setPageVisibilityOverride` | Removed in Chrome 150. Dispatch real `visibilitychange` / `focus` events instead. |
| Synthetic `element.click()` | Not a user gesture, so it is refused under a strict autoplay policy and your test "fails" for the wrong reason. Use `Input.dispatchMouseEvent`. |
| Trusted clicks land on whatever is topmost | A control below its container's fold gets a click on the scrim instead. Hit-test with `elementFromPoint` before clicking — this is what exposed §6. |
| Leftover state between runs | A connection still playing from a previous run shifts every count by one. Navigate to `about:blank`, *then* reset the ledger, then load the app. |

**Run it under two autoplay policies.** Chrome's default (realistic desktop) and
`--autoplay-policy=user-gesture-required` (worst case, stands in for iOS). The
handover in §5 only fails under the strict one — that run is the entire reason
the bug was found before shipping.

**What to assert:** a fresh connection per play · stop actually closing the
socket · play after a long idle joining the live edge *N seconds further on* ·
another player taking over tearing the stream down · an outside pause treated as
a stop · rapid stop/play not misreporting `AbortError` as a failure · a long
stall · a dead station and a working retry.

---

## 8. Where this lives in this repo

- **Implementation:** the "ONE CONNECTION, NEVER REUSED" block in
  [`public/app.js`](../public/app.js). `startLive()` / `stopLive()` are the only
  two ways audio begins and ends; nothing outside that block touches the element.
- **History and post-mortem:** [big-audio-bug.md](big-audio-bug.md) — §0.5 is the
  current model, §0.6 is what the tests measured, §1–§7 are the original
  pause/play cascade.
- **Test harness:** [`test/live-stream/`](../test/live-stream/) — fake station,
  CDP client, scenario suite. See its README to run it.
- **Simulating a failure by hand:** load the app with `?livefail=down` and press
  play; `?livefail=1` gives the real error path end to end.
