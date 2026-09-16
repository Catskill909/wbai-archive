'use strict';
// Backup and restore (docs/exports.md "1c"), WBAI's version: usage months AND
// feeds.json. Unit tests pin the validator's allow-list and the feed plan; the
// HTTP test runs two real servers — A makes a backup, B (an install with data of
// its own) restores it — and checks what a station manager would see.
//
// Months are previewed then replaced. Episodes are MERGED per show with the
// app's own mergeFeedItems: nothing on B is removed, B's copy of an episode
// wins, and restoring twice changes nothing.
//
//   node test/exports/backup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../../lib/export/backup');
const { mergeFeedItems } = require('../../server.js');
const { sleep, parseCsv, bytes, seedDataDir, snapshot, boot } = require('./harness');

const THIS_MONTH = '2026-09';
function day(extra = {}) {
  return { pageviews: 4, plays: 2, live: 1, searches: 0, shares: 0, listenSeconds: 120, liveSeconds: 30,
    byShow: { dn: 2 }, secondsByShow: { dn: 120 }, byZone: { local: 3, intl: 1 }, ...extra };
}
const ep = (slug, n, dt, extra = {}) => ({ mp3: `https://archive2.wbai.org/mp3/wbai_${slug}_${n}.mp3`, bytes: n, title: `${slug} ${n}`, dt, durationSec: 3600, desc: '', category: 'News', ...extra });
const FEEDS = { dn: { lastModified: 'x', fetchedAt: 1, channel: { title: 'Democracy Now!', desc: 'd', author: 'Amy', image: 'https://c/dn.jpg' },
  items: [ep('dn', 2, 2000), ep('dn', 1, 1000)] } };
function backupOf(months, feeds = FEEDS) {
  return B.buildBackup({ station: 'wbai', createdAt: 'x', appVersion: 'v', sourceInstanceId: 'i', months, feeds: B.backupFeeds(feeds) });
}
/** Re-sign after an edit, so the test reaches the rule it means to test rather than the checksum. */
function resign(b) {
  for (const m of Object.keys(b.stats)) b.checksums[m] = B.monthChecksum(b.stats[m]);
  b.feedsChecksum = B.monthChecksum(b.feeds);
  return b;
}
const errorsOf = (b) => { const v = B.validateBackup(b, { station: 'wbai', thisMonth: THIS_MONTH }); return v.ok ? [] : v.errors; };

