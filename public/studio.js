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

  /* ---------------- info popovers ----------------
     Same clamp-to-viewport idea as chart-tip below: a popover centred purely
     in CSS on its trigger runs off-screen once the trigger sits near the left
     edge of the page, which the first two section headings always do. */
  (function () {
    var btns = document.querySelectorAll('.info-btn');
    if (!btns.length) return;
    var openPop = null;

    function place(btn, pop) {
      var pad = 12;
      var b = btn.getBoundingClientRect();
      var r = pop.getBoundingClientRect();
      var x = Math.min(Math.max(pad, b.left + b.width / 2 - r.width / 2),
        window.innerWidth - r.width - pad);
      var y = b.bottom + 8;
      if (y + r.height + pad > window.innerHeight) y = b.top - r.height - 8;
      pop.style.setProperty('--ix', x + 'px');
      pop.style.setProperty('--iy', y + 'px');
    }
    function show(btn) {
      var pop = btn.nextElementSibling;
      if (!pop) return;
      place(btn, pop);
      pop.classList.add('is-open');
      openPop = pop;
    }
    function hide() {
      if (!openPop) return;
      openPop.classList.remove('is-open');
      openPop = null;
    }
    [].forEach.call(btns, function (btn) {
      btn.addEventListener('pointerenter', function () { show(btn); });
      btn.addEventListener('pointerleave', hide);
      btn.addEventListener('focus', function () { show(btn); });
      btn.addEventListener('blur', hide);
    });
  })();

  /* ---------------- login ---------------- */
  (function () {
    var form = document.getElementById('loginForm');
    if (!form) return;
    var input = document.getElementById('password');
    var submit = document.getElementById('submit');
    var error = document.getElementById('loginError');
    var reveal = document.getElementById('revealPassword');

    if (reveal) {
      reveal.addEventListener('click', function () {
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        reveal.setAttribute('aria-pressed', String(!showing));
        reveal.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        input.focus();
      });
    }

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

    /* ---------------- chart primitives ----------------
     *
     * Bars and meters are plain HTML: CSS handles the ellipsis on a long show
     * title, the responsive width, and the theme, none of which SVG gives for
     * free. Only the 72-column histogram is SVG, where the geometry is the
     * whole job. Widths are set through the CSSOM (`--pct`), which the app's
     * CSP allows — it blocks style attributes parsed from markup, not the
     * style object. app.js has done the same since long before this page.
     */

    var TIP = document.getElementById('chartTip');

    function showTip(ev, valueText, labelText) {
      TIP.textContent = '';
      TIP.appendChild(el('div', 'chart-tip-value', valueText));
      // textContent, never innerHTML: show titles are upstream data.
      TIP.appendChild(el('div', 'chart-tip-label', labelText));
      TIP.hidden = false;
      moveTip(ev);
    }
    function moveTip(ev) {
      if (TIP.hidden) return;
      var pad = 14;
      var r = TIP.getBoundingClientRect();
      // Point coordinates come from the pointer, or from the element's own box
      // when this was triggered by keyboard focus rather than a mouse.
      var x = (ev && ev.clientX) || 0, y = (ev && ev.clientY) || 0;
      if (!x && ev && ev.target && ev.target.getBoundingClientRect) {
        var b = ev.target.getBoundingClientRect();
        x = b.left + b.width / 2; y = b.top;
      }
      // Keep it on screen — a tooltip clipped by the viewport is worse than none.
      var left = Math.min(Math.max(pad, x + pad), window.innerWidth - r.width - pad);
      var top = y - r.height - pad;
      if (top < pad) top = y + pad * 1.6;
      TIP.style.setProperty('--x', left + 'px');
      TIP.style.setProperty('--y', top + 'px');
    }
    function hideTip() { TIP.hidden = true; }

    /**
     * Ranked horizontal bars. One colour for every bar, on purpose: these
     * categories are nominal, so shading by value would encode the bar's length
     * a second time and spend the only free channel saying nothing new.
     *
     * rows: [{ label, value, display }]
     */
    function barChart(node, rows, unit) {
      node.textContent = '';
      var max = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 0) || 1;
      rows.forEach(function (r) {
        var row = el('div', 'bar-row');
        row.tabIndex = 0;
        // The row carries the whole reading for assistive tech; the tooltip is
        // an enhancement on top, never the only route to the number.
        row.setAttribute('aria-label', r.label + ': ' + r.display + ' ' + unit);
        var label = el('div', 'bar-label', r.label);
        label.title = r.label;          // native tooltip when the text is clipped
        var track = el('div', 'bar-track');
        var fill = el('div', 'bar-fill' + (r.value > 0 ? ' bar-fill--nonzero' : ''));
        fill.style.setProperty('--pct', (r.value / max) * 100 + '%');
        track.appendChild(fill);
        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(el('div', 'bar-value', r.display));
        function show(ev) { showTip(ev, r.display + ' ' + unit, r.label); }
        row.addEventListener('pointerenter', show);
        row.addEventListener('pointermove', moveTip);
        row.addEventListener('pointerleave', hideTip);
        row.addEventListener('focus', show);
        row.addEventListener('blur', hideTip);
        node.appendChild(row);
      });
    }

    /** A ratio against a limit. Ordered, so the ramp is legitimate here. */
    function meters(node, rows) {
      node.textContent = '';
      rows.forEach(function (r, i) {
        var wrap = el('div', 'meter');
        var head = el('div', 'meter-head');
        head.appendChild(el('span', 'meter-name', r.label));
        head.appendChild(el('span', 'meter-num',
          r.value + ' / ' + r.of + '  ·  ' + Math.round((r.value / r.of) * 100) + '%'));
        var track = el('div', 'meter-track');
        var fill = el('div', 'meter-fill' + (i ? ' meter-fill--' + (i + 1) : ''));
        fill.style.setProperty('--pct', (r.value / r.of) * 100 + '%');
        track.appendChild(fill);
        wrap.appendChild(head);
        wrap.appendChild(track);
        node.appendChild(wrap);
      });
    }

    var SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs) {
      var n = document.createElementNS(SVG_NS, tag);
      for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
      return n;
    }

    /**
     * Episodes per day. Columns rather than a line: these are counts of
     * discrete things on discrete days, and a line would draw slopes between
     * days that never happened.
     *
     * Days with nothing are drawn as a faint baseline tick rather than left
     * blank, so an empty day is visibly a measured zero and not a rendering
     * gap. Rendered at measured pixel width so the type stays the right size
     * instead of scaling with a viewBox.
     */
    function columnChart(node, days, unit) {
      node.textContent = '';
      if (!days.length) return;
      var w = Math.max(280, Math.round(node.getBoundingClientRect().width));
      var h = 170, padB = 22, padT = 14;
      var max = days.reduce(function (m, d) { return Math.max(m, d.episodes); }, 0) || 1;
      var slot = w / days.length;
      var barW = Math.max(2, Math.min(24, slot - 2));   // 2px gap; capped thickness
      var peak = days.reduce(function (m, d) { return d.episodes > m.episodes ? d : m; }, days[0]);
      var empty = days.filter(function (d) { return !d.episodes; }).length;

      var svg = svgEl('svg', {
        width: w, height: h, viewBox: '0 0 ' + w + ' ' + h,
        role: 'img',
        // 72 focusable columns would be a tab trap; one honest summary is
        // better, and every underlying number is in the table above.
        'aria-label': (unit || 'episodes') + ' per day, ' + days[0].day + ' to ' + days[days.length - 1].day
          + '. Peak ' + peak.episodes + ' on ' + peak.day + '. '
          + empty + ' of ' + days.length + ' days have none.',
      });

      svg.appendChild(svgEl('line', {
        x1: 0, y1: h - padB, x2: w, y2: h - padB, class: 'chart-axis',
      }));

      days.forEach(function (d, i) {
        var x = i * slot + (slot - barW) / 2;
        var plot = h - padB - padT;
        var barH = d.episodes ? Math.max(2, (d.episodes / max) * plot) : 2;
        svg.appendChild(svgEl('rect', {
          x: x.toFixed(2), y: (h - padB - barH).toFixed(2),
          width: barW.toFixed(2), height: barH.toFixed(2),
          rx: Math.min(2, barW / 2),
          class: d.episodes ? 'chart-col' : 'chart-col--empty',
        }));
        // Hit target spans the whole slot, so the pointer only has to be
        // nearest — a 3px column is not something anyone can aim at.
        var hit = svgEl('rect', {
          x: (i * slot).toFixed(2), y: 0, width: slot.toFixed(2), height: h - padB,
          class: 'chart-hit',
        });
        function show(ev) {
          var u = unit || 'episodes';
          showTip(ev, d.episodes + ' ' + (d.episodes === 1 ? u.replace(/s$/, '') : u), d.day);
        }
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('pointermove', moveTip);
        hit.addEventListener('pointerleave', hideTip);
        svg.appendChild(hit);
      });

      // Only the ends and the peak are labelled. A tick under all 72 would be
      // unreadable, and the tooltip carries the rest.
      [[0, days[0].day], [days.length - 1, days[days.length - 1].day]].forEach(function (p, n) {
        var t = svgEl('text', {
          x: n === 0 ? 0 : w, y: h - 6, class: 'chart-tick',
          'text-anchor': n === 0 ? 'start' : 'end',
        });
        // Full dates drop the year to stay readable at 72 columns; anything
        // shorter (a YYYY-MM month from the show-history chart) is already
        // terse and the year is the information, so it stays whole.
        t.textContent = p[1].length > 7 ? p[1].slice(5) : p[1];
        svg.appendChild(t);
      });
      // The peak label is centred on its column — except near either edge,
      // where a centred label runs past the SVG boundary and is clipped. That
      // shipped once: a peak on the last day rendered "peak 4" for a value of
      // 41, which is not a cosmetic bug but a wrong number on screen. Anchor to
      // the edge instead of centring when there is not room to centre.
      var pkX = days.indexOf(peak) * slot + slot / 2;
      var anchor = 'middle';
      if (pkX < 28) { pkX = 0; anchor = 'start'; }
      else if (pkX > w - 28) { pkX = w; anchor = 'end'; }
      var pk = svgEl('text', {
        x: pkX.toFixed(2), y: padT - 3, class: 'chart-tick', 'text-anchor': anchor,
      });
      pk.textContent = 'peak ' + peak.episodes;
      svg.appendChild(pk);

      node.appendChild(svg);
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

      // ---- actions
      //
      // Rendered from what the server says it supports, so the page cannot
      // offer a button the server will reject. Built once; re-rendering on
      // every 30s poll would steal focus and wipe a running result.
      var actionsBox = document.getElementById('actions');
      if (actionsBox && !actionsBox.children.length && d.actions) {
        d.actions.forEach(function (a) {
          var b = el('button', 'action-btn', a.label);
          b.type = 'button';
          b.addEventListener('click', function () {
            // These are cheap and idempotent, but "re-check every feed" reaches
            // out to WBAI 122 times — worth one deliberate keystroke.
            if (!window.confirm(a.label + '?\n\nThis refreshes our cache from WBAI.')) return;
            var result = document.getElementById('actionResult');
            b.disabled = true;
            var was = b.textContent;
            b.textContent = 'Working…';
            result.textContent = '';
            fetch('/api/studio/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Studio-CSRF': d.csrf },
              body: JSON.stringify({ action: a.name }),
            }).then(function (res) {
              return res.json().then(function (body) { return { status: res.status, body: body }; });
            }).then(function (r) {
              if (r.status === 429) {
                result.textContent = 'Just ran — try again in ' + r.body.retryInSec + 's.';
              } else if (r.body && r.body.ok) {
                result.textContent = a.label + ': ' + r.body.result;
                load();     // the panels above are now stale
              } else {
                result.textContent = a.label + ' failed: '
                  + ((r.body && (r.body.error || r.body.result)) || 'unknown error');
              }
            }).catch(function (e) {
              result.textContent = a.label + ' failed: ' + e.message;
            }).then(function () {
              b.disabled = false;
              b.textContent = was;
            });
          });
          actionsBox.appendChild(b);
        });
      }

      // ---- feed problems, named rather than counted
      var probs = document.getElementById('feedProblems');
      probs.textContent = '';
      if (d.feeds.failures && d.feeds.failures.length) {
        var f = document.createElement('details');
        f.className = 'gap-list';
        f.open = true;   // an actual failure should not need a click to be seen
        var fs = document.createElement('summary');
        fs.appendChild(el('strong', '', d.feeds.failures.length + ' recent fetch failure(s)'));
        f.appendChild(fs);
        d.feeds.failures.forEach(function (x) {
          f.appendChild(el('p', 'gap-slugs', x.slug + ' — ' + x.error + ' (' + ago(x.at) + ')'));
        });
        probs.appendChild(f);
      }
      if (d.feeds.stale && d.feeds.stale.length) {
        var st = document.createElement('details');
        st.className = 'gap-list';
        var ss = document.createElement('summary');
        ss.appendChild(el('strong', '', d.feeds.stale.length + ' feeds not confirmed recently'));
        st.appendChild(ss);
        st.appendChild(el('p', 'gap-why',
          'Not re-checked within a full TTL. `fetchedAt` moves on a 304, so this '
          + 'means not checked — not unchanged.'));
        st.appendChild(el('p', 'gap-slugs', d.feeds.stale.map(function (x) {
          return x.slug + (x.fetchedAt ? ' (' + ago(x.fetchedAt) + ')' : ' (never)');
        }).join(', ')));
        probs.appendChild(st);
      }

      // ---- upstream hosts
      var hosts = document.getElementById('upstream');
      hosts.textContent = '';
      (d.upstream || []).forEach(function (h) {
        var row = el('div', 'host');
        row.appendChild(el('div', 'host-name', h.host));
        row.appendChild(el('div', 'host-stat', h.lastMs + 'ms · slowest ' + h.slowestMs + 'ms'));
        var meta = el('div', 'host-meta');
        meta.appendChild(document.createTextNode(
          h.ok + ' ok · ' + h.missing + ' not found · '));
        var fail = el('span', h.fail ? 'is-bad' : '', h.fail + ' failed');
        meta.appendChild(fail);
        meta.appendChild(document.createTextNode(
          ' · last ' + (h.lastStatus || 'error') + ' ' + ago(h.lastAt)));
        row.appendChild(meta);
        hosts.appendChild(row);
      });

      var p = d.process;
      facts('processFacts', [
        ['Uptime', duration(p.uptimeSec)],
        ['Node', p.node],
        ['Memory', p.rssMb + ' MB resident · ' + p.heapMb + ' MB heap'],
        ['Archive cache', p.caches.archive.hits + ' hits / ' + p.caches.archive.misses + ' misses'],
        ['Now-playing cache', p.caches.nowplaying.hits + ' hits / ' + p.caches.nowplaying.misses + ' misses'],
        ['Next full feed sweep', d.feeds.nextSweepInMs
          ? 'in ' + duration(Math.round(d.feeds.nextSweepInMs / 1000)) : 'due now'],
      ]);

      // Uptime and Node live in Process now; repeating them here was just noise.
      facts('buildFacts', [
        ['App bundle', d.version],
        ['Studio bundle', d.studioVersion],
        ['Booted', new Date(d.startedAt).toLocaleString()],
      ]);

      main.setAttribute('aria-busy', 'false');
    }

    /* ---------------- the archive stats ---------------- */

    var stats = null;                 // kept for re-render on resize and sort
    var sortKey = 'title', sortAsc = true;

    function num(n) { return Number(n).toLocaleString(); }
    // Listening time spans seconds on day one and hundreds of hours later, so
    // the unit has to move with it rather than showing "0h" for a real figure.
    function listenTime(sec) {
      if (!sec) return '0';
      if (sec < 60) return sec + 's';
      if (sec < 3600) return Math.round(sec / 60) + 'm';
      var h = sec / 3600;
      return (h < 10 ? h.toFixed(1) : String(Math.round(h))) + 'h';
    }
    function hours(sec) { return Math.round(sec / 3600); }

    function renderStats(d) {
      stats = d;
      var gb = d.totals.bytes / 1e9;

      var kpis = document.getElementById('kpis');
      kpis.textContent = '';
      [
        [num(d.totals.feeds), '', 'Shows'],
        [num(d.totals.episodes), '', 'Episodes'],
        [num(d.totals.hours), 'h', 'Audio held'],
        [gb.toFixed(1), 'GB', 'Total size'],
        [num(d.totals.categories), '', 'Categories'],
        [num(d.window.days), 'd', 'Window'],
      ].forEach(function (k) {
        var tile = el('div', 'kpi');
        var v = el('div', 'kpi-value', k[0]);
        if (k[1]) v.appendChild(el('span', 'kpi-unit', k[1]));
        tile.appendChild(v);
        tile.appendChild(el('div', 'kpi-label', k[2]));
        kpis.appendChild(tile);
      });

      // One decimal below 10h: the thin end is where fractions of an hour are
      // the whole difference between one show and the next.
      function hrs(sec) {
        var h = sec / 3600;
        return h < 10 ? h.toFixed(1) : String(Math.round(h));
      }
      var capped = d.episodeSpread.length ? d.episodeSpread[0] : { count: 0 };
      document.getElementById('atCap').textContent = capped.count;
      document.getElementById('capOf').textContent = d.totals.feeds;

      barChart(document.getElementById('thinnest'), d.thinnest.map(function (s) {
        return { label: s.title, value: s.seconds, display: hrs(s.seconds) };
      }), 'hours');

      barChart(document.getElementById('episodeSpread'), d.episodeSpread.map(function (e) {
        return {
          label: e.episodes + (e.episodes === 1 ? ' episode' : ' episodes'),
          value: e.count,
          display: num(e.count),
        };
      }), 'shows');

      document.getElementById('catCount').textContent = d.totals.categories;
      barChart(document.getElementById('categories'), d.categories.map(function (c) {
        return { label: c.name, value: c.episodes, display: num(c.episodes) };
      }), 'episodes');

      barChart(document.getElementById('durations'), d.durations.map(function (b) {
        return { label: b.label, value: b.episodes, display: num(b.episodes) };
      }), 'episodes');

      columnChart(document.getElementById('perDay'), d.perDay);

      var c = d.coverage;
      meters(document.getElementById('coverage'), [
        { label: 'Shows with a harvested description', value: c.withDescription, of: c.feeds },
        { label: 'Shows matched to the program directory', value: c.withDirectory, of: c.feeds },
        { label: 'Directory programs with a feed', value: c.withDirectory, of: c.directoryPrograms },
      ]);

      // Collapsed by default. Naming the gaps is the point — a count nobody can
      // act on is decoration — but 35 slugs unfurled is a wall of text that
      // buries the three ratios above it. <details> is native, keyboard
      // operable and announced correctly, with no JS behind it.
      var gaps = document.getElementById('gaps');
      gaps.textContent = '';
      [
        [c.noDescription, 'no harvested description yet',
          'Harvested only while a show is on air, so these fill in as the schedule turns.'],
        [c.noDirectory, 'no match in the program directory',
          'The feed title and the wbai.org program name differ, or the show is not listed there.'],
      ].forEach(function (g) {
        if (!g[0].length) return;
        var d = document.createElement('details');
        d.className = 'gap-list';
        var s = document.createElement('summary');
        s.appendChild(el('strong', '', g[0].length + ' shows'));
        s.appendChild(document.createTextNode(' with ' + g[1]));
        d.appendChild(s);
        d.appendChild(el('p', 'gap-why', g[2]));
        d.appendChild(el('p', 'gap-slugs', g[0].join(', ')));
        gaps.appendChild(d);
      });

      renderTable();
    }

    /* The rows the table currently shows — filtered and sorted. One function,
       used by both the renderer and the CSV export, so the file a user
       downloads is exactly the table they are looking at. */
    function visibleRows() {
      var q = (document.getElementById('showFilter').value || '').toLowerCase().trim();
      var rows = stats.shows.filter(function (s) {
        return !q || s.title.toLowerCase().indexOf(q) >= 0 || s.slug.indexOf(q) >= 0;
      });
      rows.sort(function (a, b) {
        var x = a[sortKey], y = b[sortKey];
        x = x === undefined ? 0 : x;
        y = y === undefined ? 0 : y;
        var r = (typeof x === 'string') ? x.localeCompare(y) : x - y;
        // Ties are the common case here — most shows hold the same five
        // episodes and nobody has played most of them — so break them by title
        // rather than leaving 100 rows in whatever order the feed map yielded.
        if (r === 0 && sortKey !== 'title') return a.title.localeCompare(b.title);
        return sortAsc ? r : -r;
      });
      return rows;
    }

    function renderTable() {
      if (!stats) return;
      var rows = visibleRows();

      var body = document.getElementById('showTableBody');
      body.textContent = '';
      rows.forEach(function (s) {
        var tr = document.createElement('tr');
        // A row is a door as well as a reading: it opens the month-by-month
        // history below the table. Focusable and keyboard-operable, because
        // a click-only affordance on a <tr> is invisible to a keyboard.
        tr.className = 'show-row';
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-label', s.title + ' — show month-by-month history');
        function open() { openHistory(s.slug); }
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
        });
        tr.appendChild(el('td', 'show-title', s.title));
        var slug = el('td', 'num', s.slug);
        tr.appendChild(slug);
        tr.appendChild(el('td', 'num', num(s.episodes)));
        tr.appendChild(el('td', 'num', String(hours(s.seconds))));
        tr.appendChild(el('td', 'num', num(s.plays || 0)));
        tr.appendChild(el('td', 'num', listenTime(s.listened || 0)));
        tr.appendChild(el('td', 'num', s.newest
          ? new Date(s.newest * 1000).toISOString().slice(0, 10) : '—'));
        body.appendChild(tr);
      });

      document.getElementById('tableCount').textContent =
        rows.length === stats.shows.length
          ? rows.length + ' shows'
          : rows.length + ' of ' + stats.shows.length + ' shows';

      // aria-sort belongs on the column header cell — the th, not the button
      // inside it — and on exactly one header at a time. The arrows are drawn
      // from it in CSS, so this is also what makes the direction visible.
      [].forEach.call(document.querySelectorAll('.th-sort'), function (b) {
        var th = b.parentNode;
        if (b.getAttribute('data-sort') === sortKey) {
          th.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending');
        } else th.removeAttribute('aria-sort');
      });
    }

    [].forEach.call(document.querySelectorAll('.th-sort'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        // Same column toggles direction; a new column starts descending for
        // numbers and ascending for text, which is what each reads best as.
        if (k === sortKey) sortAsc = !sortAsc;
        else { sortKey = k; sortAsc = (k === 'title' || k === 'slug'); }
        renderTable();
      });
    });
    document.getElementById('showFilter').addEventListener('input', renderTable);

    /* ---------------- CSV export ----------------
       Built from visibleRows(), so the download is the table as filtered and
       sorted right now — not a second report that can disagree with the one on
       screen. Raw units on purpose (seconds, not "4m"): a spreadsheet can
       format, but it cannot un-round. */
    (function () {
      var btn = document.getElementById('csvExport');
      if (!btn) return;
      function csvCell(v) {
        var s = String(v == null ? '' : v);
        // Excel executes cells that begin with = + - @ as formulas. A show
        // title is upstream data; neutralise rather than trust.
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      btn.addEventListener('click', function () {
        if (!stats) return;
        var win = stats.usageWindowDays || 30;
        var head = ['show', 'slug', 'episodes', 'audio_seconds',
          'plays_' + win + 'd', 'listened_seconds_' + win + 'd', 'newest_episode'];
        var lines = [head.join(',')];
        visibleRows().forEach(function (s) {
          lines.push([
            csvCell(s.title), csvCell(s.slug), s.episodes, s.seconds,
            s.plays || 0, s.listened || 0,
            s.newest ? new Date(s.newest * 1000).toISOString().slice(0, 10) : '',
          ].join(','));
        });
        var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'shows-' + win + 'd-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke on a delay: revoking synchronously races the download in
        // some browsers and yields an empty file.
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      });
    })();

    /* ---------------- per-show history (drill-down) ---------------- */

    function openHistory(slug) {
      var box = document.getElementById('showHistory');
      fetch('/api/studio/showhistory?slug=' + encodeURIComponent(slug),
        { headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (h) {
          if (!h) return;
          document.getElementById('showHistoryTitle').textContent =
            h.title + ' — month by month';
          var body = document.getElementById('showHistoryBody');
          body.textContent = '';
          h.months.forEach(function (m) {
            var tr = document.createElement('tr');
            tr.appendChild(el('td', '', m.month));
            tr.appendChild(el('td', 'num', num(m.plays)));
            tr.appendChild(el('td', 'num', listenTime(m.seconds)));
            body.appendChild(tr);
          });
          box.hidden = false;
          // Reuses the day histogram; a month is just a coarser bucket of the
          // same question. Minutes, matching the chart above it.
          columnChart(document.getElementById('showHistoryChart'),
            h.months.map(function (m) {
              return { day: m.month, episodes: Math.round(m.seconds / 60) };
            }), 'minutes');
          box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        })
        .catch(function () { /* row stays; nothing to break */ });
    }

    var histClose = document.getElementById('showHistoryClose');
    if (histClose) {
      histClose.addEventListener('click', function () {
        document.getElementById('showHistory').hidden = true;
      });
    }

    /* ---------------- reporting window ----------------
       One control for every listening figure on the page — the KPIs, the day
       chart, reach, top shows and the table's plays/listened columns — so no
       two panels can describe different periods while looking like one report. */
    var windowDays = '30';
    (function () {
      var picker = document.getElementById('winPicker');
      if (!picker) return;
      picker.addEventListener('click', function (ev) {
        var b = ev.target.closest('.win-btn');
        if (!b || b.getAttribute('data-days') === windowDays) return;
        windowDays = b.getAttribute('data-days');
        [].forEach.call(picker.querySelectorAll('.win-btn'), function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
        loadUsage();   // health does not depend on the window; skip it
      });
    })();

    // The histogram is sized in real pixels, so it has to be rebuilt when the
    // box changes. Debounced — a resize drag fires this continuously.
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (stats) columnChart(document.getElementById('perDay'), stats.perDay);
      }, 150);
    });

    function renderUsage(u) {
      var k = document.getElementById('usageKpis');
      k.textContent = '';
      [
        [listenTime(u.totals.listenSeconds), '', 'Time listened'],
        [listenTime(u.totals.liveSeconds), '', 'Live listened'],
        [num(u.totals.plays), '', 'Episode plays'],
        [num(u.totals.live), '', 'Live tune-ins'],
        [num(u.totals.pageviews), '', 'Page views'],
        [num(u.totals.searches), '', 'Searches'],
        [num(u.totals.shares), '', 'Shares'],
      ].forEach(function (t) {
        var tile = el('div', 'kpi');
        tile.appendChild(el('div', 'kpi-value', t[0]));
        tile.appendChild(el('div', 'kpi-label', t[2]));
        k.appendChild(tile);
      });

      // Reuse the air-date histogram: same shape of question, same mark. It
      // already draws a measured zero as a baseline tick, which matters more
      // here — a quiet day and a broken collector must not look alike.
      // A silent cap is the worst kind: the numbers just read low. Say so.
      // usageNote now lives inside the hover popover off the "Listening"
      // heading, so this warning is anchored to the heading itself instead —
      // it needs to stay visible without a hover, unlike the explainer prose.
      var heading = document.getElementById('usageNote').closest('h2');
      var warn = document.getElementById('usageDropped');
      if (warn) warn.remove();
      if (u.droppedBeacons) {
        var w = el('p', 'usage-empty', '⚠ ' + num(u.droppedBeacons)
          + ' beacons were refused by the per-address rate limit since this server '
          + 'started, so the figures below are an undercount.');
        w.id = 'usageDropped';
        heading.parentNode.insertBefore(w, heading.nextSibling);
      }

      // Minutes listened per day, not plays — the same reason the ranking below
      // is by seconds. Rounded to minutes so the axis is a human quantity.
      columnChart(document.getElementById('usageDays'),
        u.days.map(function (d) {
          return { day: d.day, episodes: Math.round((d.listenSeconds || 0) / 60) };
        }), 'minutes');

      var shows = document.getElementById('usageShows');
      if (!u.topShows.length) {
        shows.textContent = '';
        shows.appendChild(el('p', 'usage-empty',
          u.totals.plays
            ? 'Plays recorded, but none matched a show in the current feed window.'
            : 'Nothing counted yet. Counting began when this was deployed — it does not backfill.'));
      } else {
        barChart(shows, u.topShows.map(function (s) {
          return { label: s.title, value: s.seconds, display: listenTime(s.seconds) };
        }), 'listened');
      }

      renderReach(u.reach);
    }

    // Reach — page views by reported timezone. Bars rather than a pie: three or
    // four categories where one usually dwarfs the rest is exactly the case a
    // pie reads worst, and the bar shares an axis with everything else here.
    function renderReach(r) {
      var node = document.getElementById('usageReach');
      if (!node) return;
      node.textContent = '';
      if (!r || !r.total) {
        node.appendChild(el('p', 'usage-empty',
          'No page views counted yet. Reach began recording when this was '
          + 'deployed — like every counter here, it does not backfill.'));
        return;
      }
      // `unknown` is dropped once nothing is landing in it, but kept visible
      // while it is non-zero: right after a deploy it is simply everyone still
      // running a cached page, and hiding it would make the other three read as
      // shares of a whole they are not yet a whole of.
      barChart(node, r.buckets
        .filter(function (b) { return b.key !== 'unknown' || b.count > 0; })
        .map(function (b) {
          return {
            label: b.label,
            value: b.count,
            display: num(b.count) + '  ·  ' + b.pct + '%',
          };
        }), 'page views');
    }

    /* Everything the window picker governs, fetched with the active window.
       Separate from load() so changing the window re-asks these two questions
       without also re-polling health, which has no window in it. */
    function loadUsage() {
      var q = '?days=' + windowDays;
      fetch('/api/studio/usage' + q, { headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (u) { if (u) renderUsage(u); })
        .catch(function () { /* the health panel reports an outage */ });

      fetch('/api/studio/stats' + q, { headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (d) { if (d) renderStats(d); })
        .catch(function () { /* the health panel below reports the outage */ });
    }

    /* ---------------- export ----------------
       A dialog opened from the header. Dates are a from/to span of UTC days,
       bounded by what the server reports (the 1st of the oldest stats month,
       and today). Presets come from the server's `today`, never this browser's
       clock: a New York evening is already tomorrow in UTC, and the counters
       are UTC days. The index is re-read on every open, so a new day appears
       without a reload. */
    function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
    function utcMs(d) { return Date.parse(d + 'T00:00:00Z'); }
    function exportPresets(today, first) {
      var y = +today.slice(0, 4), m = +today.slice(5, 7);
      var clamp = function (from, to) {
        if (to < first) return null;   // wholly before any data: not offered
        return { from: from < first ? first : from, to: to };
      };
      return {
        thisMonth: clamp(today.slice(0, 8) + '01', today),
        lastMonth: clamp(isoDay(Date.UTC(y, m - 2, 1)), isoDay(Date.UTC(y, m - 1, 0))),
        thisYear: clamp(today.slice(0, 5) + '01-01', today),
        all: clamp(first, today),
      };
    }
    function longDay(d) {
      return new Date(utcMs(d)).toLocaleDateString(undefined,
        { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    function fileSize(n) {
      return n < 1024 ? n + ' bytes' : (Math.round(n / 102.4) / 10) + ' KB';
    }

    (function () {
      var dialog = document.getElementById('exportDialog');
      var openBtn = document.getElementById('exportOpen');
      if (!dialog || !openBtn || typeof dialog.showModal !== 'function') {
        if (openBtn) openBtn.hidden = true;
        return;
      }
      var form = document.getElementById('exportForm');
      var fromEl = document.getElementById('exportFrom');
      var toEl = document.getElementById('exportTo');
      var presetsEl = document.getElementById('exportPresets');
      var note = document.getElementById('exportSpanNote');
      var statusEl = document.getElementById('exportStatus');
      var go = document.getElementById('exportGo');
      var readme = document.getElementById('exportReadme');
      var empty = document.getElementById('exportEmpty');
      var datesStep = document.getElementById('exportDates');
      var clock = document.getElementById('exportClock');
      var index = null;     // the last /api/studio/exports answer
      var presets = {};
      // The preset last chosen, while the dates still equal it. Matching by
      // dates alone lit three buttons at once whenever the data is younger
      // than a year — This month, This year and All time are then one span.
      var chosen = 'thisMonth';
      var busy = false;

      // What each dataset's dates mean, and what "nothing yet" means for it.
      var CLOCK = {
        utc: 'Days are UTC calendar days — the listening counters were recorded that way.',
        local: function (tz) { return 'Episodes are chosen by air date in ' + tz + ', the station’s timezone.'; },
        none: 'Coverage is a snapshot of every show right now, so dates do not apply.',
        mixed: function (tz) {
          return 'Listening figures use UTC days; the archive section uses air dates in ' + tz + '.';
        },
      };
      var EMPTY = {
        listening: 'Nothing has been counted yet. Counting began when this app was deployed — it does not backfill. An export now has the columns and no figures.',
        inventory: 'The archive holds no episodes right now. An export now has the columns and no rows.',
        coverage: 'No shows are known yet — the archive listing has not been read. Try again in a minute.',
        report: '',
      };

      function status(text, kind) {
        statusEl.textContent = text;
        statusEl.className = 'export-status' + (kind ? ' is-' + kind : '');
      }
      function datasetName() { return form.querySelector('input[name=exportDataset]:checked').value; }
      function dataset() {
        var name = datasetName();
        return index ? index.datasets.filter(function (d) { return d.name === name; })[0] : null;
      }
      function spanOk() {
        var d = dataset();
        if (d && !d.span) return true;
        var from = fromEl.value, to = toEl.value;
        return !!(from && to && from <= to && from >= fromEl.min && to <= toEl.max);
      }
      function refresh() {
        var d = dataset();
        if (!d) { go.disabled = true; readme.disabled = true; return; }
        var from = fromEl.value, to = toEl.value, ok = spanOk();
        // Coverage cannot be built without any known show; the others export
        // their columns with no rows.
        var blocked = d.name === 'coverage' && !d.hasData;
        go.disabled = busy || !ok || blocked;
        readme.disabled = busy || !ok || blocked;
        datesStep.disabled = !d.span;
        if (!d.span) {
          clock.textContent = CLOCK.none;
          note.textContent = '';
          [].forEach.call(presetsEl.querySelectorAll('.win-btn'), function (b) { b.setAttribute('aria-pressed', 'false'); });
          return;
        }
        clock.textContent = d.span === 'local' ? CLOCK.local(index.stationTimezone)
          : d.span === 'mixed' ? CLOCK.mixed(index.stationTimezone) : CLOCK.utc;
        if (ok) {
          var days = Math.round((utcMs(to) - utcMs(from)) / 86400000) + 1;
          note.textContent = longDay(from) + ' – ' + longDay(to) + ' · '
            + days + (days === 1 ? ' day' : ' days');
        } else {
          note.textContent = 'Choose a start date on or before the end date, between '
            + longDay(fromEl.min) + ' and ' + longDay(toEl.max) + '.';
        }
        note.className = 'export-summary' + (ok ? '' : ' is-bad');
        var cp = chosen && presets[chosen];
        if (!cp || cp.from !== from || cp.to !== to) chosen = null;
        [].forEach.call(presetsEl.querySelectorAll('.win-btn'), function (b) {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-preset') === chosen));
        });
      }
      function setSpan(name) {
        var p = presets[name];
        if (!p) return;
        chosen = name;
        fromEl.value = p.from;
        toEl.value = p.to;
        refresh();
      }

      /* Switching dataset changes the cards, the date bounds and what the dates
         mean. A chosen preset is re-applied inside the new bounds ("This
         month" of listening and of the archive are different spans); dates
         typed by hand are kept and re-checked. */
      function applyDataset() {
        var name = datasetName(), d = dataset();
        [].forEach.call(form.querySelectorAll('.export-choices'), function (g) {
          g.hidden = g.getAttribute('data-dataset') !== name;
        });
        var picked = form.querySelector('input[name=exportFile]:checked');
        var first = form.querySelector('.export-choices[data-dataset="' + name + '"] input[name=exportFile]');
        if (first && (!picked || picked.value.split(':')[0] !== name)) first.checked = true;
        // The report is a page, not a file: no read-me, and the button opens it.
        document.getElementById('exportReadmeRow').hidden = name === 'report';
        go.textContent = name === 'report' ? 'Open report' : 'Download';
        if (!d) return refresh();
        empty.hidden = d.hasData;
        empty.textContent = d.hasData ? '' : EMPTY[name];
        if (d.span) {
          presets = exportPresets(d.today, d.firstDate);
          [fromEl, toEl].forEach(function (i) { i.min = d.firstDate; i.max = d.today; });
          [].forEach.call(presetsEl.querySelectorAll('.win-btn'), function (b) {
            b.disabled = !presets[b.getAttribute('data-preset')];
          });
          if (chosen && presets[chosen]) return setSpan(chosen);
          if (!fromEl.value || !toEl.value || !spanOk()) return setSpan(presets.thisMonth ? 'thisMonth' : 'all');
        }
        refresh();
      }

      /* Fetch, then save. A plain <a download> hands the request to the
         browser and a failure never reaches the page — which is how "the
         download starts but nothing arrives" went unexplained. Here every
         outcome is on screen: the file name and size, or the server's error
         and HTTP status. `say(text, kind)` writes into the caller's own
         status line, so reports and backups each report where they were
         asked for. */
      function saveFrom(url, say) {
        say('Preparing your file…');
        return fetch(url, { credentials: 'same-origin' })
          .then(function (res) {
            if (res.status === 401) {
              throw new Error('Your studio session has ended. Sign in again, then retry.');
            }
            if (!res.ok) {
              return res.text().then(function (body) {
                var msg = '';
                try { msg = JSON.parse(body).error || ''; } catch (e) { msg = body.slice(0, 120); }
                throw new Error('The server refused this download: ' + (msg || 'no reason given')
                  + ' (HTTP ' + res.status + ').');
              });
            }
            var cd = res.headers.get('Content-Disposition') || '';
            var name = (/filename="([^"]+)"/.exec(cd) || [])[1];
            if (!name) throw new Error('The server sent no file name (HTTP ' + res.status + ').');
            return res.blob().then(function (blob) { return { name: name, blob: blob }; });
          })
          .then(function (file) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(file.blob);
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            // Revoke on a delay: revoking synchronously races the download in
            // some browsers and yields an empty file.
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
            say('Saved ' + file.name + ' · ' + fileSize(file.blob.size)
              + '. Check your Downloads folder.', 'ok');
          })
          .catch(function (e) {
            console.error('[studio] download failed:', e);
            say(e && e.message ? e.message : 'The download failed: ' + e, 'bad');
          });
      }
      function download(format, table) {
        var d = dataset();
        if (busy || !d || !spanOk()) return;
        var q = 'dataset=' + d.name + '&format=' + format;
        if (d.span) q += '&from=' + fromEl.value + '&to=' + toEl.value;
        if (table) q += '&table=' + table;
        busy = true;
        refresh();
        saveFrom('/api/studio/export?' + q, status)
          .then(function () { busy = false; refresh(); });
      }

      // Named loadOptions, not load: the page's own load() (the dashboard
      // refresh) lives in the enclosing scope, and a restore must call THAT.
      function loadOptions() {
        status('');
        fetch('/api/studio/exports', { headers: { 'Accept': 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not load export options (HTTP ' + res.status + ').');
            return res.json();
          })
          .then(function (x) {
            index = x;
            applyDataset();
          })
          .catch(function (e) {
            console.error('[studio] export options failed:', e);
            go.disabled = true;
            status(e.message, 'bad');
          });
      }

      /* ---- tabs: Reports | Backup & restore (WAI-ARIA tabs; arrow keys move) */
      var tabs = [document.getElementById('tabReports'), document.getElementById('tabBackup')];
      function selectTab(tab, focus) {
        tabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
          document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
        });
        if (focus) tab.focus();
        if (tab.id === 'tabBackup') loadImportStatus();
      }
      tabs.forEach(function (t, i) {
        t.addEventListener('click', function () { selectTab(t); });
        t.addEventListener('keydown', function (ev) {
          if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
          ev.preventDefault();
          selectTab(tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
        });
      });

      /* ---- backup & restore (docs/exports.md "1c")
         The chosen file is read in the browser and sent as-is: the server
         validates it and the preview writes nothing. Restore sends the same
         bytes with the token the preview returned, so what is written is
         exactly what was previewed. */
      var backupStatus = document.getElementById('backupStatus');
      var restoreFile = document.getElementById('restoreFile');
      var restoreName = document.getElementById('restoreFileName');
      var previewBox = document.getElementById('restorePreview');
      var planBody = document.getElementById('restorePlan');
      var summary = document.getElementById('restoreSummary');
      var warn = document.getElementById('restoreWarn');
      var applyBtn = document.getElementById('restoreApply');
      var restoreStatus = document.getElementById('restoreStatus');
      var undoStep = document.getElementById('undoStep');
      var undoSummary = document.getElementById('undoSummary');
      var undoBtn = document.getElementById('restoreUndo');
      var undoStatus = document.getElementById('undoStatus');
      var pending = null;   // { text, token, changes } from the last good preview
      var csrf = null;

      function sayInto(node) {
        return function (text, kind) {
          node.textContent = text;
          node.className = 'export-status' + (kind ? ' is-' + kind : '');
        };
      }
      function monthName(m) {
        return new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1))
          .toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
      }
      function monthFigures(t) {
        if (!t) return '—';
        return num(t.plays) + ' plays · ' + num(t.pageviews) + ' page views · '
          + listenTime(t.listenSeconds) + ' listened';
      }
      function whenText(iso) {
        var d = new Date(iso);
        return isNaN(d) ? 'an unknown date' : d.toLocaleString(undefined,
          { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      }
      function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }
      // The session's CSRF token, from the same health payload the actions use.
      function withCsrf() {
        if (csrf) return Promise.resolve(csrf);
        return fetch('/api/studio/health', { headers: { 'Accept': 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not start a studio request (HTTP ' + res.status + ').');
            return res.json();
          })
          .then(function (d) { csrf = d.csrf; return csrf; });
      }
      function postImport(step, body, extra) {
        return withCsrf().then(function (token) {
          var headers = { 'Content-Type': 'application/json', 'X-Studio-CSRF': token };
          Object.keys(extra || {}).forEach(function (k) { headers[k] = extra[k]; });
          return fetch('/api/studio/import/' + step, { method: 'POST', headers: headers, body: body });
        }).then(function (res) {
          return res.text().then(function (t) {
            if (res.status === 401) throw new Error('Your studio session has ended. Sign in again, then retry.');
            var j = null;
            try { j = JSON.parse(t); } catch (e) { j = null; }
            if (!j) throw new Error('The server answered HTTP ' + res.status + ' with no readable reason.');
            return { status: res.status, body: j };
          });
        });
      }

      document.getElementById('backupDownload').addEventListener('click', function () {
        var b = this;
        b.disabled = true;
        saveFrom('/api/studio/backup', sayInto(backupStatus))
          .then(function () { b.disabled = false; });
      });

      var feedsBadge = document.getElementById('restoreFeedsBadge');
      var feedsText = document.getElementById('restoreFeedsText');
      var feedsShows = document.getElementById('restoreFeedsShows');
      var BADGE = { 'new': 'New', replace: 'Replaced', identical: 'Already the same', kept: 'Kept', merge: 'Added' };
      var WHAT = {
        'new': 'Added from the backup.',
        replace: 'This server’s figures are replaced by the backup’s.',
        identical: 'No change.',
        kept: 'Not in the backup — left as it is.',
      };
      /* The episodes half. Merged, never replaced: the line says what is added
         and that nothing here is removed, then names the shows that gain. */
      function renderFeeds(f) {
        var adds = f.episodesAdded > 0;
        feedsBadge.className = 'plan-badge plan-badge--' + (adds ? 'merge' : 'identical');
        feedsBadge.textContent = adds ? 'Added' : 'Already the same';
        feedsText.textContent = 'Archive episodes: the backup holds ' + num(f.backupEpisodes) + ' of '
          + plural(f.backupShows, 'show') + ', this server ' + num(f.serverEpisodes) + ' of '
          + plural(f.serverShows, 'show') + '. '
          + (adds
            ? 'Restoring adds ' + plural(f.episodesAdded, 'episode') + ' to ' + plural(f.showsGaining, 'show')
              + (f.newShows ? ' (' + f.newShows + ' not held here yet)' : '')
              + '. Nothing on this server is removed or changed.'
            : 'This server already holds every episode in the backup.');
        feedsShows.textContent = '';
        f.shows.slice(0, 12).forEach(function (s) {
          feedsShows.appendChild(el('li', '', s.title + ' · +' + plural(s.adds, 'episode')
            + (s.action === 'new' ? ' (new show)' : '')));
        });
        if (f.shows.length > 12) feedsShows.appendChild(el('li', 'plan-muted', '…and ' + (f.shows.length - 12) + ' more shows.'));
      }
      function renderPlan(p) {
        renderFeeds(p.feeds);
        planBody.textContent = '';
        p.plan.forEach(function (row) {
          var tr = el('tr');
          // data-label carries the column name for the phone layout, where each
          // month is drawn as a card instead of a row (studio.css .export-plan).
          var cell = function (cls, text, label) {
            var c = el('td', cls, text);
            c.setAttribute('data-label', label);
            return c;
          };
          tr.appendChild(cell('plan-month', monthName(row.month), 'Month'));
          tr.appendChild(cell(row.backup ? '' : 'plan-muted', monthFigures(row.backup), 'In the backup'));
          tr.appendChild(cell(row.server ? '' : 'plan-muted', monthFigures(row.server), 'On this server'));
          var td = cell('', undefined, 'What happens');
          td.appendChild(el('span', 'plan-badge plan-badge--' + row.action, BADGE[row.action]));
          td.appendChild(el('div', 'plan-muted', WHAT[row.action]));
          tr.appendChild(td);
          planBody.appendChild(tr);
        });
        summary.textContent = 'Backup of ' + String(p.backup.station).toUpperCase() + ' made '
          + whenText(p.backup.createdAt) + ' · ' + plural(p.backup.months, 'month')
          + (p.backup.sameServer ? ' · made on this server.' : '.');
        var replaced = p.plan.filter(function (r) { return r.action === 'replace'; }).length;
        warn.hidden = !replaced;
        warn.textContent = replaced
          ? plural(replaced, 'month') + ' on this server will be replaced by the backup’s figures, '
            + 'including anything counted here since the backup was made. A copy of each is saved '
            + 'first, and you can undo the restore.'
          : '';
        var parts = [];
        if (p.changes) parts.push(plural(p.changes, 'month'));
        if (p.feeds.episodesAdded) parts.push(plural(p.feeds.episodesAdded, 'episode'));
        applyBtn.disabled = !parts.length;
        applyBtn.textContent = parts.length
          ? 'Restore ' + parts.join(' and ')
          : 'Nothing to restore — this server already matches';
        previewBox.hidden = false;
      }

      restoreFile.addEventListener('change', function () {
        var say = sayInto(restoreStatus);
        var f = restoreFile.files && restoreFile.files[0];
        pending = null;
        previewBox.hidden = true;
        restoreName.textContent = f ? f.name : 'No file chosen';
        if (!f) { say(''); return; }
        say('Checking the backup…');
        f.text()
          .then(function (text) {
            return postImport('preview', text).then(function (r) { return { r: r, text: text }; });
          })
          .then(function (x) {
            if (x.r.status !== 200) {
              var errs = x.r.body.errors || [x.r.body.error || 'HTTP ' + x.r.status];
              say('This file cannot be restored. ' + errs.join(' '), 'bad');
              return;
            }
            pending = { text: x.text, token: x.r.body.token, changes: x.r.body.changes + x.r.body.feeds.episodesAdded };
            renderPlan(x.r.body);
            say('');
          })
          .catch(function (e) {
            console.error('[studio] restore preview failed:', e);
            say(e.message, 'bad');
          });
      });

      applyBtn.addEventListener('click', function () {
        var say = sayInto(restoreStatus);
        if (!pending || !pending.changes) return;
        applyBtn.disabled = true;
        say('Restoring…');
        postImport('apply', pending.text, { 'X-Import-Token': pending.token })
          .then(function (r) {
            if (r.status !== 200) {
              throw new Error(r.body.error || (r.body.errors || []).join(' ')
                || 'The restore was refused (HTTP ' + r.status + ').');
            }
            say('Restored ' + plural(r.body.replaced.length + r.body.added.length, 'month') + ' ('
              + r.body.added.length + ' added, ' + r.body.replaced.length + ' replaced) and '
              + plural(r.body.episodesAdded, 'episode') + '. The dashboard has been refreshed.', 'ok');
            pending = null;
            previewBox.hidden = true;
            restoreFile.value = '';
            restoreName.textContent = 'No file chosen';
            showUndo(r.body.lastImport);
            load();
          })
          .catch(function (e) {
            console.error('[studio] restore failed:', e);
            say(e.message, 'bad');
            applyBtn.disabled = false;
          });
      });

      function showUndo(last) {
        undoStep.hidden = !(last && last.undoable);
        if (!last || !last.undoable) return;
        undoSummary.textContent = 'Restored ' + whenText(last.importedAt) + ': '
          + plural(last.replaced.length + last.added.length, 'month') + ' (' + last.added.length
          + ' added, ' + last.replaced.length + ' replaced) and ' + plural(last.feedsEpisodesAdded || 0, 'episode')
          + '. Undo puts this server’s figures back as they were before it and takes out the episodes it '
          + 'added. Nothing is deleted — the restored copy stays on the server.';
        undoBtn.disabled = false;
        undoStatus.textContent = '';
        undoStatus.className = 'export-status';
      }
      function loadImportStatus() {
        fetch('/api/studio/import/status', { headers: { 'Accept': 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (x) { showUndo(x.lastImport); })
          .catch(function (e) { console.error('[studio] import status failed:', e); });
      }
      undoBtn.addEventListener('click', function () {
        var say = sayInto(undoStatus);
        undoBtn.disabled = true;
        say('Undoing…');
        postImport('undo', '')
          .then(function (r) {
            if (r.status !== 200) throw new Error(r.body.error || 'Undo was refused (HTTP ' + r.status + ').');
            undoSummary.textContent = 'This restore has been undone.';
            say('Undone: ' + plural(r.body.restored.length, 'month') + ' put back, '
              + r.body.removed.length + ' moved aside, ' + plural(r.body.removedEpisodes, 'episode')
              + ' taken out. The dashboard has been refreshed.', 'ok');
            load();
          })
          .catch(function (e) {
            console.error('[studio] undo failed:', e);
            say(e.message, 'bad');
            undoBtn.disabled = false;
          });
      });

      openBtn.addEventListener('click', function () {
        dialog.showModal();
        loadOptions();
      });
      function close() { dialog.close(); openBtn.focus(); }
      document.getElementById('exportClose').addEventListener('click', close);
      document.getElementById('exportCancel').addEventListener('click', close);
      // A click on the backdrop lands on the <dialog> itself.
      dialog.addEventListener('click', function (ev) { if (ev.target === dialog) close(); });
      presetsEl.addEventListener('click', function (ev) {
        var b = ev.target.closest('.win-btn');
        if (b) setSpan(b.getAttribute('data-preset'));
      });
      fromEl.addEventListener('input', refresh);
      toEl.addEventListener('input', refresh);
      [].forEach.call(form.querySelectorAll('input[name=exportDataset]'), function (r) {
        r.addEventListener('change', applyDataset);
      });
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (datasetName() === 'report') {
          if (!spanOk()) return;
          var url = '/studio/report?from=' + fromEl.value + '&to=' + toEl.value;
          var tab = window.open(url, '_blank');
          // A blocked pop-up returns null: say so and offer the link, rather
          // than leaving the click looking like it did nothing.
          if (tab) {
            status('Opened the report in a new tab. Use Print or save as PDF there.', 'ok');
          } else {
            status('Your browser blocked the new tab. Open the report here: ' + location.origin + url, 'bad');
          }
          return;
        }
        // value is dataset:format[:table]; the dataset is already the checked one.
        var pick = form.querySelector('input[name=exportFile]:checked').value.split(':');
        download(pick[1], pick[2]);
      });
      readme.addEventListener('click', function () { download('readme'); });
    })();

    function load() {
      loadUsage();

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
