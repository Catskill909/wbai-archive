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
    function columnChart(node, days) {
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
        'aria-label': 'Episodes per day, ' + days[0].day + ' to ' + days[days.length - 1].day
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
          showTip(ev, d.episodes + (d.episodes === 1 ? ' episode' : ' episodes'), d.day);
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
        t.textContent = p[1].slice(5);
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
    var sortKey = 'seconds', sortAsc = false;

    function num(n) { return Number(n).toLocaleString(); }
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

    function renderTable() {
      if (!stats) return;
      var q = (document.getElementById('showFilter').value || '').toLowerCase().trim();
      var rows = stats.shows.filter(function (s) {
        return !q || s.title.toLowerCase().indexOf(q) >= 0 || s.slug.indexOf(q) >= 0;
      });
      rows.sort(function (a, b) {
        var x = a[sortKey], y = b[sortKey];
        var r = (typeof x === 'string') ? x.localeCompare(y) : x - y;
        return sortAsc ? r : -r;
      });

      var body = document.getElementById('showTableBody');
      body.textContent = '';
      rows.forEach(function (s) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', 'show-title', s.title));
        var slug = el('td', 'num', s.slug);
        tr.appendChild(slug);
        tr.appendChild(el('td', 'num', num(s.episodes)));
        tr.appendChild(el('td', 'num', String(hours(s.seconds))));
        tr.appendChild(el('td', 'num', num(s.plays || 0)));
        tr.appendChild(el('td', 'num', s.newest
          ? new Date(s.newest * 1000).toISOString().slice(0, 10) : '—'));
        body.appendChild(tr);
      });

      document.getElementById('tableCount').textContent =
        rows.length === stats.shows.length
          ? rows.length + ' shows'
          : rows.length + ' of ' + stats.shows.length + ' shows';

      // aria-sort belongs on exactly one header at a time.
      [].forEach.call(document.querySelectorAll('.th-sort'), function (b) {
        if (b.getAttribute('data-sort') === sortKey) {
          b.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending');
        } else b.removeAttribute('aria-sort');
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
      columnChart(document.getElementById('usageDays'),
        u.days.map(function (d) { return { day: d.day, episodes: d.plays }; }));

      // Terms exist only if they crossed the storage threshold, so an empty
      // list is the normal early state and should say so rather than look broken.
      var terms = document.getElementById('usageTerms');
      var th = document.getElementById('termsHeading');
      terms.textContent = '';
      if (!u.searchTermsRecorded) {
        th.textContent = 'Searches';
        terms.appendChild(el('p', 'usage-empty',
          'Search terms are not being recorded (TRACK_SEARCH_TERMS=off). '
          + u.totals.searches + ' searches counted.'));
      } else if (!u.terms || !u.terms.length) {
        th.textContent = 'What people searched for';
        // Say WHY it is empty, with the numbers. "Nothing here" and "this is
        // broken" look identical otherwise, which is exactly the question this
        // panel got asked on its first day.
        terms.appendChild(el('p', 'usage-empty',
          u.totals.searches
            ? u.totals.searches + ' searches so far, and '
              + (u.termsBelowThreshold || 0) + ' distinct term(s) waiting — a term '
              + 'is only written down once ' + u.termThreshold + ' searches have used '
              + 'the same words. Rarer ones are never stored at all.'
            : 'No searches yet. A term is only kept once ' + u.termThreshold
              + ' searches have used the same words.'));
      } else {
        th.textContent = 'What people searched for';
        barChart(terms, u.terms.map(function (t) {
          return { label: t.term, value: t.count, display: num(t.count) };
        }), 'searches');
      }

      var shows = document.getElementById('usageShows');
      if (!u.topShows.length) {
        shows.textContent = '';
        shows.appendChild(el('p', 'usage-empty',
          u.totals.plays
            ? 'Plays recorded, but none matched a show in the current feed window.'
            : 'Nothing counted yet. Counting began when this was deployed — it does not backfill.'));
      } else {
        barChart(shows, u.topShows.map(function (s) {
          return { label: s.title, value: s.plays, display: num(s.plays) };
        }), 'plays');
      }
    }

    function load() {
      fetch('/api/studio/usage', { headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (u) { if (u) renderUsage(u); })
        .catch(function () { /* the health panel reports an outage */ });

      fetch('/api/studio/stats', { headers: { 'Accept': 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (d) { if (d) renderStats(d); })
        .catch(function () { /* the health panel below reports the outage */ });

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