test('validator: a backup this app makes is accepted, and every rule refuses what it names', () => {
  const good = backupOf({ '2026-08': { station: 'wbai', month: '2026-08', days: { '2026-08-02': day() } } });
  assert.deepEqual(errorsOf(good), []);
  assert.deepEqual(errorsOf(JSON.parse(JSON.stringify(good))), [], 'still valid after a JSON round trip');
  assert.equal(good.feeds.dn.lastModified, undefined, 'fetch state is not data and does not travel');
  assert.deepEqual(errorsOf(backupOf({}, FEEDS)), [], 'a station that counts nothing can still move its episodes');

  const cases = [
    ['another station', (b) => { b.station = 'kpfk'; }, /belongs to station "kpfk"/],
    ['edited count, checksum kept', (b) => { b.stats['2026-08'].days['2026-08-02'].plays = 999; }, /does not match its checksum/],
    ['path-like month key', (b) => { b.stats['../x'] = b.stats['2026-08']; resign(b); }, /is not a month/],
    ['future month', (b) => { b.stats['2026-10'] = { station: 'wbai', month: '2026-10', days: {} }; resign(b); }, /is in the future/],
    ['identifier field in a day', (b) => { b.stats['2026-08'].days['2026-08-02'].ip = '203.0.113.9'; resign(b); }, /unexpected field "ip"/],
    ['negative counter', (b) => { b.stats['2026-08'].days['2026-08-02'].plays = -1; resign(b); }, /"plays" must be a whole number/],
    ['unknown zone', (b) => { b.stats['2026-08'].days['2026-08-02'].byZone.Europe_Paris = 1; resign(b); }, /"byZone" has an unexpected key/],
    ['nothing at all', (b) => { b.stats = {}; b.checksums = {}; b.feeds = {}; resign(b); }, /no months and no episodes/],
    // The feeds half.
    ['no feeds section', (b) => { delete b.feeds; }, /no "feeds" section/],
    ['edited episode, checksum kept', (b) => { b.feeds.dn.items[0].title = 'changed'; }, /feeds section does not match its checksum/],
    ['path-like show slug', (b) => { b.feeds['../etc'] = b.feeds.dn; resign(b); }, /is not a show slug/],
    ['identifier on an episode', (b) => { b.feeds.dn.items[0].listener = 'x'; resign(b); }, /unexpected field "listener"/],
    ['extra field on a show', (b) => { b.feeds.dn.lastModified = 'x'; resign(b); }, /unexpected field "lastModified"/],
    ['script as audio', (b) => { b.feeds.dn.items[0].mp3 = 'javascript:alert(1)'; resign(b); }, /audio address is not a web address/],
    ['non-web image', (b) => { b.feeds.dn.channel.image = 'file:///etc/passwd'; resign(b); }, /image is not a web address/],
    ['fractional duration', (b) => { b.feeds.dn.items[0].durationSec = 1.5; resign(b); }, /"durationSec" must be a whole number/],
    ['text that is not text', (b) => { b.feeds.dn.items[0].title = { $gt: 1 }; resign(b); }, /"title" must be text/],
    ['too many episodes', (b) => { b.feeds.dn.items = Array.from({ length: 2001 }, (_, i) => ep('dn', i, i)); resign(b); }, /at most 2000/],
  ];
  for (const [name, edit, re] of cases) {
    const b = JSON.parse(JSON.stringify(good)); edit(b);
    const errs = errorsOf(b);
    assert.ok(errs.some((e) => re.test(e)), `${name}: expected ${re}, got ${JSON.stringify(errs)}`);
  }
});

test('planFeeds: merge with the harvest\'s own merge — add, never remove, this server wins a collision', () => {
  const incoming = B.backupFeeds({
    dn: { channel: {}, items: [ep('dn', 3, 3000), ep('dn', 2, 2000, { title: 'backup telling' }), ep('dn', 1, 1000)] },
    newshow: { channel: { title: 'New' }, items: [ep('newshow', 1, 500)] },
    empty: { channel: {}, items: [] },
  });
  const current = { dn: { items: [ep('dn', 2, 2000, { title: 'server telling' })] }, mine: { items: [ep('mine', 1, 1)] } };
  const p = B.planFeeds(incoming, current, mergeFeedItems);
  assert.deepEqual(p.shows.map((s) => [s.slug, s.action, s.adds.length]), [['dn', 'merge', 2], ['newshow', 'new', 1]], 'an empty show is not a change');
  assert.deepEqual([p.episodesAdded, p.showsGaining, p.newShows, p.serverShows, p.serverEpisodes, p.backupEpisodes], [3, 2, 1, 2, 2, 4]);
  const merged = mergeFeedItems(incoming.dn.items, current.dn.items);
  assert.equal(merged.find((i) => i.dt === 2000).title, 'server telling', 'the server\'s copy wins, as apply passes it');
  const after = { ...current, dn: { items: merged }, newshow: { items: mergeFeedItems(incoming.newshow.items, []) } };
  const again = B.planFeeds(incoming, after, mergeFeedItems);
  assert.equal(again.episodesAdded, 0, 'restoring twice adds nothing the second time');
  assert.ok(again.shows.every((s) => s.action === 'identical'));
});

