'use strict';

/* Usage beacons — the smallest thing that answers "is anyone listening, and to
 * what".
 *
 * WHAT IT SENDS: an event name, and for a play the media URL already in the
 * <audio> element. Nothing else. No identifier, no cookie, no session, no
 * fingerprint — the server stores counters and drops the request, so there is no
 * per-visit history anywhere. "Unique listeners" is therefore not a number this
 * app can produce, deliberately. Search *volume* is counted; the words someone
 * typed are not sent at all.
 *
 * WHY IT IS ITS OWN FILE, and touches nothing in app.js:
 *
 *   app.js is 3,000 lines that own two <audio> elements, a shared player bar and
 *   a touch-lock system with its own war-story documentation. Threading analytics
 *   call sites through it would put counting code in the blast radius of every
 *   playback change, for a feature that must never affect playback. So this
 *   listens from outside instead:
 *
 *   - Media events do not bubble, but they DO propagate through the capture
 *     phase, so one capturing listener on `document` sees `play` from both the
 *     static archive element and the live element that app.js builds and throws
 *     away per connection (see docs/live-audio-pattern.md).
 *   - Which show is playing is resolved SERVER-side from the media URL against
 *     the feed index it already holds. This file never needs to know how app.js
 *     represents the current episode, so it cannot break when that changes.
 *
 * It is loaded `defer` and every listener is passive. If this file fails to
 * parse, the app is unaffected — which is the correct priority.
 */
