'use strict';
// Studio exports (docs/exports.md), ported from KPFK 2026-09-16.
//
// Unit tests pin the CSV writer and the pure builders; the HTTP test boots the
// real server on a seeded data dir, downloads what a station manager would,
// parses it with an independent parser, and compares it to the seeded files and
// to the dashboard's own report.
//
//   node test/exports/export.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toCsv } = require('../../lib/export/csv');
const L = require('../../lib/export/listening');
const INV = require('../../lib/export/inventory');
const COV = require('../../lib/export/coverage');
const { parseCsv, bytes, seedDataDir, boot } = require('./harness');

const TZ = 'America/New_York';
// The documented columns, written out here rather than read from the modules:
// a column added without a docs/exports.md change must fail this.
const DOCUMENTED = {
  daily: ['station', 'date_utc', 'page_views', 'episode_plays', 'live_tune_ins', 'searches', 'shares',
    'seconds_listened_on_demand', 'seconds_listened_live'],
  shows: ['station', 'show_key', 'show_title', 'plays', 'seconds_listened'],
  reach: ['station', 'bucket', 'label', 'page_views'],
  episodes: ['station', 'show_key', 'show_title', 'episode_title', 'air_date_local', 'air_time_local',
    'air_datetime_utc', 'duration_seconds', 'file_bytes', 'category', 'host', 'audio_url'],
  inventoryShows: ['station', 'show_key', 'show_title', 'episodes', 'oldest_air_date_local',
    'newest_air_date_local', 'total_seconds', 'total_bytes'],
  coverage: ['station', 'show_key', 'show_title', 'has_feed', 'has_artwork', 'has_description', 'has_host',
    'in_program_directory', 'episodes_held', 'newest_air_date_local', 'days_since_newest_episode'],
};