// ---------------------------------------------------------------- real HTTP
test('real HTTP: back up A, restore on B — months replace, episodes merge, refusals, idempotent, undo', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-backup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const todayUtc = new Date().toISOString().slice(0, 10), thisMonth = todayUtc.slice(0, 7);
  const ch = (title) => ({ title, desc: '', author: '', image: '' });

  // A: old episodes B never saw (they rotated out of upstream before B existed).
  const aDir = path.join(tmp, 'a'), bDir = path.join(tmp, 'b');
  seedDataDir(aDir, {
    'feeds.json': {
      dn: { lastModified: 'Mon', fetchedAt: Date.now(), channel: ch('Democracy Now!'),
        items: [ep('dn', 4, now - DAY, { title: 'A telling' }), ep('dn', 3, now - 30 * DAY), ep('dn', 2, now - 60 * DAY), ep('dn', 1, now - 90 * DAY)] },
      housing: { lastModified: 'Mon', fetchedAt: Date.now(), channel: ch('Housing Notice'), items: [ep('housing', 1, now - 45 * DAY)] },
    },
    'stats/2020-02.json': { station: 'wbai', month: '2020-02', days: { '2020-02-10': day({ terms: { x: 1 } }), '2020-02-29': day({ plays: 5 }) } },
  });
  // B: a newer install — the recent dn episode (with its own telling), a show A
  // never had, and some counting of its own.
  seedDataDir(bDir, {
    'feeds.json': {
      dn: { lastModified: 'Tue', fetchedAt: Date.now(), channel: ch('Democracy Now!'),
        items: [ep('dn', 5, now), ep('dn', 4, now - DAY, { title: 'B telling' })] },
      zeta: { lastModified: 'Tue', fetchedAt: Date.now(), channel: ch('Zeta'), items: [ep('zeta', 1, now - 2 * DAY)] },
    },
  });
  const A = await boot(t, aDir, 'password-for-a'), Bs = await boot(t, bDir, 'password-for-b');

  for (const b of [{ t: 'pageview', z: 'America/Chicago' }, { t: 'play', u: ep('dn', 4, 0).mp3 }]) assert.equal((await A.beacon(b)).status, 204);
  const backupRes = await A.get('/api/studio/backup');
  assert.equal(backupRes.headers.get('content-disposition'), `attachment; filename="wbai-backup-${todayUtc}.json"`);
  const backupText = await backupRes.text();
  const backup = JSON.parse(backupText);
  assert.deepEqual(Object.keys(backup.stats), ['2020-02', thisMonth], 'every month, including counters not yet flushed');
  assert.deepEqual(Object.keys(backup.feeds), ['dn', 'housing'], 'the feed store travels');
  assert.equal(backup.feeds.dn.items.length, 4);
  assert.doesNotMatch(backupText, /"terms"|lastModified|fetchedAt/, 'no legacy search terms, no fetch state');

  for (const b of [{ t: 'play', u: ep('dn', 5, 0).mp3 }, { t: 'play', u: ep('dn', 5, 0).mp3 }]) assert.equal((await Bs.beacon(b)).status, 204);
  // Counters reach disk on a 5 s debounce; wait, so "the preview wrote nothing"
  // is not confused with the flush timer writing something.
  await sleep(5600);
  const bFeedsBefore = JSON.parse(fs.readFileSync(path.join(bDir, 'feeds.json'), 'utf8'));

  // Gates.
  assert.equal((await fetch(Bs.url + '/api/studio/import/preview', { method: 'POST', body: backupText })).status, 401);
  assert.equal((await Bs.post('/api/studio/import/preview', backupText, { 'X-Studio-CSRF': 'nope' })).status, 403);
  assert.equal((await Bs.post('/api/studio/import/apply', backupText)).status, 409, 'apply without a preview token');

  // Preview writes nothing, and says what the episodes would do.
  const before = snapshot(bDir);
  const preview = await (await Bs.post('/api/studio/import/preview', backupText)).json();
  assert.deepEqual(preview.plan.map((p) => [p.month, p.action]), [[thisMonth, 'replace'], ['2020-02', 'new']]);
  assert.deepEqual([preview.feeds.episodesAdded, preview.feeds.showsGaining, preview.feeds.newShows], [4, 2, 1]);
  assert.deepEqual(preview.feeds.shows.map((s) => [s.slug, s.title, s.action, s.adds]), [['dn', 'Democracy Now!', 'merge', 3], ['housing', 'Housing Notice', 'new', 1]]);
  assert.equal(JSON.stringify(preview).includes('.mp3'), false, 'the preview names shows, not every audio URL');
  assert.deepEqual(snapshot(bDir), before, 'the data directory is byte-identical after a preview');

  const refused = async (label, edit, re) => {
    const b = JSON.parse(backupText); edit(b);
    const r = await Bs.post('/api/studio/import/preview', JSON.stringify(b));
    const body = await r.json();
    assert.equal(r.status, 422, label); assert.ok(body.errors.some((e) => re.test(e)), `${label}: ${JSON.stringify(body.errors)}`);
  };
  await refused('another station', (b) => { b.station = 'kpfk'; }, /belongs to station "kpfk"/);
  await refused('tampered episode', (b) => { b.feeds.dn.items[0].mp3 = 'https://evil.example/x.mp3'; }, /feeds section does not match its checksum/);
  await refused('planted identifier', (b) => { b.feeds.dn.items[0].ip = '198.51.100.7'; resign(b); }, /unexpected field "ip"/);
  assert.equal((await Bs.post('/api/studio/import/apply', backupText.replace('"A telling"', '"A telling!"'), { 'X-Import-Token': preview.token })).status, 409,
    'a token is bound to the previewed bytes');
  assert.deepEqual(snapshot(bDir), before, 'nothing refused wrote anything');

  // Apply.
  const applyRes = await Bs.post('/api/studio/import/apply', backupText, { 'X-Import-Token': preview.token });
  const applied = await applyRes.json();
  assert.equal(applyRes.status, 200, JSON.stringify(applied));
  assert.deepEqual([applied.replaced, applied.added, applied.episodesAdded], [[thisMonth], ['2020-02'], 4]);
  const folder = path.join(bDir, 'imports', applied.folder);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'feeds.json'), 'utf8')), bFeedsBefore, 'B\'s feeds were copied aside first');
  assert.equal(fs.existsSync(path.join(bDir, 'stats', applied.folder)), false, 'import folders never sit among the month files');

  const feedsAfter = JSON.parse(fs.readFileSync(path.join(bDir, 'feeds.json'), 'utf8'));
  const mp3s = (store, slug) => (store[slug] ? store[slug].items.map((i) => i.mp3).sort() : []);
  assert.deepEqual(mp3s(feedsAfter, 'dn'), [...new Set([...mp3s(bFeedsBefore, 'dn'), ...backup.feeds.dn.items.map((i) => i.mp3)])].sort(), 'union, no duplicates');
  assert.equal(feedsAfter.dn.items.find((i) => i.mp3.endsWith('_4.mp3')).title, 'B telling', 'B\'s copy of a shared episode wins');
  assert.deepEqual(feedsAfter.zeta, bFeedsBefore.zeta, 'a show only B holds is untouched');
  assert.equal(feedsAfter.dn.lastModified, 'Tue', 'B keeps its own fetch state for a show it held');
  assert.deepEqual([feedsAfter.housing.lastModified, feedsAfter.housing.fetchedAt], ['', 0], 'a show the restore adds is fetched afresh');
  assert.deepEqual(feedsAfter.dn.items.map((i) => i.dt), feedsAfter.dn.items.map((i) => i.dt).slice().sort((a, b) => b - a), 'newest first, as the harvest keeps it');

  // What a station manager sees: B's archive export now holds A's old episodes,
  // and the studio dashboard counts the same store.
  const idx = await (await Bs.get('/api/studio/exports')).json();
  const inv = idx.datasets.find((d) => d.name === 'inventory');
  const episodes = parseCsv(await bytes(await Bs.get(`/api/studio/export?dataset=inventory&from=${inv.firstDate}&to=${inv.today}&format=csv&table=episodes`)));
  assert.equal(episodes.rows.length, 7, '2 of B\'s + 1 of B\'s other show + 4 added');
  assert.equal((await (await Bs.get('/api/studio/stats')).json()).totals.episodes, 7);
  assert.equal(idx.firstDate, '2020-02-01', 'the restored month is a real month to the rest of the app');
  const usage = await (await Bs.get('/api/studio/usage?days=7')).json();
  assert.equal(usage.days[usage.days.length - 1].plays, 1, 'A\'s counters replaced B\'s for this month');
  assert.equal((await (await A.get('/api/studio/export?dataset=listening&from=2020-02-01&to=2020-02-29&format=csv&table=daily')).text()),
    (await (await Bs.get('/api/studio/export?dataset=listening&from=2020-02-01&to=2020-02-29&format=csv&table=daily')).text()), 'B\'s February export equals A\'s');

  // Idempotent: the same file again adds no episode and does not touch feeds.json.
  await sleep(3100);
  const feedsBytes = fs.readFileSync(path.join(bDir, 'feeds.json'));
  const again = await (await Bs.post('/api/studio/import/preview', backupText)).json();
  assert.equal(again.feeds.episodesAdded, 0);
  assert.equal(again.plan.find((p) => p.month === '2020-02').action, 'identical');
  const againApplied = await (await Bs.post('/api/studio/import/apply', backupText, { 'X-Import-Token': again.token })).json();
  assert.equal(againApplied.episodesAdded, 0);
  assert.deepEqual(fs.readFileSync(path.join(bDir, 'feeds.json')), feedsBytes, 'feeds.json byte-identical after a second restore');

  assert.equal(againApplied.lastImport.importedAt, applied.lastImport.importedAt, 'a restore that changes nothing records no new import');
});

