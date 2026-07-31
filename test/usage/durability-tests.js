'use strict';

/**
 * Usage counters: does an event that was accepted actually reach the disk?
 *
 * This exists because of a bug that looked like everything except what it was.
 * The studio showed "On The Ground" with **4 minutes listened and 0 plays**
 * (2026-07-31). Nothing was wrong with attribution: the beacon was sent, the
 * server matched the mp3 to the slug, and `plays` was incremented — in memory,
 * where a 60-second write debounce then held it until the container went away.
 *
 * The reason it presented as an attribution bug is the asymmetry in CLAUDE.md's
 * terms: a play is ONE beacon that must survive the debounce, while listening
 * time is a stream that keeps re-sending itself into whatever process is alive.
 * A restart therefore deletes the play and barely dents the minutes, and the
 * table reads as though the two counters disagree about the same listen.
 *
 * So this suite does not ask "did /api/ev return 204" — it returned 204 the
 * whole time the numbers were wrong. It asks whether the counter is on disk
 * after the process is killed WITHOUT a chance to clean up, which is the only
 * version of the question production was asking.
 *
 * CLAUDE.md §3a, rule 5: the pass here is an assertion of presence, so its
 * self-test is the opposite one — section 1 kills a server before the debounce
 * can fire and REQUIRES the probe to see the play missing. If reading the stats
 * file ever stops reflecting when a flush happened, that check fails and this
 * whole suite stops being able to pass vacuously.
 *
 *   node test/usage/durability-tests.js
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT_FAST = 8126;   // killed after the debounce should have fired
const PORT_RACE = 8127;   // killed before it possibly could — the self-test
const PORT_TERM = 8128;   // stopped politely, inside the window
const ROOT = path.join(__dirname, '..', '..');

/**
 * Must exceed STATS_FLUSH_MS in server.js, and this test is where that ceiling
 * is enforced: raising the debounce past this without thinking reintroduces
 * exactly the production bug above, and section 2 will fail when it does.
 */
const AFTER_FLUSH_MS = 8000;

const MP3 = 'https://archive.example.test/mp3/alpha_ep1.mp3';
const FIXTURE = {
  alpha: {
    lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
    fetchedAt: Date.now(),
    channel: { title: 'Alpha Show' },
    items: [{ mp3: MP3, bytes: 1e6, title: 'ep1', dt: 1767225600, durationSec: 3600 }],
  },
};

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, dataDir) {
  fs.writeFileSync(path.join(dataDir, 'feeds.json'), JSON.stringify(FIXTURE));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: dataDir, STUDIO_PASSWORD: '',
    }),
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
    await sleep(100);
  }
  throw new Error(`server on :${port} never became ready`);
}

// Exactly what public/track.js sends, so a change to the beacon shape breaks
// this rather than passing against a payload only the test knows how to build.
const beacon = (port, payload) => fetch(`http://127.0.0.1:${port}/api/ev`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

/** Whatever the running process has actually committed, read from the file. */
function statsOnDisk(dataDir) {
  const month = new Date().toISOString().slice(0, 7);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dataDir, 'stats', `${month}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')).days || {})[day] || null;
  } catch (e) { return null; }
}

/** Wait for the process to be gone, so no flush can land after we read. */
function reap(child) {
  return new Promise((r) => { child.on('exit', () => setTimeout(r, 200)); });
}

async function run() {
  // -------------------------------------------------------------- 1. self-test
  //
  // Kill the server the instant the beacon is acknowledged. The play is real and
  // counted; it simply cannot have been written yet. If this sees a play, the
  // probe below is not measuring flushes at all and section 2 proves nothing.
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-usage-'));
    const s = startServer(PORT_RACE, dataDir);
    await waitReady(PORT_RACE);
    const res = await beacon(PORT_RACE, { t: 'play', u: MP3 });
    ok('self-test: the play beacon is accepted', res.status === 204, `status ${res.status}`);
    s.kill('SIGKILL');
    await reap(s);
    const rec = statsOnDisk(dataDir);
    ok('self-test: killed inside the window, the play is NOT on disk',
      !rec || rec.plays === 0,
      `the probe cannot distinguish flushed from unflushed: ${JSON.stringify(rec)}`);
  }

  // ------------------------------------------------------- 2. the actual bug
  //
  // Same kill, given the debounce time to fire first. This is the production
  // failure: the container is replaced, and the counter must already be safe.
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-usage-'));
    const s = startServer(PORT_FAST, dataDir);
    await waitReady(PORT_FAST);
    await beacon(PORT_FAST, { t: 'play', u: MP3 });
    await beacon(PORT_FAST, { t: 'listen', u: MP3, s: 30 });
    await sleep(AFTER_FLUSH_MS);
    s.kill('SIGKILL');           // no SIGTERM: nothing gets to clean up
    await reap(s);

    const rec = statsOnDisk(dataDir);
    ok('a play survives a hard kill after the flush window',
      !!rec && rec.plays === 1, JSON.stringify(rec));
    ok('and it is still attributed to its show',
      !!rec && rec.byShow && rec.byShow.alpha === 1, JSON.stringify(rec && rec.byShow));

    // The pairing that names the bug: listening time healed itself in production
    // because it keeps re-sending, so it must not be the only survivor here.
    ok('listened seconds and the play survive together, not one without the other',
      !!rec && rec.secondsByShow && rec.secondsByShow.alpha === 30 && rec.plays === 1,
      `plays=${rec && rec.plays} seconds=${JSON.stringify(rec && rec.secondsByShow)}`);
  }

  // ------------------------------------------------- 3. the graceful stop too
  //
  // flushOnExit is what a normal redeploy relies on, and it has to work INSIDE
  // the debounce — that is the whole reason it exists (server.js, flushOnExit).
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-usage-'));
    const s = startServer(PORT_TERM, dataDir);
    await waitReady(PORT_TERM);
    await beacon(PORT_TERM, { t: 'play', u: MP3 });
    s.kill('SIGTERM');
    await reap(s);
    const rec = statsOnDisk(dataDir);
    ok('SIGTERM flushes a play that the debounce had not written yet',
      !!rec && rec.plays === 1, JSON.stringify(rec));
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall usage durability tests passed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
