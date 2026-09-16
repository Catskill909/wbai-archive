'use strict';

/**
 * The printable report — a page a board or a funder can read, and that the
 * browser's own Print → Save as PDF turns into a PDF. No PDF library: this app
 * has no dependencies and no build step (docs/exports.md "On PDF").
 *
 * Pure: it takes the SAME objects the listening, inventory and coverage
 * downloads are built from, so a report and a CSV for the same dates cannot
 * disagree. Server-rendered, not drawn by script, so printing never waits on
 * JavaScript. The page's CSP forbids inline style and inline script: the chart
 * is SVG drawn with attributes, styling lives in /report.css, and the Print
 * button's handler in /report.js.
 */

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function num(n) { return Number(n || 0).toLocaleString('en-US'); }
function duration(sec) {
  const s = Math.round(sec || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  // Under a minute is shown in seconds: "0m" for 14 seconds of listening read
  // as nobody listening at all.
  if (!h && !m) return `${s}s`;
  return h ? `${num(h)}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
function pct(part, whole) { return whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—'; }
function longDate(d) {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function showName(title, key) {
  return title ? esc(title) : `<span class="muted">untitled in the feed (${esc(key)})</span>`;
}
function sum(rows, k) { return rows.reduce((n, r) => n + (Number(r[k]) || 0), 0); }

/** Minutes listened per day (on demand + live) as an SVG column chart. */
function dailyChart(daily) {
  const W = 720, H = 180, top = 22, bottom = 22;
  const values = daily.map((d) => Math.round((d.seconds_listened_on_demand + d.seconds_listened_live) / 60));
  const max = Math.max(1, ...values);
  const peakAt = values.indexOf(Math.max(...values));
  const slot = W / Math.max(1, values.length);
  const barW = Math.max(1, Math.min(18, slot * 0.72));
  const bars = values.map((v, i) => {
    const h = v ? Math.max(1.5, (v / max) * (H - top - bottom)) : 1;
    const x = i * slot + (slot - barW) / 2;
    return `<rect class="${v ? 'bar' : 'bar bar--zero'}" x="${x.toFixed(1)}" y="${(H - bottom - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(daily[i].date_utc)}: ${num(v)} min</title></rect>`;
  }).join('');
  const first = daily[0] ? daily[0].date_utc : '', last = daily.length ? daily[daily.length - 1].date_utc : '';
  const peakX = Math.min(W - 4, Math.max(4, peakAt * slot + slot / 2));
  const anchor = peakX < 60 ? 'start' : peakX > W - 60 ? 'end' : 'middle';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutes listened per day, ${esc(first)} to ${esc(last)}; peak ${num(values[peakAt] || 0)} minutes">
  <line class="axis" x1="0" y1="${H - bottom}" x2="${W}" y2="${H - bottom}"/>
  ${bars}
  ${values[peakAt] ? `<text class="label" x="${peakX.toFixed(1)}" y="14" text-anchor="${anchor}">peak ${num(values[peakAt])} min</text>` : ''}
  <text class="label" x="0" y="${H - 5}" text-anchor="start">${esc(first)}</text>
  <text class="label" x="${W}" y="${H - 5}" text-anchor="end">${esc(last)}</text>
</svg>`;
}

function listeningSection(L) {
  const t = {
    onDemand: sum(L.daily, 'seconds_listened_on_demand'), live: sum(L.daily, 'seconds_listened_live'),
    plays: sum(L.daily, 'episode_plays'), tuneIns: sum(L.daily, 'live_tune_ins'),
    views: sum(L.daily, 'page_views'), searches: sum(L.daily, 'searches'), shares: sum(L.daily, 'shares'),
  };
  const tiles = [
    [duration(t.onDemand), 'Archive listening'], [duration(t.live), 'Live stream listening'],
    [num(t.plays), 'Episode plays'], [num(t.tuneIns), 'Live tune-ins'],
    [num(t.views), 'Page views'], [num(t.searches), 'Searches'], [num(t.shares), 'Shares'],
  ].map(([v, l]) => `<div class="tile"><div class="tile-value">${esc(v)}</div><div class="tile-label">${esc(l)}</div></div>`).join('');
  const top = L.shows.slice(0, 15);
  const reachTotal = sum(L.reach, 'page_views');
  return `