test('real HTTP: undo takes out exactly the episodes a restore added, and deletes nothing', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-undo-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const ch = (title) => ({ title, desc: '', author: '', image: '' });
  const bDir = path.join(tmp, 'b');
  const mine = { dn: { lastModified: 'Tue', fetchedAt: 5, channel: ch('Democracy Now!'), items: [ep('dn', 5, now), ep('dn', 4, now - DAY)] } };
  seedDataDir(bDir, { 'feeds.json': mine });
  const Bs = await boot(t, bDir, 'password-for-b');
  const thisMonth = new Date().toISOString().slice(0, 7);
  const backupText = JSON.stringify(backupOf({ '2020-02': { station: 'wbai', month: '2020-02', days: { '2020-02-10': day() } } }, {
    dn: { channel: ch('Democracy Now!'), items: [ep('dn', 4, now - DAY, { title: 'other telling' }), ep('dn', 3, now - 30 * DAY)] },
    housing: { channel: ch('Housing Notice'), items: [ep('housing', 1, now - 45 * DAY)] },
  }));
  assert.ok(thisMonth > '2020-02');
  const preview = await (await Bs.post('/api/studio/import/preview', backupText)).json();
  const applied = await (await Bs.post('/api/studio/import/apply', backupText, { 'X-Import-Token': preview.token })).json();
  assert.equal(applied.episodesAdded, 2);
  const status = await (await Bs.get('/api/studio/import/status')).json();
  assert.equal(status.lastImport.feedsEpisodesAdded, 2);
  assert.equal(status.lastImport.feedsAdded, undefined, 'the per-episode list stays on the server');

  await sleep(3100);
  const undoRes = await Bs.post('/api/studio/import/undo', '');
  const undone = await undoRes.json();
  assert.equal(undoRes.status, 200, JSON.stringify(undone));
  assert.deepEqual([undone.removed, undone.removedEpisodes], [['2020-02'], 2]);
  const feeds = JSON.parse(fs.readFileSync(path.join(bDir, 'feeds.json'), 'utf8'));
  assert.deepEqual(feeds, mine, 'B\'s feed store is exactly what it was — the added show gone, its own episodes intact');
  const folder = path.join(bDir, 'imports', applied.folder);
  assert.ok(fs.existsSync(path.join(folder, 'undone-feeds.json')), 'the store as restored is kept, not deleted');
  assert.ok(fs.existsSync(path.join(folder, 'imported-2020-02.json')), 'the added month moved into the import folder');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'undone-feeds.json'), 'utf8')).housing.items.length, 1);
  const inv = (await (await Bs.get('/api/studio/exports')).json()).datasets.find((d) => d.name === 'inventory');
  const csv = parseCsv(await bytes(await Bs.get(`/api/studio/export?dataset=inventory&from=${inv.firstDate}&to=${inv.today}&format=csv&table=episodes`)));
  assert.equal(csv.rows.length, 2, 'the archive export is back to B\'s own two episodes');
  await sleep(3100);
  assert.equal((await Bs.post('/api/studio/import/undo', '')).status, 409, 'a restore is undone once');
  assert.doesNotMatch(Bs.logs(), /import request failed|import failed|undo failed/);
});
