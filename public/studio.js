'use strict';

/* Studio — the station-side view at /studio.
 *
 * One file for both pages (login and dashboard); each block no-ops when its
 * elements are absent. That keeps the server's job to "serve one of two HTML
 * files" with no per-page asset routing.
 *
 * Everything here obeys the app's CSP (`script-src 'self'`, `style-src 'self'`,
 * no unsafe-inline): no inline handlers, and dynamic sizing goes through the
 * CSSOM rather than markup style attributes. See docs/admin-page.md §2.1.
 */
(function () {

  /* ---------------- theme ----------------
     Identical behaviour to the listener app's toggle, driven by the same
     window.WBAITheme from theme-boot.js. The icon itself is pure CSS (--sun),
     so it is already right before this runs; all this owns is the choice. */
  (function () {
    var btn = document.getElementById('themeBtn');
    var T = window.WBAITheme;
    if (!btn || !T) return;   // boot script blocked — leave the system theme alone

    function label() {
      // Name the action, not the state.
      var next = T.active() === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
      btn.title = 'Switch to ' + next + ' theme';
    }
    btn.addEventListener('click', function () {
      var next = T.active() === 'dark' ? 'light' : 'dark';
      T.save(next);
      T.apply(next);
      label();
    });
    label();
  })();

  /* ---------------- login ---------------- */
  (function () {
    var form = document.getElementById('loginForm');
    if (!form) return;
    var input = document.getElementById('password');
    var submit = document.getElementById('submit');
    var error = document.getElementById('loginError');

    function fail(msg) {
      error.textContent = msg;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Enter';
      input.select();
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Checking…';

      fetch('/api/studio/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      }).then(function (res) {
        if (res.ok) {
          // Replace rather than assign: the login page should not sit in the
          // back-button history of a signed-in session.
          location.replace('/studio');
          return;
        }
        var retry = Number(res.headers.get('Retry-After') || 0);
        // The server deliberately answers a wrong password and a rate-limited
        // attempt identically, so this is the one place the two are told apart
        // — by a header that only ever appears on the second.
        fail(retry
          ? 'Too many attempts. Try again in ' + retry + 's.'
          : 'That password was not accepted.');
      }).catch(function () {
        fail('Could not reach the server.');
      });
    });
  })();

  /* ---------------- dashboard ---------------- */
  (function () {
    var main = document.getElementById('main');
    if (!main || !document.getElementById('storageFacts')) return;

    var logout = document.getElementById('logout');
    if (logout) {
      logout.addEventListener('click', function () {
        fetch('/api/studio/logout', { method: 'POST' })
          .then(function () { location.replace('/studio'); })
          .catch(function () { location.replace('/studio'); });
      });
    }

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    }

    // <dl> of label/value pairs. Built with createElement rather than innerHTML:
    // several of these values come from the environment (a volume name, a data
    // dir) and string-building HTML around values you did not author is how
    // injection bugs start, admin page or not.
    function facts(id, rows) {
      var dl = document.getElementById(id);
      dl.textContent = '';
      rows.forEach(function (row) {
        if (row[1] === undefined) return;
        dl.appendChild(el('dt', 'studio-fact-key', row[0]));
        var dd = el('dd', 'studio-fact-val', row[1]);
        if (row[2]) dd.classList.add(row[2]);
        dl.appendChild(dd);
      });
    }

    function ago(ms) {
      if (!ms) return 'never';
      var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    }

    function duration(sec) {
      if (sec < 60) return sec + 's';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
      return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
    }

    /* The storage verdict, in the words an operator needs rather than the
       fields the server happens to expose. The ordering matters: report the
       failure you can be certain about first. */
    function storageVerdict(s) {
      if (!s.writable) {
        return ['bad', 'Not writable — nothing is being saved at all.'];
      }
      if (s.mounted === false) {
        return ['bad', 'No volume mounted. Everything here dies with this container.'];
      }
      if (s.anonymousVolume) {
        return ['bad', 'Anonymous volume — Docker named it, so the next deploy replaces it.'];
      }
      if (s.freshVolume) {
        // Correct exactly once, and indistinguishable from a real failure until
        // the next deploy. Say so rather than implying either verdict.
        return ['warn', 'Fresh volume. Correct on a first deploy — redeploy and check this again.'];
      }
      return ['good', 'Persisting since ' + new Date(s.persistedSince).toLocaleString() + '.'];
    }

    function render(d) {
      document.getElementById('station').textContent = d.station || '';

      var v = storageVerdict(d.storage);
      var box = document.getElementById('storageVerdict');
      box.setAttribute('data-state', v[0]);
      document.getElementById('storageVerdictText').textContent = v[1];

      facts('storageFacts', [
        ['Data directory', d.storage.dataDir],
        ['Writable', d.storage.writable ? 'yes' : 'no'],
        ['Mounted', d.storage.mounted === null ? 'unknown (not a Linux container)'
          : d.storage.mounted ? 'yes' : 'no'],
        ['Volume', d.storage.volume || '—'],
        ['Instance id', d.storage.instanceId || '—'],
        ['Persisting since', d.storage.persistedSince
          ? new Date(d.storage.persistedSince).toLocaleString() : '—'],
        ['Records on disk at boot', d.storage.showinfoOnDisk + ' shows, ' + d.storage.feedsOnDisk + ' feeds'],
      ]);

      facts('countFacts', [
        ['Feeds', d.counts.feeds],
        ['Programs', d.counts.programs],
        ['Show records', d.counts.showinfo],
      ]);

      // The last full sweep, with its denominator. A bare running total of 304s
      // is unreadable: two consecutive deploys reported 122 and then 0, both
      // correct, because upstream regenerates every feed at once and a sweep
      // either straddles that or doesn't. "122 asked · 122 unchanged" says
      // something; "304s: 0" says nothing.
      var sweep = d.feeds.lastSweep;
      facts('feedFacts', [
        ['Feeds held', d.feeds.held],
        ['Last full sweep', sweep ? ago(sweep.at) : 'not yet this boot'],
        ['That sweep', sweep
          ? sweep.asked + ' asked · ' + sweep.notModified + ' unchanged · '
            + (sweep.asked - sweep.notModified - sweep.failed) + ' refetched'
          : '—'],
        ['Failed in that sweep', sweep ? sweep.failed : '—',
          (sweep && sweep.failed) ? 'is-bad' : ''],
        ['Failures since boot', d.feeds.failed, d.feeds.failed ? 'is-bad' : ''],
      ]);

      facts('buildFacts', [
        ['App bundle', d.version],
        ['Studio bundle', d.studioVersion],
        ['Node', d.node],
        ['Uptime', duration(d.uptimeSec)],
        ['Booted', new Date(d.startedAt).toLocaleString()],
      ]);

      main.setAttribute('aria-busy', 'false');
    }

    function load() {
      fetch('/api/studio/health', { headers: { 'Accept': 'application/json' } })
        .then(function (res) {
          // Any 401 means the session went away underneath us — expired, or the
          // password was rotated. Go back to the door rather than showing a
          // half-dead page.
          if (res.status === 401) { location.replace('/studio'); return null; }
          if (!res.ok) throw new Error('status ' + res.status);
          return res.json();
        })
        .then(function (d) { if (d) render(d); })
        .catch(function (e) {
          var box = document.getElementById('loadError');
          box.textContent = 'Could not load status: ' + e.message;
          box.hidden = false;
          main.setAttribute('aria-busy', 'false');
        });
    }

    load();
    // Slow on purpose. Nothing on this page changes second to second, and a
    // tight poll on an admin page is just load with no information in it.
    //
    // Skipped entirely while the tab is hidden: a studio left open in a
    // background tab overnight would otherwise make ~2,900 pointless requests,
    // and every one of them keeps a session's worth of work alive on a server
    // whose whole design goal is to stay small. Refresh on the way back instead,
    // which is also when a stale number would actually be seen.
    setInterval(function () { if (!document.hidden) load(); }, 30000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) load();
    });
  })();

})();