<section class="section" id="listening">
  <h2>Listening at a glance</h2>
  <div class="tiles" data-totals='${esc(JSON.stringify(t))}'>${tiles}</div>
  <h3>Minutes listened per day</h3>
  ${dailyChart(L.daily)}
</section>
<section class="section" id="shows">
  <h2>Most listened shows</h2>
  ${top.length ? `<table>
    <thead><tr><th scope="col">Show</th><th scope="col" class="num">Plays</th><th scope="col" class="num">Time listened</th></tr></thead>
    <tbody>${top.map((s) => `<tr><td>${showName(s.show_title, s.show_key)}</td><td class="num">${num(s.plays)}</td><td class="num">${duration(s.seconds_listened)}</td></tr>`).join('')}</tbody>
  </table>
  ${L.shows.length > top.length ? `<p class="note">Top ${top.length} of ${num(L.shows.length)} shows listened to, ranked by time listened.</p>` : ''}` : '<p class="note">No archive listening was recorded in this period.</p>'}
</section>
<section class="section" id="reach">
  <h2>Reach</h2>
  <table>
    <thead><tr><th scope="col">Listeners&rsquo; browser clock</th><th scope="col" class="num">Page views</th><th scope="col" class="num">Share</th></tr></thead>
    <tbody>${L.reach.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${num(r.page_views)}</td><td class="num">${pct(r.page_views, reachTotal)}</td></tr>`).join('')}</tbody>
  </table>
  <p class="note">Grouped by the timezone each browser reports — a clock, not a location. No address is ever read.</p>
</section>`;
}

function archiveSection(I) {
  const hours = sum(I.episodes, 'duration_seconds');
  const cats = new Map();
  for (const e of I.episodes) {
    const c = cats.get(e.category || '') || { episodes: 0, seconds: 0 };
    c.episodes++; c.seconds += e.duration_seconds;
    cats.set(e.category || '', c);
  }
  const rows = [...cats.entries()].sort((a, b) => b[1].episodes - a[1].episodes);
  return `
<section class="section" id="archive">
  <h2>What the archive aired</h2>
  <div class="tiles">
    <div class="tile"><div class="tile-value">${num(I.episodes.length)}</div><div class="tile-label">Episodes</div></div>
    <div class="tile"><div class="tile-value">${num(I.shows.length)}</div><div class="tile-label">Shows</div></div>
    <div class="tile"><div class="tile-value">${duration(hours)}</div><div class="tile-label">Audio</div></div>
  </div>
  ${rows.length ? `<table>
    <thead><tr><th scope="col">Category</th><th scope="col" class="num">Episodes</th><th scope="col" class="num">Audio</th></tr></thead>
    <tbody>${rows.map(([c, v]) => `<tr><td>${c ? esc(c) : '<span class="muted">no category</span>'}</td><td class="num">${num(v.episodes)}</td><td class="num">${duration(v.seconds)}</td></tr>`).join('')}</tbody>
  </table>` : '<p class="note">The archive holds no episodes that aired in this period.</p>'}
  <p class="note">Episodes this app holds whose air date in ${esc(I.manifest.station_timezone)} falls in the period &mdash; what the podcast feeds carry now plus the episodes kept after they left the feed. Episodes aired before the app began keeping them are not counted.</p>
</section>`;
}

function listOf(rows, limit = 24) {
  if (!rows.length) return '<p class="note">None.</p>';
  const shown = rows.slice(0, limit).map((r) => `<li>${showName(r.show_title, r.show_key)}</li>`).join('');
  return `<ul class="names">${shown}</ul>${rows.length > limit ? `<p class="note">…and ${num(rows.length - limit)} more — the Coverage download lists them all.</p>` : ''}`;
}