(function () {
  var LIVE_HOST = 'streaming.wbai.org';

  function send(payload) {
    // A page being closed is exactly when a beacon matters most; sendBeacon is
    // the only thing guaranteed to survive it. keepalive fetch is the fallback.
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/ev', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/ev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* counting must never break the page */ }
  }

  // ---- page view -----------------------------------------------------------
  //
  // The pageview carries the browser's own IANA timezone (`America/New_York`),
  // and it is the ONLY attribute of a visitor this file has ever sent. It is
  // here to answer one question — does this station reach past its own signal —
  // without going near an address: the IP is never read, resolved, retained or
  // sent anywhere, so the "no stored or hashed IP" promise is untouched.
  //
  // What it costs, stated plainly because the README has to say it too: a
  // timezone is a classic fingerprinting *signal*. It is not one here, because
  // there is nothing to join it to — the server files it under one of four
  // fixed buckets (local / national / intl / unknown) and increments a counter,
  // so what reaches the disk is `{ local: 41 }`, not a string attached to a
  // visit. But it is the first
  // visitor attribute collected at all, and that is a real change of kind, not
  // just of degree.
  //
  // Bucketing happens SERVER-side, for the same reason show attribution does:
  // this file stays ignorant, the buckets can be changed without a stale cached
  // page sending the wrong shape, and the fine-grained string never lands in a
  // file. A browser that refuses to say (or an old cached page) sends nothing
  // and counts as `unknown` rather than being guessed at.
  function timezone() {
    try {
      return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 64);
    } catch (e) { return ''; }
  }
  send({ t: 'pageview', z: timezone() });

  // ---- plays ---------------------------------------------------------------
  //
  // One 'play' event is not one listen: pausing and resuming, seeking, and the
  // autoplay retry in app.js all fire it again. Count a source once, unless
  // enough time has passed that it is plausibly a second sitting.
  var lastSrc = '';
  var lastAt = 0;
  var REPLAY_MS = 30 * 60 * 1000;

  document.addEventListener('play', function (ev) {
    var el = ev.target;
    if (!el || !el.currentSrc) return;
    var src = el.currentSrc;
    var now = Date.now();
    if (src === lastSrc && now - lastAt < REPLAY_MS) return;
    lastSrc = src;
    lastAt = now;

    if (src.indexOf(LIVE_HOST) >= 0) send({ t: 'live' });
    else send({ t: 'play', u: src });
  }, true);   // capture: media events do not bubble

  // ---- listening time ------------------------------------------------------
  //
  // A play is a click; time listened is the thing worth knowing. Measured as
  // **media actually consumed**, not wall-clock, by sampling `currentTime` and
  // counting the delta:
  //
  //   - a pause contributes nothing, because currentTime stops advancing;
  //   - a stall or a buffer contributes nothing, for the same reason;
  //   - a SEEK is excluded by the upper bound — jumping ten minutes forward
  //     produces a delta far larger than a sample interval, and counting it
  //     would let one listener manufacture hours by dragging the scrubber.
  //
  // Wall-clock between play and pause would have counted all three as listening.
  //
  // The cost of the seek guard is that the one interval CONTAINING a seek is
  // discarded whole, so a listener who scrubs loses up to a sample interval.
  // That is the correct direction to be wrong in: this number under-reports
  // slightly and can never over-report, which matters for a figure a station
  // might quote. Measured end to end: 50s of uninterrupted playback records
  // 49s; 40s of playback either side of a 30-minute seek records ~24s and
  // never the 1,800.
  var SAMPLE_MS = 15000;
  var SAMPLE_SEC = SAMPLE_MS / 1000;
  var MAX_DELTA = SAMPLE_SEC * 1.5;   // anything larger is a seek, not listening
  var FLUSH_AT_SEC = 20;

  var active = [];            // elements seen playing: at most the two the app owns
  var lastPos = new WeakMap();
  var pending = {};           // src -> whole seconds not yet sent

  // Watch every element that has played. app.js builds and discards a fresh
  // element per live connection, so this is a list rather than a fixed pair,
  // pruned when one leaves the document.
  document.addEventListener('play', function (ev) {
    var el = ev.target;
    if (!el) return;
    // Base the measurement at the moment playback starts, not at the first
    // tick. Establishing it on the first interval silently discarded the
    // opening interval of EVERY listen — a 50s listen measured 29s.
    lastPos.set(el, el.currentTime);
    if (active.indexOf(el) >= 0) return;
    active.push(el);
    active = active.filter(function (e) { return e.isConnected !== false; });
  }, true);

  function addSeconds(src, sec) {
    pending[src] = (pending[src] || 0) + sec;
  }

  function flushListening(force) {
    for (var src in pending) {
      if (!Object.prototype.hasOwnProperty.call(pending, src)) continue;
      var whole = Math.floor(pending[src]);
      if (whole < 1 || (!force && whole < FLUSH_AT_SEC)) continue;
      pending[src] -= whole;
      send({ t: 'listen', u: src, s: whole });
    }
  }

  // `stopping` is the pause/ended path, where the element is already paused but
  // its currentTime still holds the position reached — that final partial
  // interval is real listening and was being thrown away.
  function sample(el, stopping) {
    if (!el || !el.currentSrc) return;
    if (!stopping && (el.paused || el.ended)) return;
    var now = el.currentTime;
    var prev = lastPos.get(el);
    lastPos.set(el, now);
    if (prev === undefined) return;
    var delta = now - prev;
    if (delta > 0 && delta <= MAX_DELTA) addSeconds(el.currentSrc, delta);
  }

  setInterval(function () {
    for (var i = 0; i < active.length; i++) sample(active[i]);
    flushListening(false);
  }, SAMPLE_MS);

  // Stopping is the moment the last partial interval is worth banking, and the
  // page being hidden or closed is the moment it is most likely to be lost.
  //
  // Closing the window mid-episode is the case that matters, and it works
  // because `pagehide` + `sendBeacon` are exactly the pair designed for it: the
  // browser hands the request to the network stack and lets the document die.
  // Measured: 40s of playback, tab closed outright, 39s recorded and attributed.
  //
  // What is NOT recoverable is a hard kill — a crash, an OS out-of-memory, or
  // swiping the app away on a phone — where no unload event fires at all. The
  // exposure is bounded to whatever has not been flushed, at most ~30s. That is
  // an undercount, never an overcount, which is the right way round.
  function stopped(ev) {
    sample(ev.target, true);
    lastPos.delete(ev.target);
    flushListening(true);
  }
  document.addEventListener('pause', stopped, true);
  document.addEventListener('ended', stopped, true);
  function bankEverything() {
    for (var i = 0; i < active.length; i++) sample(active[i], true);
    flushListening(true);
  }
  window.addEventListener('pagehide', bankEverything);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) bankEverything();
  });

  // ---- searches ------------------------------------------------------------
  //
  // Only THAT a search happened — never the words. Terms were collected briefly
  // on 2026-07-31 and removed the same day: the box filters as you type, so
  // people stop after two or three characters and what came back was mostly
  // stems. Not worth collecting, and not collecting it is the simplest promise
  // to keep.
  //
  // Debounced to the settled query so one search is one event rather than one
  // per keystroke, and suppressed while a query is merely being extended — a
  // pause mid-word is still the same search.
  var q = document.getElementById('q');
  if (q) {
    var timer = null;
    var lastCounted = '';
    var lastCountedAt = 0;
    var BURST_MS = 8000;

    q.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var v = (q.value || '').trim();
        if (!v) { lastCounted = ''; return; }
        if (v.length < 2 || v === lastCounted) return;
        var extending = lastCounted
          && (v.indexOf(lastCounted) === 0 || lastCounted.indexOf(v) === 0);
        if (extending && Date.now() - lastCountedAt < BURST_MS) {
          lastCounted = v;
          return;
        }
        lastCounted = v;
        lastCountedAt = Date.now();
        send({ t: 'search' });
      }, 1200);
    }, { passive: true });
  }

  // ---- shares --------------------------------------------------------------
  //
  // The share control is rendered into the info sheet on demand, so match on
  // the way up from whatever was clicked rather than binding to an element that
  // may not exist yet.
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('.sheet-share')) send({ t: 'share' });
  }, true);
})();
