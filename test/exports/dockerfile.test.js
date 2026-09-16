'use strict';
// Every local file server.js requires must be copied into the image.
//
// The Dockerfile copies named paths, never `COPY . .` (the storage guard
// refuses a bulk copy, so live data/ can never be baked in). The cost of that
// rule is that a new directory is invisible to the image until someone adds a
// line — and `require('./lib/...')` with no `COPY lib` passes every local test
// and crashes the container at boot. The exports port added lib/; this is the
// test that would have caught forgetting it.
//
//   node test/exports/dockerfile.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

/** Local require() targets of a file, followed through the files they require. */
function localRequires(entry) {
  const seen = new Set();
  (function walk(file) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
      const rel = path.relative(root, target);
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (target.endsWith('.js') && fs.existsSync(target)) walk(target);
    }
  })(path.join(root, entry));
  return [...seen];
}

/** Paths a Dockerfile's COPY lines bring in from the build context. */
function copiedPaths(dockerfile) {
  const out = [];
  for (const line of dockerfile.split('\n')) {
    const m = line.match(/^\s*COPY\s+(?!--from)(.+)$/);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/).filter((p) => !p.startsWith('--'));
    parts.pop();   // the destination
    out.push(...parts.map((p) => p.replace(/^\.\//, '').replace(/\/$/, '')));
  }
  return out;
}

const covered = (rel, copied) => copied.some((c) => c === '.' || rel === c || rel.startsWith(c + '/'));

test('every local module server.js loads is copied into the image', () => {
  const needed = localRequires('server.js');
  assert.ok(needed.some((r) => r.startsWith('lib/')), 'the probe sees server.js\'s lib/ requires');
  const copied = copiedPaths(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'));
  for (const rel of needed) assert.ok(covered(rel, copied), `${rel} is required by server.js but no COPY line brings it into the image`);
});

test('self-test: the check fails when a required directory is not copied', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const without = dockerfile.split('\n').filter((l) => !/^\s*COPY\s+lib\b/.test(l)).join('\n');
  assert.notEqual(without, dockerfile, 'the Dockerfile has a COPY lib line to remove');
  const copied = copiedPaths(without);
  assert.ok(localRequires('server.js').some((rel) => !covered(rel, copied)), 'removing COPY lib is noticed');
});
