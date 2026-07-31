'use strict';

/**
 * Studio gate tests.
 *
 * These drive a real server process over HTTP. No stubs, no reaching into
 * module internals: the thing being tested is whether an unauthenticated
 * request can get at studio data, and the only honest way to ask that is to
 * make one.
 *
 * Two rules from CLAUDE.md §3a shape this file:
 *
 *   1. Assert the effect, not the declaration. "Is the cookie HttpOnly?" is a
 *      weak question; "does /api/studio/health answer a client with no cookie?"
 *      is the real one.
 *   2. An assertion of absence must prove it can still see presence. A suite
 *      full of "the request was refused" passes perfectly once the probe stops
 *      working — so every refusal below is paired with the same request
 *      succeeding under a valid session. If the probe went blind, those pairs
 *      break.
 *
 *   node test/studio/studio-tests.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PASSWORD = 'correct-horse-battery-staple';
const PORT_ON = 8123;
const PORT_OFF = 8124;
const ROOT = path.join(__dirname, '..', '..');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/**
 * A tiny, fixed archive written into the server's data dir before it boots.
 *
 * Without it the test server starts empty and every stats assertion passes
 * vacuously — `perDay` is `[]`, so "does it include empty days?" is answered by
 * an empty array rather than by the behaviour. Two shows, a deliberate two-day
 * hole between the 3rd and the 6th, and known durations either side of a bucket
 * boundary, so the histogram, the buckets and the totals all have something real
 * to be wrong about.
 */
const DAY = 86400;
const D0 = Math.floor(Date.UTC(2026, 0, 1) / 1000);   // fixed: no clock dependence
const FIXTURE = {
  alpha: {
    lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
    fetchedAt: Date.now(),
    channel: { title: 'Alpha Show' },
    items: [
      { mp3: 'a1', bytes: 1e6, title: 'a1', dt: D0, durationSec: 3600, category: 'News' },
      { mp3: 'a2', bytes: 1e6, title: 'a2', dt: D0 + DAY, durationSec: 3600, category: 'News' },
      // gap: D0+2 and D0+3 have nothing
      { mp3: 'a3', bytes: 1e6, title: 'a3', dt: D0 + 4 * DAY, durationSec: 7800, category: 'News' },
    ],
  },
  beta: {
    lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
    fetchedAt: Date.now(),
    channel: { title: 'Beta Show' },
    items: [
      { mp3: 'b1', bytes: 1e6, title: 'b1', dt: D0 + 4 * DAY, durationSec: 1500, category: 'Music' },
    ],
  },
};

// Which temp dir a spawned server was given — the on-disk privacy assertion
// has to look at the actual files, not just the API response.
const dataDirs = new WeakMap();
function dataDirOf(child) { return dataDirs.get(child); }

function startServer(port, env, fixture) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-studio-'));
  if (fixture) fs.writeFileSync(path.join(dataDir, 'feeds.json'), JSON.stringify(fixture));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
  dataDirs.set(child, dataDir);
  return child;
}

