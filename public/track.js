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
  send({ t: 'pageview' });

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

  // ---- searches ------------------------------------------------------------
  //
  // Debounced to the settled query, so one search is one event rather than one
  // per keystroke — nobody searched for "d", "de", "dem", "demo".
  //
  // The query text IS sent, since 2026-07-31. What protects it is on the server
  // and is worth knowing from here: a term is held in memory and **never
  // written to disk** until it has been seen several times, and stored terms
  // are aggregated per month rather than per day. One person searching once for
  // something unusual leaves no record anywhere. See the TRACK_SEARCH_TERMS
  // block in server.js.
  var q = document.getElementById('q');
  if (q) {
    var timer = null;
    var lastSent = '';
    var lastSentAt = 0;
    var BURST_MS = 8000;

    q.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var v = (q.value || '').trim();
        if (!v) { lastSent = ''; return; }
        if (v.length < 2 || v === lastSent) return;

        // Suppress only within one typing burst. Someone who pauses mid-word
        // ("jazz" … "jazz festival") should count once, but the same person
        // refining their search a minute later is a second, real search — and
        // suppressing that outright would bias the record toward truncated
        // queries, which is a worse answer than counting one extra.
        var prefixOfEachOther = lastSent
          && (v.indexOf(lastSent) === 0 || lastSent.indexOf(v) === 0);
        if (prefixOfEachOther && Date.now() - lastSentAt < BURST_MS) {
          lastSent = v;
          return;
        }
        lastSent = v;
        lastSentAt = Date.now();
        send({ t: 'search', q: v.slice(0, 60) });
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