// A station-clock formatter built here, not the app's.
const ny = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const nyDate = (sec) => { const p = Object.fromEntries(ny.formatToParts(sec * 1000).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };

test('CSV writer: quoting, BOM, CRLF, formula cells, raw numbers', () => {
  const tricky = ['Radio "Maíz", en Español', 'line one\nline two', 'carriage\rreturn', '', 'plain'];
  const rows = tricky.map((t, n) => ({ title: t, n: n * 1.5, neg: -n }));
  rows.push({ title: null, n: 0, neg: 0 }, { title: '=HYPERLINK("x")', n: 1, neg: 1 }, { title: '-1 Show', n: 2, neg: 2 });
  const csv = toCsv(['title', 'n', 'neg'], rows);
  assert.deepEqual([...Buffer.from(csv, 'utf8').subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM is the first three bytes');
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.rows.slice(0, tricky.length).map((r) => r.title), tricky, 'text round-trips exactly');
  assert.deepEqual(parsed.rows.map((r) => r.n), ['0', '1.5', '3', '4.5', '6', '0', '1', '2'], 'numbers unrounded');
  assert.equal(parsed.rows[1].neg, '-1', 'a negative number is not treated as a formula');
  assert.equal(parsed.rows[5].title, '', 'null is an empty cell');
  assert.equal(parsed.rows[6].title, '\'=HYPERLINK("x")', 'formula-looking text is neutralised');
  assert.throws(() => toCsv(['n'], [{ n: NaN }]), /non-finite/);
});

test('listening builder: every day of the span, totals equal the records, documented columns only', () => {
  const ZONES = ['local', 'national', 'intl', 'unknown'].map((key) => ({ key, label: key }));
  const store = {
    '2026-08': {
      '2026-08-03': { pageviews: 5, plays: 2, live: 1, searches: 1, shares: 0, listenSeconds: 400, liveSeconds: 30,
        byShow: { dn: 2 }, secondsByShow: { dn: 400 }, byZone: { local: 4, intl: 1 } },
      // An older build's record: no listenSeconds, no maps. Zeros, never NaN.
      '2026-08-31': { pageviews: 1, plays: 1, live: 0, searches: 0, shares: 1 },
    },
    '2026-09': { '2026-09-02': { pageviews: 2, plays: 3, byShow: { housing: 3 }, secondsByShow: { housing: 50, dn: 60 } } },
  };
  const build = (from, to) => L.buildListeningExport({ station: 'wbai', stationTimezone: TZ, from, to,
    monthDays: (m) => store[m] || {}, titleFor: (k) => (k === 'dn' ? 'Democracy Now!' : ''), zones: ZONES, generatedAt: 'g' });
  const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
  const aug = build('2026-08-01', '2026-08-31');
  assert.equal(aug.daily.length, 31, 'a whole month, including days with no activity');
  assert.equal(sum(aug.daily, 'episode_plays'), 3); assert.equal(sum(aug.daily, 'seconds_listened_on_demand'), 400);
  assert.deepEqual(aug.shows, [{ station: 'wbai', show_key: 'dn', show_title: 'Democracy Now!', plays: 2, seconds_listened: 400 }]);
  const cut = build('2026-08-04', '2026-09-02');
  assert.equal(sum(cut.daily, 'episode_plays'), 4, 'a span cuts at days, not months');
  assert.deepEqual(cut.shows.map((s) => [s.show_key, s.show_title]), [['dn', 'Democracy Now!'], ['housing', '']], 'an unnamed show has an empty title');
  for (const t of ['daily', 'shows', 'reach']) {
    assert.deepEqual(L.COLUMNS[t], DOCUMENTED[t]);
    for (const r of cut[t]) assert.deepEqual(Object.keys(r), DOCUMENTED[t]);
    assert.ok(cut.manifest.tables[t].every((c) => c.meaning), `${t}: every column explained`);
  }
  const empty = build('2027-01-01', '2027-01-03');
  assert.equal(empty.daily.length, 3, 'a span with no records still has its days');
  assert.ok(empty.daily.every((r) => r.page_views === 0 && r.episode_plays === 0), '...as zeros');
  assert.deepEqual(parseCsv(toCsv(L.COLUMNS.shows, build('2027-01-01', '2027-01-02').shows)).rows, [], 'no data: headers, no rows');
});

// 2026-09-01T01:30Z is 9:30 pm on 2026-08-31 in New York.
const EVENING = Date.UTC(2026, 8, 1, 1, 30) / 1000;
const NOON = Date.UTC(2026, 8, 1, 16, 0) / 1000;

test('inventory builder: every held episode, by air date in New York, bytes carried, titles never slugs', () => {
  const feeds = {
    alpha: { channel: { title: 'Alpha', author: 'Host A' }, items: [
      { mp3: 'https://x/a1.mp3', bytes: 1000, title: 'Late', dt: EVENING, durationSec: 3600, category: 'News' },
      { mp3: 'https://x/a2.mp3', bytes: 500, title: 'Noon', dt: NOON, durationSec: 1800, category: 'News' },
      { mp3: 'https://x/a0.mp3', bytes: 1, title: 'No date', dt: 0, durationSec: 60, category: '' },
    ] },
    nameless: { channel: { title: '', author: '' }, items: [{ mp3: 'https://x/n.mp3', bytes: 0, title: 'N', dt: NOON, durationSec: 60 }] },
  };
  const build = (from, to) => INV.buildInventory({ station: 'wbai', stationTimezone: TZ, from, to, feeds,
    titleFor: (k) => (k === 'alpha' ? 'Alpha' : ''), generatedAt: 'g' });
  assert.deepEqual(build('2026-08-31', '2026-08-31').episodes.map((e) => e.episode_title), ['Late'], 'the 9:30 pm episode is an August 31 episode');
  assert.deepEqual(build('2026-09-01', '2026-09-01').episodes.map((e) => e.episode_title).sort(), ['N', 'Noon'], 'and not a September 1 one');
  const all = build('2026-08-01', '2026-09-30');
  assert.equal(all.episodes[0].air_time_local, '21:30'); assert.equal(all.episodes[0].air_datetime_utc, '2026-09-01T01:30:00.000Z');
  assert.equal(all.manifest.undated_skipped, 1, 'an undated item is counted, not silently dropped');
  assert.deepEqual(all.shows.map((s) => [s.show_key, s.show_title, s.episodes, s.total_seconds, s.total_bytes]),
    [['alpha', 'Alpha', 2, 5400, 1500], ['nameless', '', 1, 60, 0]]);
  assert.equal(all.episodes.find((e) => e.show_key === 'nameless').show_title, '');
  assert.deepEqual(INV.COLUMNS.episodes, DOCUMENTED.episodes); assert.deepEqual(INV.COLUMNS.shows, DOCUMENTED.inventoryShows);
  for (const [t, cols] of Object.entries(INV.COLUMNS)) for (const r of all[t]) assert.deepEqual(Object.keys(r), cols);
  assert.equal(INV.exportFilename(all.manifest, 'episodes', 'csv'), 'wbai-archive-episodes-2026-08-01_2026-09-30.csv');
});

test('coverage builder: listed and held shows, generic artwork is not artwork, each source of a fact counts', () => {
  const now = Date.UTC(2026, 8, 16, 12);
  const G = 'https://confessor2.wbai.org/pix/WBAI_it_.jpg';
  const feeds = {
    own: { channel: { title: 'Own', image: 'https://c/own.jpg', desc: 'd', author: 'H' }, items: [{ mp3: 'https://x/o.mp3', dt: now / 1000 - 86400 * 3 - 60 }] },
    g1: { channel: { title: 'G1', image: G, desc: '', author: '' }, items: [{ mp3: 'https://x/g1.mp3', dt: now / 1000 - 86400 * 40 }] },
    g2: { channel: { title: 'G2', image: G }, items: [] },
    g3: { channel: { title: 'G3', image: G }, items: [] },
    g4: { channel: { title: 'G4', image: G }, items: [] },
    pair1: { channel: { title: 'P1', image: 'https://c/pair.jpg' }, items: [] },
    pair2: { channel: { title: 'P2', image: 'https://c/pair.jpg' }, items: [] },
  };
  const c = COV.buildCoverage({ station: 'wbai', stationTimezone: TZ, feeds, knownSlugs: ['own', 'listed', 'ghost'],
    showInfo: { listed: { name: 'Listed', dj: 'DJ', desc: 'about' }, g2: { photo: '/pix/g2_med_1.jpg' } },
    photoMap: { g3: '12' }, inDirectory: (k, title) => title === 'Own',
    titleFor: (k) => ({ own: 'Own', listed: 'Listed', g1: 'G1' })[k] || '', now, generatedAt: '2026-09-16T12:00:00.000Z' });
  const by = Object.fromEntries(c.shows.map((r) => [r.show_key, r]));
  assert.deepEqual(Object.keys(by), ['g1', 'g2', 'g3', 'g4', 'ghost', 'listed', 'own', 'pair1', 'pair2'], 'held ∪ listed, sorted, each once');
  assert.equal(by.g1.has_artwork, false, 'a picture on four shows is the generic one');
  assert.equal(by.g4.has_artwork, false);
  assert.equal(by.g2.has_artwork, true, 'a show record photo is artwork');
  assert.equal(by.g3.has_artwork, true, 'a schedule-page photo is artwork');
  assert.equal(by.pair1.has_artwork, true, 'two shows sharing a real image still have artwork');
  assert.deepEqual(c.manifest.generic_artwork, [{ url: G, shows: 4 }]);
  assert.deepEqual([by.listed.has_feed, by.listed.has_description, by.listed.has_host, by.listed.episodes_held, by.listed.newest_air_date_local],
    [false, true, true, 0, ''], 'a listed show with no feed: facts from its show record, no episodes');
  assert.deepEqual([by.own.has_feed, by.own.in_program_directory, by.own.days_since_newest_episode, by.g1.days_since_newest_episode], [true, true, 3, 40]);
  assert.equal(by.ghost.show_title, ''); assert.equal(by.ghost.in_program_directory, false, 'no title, no directory match');
  assert.deepEqual(c.manifest.summary, { with_feed: 2, without_feed: 7, without_artwork: 4, without_description: 7, without_host: 7, not_in_program_directory: 8 });
  assert.deepEqual(COV.COLUMNS.shows, DOCUMENTED.coverage);
  for (const r of c.shows) assert.deepEqual(Object.keys(r), DOCUMENTED.coverage);
  assert.equal(COV.exportFilename(c.manifest, 'shows', 'csv'), 'wbai-coverage-shows-2026-09-16.csv');
});

// ---------------------------------------------------------------- real HTTP
test('real HTTP: exports are gated, validated, titled, and agree with the dashboard', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const GENERIC = 'https://confessor2.wbai.org/pix/WBAI_it_.jpg';
  const mp3 = (slug, n) => `https://archive2.wbai.org/mp3/wbai_${slug}_${n}.mp3`;
  const item = (slug, n, dt, extra = {}) => ({ mp3: mp3(slug, n), bytes: 1000 * n, title: `${slug} ${n}`, dt, durationSec: 1800 * n, desc: '', category: 'Public Affairs', ...extra });
  const DAY = 86400, today = Math.floor(Date.now() / 1000);
  const FEEDS = {
    alpha: { lastModified: '', fetchedAt: Date.now(), channel: { title: 'Radio "Maíz", en Español', desc: 'd', author: 'Host A', image: 'https://c/alpha.jpg' },
      items: [item('alpha', 1, EVENING), item('alpha', 2, NOON), item('alpha', 3, today - 2 * DAY)] },
    beta: { lastModified: '', fetchedAt: Date.now(), channel: { title: 'Capitalism, Race and Democracy', desc: '', author: '', image: GENERIC },
      items: [item('beta', 1, today - 40 * DAY)] },
    gamma: { lastModified: '', fetchedAt: Date.now(), channel: { title: 'Gamma', desc: '', author: '', image: GENERIC }, items: [item('gamma', 1, NOON)] },
    delta: { lastModified: '', fetchedAt: Date.now(), channel: { title: 'Delta', desc: '', author: '', image: GENERIC }, items: [item('delta', 1, NOON)] },
    // A feed that names no title.
    epsilon: { lastModified: '', fetchedAt: Date.now(), channel: { title: '', desc: '', author: '', image: GENERIC }, items: [item('epsilon', 1, NOON)] },
  };
  // Keys: titled with a comma and quotes; a show with no feed that only its show
  // record names; a feed with no title; and a slug nothing names.
  const SEEDED = { alpha: 'Radio "Maíz", en Español', beta: 'Capitalism, Race and Democracy', listed: 'Listed Show', epsilon: '', nosuchshow: '' };
  const past = { station: 'wbai', month: '2020-02', days: {
    '2020-02-10': { pageviews: 7, plays: 4, live: 2, searches: 3, shares: 1, listenSeconds: 1234, liveSeconds: 99,
      byShow: { alpha: 1, beta: 2, listed: 1 }, secondsByShow: { alpha: 600, beta: 500, epsilon: 134, nosuchshow: 7 }, byZone: { local: 5, intl: 2 } },
    '2020-02-29': { pageviews: 1, plays: 1, live: 0, searches: 0, shares: 0, listenSeconds: 10, liveSeconds: 0,
      byShow: { alpha: 1 }, secondsByShow: { alpha: 10 }, byZone: { unknown: 1 } },
  } };
  seedDataDir(dir, {
    'feeds.json': FEEDS,
    'known-slugs.json': ['alpha', 'beta', 'listed', 'ghost'],
    'showinfo.json': { listed: { name: 'Listed Show', dj: 'DJ', desc: 'about' }, gamma: { name: 'Gamma', photo: '/pix/gamma_med_1.jpg' } },
    'photomap.json': { delta: '12' },
    'programs.json': { updated: Date.now(), programs: { 'capitalism race and democracy': { title: 'CAPITALISM, RACE AND DEMOCRACY' } } },
    'stats/2020-02.json': past,
  });
  const S = await boot(t, dir);
  const { get } = S;
  const FEB = 'from=2020-02-01&to=2020-02-29';
  const todayUtc = new Date().toISOString().slice(0, 10), thisMonth = todayUtc.slice(0, 7);
  const tomorrow = new Date(Date.now() + DAY * 1000).toISOString().slice(0, 10);

  // Signed out: refused — and the same URLs work signed in below.
  for (const p of ['/api/studio/exports', `/api/studio/export?dataset=listening&${FEB}&format=csv&table=shows`,
    '/api/studio/export?dataset=coverage&format=csv', '/api/studio/backup']) {
    const r = await fetch(S.url + p); assert.equal(r.status, 401, p); assert.doesNotMatch(await r.text(), /Capitalism/);
  }

  for (const b of [{ t: 'pageview', z: 'Europe/Paris' }, { t: 'play', u: mp3('alpha', 3) }, { t: 'listen', u: mp3('alpha', 3), s: 45 }, { t: 'search' }]) {
    assert.equal((await S.beacon(b)).status, 204);
  }

  const index = await (await get('/api/studio/exports')).json();
  assert.deepEqual(index.months.map((m) => m.month), [thisMonth, '2020-02'], 'newest first');
  assert.equal(index.firstDate, '2020-02-01');
  assert.deepEqual(index.datasets.map((d) => [d.name, d.span]), [['listening', 'utc'], ['inventory', 'local'], ['coverage', null], ['report', 'mixed']],
    'no station profile on WBAI');

  for (const [from, to] of [['2020-02-10', '2020-02-09'], ['2020-01-31', '2020-02-29'], ['2020-02-01', tomorrow],
    ['2020-02-30', '2020-03-01'], ['../stats/2020-02', '2020-02-29'], ['', '2020-02-29']]) {
    assert.equal((await get(`/api/studio/export?dataset=listening&format=csv&from=${encodeURIComponent(from)}&to=${to}`)).status, 400, `span ${from}..${to}`);
  }
  for (const q of [`dataset=nosuch&${FEB}&format=csv`, `dataset=profile&format=json`, `dataset=inventory&format=csv&table=episodes`,
    `dataset=coverage&format=csv&table=daily`, `dataset=listening&${FEB}&format=xlsx`, `dataset=listening&${FEB}&format=csv&table=ip`]) {
    assert.equal((await get('/api/studio/export?' + q)).status, 400, q);
  }

  // Listening: titles from the feed and from the show record; empty, never a slug.
  const showsRes = await get(`/api/studio/export?dataset=listening&${FEB}&format=csv&table=shows`);
  assert.equal(showsRes.headers.get('content-disposition'), 'attachment; filename="wbai-listening-shows-2020-02-01_2020-02-29.csv"');
  assert.equal(showsRes.headers.get('cache-control'), 'private, no-store');
  const shows = parseCsv(await bytes(showsRes));
  assert.deepEqual(shows.head, DOCUMENTED.shows);
  assert.deepEqual(shows.rows.map((r) => r.show_key), ['alpha', 'beta', 'epsilon', 'nosuchshow', 'listed'], 'every seeded show, ranked by seconds');
  for (const r of shows.rows) assert.equal(r.show_title, SEEDED[r.show_key], `${r.show_key} title`);
  const daily = parseCsv(await bytes(await get(`/api/studio/export?dataset=listening&${FEB}&format=csv&table=daily`)));
  assert.equal(daily.rows.length, 29, 'leap February, zero days included');
  const total = (rows, k) => rows.reduce((n, r) => n + Number(r[k]), 0);
  const seeded = (k) => Object.values(past.days).reduce((n, d) => n + d[k], 0);
  assert.equal(total(daily.rows, 'episode_plays'), seeded('plays'));
  assert.equal(total(daily.rows, 'seconds_listened_on_demand'), seeded('listenSeconds'));
  const reach = parseCsv(await bytes(await get(`/api/studio/export?dataset=listening&${FEB}&format=csv&table=reach`)));
  assert.deepEqual(reach.rows.map((r) => [r.bucket, r.label, r.page_views]),
    [['local', TZ, '5'], ['national', 'Elsewhere in the US', '0'], ['intl', 'International', '2'], ['unknown', 'Not reported', '1']]);

  // Export and dashboard read today identically, and not as 0 = 0.
  const usage = await (await get('/api/studio/usage?days=7')).json();
  const todayDash = usage.days[usage.days.length - 1];
  const now = parseCsv(await bytes(await get(`/api/studio/export?dataset=listening&from=${thisMonth}-01&to=${todayUtc}&format=csv&table=daily`)));
  const todayExp = now.rows[now.rows.length - 1];
  assert.ok(todayDash.plays > 0 && todayDash.listenSeconds > 0, 'beacons landed');
  assert.deepEqual([todayExp.page_views, todayExp.episode_plays, todayExp.searches, todayExp.seconds_listened_on_demand].map(Number),
    [todayDash.pageviews, todayDash.plays, todayDash.searches, todayDash.listenSeconds]);

  // The studio's screens name a show from its show record when no feed does
  // (KPFK 0f0ad11's class): only a show nothing names prints its slug.
  const allUsage = await (await get('/api/studio/usage?days=all')).json();
  const usageTitle = (k) => (allUsage.topShows.find((x) => x.slug === k) || {}).title;
  assert.equal(usageTitle('listed'), 'Listed Show');
  assert.equal(usageTitle('alpha'), 'Radio "Maíz", en Español');
  assert.equal(usageTitle('nosuchshow'), 'nosuchshow');
  assert.equal((await (await get('/api/studio/showhistory?slug=listed')).json()).title, 'Listed Show');

  // ---- Archive: every held episode, placed on its New York air date.
  const inv = index.datasets.find((d) => d.name === 'inventory');
  const heldItems = Object.entries(FEEDS).flatMap(([slug, r]) => r.items.map((it) => ({ slug, ...it })));
  assert.equal(inv.firstDate, nyDate(Math.min(...heldItems.map((i) => i.dt))), 'archive span starts at the oldest local air date');
  const episodes = parseCsv(await bytes(await get(`/api/studio/export?dataset=inventory&from=${inv.firstDate}&to=${inv.today}&format=csv&table=episodes`)));
  assert.deepEqual(episodes.head, DOCUMENTED.episodes);
  assert.deepEqual(episodes.rows.map((r) => r.audio_url).sort(), heldItems.map((i) => i.mp3).sort(), 'every held episode, once');
  for (const r of episodes.rows) {
    const src = heldItems.find((i) => i.mp3 === r.audio_url);
    assert.equal(r.air_date_local, nyDate(src.dt)); assert.equal(Number(r.file_bytes), src.bytes);
    assert.equal(r.show_title, SEEDED[r.show_key] !== undefined ? SEEDED[r.show_key] : FEEDS[r.show_key].channel.title);
  }
  const onEvening = parseCsv(await bytes(await get('/api/studio/export?dataset=inventory&from=2026-08-31&to=2026-08-31&format=csv&table=episodes')));
  assert.deepEqual(onEvening.rows.map((r) => r.audio_url), [mp3('alpha', 1)], 'the 9:30 pm New York episode is on its New York day');
  const invShows = parseCsv(await bytes(await get(`/api/studio/export?dataset=inventory&from=${inv.firstDate}&to=${inv.today}&format=csv&table=shows`)));
  assert.equal(invShows.rows.reduce((n, r) => n + Number(r.episodes), 0), episodes.rows.length, 'show counts add up');
  assert.equal((await get(`/api/studio/export?dataset=inventory&from=${inv.firstDate}&to=${tomorrow}&format=csv`)).status, 400);
  // The export and the studio's "Every feed" dashboard count the same store.
  const stats = await (await get('/api/studio/stats')).json();
  assert.equal(stats.totals.episodes, episodes.rows.length);

  // ---- Coverage
  const covRes = await get('/api/studio/export?dataset=coverage&format=csv&table=shows');
  assert.equal(covRes.headers.get('content-disposition'), `attachment; filename="wbai-coverage-shows-${todayUtc}.csv"`);
  const cov = parseCsv(await bytes(covRes));
  const by = Object.fromEntries(cov.rows.map((r) => [r.show_key, r]));
  assert.deepEqual(Object.keys(by), ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'ghost', 'listed']);
  assert.deepEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'ghost', 'listed'].map((k) => [k, by[k].has_feed, by[k].has_artwork]), [
    ['alpha', 'true', 'true'], ['beta', 'true', 'false'], ['gamma', 'true', 'true'], ['delta', 'true', 'true'],
    ['epsilon', 'true', 'false'], ['ghost', 'false', 'false'], ['listed', 'false', 'false']]);
  assert.equal(by.beta.in_program_directory, 'true', 'matched by title to the program directory');
  assert.equal(by.listed.show_title, 'Listed Show'); assert.equal(by.ghost.show_title, '');
  assert.equal(by.beta.days_since_newest_episode, '40');
  const covJson = await (await get('/api/studio/export?dataset=coverage&format=json')).json();
  assert.deepEqual(covJson.manifest.generic_artwork, [{ url: GENERIC, shows: 4 }]);
  assert.equal(covJson.manifest.summary.without_feed, 2);

  // ---- Printable report: the same numbers as the downloads, CSP-clean, escaped.
  const signedOut = await fetch(S.url + `/studio/report?${FEB}`, { redirect: 'manual' });
  assert.equal(signedOut.status, 302); assert.equal(signedOut.headers.get('location'), '/studio');
  const repRes = await get(`/studio/report?${FEB}`);
  assert.equal(repRes.status, 200);
  assert.match(repRes.headers.get('content-security-policy'), /style-src 'self'/);
  const rep = await repRes.text();
  const unescape = (x) => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const totals = JSON.parse(unescape(rep.match(/data-totals='([^']+)'/)[1]));
  assert.equal(totals.plays, seeded('plays')); assert.equal(totals.onDemand, seeded('listenSeconds'));
  assert.match(rep, /Radio &quot;Maíz&quot;, en Español/, 'titles are escaped');
  assert.doesNotMatch(rep, /Radio "Maíz"/, 'and never raw');
  assert.match(rep, /untitled in the feed \(nosuchshow\)/);
  assert.doesNotMatch(rep, /\sstyle=|<style|<script(?![^>]*\ssrc=)/, 'no inline style or script: the CSP would void them');
  for (const [, src] of rep.matchAll(/\ssrc="([^"]+)"/g)) assert.ok(src.startsWith('/'), `same-origin: ${src}`);
  assert.match(rep, /href="\/report\.css\?v=[^"]+"/, 'the stylesheet is version-stamped');
  const tile = (html, label) => Number(((html.match(new RegExp(`<div class="tile-value">([\\d,]+)</div><div class="tile-label">${label}</div>`)) || [])[1] || 'NaN').replace(/,/g, ''));
  const repAll = await (await get(`/studio/report?from=2020-02-01&to=${todayUtc}`)).text();
  assert.equal(tile(repAll, 'Episodes'), episodes.rows.length, 'report episodes = the Archive CSV');
  assert.equal(tile(repAll, 'No podcast feed'), cov.rows.filter((r) => r.has_feed === 'false').length, 'report feed gaps = the Coverage CSV');
  assert.equal(tile(repAll, 'No artwork'), cov.rows.filter((r) => r.has_feed === 'true' && r.has_artwork === 'false').length);
  for (const q of ['from=2020-02-10&to=2020-02-09', `from=2020-02-01&to=${tomorrow}`, 'from=1999-01-01&to=2020-02-01']) {
    assert.equal((await get('/studio/report?' + q)).status, 400, 'report span ' + q);
  }

  const readme = await (await get(`/api/studio/export?dataset=listening&${FEB}&format=readme`)).text();
  assert.match(readme, /never collects an IP address/);
  for (const c of [...DOCUMENTED.daily, ...DOCUMENTED.shows]) assert.match(readme, new RegExp(`  ${c}: `));
  assert.doesNotMatch(S.logs(), /\[error\]|TypeError|ReferenceError/);
});