async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on :${port} never became ready`);
}

const get = (port, p, headers) => fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: 'manual' });
const post = (port, p, body, headers) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
  body: body === undefined ? undefined : JSON.stringify(body),
  redirect: 'manual',
});

// The cookie scheme, reimplemented so the tests can forge and age sessions.
// Duplicating it is the point: if server.js changes how sessions are signed,
// these must be updated deliberately rather than silently keeping up.
function sign(exp, secret) {
  const key = crypto.createHash('sha256').update('wbai-studio-session\0' + secret).digest();
  return `${exp}.${crypto.createHmac('sha256', key).update(String(exp)).digest('base64url')}`;
}

async function run() {
  // ---------------------------------------------------------------- disabled
  //
  // With no STUDIO_PASSWORD the feature must not exist — not "exists and
  // refuses". A 401 or a login form would tell a scanner there is something
  // here worth coming back for.
  const off = startServer(PORT_OFF, { STUDIO_PASSWORD: '' });
  try {
    await waitReady(PORT_OFF);

    const page = await get(PORT_OFF, '/studio');
    const html = await page.text();
    ok('disabled: /studio serves the listener app, not a login form',
      page.status === 200 && !html.includes('loginForm') && html.includes('/app.js'),
      `status ${page.status}, loginForm=${html.includes('loginForm')}`);

    const api = await get(PORT_OFF, '/api/studio/health');
    const apiBody = await api.text();
    ok('disabled: /api/studio/health is not a studio response',
      !apiBody.includes('"error"') && !apiBody.includes('instanceId'),
      apiBody.slice(0, 80));

    const login = await post(PORT_OFF, '/api/studio/login', { password: PASSWORD });
    ok('disabled: POST /api/studio/login is refused as a method, not handled',
      login.status === 405, `status ${login.status}`);

    const hz = await (await get(PORT_OFF, '/healthz')).json();
    ok('disabled: /healthz does not advertise the studio',
      !('studio' in hz), JSON.stringify(hz).slice(0, 120));
  } finally {
    off.kill('SIGKILL');
  }

  // ----------------------------------------------------------------- enabled
  const on = startServer(PORT_ON, { STUDIO_PASSWORD: PASSWORD }, FIXTURE);
  try {
    await waitReady(PORT_ON);

    // -- the door -----------------------------------------------------------
    const door = await get(PORT_ON, '/studio');
    const doorHtml = await door.text();
    ok('enabled: /studio serves the login page',
      door.status === 200 && doorHtml.includes('loginForm'), `status ${door.status}`);
    ok('login page is uncacheable and varies on the cookie',
      /private/.test(door.headers.get('cache-control') || '')
      && /no-store/.test(door.headers.get('cache-control') || '')
      && /cookie/i.test(door.headers.get('vary') || ''),
      `cache-control=${door.headers.get('cache-control')} vary=${door.headers.get('vary')}`);

    // The never-stale guarantee has to reach the studio's own assets, or the
    // newest code in the repo is the one code that can go stale (CLAUDE.md §1).
    ok('studio assets are version-stamped',
      doorHtml.includes('/studio.css?v=') && doorHtml.includes('/studio.js?v=')
      && doorHtml.includes('/styles.css?v='),
      doorHtml.match(/<(link|script)[^>]*>/g).join('\n'));

    // -- refusals, before we have a session ---------------------------------
    const noCookie = await get(PORT_ON, '/api/studio/health');
    ok('no cookie: health is 401', noCookie.status === 401, `status ${noCookie.status}`);

    const badPw = await post(PORT_ON, '/api/studio/login', { password: 'wrong' });
    ok('wrong password: 401', badPw.status === 401, `status ${badPw.status}`);

    const noBody = await post(PORT_ON, '/api/studio/login');
    ok('empty body: 401 rather than a crash', noBody.status === 401, `status ${noBody.status}`);

    // -- the studio HTML must not be reachable as a file ---------------------
    //
    // If it were, the whole gate would be walked around by guessing a filename.
    for (const p of ['/studio.html', '/admin/studio.html', '/admin/login.html',
                     '/../admin/studio.html', '/studio/../../admin/studio.html']) {
      const r = await get(PORT_ON, p);
      const body = await r.text();
      ok(`studio HTML is not served from ${p}`,
        !body.includes('storageFacts'), `status ${r.status}`);
    }

    // -- a real session ------------------------------------------------------
    const good = await post(PORT_ON, '/api/studio/login', { password: PASSWORD });
    const setCookie = good.headers.get('set-cookie') || '';
    ok('correct password: 200 and a cookie', good.status === 200 && /studio=/.test(setCookie),
      `status ${good.status}, set-cookie=${setCookie}`);
    ok('cookie is HttpOnly and SameSite=Strict',
      /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie);

    const session = setCookie.split(';')[0];
    const authed = { Cookie: session };

    // -- the paired positives (see rule 2 in the header) --------------------
    const health = await get(PORT_ON, '/api/studio/health', authed);
    const data = await health.json();
    ok('with a session: health returns data', health.status === 200 && !!data.storage,
      `status ${health.status}`);
    ok('health carries the fields the dashboard renders',
      data.station && data.version && data.studioVersion && data.counts && data.feeds
      && typeof data.storage.instanceId === 'string',
      JSON.stringify(data).slice(0, 160));

    // Named individually, and this is not pedantry: the first version of the
    // studio sent a storage object that was MISSING feedsOnDisk, and the page
    // rendered the words "undefined feeds" to the operator. A test asking "is
    // there a storage object" passed it happily — JSON simply omits a key whose
    // value is undefined, so absence looks like nothing at all. Assert the keys.
    const wantStorage = ['dataDir', 'writable', 'mounted', 'volume', 'anonymousVolume',
      'instanceId', 'persistedSince', 'bootedAt', 'freshVolume',
      'showinfoOnDisk', 'showinfoNow', 'feedsOnDisk'];
    const missing = wantStorage.filter((k) => !(k in data.storage));
    ok('every storage field the dashboard reads is present', missing.length === 0,
      `missing: ${missing.join(', ')}`);

    // Same fields, same shape, on the public endpoint — they are one function,
    // and this is what stops them drifting apart again.
    const publicStorage = (await (await get(PORT_ON, '/healthz')).json()).storage;
    // `lastSweep` is null until a full sweep has run, which is correct and is
    // exactly why the key must still be PRESENT — the dashboard branches on it,
    // and an absent key and a null one are the same to `d.feeds.lastSweep` only
    // by luck. Assert the contract, not today's value.
    ok('feeds report carries lastSweep (null before the first full sweep)',
      'lastSweep' in data.feeds, JSON.stringify(data.feeds));

    ok('/healthz and the studio report identical storage keys',
      JSON.stringify(Object.keys(publicStorage).sort())
      === JSON.stringify(Object.keys(data.storage).sort()),
      `${Object.keys(publicStorage).sort()} vs ${Object.keys(data.storage).sort()}`);
    ok('health is uncacheable and varies on the cookie',
      /no-store/.test(health.headers.get('cache-control') || '')
      && /cookie/i.test(health.headers.get('vary') || ''),
      `cache-control=${health.headers.get('cache-control')}`);

    // -- actions (phase 4) ----------------------------------------------------
    //
    // The only state-changing routes in the app. `archive` is used for the
    // happy path because it touches nothing upstream — a test suite should not
    // fire 122 requests at a small station's server to prove a button works.
    const csrf = (await (await get(PORT_ON, '/api/studio/health', authed)).json()).csrf;
    ok('health hands the page a CSRF token', typeof csrf === 'string' && csrf.length > 20);

    const act = (body, headers) => post(PORT_ON, '/api/studio/action', body, headers);

    ok('action without a session: 401',
      (await act({ action: 'archive' }, { 'X-Studio-CSRF': csrf })).status === 401);
    ok('action with a session but no token: 403',
      (await act({ action: 'archive' }, authed)).status === 403);
    ok('action with a wrong token: 403',
      (await act({ action: 'archive' },
        Object.assign({ 'X-Studio-CSRF': 'nope' }, authed))).status === 403);

    /* The token must be bound to THIS session, not a constant the server would
     * accept from anyone. Signing one against a different secret is what an
     * attacker who guessed the scheme but not the key would have. */
    const foreign = crypto.createHmac('sha256',
      crypto.createHash('sha256').update('wbai-studio-session\0other').digest())
      .update('csrf\0' + session.split('=')[1]).digest('base64url');
    ok('a token minted with the wrong key is refused',
      (await act({ action: 'archive' },
        Object.assign({ 'X-Studio-CSRF': foreign }, authed))).status === 403,
      'the token is not bound to the session key');

    const authedCsrf = Object.assign({ 'X-Studio-CSRF': csrf }, authed);
    ok('an unknown action is rejected rather than guessed at',
      (await act({ action: 'rm -rf /' }, authedCsrf)).status === 400);

    const ran = await act({ action: 'archive' }, authedCsrf);
    const ranBody = await ran.json();
    ok('a real action runs and reports what it did',
      ran.status === 200 && ranBody.ok === true && typeof ranBody.result === 'string',
      JSON.stringify(ranBody));

    // The cooldown is what stops "re-check every feed" from being a button that
    // hammers WBAI. Asserted by effect: the same action immediately again.
    const again = await act({ action: 'archive' }, authedCsrf);
    const againBody = await again.json();
    ok('the same action immediately again is refused with a wait',
      again.status === 429 && againBody.retryInSec > 0,
      `status ${again.status} ${JSON.stringify(againBody)}`);

    // -- usage counters (phase 5) --------------------------------------------
    //
    // The ingest route is public and answers 204 to everything, so its
    // behaviour has to be read from what the counters do, never from a status.
    const usageNone = await get(PORT_ON, '/api/studio/usage');
    ok('no cookie: usage is 401', usageNone.status === 401, `status ${usageNone.status}`);

    const beacon = (b) => post(PORT_ON, '/api/ev', b);
    ok('a valid beacon is accepted with no body',
      (await beacon({ t: 'pageview' })).status === 204);
    ok('garbage and unknown event types are dropped, not errors',
      (await beacon({ t: 'nonsense' })).status === 204
      && (await beacon({})).status === 204
      && (await fetch(`http://127.0.0.1:${PORT_ON}/api/ev`,
        { method: 'POST', body: 'not json' })).status === 204);

    await beacon({ t: 'play', u: 'a1' });          // resolvable in FIXTURE
    await beacon({ t: 'play', u: 'no-such-url' }); // not resolvable
    await beacon({ t: 'live' });
    await beacon({ t: 'share' });
    await beacon({ t: 'search', q: 'a listener typed this' });

    const usage = await (await get(PORT_ON, '/api/studio/usage', authed)).json();
    ok('counters reflect the beacons that were sent',
      usage.totals.plays === 2 && usage.totals.live === 1
      && usage.totals.shares === 1 && usage.totals.searches === 1
      && usage.totals.pageviews >= 1,
      JSON.stringify(usage.totals));

    // An unresolvable media URL is an unattributed play, never a guess.
    /* LISTENING TIME. A play is a click; seconds are whether anyone stayed, and
     * the two orders genuinely differ — a show people open and abandon must not
     * outrank one they sit through. `beta` is opened once and listened to for
     * ten minutes; `alpha` was opened once and barely played. */
    await beacon({ t: 'play', u: 'b1' });
    for (let i = 0; i < 10; i++) await beacon({ t: 'listen', u: 'b1', s: 60 });
    // alpha is opened repeatedly and abandoned each time. Without these extra
    // plays both shows have one play, the two orderings agree, and the test
    // cannot tell them apart — it would pass whichever key we sorted on.
    for (let i = 0; i < 3; i++) await beacon({ t: 'play', u: 'a2' });
    await beacon({ t: 'listen', u: 'a1', s: 5 });

    // The counter a station would quote publicly, so the ceiling matters.
    await beacon({ t: 'listen', u: 'a1', s: 99999 });
    await beacon({ t: 'listen', u: 'a1', s: -60 });
    await beacon({ t: 'listen', u: 'a1', s: 'lots' });

    const listened = await (await get(PORT_ON, '/api/studio/usage', authed)).json();
    ok('listening seconds are recorded per show',
      listened.totals.listenSeconds === 605,
      `expected 605 (10x60 + 5, junk rejected), got ${listened.totals.listenSeconds}`);

    const ranked = listened.topShows;
    ok('shows rank by time listened, not by plays',
      ranked[0].slug === 'beta' && ranked[0].plays < ranked[1].plays
      && ranked[0].seconds > ranked[1].seconds,
      JSON.stringify(ranked.map((r) => r.slug + ':' + r.plays + 'p/' + r.seconds + 's')));

    // A silent ceiling is the worst failure this counter has — it reads as a
    // quiet day. The number must be reported, not merely enforced.
    ok('the report says how many beacons the rate limit refused',
      typeof listened.droppedBeacons === 'number',
      String(listened.droppedBeacons));

    ok('an out-of-range duration is rejected rather than clamped in',
      (ranked.find((r) => r.slug === 'alpha') || {}).seconds === 5,
      JSON.stringify(ranked));

    // Per-show plays must reach the table, so a single show's figure is
    // reachable by filtering rather than only if it makes the top twelve.
    const withPlays = await (await get(PORT_ON, '/api/studio/stats', authed)).json();
    const alpha = withPlays.shows.find((s) => s.slug === 'alpha');
    const beta = withPlays.shows.find((s) => s.slug === 'beta');
    ok('every show row carries its own play count, zero included',
      alpha && alpha.plays === 4 && beta && beta.plays === 1,
      JSON.stringify(withPlays.shows.map((s) => s.slug + ':' + s.plays)));
    ok('every show row carries its own listening time',
      alpha && alpha.listened === 5 && beta && beta.listened === 600,
      JSON.stringify(withPlays.shows.map((s) => s.slug + ':' + s.listened)));

    ok('a play is attributed to a show only when the URL resolves',
      usage.topShows.length === 1 && usage.topShows[0].slug === 'alpha'
      && usage.topShows[0].plays === 1,
      JSON.stringify(usage.topShows));

    /* THE PRIVACY PROMISE, asserted rather than documented.
     *
     * Search terms are not collected. They were, briefly, behind a storage
     * threshold; that was removed on product grounds — an as-you-type filter
     * means people stop after two or three characters, so the terms were mostly
     * stems and not worth having.
     *
     * The promise is back to its strongest form, so the test is too: send a term
     * and require that it reaches neither the report nor the disk. `q` is sent
     * deliberately here — a stale cached client will keep sending it for a
     * while, and the server must ignore it rather than merely not ask for it. */
    const secret = 'zzq private query';
    await beacon({ t: 'search', q: secret });
    await beacon({ t: 'searchterm', q: secret });   // the removed event type
    const afterTerm = await (await get(PORT_ON, '/api/studio/usage', authed)).json();

    ok('a search still counts even when a stale client sends the words',
      afterTerm.totals.searches > usage.totals.searches,
      `${usage.totals.searches} → ${afterTerm.totals.searches}`);
    ok('the words never reach the report',
      JSON.stringify(afterTerm).indexOf(secret) < 0 && !afterTerm.terms,
      JSON.stringify(afterTerm).slice(0, 200));
    ok('the report states plainly that terms are not recorded',
      afterTerm.searchTermsRecorded === false);

    const statsDir = path.join(dataDirOf(on), 'stats');
    const onDisk = fs.existsSync(statsDir)
      ? fs.readdirSync(statsDir).map((f) => fs.readFileSync(path.join(statsDir, f), 'utf8')).join('')
      : '';
    ok('the words never reach the disk either',
      onDisk.indexOf(secret) < 0 && onDisk.indexOf('"terms"') < 0,
      onDisk.slice(0, 200));

    // The removed event type must be inert, not silently accepted.
    ok('the retired searchterm event does not count as a search',
      afterTerm.totals.searches === usage.totals.searches + 1,
      `expected exactly one more search, got ${afterTerm.totals.searches}`);

    ok('the usage report carries a day series, not just totals',
      Array.isArray(usage.days) && usage.days.length === 30
      && usage.days[usage.days.length - 1].plays === 2,
      `${usage.days.length} days`);

    // -- operational health (phase 3) ----------------------------------------
    const wantHealth = ['upstream', 'process'];
    ok('health carries the operational blocks',
      wantHealth.every((k) => k in data), JSON.stringify(Object.keys(data)));
    ok('feeds report names its problems rather than only counting them',
      Array.isArray(data.feeds.failures) && Array.isArray(data.feeds.stale)
      && typeof data.feeds.nextSweepInMs === 'number',
      JSON.stringify(Object.keys(data.feeds)));
    ok('process block reports uptime, memory and cache effectiveness',
      typeof data.process.uptimeSec === 'number' && data.process.rssMb > 0
      && data.process.caches.archive && data.process.caches.nowplaying,
      JSON.stringify(data.process).slice(0, 140));

    // A 404 must never be counted as a failure. 33 of the slugs the listing
    // advertises have no feed behind them, so probing them 404s by design —
    // folding that into an error count shows a permanently unhealthy upstream
    // and trains everyone to ignore the panel.
    ok('upstream counts 404 separately from failure',
      data.upstream.every((h) => typeof h.missing === 'number' && typeof h.fail === 'number'),
      JSON.stringify(data.upstream).slice(0, 160));

    // -- the stats endpoint ---------------------------------------------------
    const statsNoCookie = await get(PORT_ON, '/api/studio/stats');
    ok('no cookie: stats is 401', statsNoCookie.status === 401, `status ${statsNoCookie.status}`);

    const statsRes = await get(PORT_ON, '/api/studio/stats', authed);
    const stats = await statsRes.json();
    ok('with a session: stats returns data', statsRes.status === 200 && !!stats.totals,
      `status ${statsRes.status}`);

    const wantStats = ['generated', 'window', 'totals', 'thinnest', 'episodeSpread',
      'categories', 'perDay', 'durations', 'coverage', 'shows'];
    const missingStats = wantStats.filter((k) => !(k in stats));
    ok('stats carries every block the dashboard renders', missingStats.length === 0,
      `missing: ${missingStats.join(', ')}`);

    // The histogram's whole claim is that it shows empty days. If the server
    // emitted only the days that have episodes, the chart would silently close
    // the gaps up and read as a continuous schedule.
    const spanDays = stats.window.newest && stats.window.oldest
      ? Math.round((stats.window.newest - stats.window.oldest) / 86400) + 1 : 0;
    ok('perDay covers the whole window, not just populated days',
      stats.perDay.length === spanDays && spanDays === 5,
      `perDay ${stats.perDay.length} vs span ${spanDays}`);
    ok('perDay reports the fixture\'s deliberate 2-day hole as zeros',
      stats.perDay.filter((d) => d.episodes === 0).length === 2,
      JSON.stringify(stats.perDay));
    ok('perDay counts are right where the fixture has episodes',
      stats.perDay[0].episodes === 1 && stats.perDay[4].episodes === 2,
      JSON.stringify(stats.perDay.map((d) => d.episodes)));

    // `thinnest` is ascending on purpose — a descending list is a 12-way tie at
    // the episode cap and tells the reader nothing. If someone "fixes" it to a
    // top-N later, this fails and points at the comment explaining why.
    const asc = stats.thinnest.every((s, i, a) => i === 0 || a[i - 1].seconds <= s.seconds);
    ok('thinnest is ascending and excludes empty feeds',
      asc && stats.thinnest.every((s) => s.episodes > 0),
      JSON.stringify(stats.thinnest.map((s) => s.episodes)));

    ok('coverage ratios never exceed their denominators',
      stats.coverage.withDescription <= stats.coverage.feeds
      && stats.coverage.withDirectory <= stats.coverage.feeds
      && stats.coverage.withDirectory <= stats.coverage.directoryPrograms,
      JSON.stringify(stats.coverage).slice(0, 120));

    // Duration buckets must account for every episode exactly once; a bug here
    // silently invents or loses episodes and nothing else would notice.
    const bucketed = stats.durations.reduce((n, b) => n + b.episodes, 0);
    ok('every episode lands in exactly one duration bucket',
      bucketed + stats.totals.unknownDuration === stats.totals.episodes,
      `${bucketed} + ${stats.totals.unknownDuration} vs ${stats.totals.episodes}`);

    const dash = await get(PORT_ON, '/studio', authed);
    const dashHtml = await dash.text();
    ok('with a session: /studio serves the dashboard, not the login page',
      dashHtml.includes('storageFacts') && !dashHtml.includes('loginForm'),
      `status ${dash.status}`);

    // -- forged and stale sessions ------------------------------------------
    const forged = session.slice(0, -1) + (session.endsWith('A') ? 'B' : 'A');
    const forgedRes = await get(PORT_ON, '/api/studio/health', { Cookie: forged });
    ok('tampered signature: 401', forgedRes.status === 401, `status ${forgedRes.status}`);

    const expired = await get(PORT_ON, '/api/studio/health',
      { Cookie: `studio=${sign(Date.now() - 1000, PASSWORD)}` });
    ok('correctly signed but expired: 401', expired.status === 401, `status ${expired.status}`);

    const wrongKey = await get(PORT_ON, '/api/studio/health',
      { Cookie: `studio=${sign(Date.now() + 60000, 'some-other-password')}` });
    ok('signed with the wrong secret: 401', wrongKey.status === 401, `status ${wrongKey.status}`);

    const noSig = await get(PORT_ON, '/api/studio/health',
      { Cookie: `studio=${Date.now() + 60000}` });
    ok('unsigned session id: 401', noSig.status === 401, `status ${noSig.status}`);

    // -- the probe's own self-test ------------------------------------------
    //
    // Everything above asserts a refusal. If the health endpoint answered 401
    // for an unrelated reason — a typo in the route, a handler that throws —
    // every one of those assertions would still pass while proving nothing. The
    // pairing is what rules that out: the SAME request, with a valid session,
    // must succeed. `stillWorks` below and the four forged-cookie refusals
    // above are one measurement, not five.
    const stillWorks = await get(PORT_ON, '/api/studio/health', authed);
    ok('self-test: the same request succeeds with a valid session',
      stillWorks.status === 200, `status ${stillWorks.status}`);

    const bye = await post(PORT_ON, '/api/studio/logout', undefined, authed);
    const cleared = bye.headers.get('set-cookie') || '';
    ok('logout clears the cookie', /Max-Age=0/.test(cleared), cleared);

    // A KNOWN AND ACCEPTED LIMITATION, pinned here so it is a decision rather
    // than a surprise. Sessions are stateless — a signed cookie, no server-side
    // store (deliberately: see server.js, and CLAUDE.md §4 on why this app
    // cannot rely on storage). Sign-out therefore clears the *browser's* copy;
    // it cannot invalidate a cookie value someone already copied off the
    // device. That value stays good until it expires.
    //
    // The mitigations are real: HttpOnly puts it out of reach of scripts,
    // SameSite=Strict of other sites, Secure of the network — so obtaining it
    // means having the device. And rotating STUDIO_PASSWORD kills every live
    // session at once, which is the documented revocation path.
    //
    // If this test ever fails, someone has added server-side session state.
    // That is not a regression — but it changes the design, so make it
    // deliberate and update this block.
    const replayed = await get(PORT_ON, '/api/studio/health', authed);
    ok('documented: a copied cookie still works after sign-out (stateless sessions)',
      replayed.status === 200, `status ${replayed.status}`);

    // -- rate limiting -------------------------------------------------------
    //
    // Asserted by its effect (a Retry-After appears), not by reading a counter.
    let retryAfter = null;
    for (let i = 0; i < 8 && !retryAfter; i++) {
      const r = await post(PORT_ON, '/api/studio/login', { password: 'nope-' + i });
      retryAfter = r.headers.get('retry-after');
    }
    ok('repeated wrong passwords start returning Retry-After',
      retryAfter !== null && Number(retryAfter) > 0, `retry-after=${retryAfter}`);

    const lockedOut = await post(PORT_ON, '/api/studio/login', { password: PASSWORD });
    ok('while rate limited, even the CORRECT password is refused',
      lockedOut.status === 401, `status ${lockedOut.status}`);
    ok('rate-limited response is indistinguishable in status from a wrong one',
      lockedOut.status === badPw.status, `${lockedOut.status} vs ${badPw.status}`);

    // -- method surface ------------------------------------------------------
    const put = await fetch(`http://127.0.0.1:${PORT_ON}/api/studio/login`, { method: 'PUT' });
    ok('PUT is still refused: only POST was opened', put.status === 405, `status ${put.status}`);
    const postElsewhere = await post(PORT_ON, '/api/archive', {});
    ok('POST to a non-studio route is still 405', postElsewhere.status === 405,
      `status ${postElsewhere.status}`);
  } finally {
    on.kill('SIGKILL');
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
