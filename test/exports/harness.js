'use strict';
// Shared by the export and backup suites: an RFC 4180 parser independent of the
// writer under test, and a real server booted offline on a seeded data dir.
//
// Offline means: nothing here calls /api/archive or /api/nowplaying (those
// reach WBAI), programs.json is seeded fresh so the boot-time directory refresh
// does not fire, and SEED_PATH points nowhere so the image's show records do
// not mix into the fixture's.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RFC 4180 parser. Strips the BOM, and insists on it. */
function parseCsv(text) {
  assert.equal(text.charCodeAt(0), 0xFEFF, 'CSV starts with a BOM');
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else if (c === '\n') throw new Error('bare LF outside quotes at ' + i);
    else cell += c;
  }
  assert.equal(cell + row.join(''), '', 'file ends with CRLF');
  const [head, ...body] = rows;
  return { head, rows: body.map((r) => { assert.equal(r.length, head.length, 'row width'); return Object.fromEntries(head.map((h, j) => [h, r[j]])); }) };
}

/** Response bytes as sent. Response.text() would silently strip the BOM. */
const bytes = async (r) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());

async function freePort() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r)); return port;
}

/** Write a data dir: { 'feeds.json': obj, 'stats/2020-02.json': obj, ... }. */
function seedDataDir(dir, files) {
  fs.mkdirSync(path.join(dir, 'stats'), { recursive: true });
  const all = { 'programs.json': { updated: Date.now(), programs: {} }, ...files };
  for (const [name, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
}

/**
 * Every file under a directory: its bytes, inode and mtime. Bytes alone cannot
 * see a write that puts back identical content — a planted "the preview writes
 * feeds.json" passed a bytes-only snapshot, because the store it wrote was the
 * one already on disk. writeJsonAtomic renames a temp file into place, so any
 * write changes the inode.
 */
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${st.ino}:${st.mtimeMs}:${fs.readFileSync(p).toString('base64')}`;
    }
  })(dir);
  return out;
}

/** Boot server.js on `dataDir`, sign in, and hand back request helpers. */
async function boot(t, dataDir, password = 'test-studio-password') {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, STUDIO_PASSWORD: password,
    SEED_PATH: path.join(dataDir, 'no-seed.json') };
  for (const k of ['STATION_ID', 'STATION_TZ', 'USAGE_TRACKING', 'FEEDS_PATH', 'SHOWINFO_PATH', 'PROGRAMS_PATH',
    'PHOTOMAP_PATH', 'KNOWN_SLUGS_PATH', 'STUDIO_SECRET']) delete env[k];
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (x) => { logs += x; }); child.stderr.on('data', (x) => { logs += x; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); } });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    if (child.exitCode !== null) throw new Error('server exited: ' + logs);
    try { up = (await fetch(url + '/healthz')).ok; } catch { /* not listening yet */ }
    if (!up) await sleep(30);
  }
  assert.ok(up, 'server ready: ' + logs);
  const login = await fetch(url + '/api/studio/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200, 'login');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await (await fetch(url + '/api/studio/health', { headers: { Cookie: cookie } })).json()).csrf;
  return {
    url, dataDir, logs: () => logs,
    get: (p) => fetch(url + p, { headers: { Cookie: cookie }, redirect: 'manual' }),
    post: (p, body, headers = {}) => fetch(url + p, { method: 'POST', body,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Studio-CSRF': csrf, ...headers } }),
    beacon: (b) => fetch(url + '/api/ev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
  };
}

module.exports = { root, sleep, parseCsv, bytes, seedDataDir, snapshot, boot };
