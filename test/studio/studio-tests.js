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

function startServer(port, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-studio-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
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
  const on = startServer(PORT_ON, { STUDIO_PASSWORD: PASSWORD });
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
    ok('/healthz and the studio report identical storage keys',
      JSON.stringify(Object.keys(publicStorage).sort())
      === JSON.stringify(Object.keys(data.storage).sort()),
      `${Object.keys(publicStorage).sort()} vs ${Object.keys(data.storage).sort()}`);
    ok('health is uncacheable and varies on the cookie',
      /no-store/.test(health.headers.get('cache-control') || '')
      && /cookie/i.test(health.headers.get('vary') || ''),
      `cache-control=${health.headers.get('cache-control')}`);

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
