#!/usr/bin/env node
/**
 * feeds.json is the only copy of the station's older listings. This asserts what
 * happens to it when it will not parse.
 *
 * Runs REAL server processes against throwaway DATA_DIRs and then looks at the
 * disk, because the property that matters is "the bytes still exist somewhere",
 * and no amount of reading server.js can establish that. Section 3a of
 * CLAUDE.md, applied to the one file we cannot re-fetch.
 *
 * The three cases that matter, and they are genuinely different:
 *   1. absent      -> a first boot. Start empty, touch nothing, no quarantine.
 *   2. unparseable -> move the bytes aside, keep serving, say so in /healthz.
 *   3. healthy     -> load it, and above all DO NOT quarantine a good file.
 *
 * (3) is the one that would hurt most if the guard were overzealous: a false
 * positive here renames a working store on every boot.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, what, detail) {
  (cond ? pass++ : fail++);
  console.log((cond ? 'ok    ' : 'FAIL  ') + what + (detail !== undefined ? `  ${detail}` : ''));
}

let portSeq = 8140;

// Boot a server on its own DATA_DIR, read /healthz, shut it down politely.
async function boot(dataDir) {
  const port = portSeq++;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: dataDir,
      STUDIO_PASSWORD: '', USAGE_TRACKING: 'off', NODE_ENV: 'production',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  let health = null;
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) { health = await r.json(); break; }
    } catch (e) { /* not up yet */ }
  }
  child.kill('SIGTERM');
  await sleep(400);
  if (!child.killed) child.kill('SIGKILL');
  return { health, log };
}

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wbai-${name}-`));
  return d;
}
function corruptNames(dir) {
  return fs.readdirSync(dir).filter(f => /^feeds\.json\.corrupt-/.test(f));
}

(async () => {
  console.log('#### 1. absent feeds.json is a first boot, not an incident');
  {
    const dir = tmpDir('absent');
    const { health } = await boot(dir);
    ok(!!health, 'server came up');
    ok(Array.isArray(health.storage.quarantined) && health.storage.quarantined.length === 0,
       'nothing was quarantined', JSON.stringify(health.storage.quarantined));
    ok(corruptNames(dir).length === 0, 'no .corrupt file was created');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n#### 2. a healthy feeds.json is loaded and LEFT ALONE');
  {
    const dir = tmpDir('healthy');
    const good = { someshow: { lastModified: null, fetchedAt: Date.now(), channel: {}, items: [] } };
    fs.writeFileSync(path.join(dir, 'feeds.json'), JSON.stringify(good));
    const { health } = await boot(dir);
    ok(!!health, 'server came up');
    ok(health.storage.quarantined.length === 0,
       'a VALID file is never quarantined (a false positive here renames a working store)',
       JSON.stringify(health.storage.quarantined));
    ok(corruptNames(dir).length === 0, 'no .corrupt file was created');
    ok(fs.existsSync(path.join(dir, 'feeds.json')), 'and the original is still where it was');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n#### 3. an unparseable feeds.json is MOVED ASIDE, not discarded');
  {
    const dir = tmpDir('corrupt');
    // What a crash mid-write actually leaves: valid-looking bytes, truncated.
    const truncated = JSON.stringify({ show: { items: [{ mp3: 'a.mp3' }, { mp3: 'b.mp3' }] } }).slice(0, -12);
    fs.writeFileSync(path.join(dir, 'feeds.json'), truncated);
    const { health, log } = await boot(dir);

    ok(!!health, 'the server still came up (quarantine must not be an outage)');
    const q = health.storage.quarantined;
    ok(q.length === 1 && q[0].file === 'feeds.json',
       '/healthz reports the quarantine', JSON.stringify(q));
    ok(q[0].movedTo && /^feeds\.json\.corrupt-/.test(q[0].movedTo),
       '...and names where the bytes went', q[0] && q[0].movedTo);

    const kept = corruptNames(dir);
    ok(kept.length === 1, 'exactly one quarantined copy exists on disk', kept.join(','));
    // THE point of the whole exercise: the bytes survived.
    ok(kept.length === 1 && fs.readFileSync(path.join(dir, kept[0]), 'utf8') === truncated,
       'the quarantined file is byte-for-byte what was there before');
    ok(!fs.existsSync(path.join(dir, 'feeds.json')) ||
       fs.readFileSync(path.join(dir, 'feeds.json'), 'utf8') !== truncated,
       'the corrupt bytes are no longer sitting at feeds.json waiting to be overwritten');
    ok(/UNREADABLE/.test(log), 'and it is loud in the log, not a console.warn nobody reads');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n#### 4. self-test: the probe can tell the two apart');
  {
    // If `boot()` silently failed, every "nothing was quarantined" above would
    // pass for the wrong reason. Prove a corrupt file really does move the
    // needle that the healthy case asserts is still.
    const dir = tmpDir('selftest');
    fs.writeFileSync(path.join(dir, 'feeds.json'), '{"a":');
    const { health } = await boot(dir);
    ok(health && health.storage.quarantined.length === 1,
       'a deliberately broken file DOES produce a finding, so the clean cases mean something');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