function coverageSection(C) {
  // No published schedule on WBAI: the gaps are counted across every show the
  // archive listing names. A show with no feed has no episodes in this app.
  const noFeed = C.shows.filter((s) => !s.has_feed);
  const withFeed = C.shows.filter((s) => s.has_feed);
  const noArt = withFeed.filter((s) => !s.has_artwork);
  const noDesc = withFeed.filter((s) => !s.has_description);
  const stale = withFeed.filter((s) => s.days_since_newest_episode > 30);
  return `
<section class="section" id="coverage">
  <h2>Program data gaps</h2>
  <p class="note">As of ${esc(C.manifest.as_of_utc.slice(0, 10))}, across the ${num(C.shows.length)} shows WBAI&rsquo;s archive listing names. These come from WBAI&rsquo;s archive and podcast feeds; they are fixed there, not in this app.</p>
  <div class="tiles">
    <div class="tile"><div class="tile-value">${num(noFeed.length)}</div><div class="tile-label">No podcast feed</div></div>
    <div class="tile"><div class="tile-value">${num(noArt.length)}</div><div class="tile-label">No artwork</div></div>
    <div class="tile"><div class="tile-value">${num(noDesc.length)}</div><div class="tile-label">No description</div></div>
    <div class="tile"><div class="tile-value">${num(stale.length)}</div><div class="tile-label">None in 30 days</div></div>
  </div>
  <h3>Listed without a podcast feed (no episodes in the app)</h3>${listOf(noFeed)}
  <h3>With a feed but no artwork</h3>${listOf(noArt)}
  <h3>No new episode in over 30 days</h3>${listOf(stale)}
</section>`;
}

/**
 * @param {object} o
 * @param {{name: string, frequency: string, city: string, logo: string}} o.station  public profile fields
 * @param {string} o.from, o.to     the report's dates
 * @param {object} o.listening      buildListeningExport() for the span
 * @param {object|null} o.inventory buildInventory() for the span, or null when unavailable
 * @param {object|null} o.coverage  buildCoverage(), or null when unavailable
 * @param {string} o.generatedAt
 */
function renderReport(o) {
  const L = o.listening;
  const title = `${o.station.name} listening and archive report`;
  const span = o.from === o.to ? longDate(o.from) : `${longDate(o.from)} – ${longDate(o.to)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(span)}</title>
<link rel="stylesheet" href="/report.css">
<script src="/report.js" defer></script>
</head>
<body>
<main class="report" data-from="${esc(o.from)}" data-to="${esc(o.to)}">
  <div class="toolbar no-print">
    <a class="button button--quiet" href="/studio">Back to the studio</a>
    <button class="button" id="printReport" type="button">Print or save as PDF</button>
  </div>
  <header class="masthead">
    ${o.station.logo ? `<img class="logo" src="${esc(o.station.logo)}" alt="${esc(o.station.name)}">` : ''}
    <div>
      <h1>${esc(title)}</h1>
      <p class="span">${esc(span)}</p>
      <p class="meta">${esc([o.station.frequency, o.station.city].filter(Boolean).join(' · '))} · generated ${esc(o.generatedAt.slice(0, 16).replace('T', ' '))} UTC</p>
    </div>
  </header>
  ${listeningSection(L)}
  ${o.inventory ? archiveSection(o.inventory) : ''}
  ${o.coverage ? coverageSection(o.coverage) : ''}
  <section class="section about" id="about">
    <h2>About these figures</h2>
    <ul>
      <li>Listening figures are <strong>counters only</strong>. The app collects no IP address, cookie, session, device or search words, so it cannot count unique people &mdash; only plays, time listened and page views.</li>
      <li>Listening is counted in <strong>UTC days</strong> (${esc(L.manifest.from_date_utc)} to ${esc(L.manifest.to_date_utc)}); the station&rsquo;s own clock is ${esc(L.manifest.station_timezone)}.</li>
      ${o.inventory ? `<li>The archive section uses <strong>air dates in ${esc(o.inventory.manifest.station_timezone)}</strong>.</li>` : ''}
      <li>Every number here matches the studio&rsquo;s CSV and JSON downloads for the same dates.</li>
    </ul>
  </section>
</main>
</body>
</html>
`;
}

module.exports = { renderReport, esc };
