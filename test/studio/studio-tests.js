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
const PORT_OLD = 8125;
const PORT_ROLL = 8126;
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

/**
 * A stats file written by an EARLIER build — counters that existed then, and
 * none of the ones added later.
 *
 * This shipped and broke production silently: `day.listenSeconds += 30` on a
 * record with no such key evaluates `undefined + 30` → NaN, JSON writes `null`,
 * and the report's `|| 0` renders a confident zero. Plays kept working because
 * their key existed, so the symptom was "one metric works and the new one
 * doesn't" with no error anywhere.
 */
function legacyStats() {
  const month = new Date().toISOString().slice(0, 7);
  const day = new Date().toISOString().slice(0, 10);
  return {
    station: 'wbai',
    month,
    days: { [day]: { pageviews: 40, plays: 6, live: 2, searches: 3, shares: 1, byShow: { alpha: 6 } } },
  };
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
  // STATION_TZ is pinned rather than inherited: the reach tests below assert
  // which zone counts as "local", and that must not depend on the timezone of
  // whatever machine is running the suite.
  const on = startServer(PORT_ON,
    { STUDIO_PASSWORD: PASSWORD, STATION_TZ: 'America/New_York' }, FIXTURE);
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

    /* REACH — the one visitor attribute collected, and the promise around it.
     *
     * A page view carries the browser's IANA timezone. The whole privacy claim
     * rests on it being bucketed at ingest and discarded, so the fine-grained
     * string exists only long enough to be classified: what may reach a file is
     * `{ local: 41 }` and never `America/New_York`.
     *
     * That is an assertion of ABSENCE, which CLAUDE.md §3a warns is exactly the
     * kind that keeps passing after the probe goes blind — a bucketer that threw
     * away the event entirely would satisfy "the string is not on disk"
     * perfectly. So each absence check below is paired with a count that MUST
     * have moved, which fails if the beacons stopped arriving. */
    const reachBefore = (await (await get(PORT_ON, '/api/studio/usage', authed)).json()).reach;
    const zoneSecret = 'Australia/Broken_Hill';   // distinctive; greppable
    await beacon({ t: 'pageview', z: 'America/New_York' });   // == STATION_TZ → local
    await beacon({ t: 'pageview', z: 'America/Chicago' });    // → national
    await beacon({ t: 'pageview', z: 'America/Sao_Paulo' });  // NOT US, despite America/
    await beacon({ t: 'pageview', z: zoneSecret });           // → intl
    await beacon({ t: 'pageview' });                          // stale client → unknown
    await beacon({ t: 'pageview', z: '<script>x</script>' }); // junk → unknown, never a key
    const reach = (await (await get(PORT_ON, '/api/studio/usage', authed)).json()).reach;
    const grew = (k) => {
      const now = reach.buckets.find((x) => x.key === k).count;
      const was = reachBefore.buckets.find((x) => x.key === k).count;
      return now - was;
    };

    ok('the station\'s own timezone counts as local',
      grew('local') === 1, `local grew by ${grew('local')}`);
    ok('another US zone counts as national, not local',
      grew('national') === 1, `national grew by ${grew('national')}`);
    // The America/ prefix is a trap: Sao_Paulo is not the United States. Both
    // it and the Australian zone must land in intl, so +2 proves the prefix is
    // not being used as the test for "US".
    ok('America/Sao_Paulo is international, not US',
      grew('intl') === 2, `intl grew by ${grew('intl')}`);
    ok('a client that sends no zone, and a junk zone, both count as unknown',
      grew('unknown') === 2, `unknown grew by ${grew('unknown')}`);
    ok('the label names the timezone, never a city',
      reach.buckets.find((x) => x.key === 'local').label === 'America/New_York'
      && reach.stationTz === 'America/New_York',
      JSON.stringify(reach.buckets.map((b) => b.label)));

    // The absence checks, each backed by a count above that had to move.
    ok('the raw timezone never reaches the report',
      JSON.stringify(reach).indexOf(zoneSecret) < 0,
      JSON.stringify(reach).slice(0, 200));
    ok('a junk zone never becomes a bucket key',
      reach.buckets.every((b) => ['local', 'national', 'intl', 'unknown'].indexOf(b.key) >= 0)
      && JSON.stringify(reach).indexOf('script') < 0,
      JSON.stringify(reach.buckets.map((b) => b.key)));

    /* The disk. Polled rather than slept on, because the counters are written
     * behind a 5s debounce — and the poll waits for `byZone` to APPEAR, which
     * is what stops this from being the vacuous "nothing was written yet, so
     * the secret is not in it" pass. */
    let zoneDisk = '';
    for (let i = 0; i < 80; i++) {
      const dir = path.join(dataDirOf(on), 'stats');
      zoneDisk = fs.existsSync(dir)
        ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
        : '';
      if (zoneDisk.indexOf('byZone') >= 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    ok('self-test: the buckets really did reach the disk (so the check below can see)',
      zoneDisk.indexOf('byZone') >= 0 && /"local":\s*\d+/.test(zoneDisk),
      zoneDisk.slice(0, 200));
    ok('the raw timezone never reaches the disk either',
      zoneDisk.indexOf(zoneSecret) < 0 && zoneDisk.indexOf('Sao_Paulo') < 0
      && zoneDisk.indexOf('America/') < 0,
      zoneDisk.slice(0, 300));

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

  // ------------------------------------------------- upgrading an older file
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-legacy-'));
  fs.writeFileSync(path.join(dataDir, 'feeds.json'), JSON.stringify(FIXTURE));
  fs.mkdirSync(path.join(dataDir, 'stats'), { recursive: true });
  const legacy = legacyStats();
  fs.writeFileSync(path.join(dataDir, 'stats', `${legacy.month}.json`), JSON.stringify(legacy));

  const upg = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env,
      { PORT: String(PORT_OLD), DATA_DIR: dataDir, STUDIO_PASSWORD: PASSWORD }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  upg.stdout.on('data', () => {});
  upg.stderr.on('data', () => {});
  try {
    await waitReady(PORT_OLD);
    const login2 = await post(PORT_OLD, '/api/studio/login', { password: PASSWORD });
    const cookie2 = { Cookie: (login2.headers.get('set-cookie') || '').split(';')[0] };

    await post(PORT_OLD, '/api/ev', { t: 'listen', u: 'a1', s: 30 });
    await post(PORT_OLD, '/api/ev', { t: 'listen', u: 'a1', s: 30 });
    await post(PORT_OLD, '/api/ev', { t: 'play', u: 'a1' });

    const u2 = await (await get(PORT_OLD, '/api/studio/usage', cookie2)).json();
    ok('a stats file from an older build still records listening time',
      u2.totals.listenSeconds === 60,
      `expected 60, got ${u2.totals.listenSeconds} (NaN here means the backfill regressed)`);
    ok('and its existing counters survive the upgrade',
      u2.totals.plays === 7 && u2.totals.pageviews === 40,
      `plays ${u2.totals.plays} (6 + 1), pageviews ${u2.totals.pageviews}`);
  } finally {
    upg.kill('SIGKILL');
  }

  // ------------------------------------------------ surviving a month rollover
  /**
   * The per-show numbers must survive 00:00 UTC on the 1st. They did not.
   *
   * `topShows` and the table's plays/listened columns all iterated
   * `statsStore.days` — one *calendar* month, replaced with an empty object at
   * the rollover — while the day chart beside them already read the month files
   * and carried on regardless. So at midnight UTC on 2026-08-01 the ranking
   * emptied and every per-show figure read zero, with nothing logged, no error,
   * and every other number on the page healthy. Only the shape of the failure
   * ("all the show data at once, on the 1st") pointed anywhere.
   *
   * The window is 30 rolling days, so it reaches into the previous month's file
   * on every day of the month except the 30th and 31st — on those two the whole
   * window genuinely fits inside one month and there is nothing cross-month to
   * assert. Seed a day in the previous month, add a current-month day live, and
   * require the total to include both: a probe that stops seeing either half
   * fails rather than passing quietly.
   */
  const rollDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-rollover-'));
  fs.writeFileSync(path.join(rollDir, 'feeds.json'), JSON.stringify(FIXTURE));
  fs.mkdirSync(path.join(rollDir, 'stats'), { recursive: true });

  const nowUTC = new Date();
  const firstOfMonth = Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), 1);
  const prevLastMs = firstOfMonth - 86400000;
  const prevLast = new Date(prevLastMs).toISOString().slice(0, 10);
  const todayMs = Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate());
  const prevInWindow = Math.round((todayMs - prevLastMs) / 86400000) <= 29;

  fs.writeFileSync(path.join(rollDir, 'stats', `${prevLast.slice(0, 7)}.json`), JSON.stringify({
    station: 'wbai',
    month: prevLast.slice(0, 7),
    days: {
      [prevLast]: {
        pageviews: 5, plays: 2, live: 0, searches: 0, shares: 0,
        listenSeconds: 120, liveSeconds: 0,
        byShow: { alpha: 2 }, secondsByShow: { alpha: 120 },
      },
    },
  }));

  const roll = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env,
      { PORT: String(PORT_ROLL), DATA_DIR: rollDir, STUDIO_PASSWORD: PASSWORD }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  roll.stdout.on('data', () => {});
  roll.stderr.on('data', (d) => process.stderr.write(`[server:${PORT_ROLL}] ${d}`));
  try {
    await waitReady(PORT_ROLL);
    const login3 = await post(PORT_ROLL, '/api/studio/login', { password: PASSWORD });
    const cookie3 = { Cookie: (login3.headers.get('set-cookie') || '').split(';')[0] };

    await post(PORT_ROLL, '/api/ev', { t: 'play', u: 'a1' });
    await post(PORT_ROLL, '/api/ev', { t: 'listen', u: 'a1', s: 30 });

    // What the numbers must be if BOTH months are in view, and what the bug
    // produced: the current month alone.
    const wantPlays = prevInWindow ? 3 : 1;
    const wantSecs = prevInWindow ? 150 : 30;
    const both = prevInWindow ? ' across a month boundary' : ' (window is inside one month today)';

    const u3 = await (await get(PORT_ROLL, '/api/studio/usage', cookie3)).json();
    const top = (u3.topShows || []).find((s) => s.slug === 'alpha');
    ok(`top shows sum the whole 30-day window${both}`,
      top && top.plays === wantPlays && top.seconds === wantSecs,
      `expected ${wantPlays}p/${wantSecs}s, got ${JSON.stringify(top)}`);

    const s3 = await (await get(PORT_ROLL, '/api/studio/stats', cookie3)).json();
    const rowA = (s3.shows || []).find((s) => s.slug === 'alpha');
    ok(`the per-show columns sum the whole 30-day window${both}`,
      rowA && rowA.plays === wantPlays && rowA.listened === wantSecs,
      `expected ${wantPlays}p/${wantSecs}s, got ${JSON.stringify(rowA)}`);

    // The day series already read the month files; assert it still agrees with
    // the aggregates above, so the two can't drift apart again.
    const prevRow = (u3.days || []).find((d) => d.day === prevLast);
    ok('the day series and the per-show totals cover the same window',
      prevInWindow ? (prevRow && prevRow.listenSeconds === 120) : !prevRow,
      `${prevLast}: ${JSON.stringify(prevRow)}`);

    // -- selectable windows ---------------------------------------------------
    //
    // The same two seeded months are the ground truth for every window. `all`
    // must always see both; a 7-day window must see the previous month's day
    // only when today is close enough to the boundary — computed, not assumed,
    // for the same reason prevInWindow is.
    const uAll = await (await get(PORT_ROLL, '/api/studio/usage?days=all', cookie3)).json();
    const topAll = (uAll.topShows || []).find((s) => s.slug === 'alpha');
    ok('days=all reaches back to the oldest month file',
      topAll && topAll.plays === 3 && topAll.seconds === 150
      && uAll.windowDays >= 30,
      `windowDays ${uAll.windowDays}, got ${JSON.stringify(topAll)}`);

    const prevIn7 = Math.round((todayMs - prevLastMs) / 86400000) <= 6;
    const u7 = await (await get(PORT_ROLL, '/api/studio/usage?days=7', cookie3)).json();
    const top7 = (u7.topShows || []).find((s) => s.slug === 'alpha');
    ok('days=7 narrows the window and says so',
      u7.windowDays === 7 && u7.days.length === 7
      && top7 && top7.plays === (prevIn7 ? 3 : 1),
      `windowDays ${u7.windowDays}, ${u7.days.length} days, ${JSON.stringify(top7)}`);

    ok('an off-menu window falls back to 30 rather than being obeyed',
      (await (await get(PORT_ROLL, '/api/studio/usage?days=99999', cookie3)).json())
        .windowDays === 30);

    const sAll = await (await get(PORT_ROLL, '/api/studio/stats?days=all', cookie3)).json();
    const rowAll = (sAll.shows || []).find((s) => s.slug === 'alpha');
    ok('the table columns follow the requested window too',
      sAll.usageWindowDays >= 30 && rowAll
      && rowAll.plays === 3 && rowAll.listened === 150,
      `usageWindowDays ${sAll.usageWindowDays}, got ${JSON.stringify(rowAll)}`);

    // -- per-show history -------------------------------------------------------
    const histNone = await get(PORT_ROLL, '/api/studio/showhistory?slug=alpha');
    ok('no cookie: show history is 401', histNone.status === 401, `status ${histNone.status}`);
    ok('a junk slug is refused, not summed',
      (await get(PORT_ROLL, '/api/studio/showhistory?slug=..%2F..%2Fetc', cookie3)).status === 400);

    const hist = await (await get(PORT_ROLL, '/api/studio/showhistory?slug=alpha', cookie3)).json();
    const hPrev = (hist.months || []).find((m) => m.month === prevLast.slice(0, 7));
    const hNow = (hist.months || [])[hist.months.length - 1];
    ok('show history returns every recorded month with its totals',
      hPrev && hPrev.plays === 2 && hPrev.seconds === 120
      && hNow && hNow.plays === 1 && hNow.seconds === 30,
      JSON.stringify(hist.months));

    // -- month vs month ---------------------------------------------------------
    const cmpNone = await get(PORT_ROLL, '/api/studio/months');
    ok('no cookie: month comparison is 401', cmpNone.status === 401, `status ${cmpNone.status}`);
    const cmp = await (await get(PORT_ROLL, '/api/studio/months', cookie3)).json();
    const cmpA = (cmp.shows || []).find((s) => s.slug === 'alpha');
    ok('month comparison holds both calendar months for the same show',
      cmp.prevMonth === prevLast.slice(0, 7)
      && cmpA && cmpA.prevPlays === 2 && cmpA.prevSeconds === 120
      && cmpA.plays === 1 && cmpA.seconds === 30,
      JSON.stringify(cmp));
  } finally {
    roll.kill('SIGKILL');
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
