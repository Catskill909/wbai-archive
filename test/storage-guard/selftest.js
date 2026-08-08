#!/usr/bin/env node
/**
 * Self-test for tools/check-storage-safety.js.
 *
 * The guard's whole value is that it fails on a bad commit. A guard nobody has
 * ever SEEN fail is indistinguishable from a guard that cannot fail — and this
 * one is especially easy to break silently, because every rule is a regex and a
 * regex that stops matching still returns "no findings", which reads as a pass.
 * CLAUDE.md §3a, applied to the guard itself.
 *
 * So for every rule: feed it a repo that breaks that rule and REQUIRE the
 * finding, then feed it the real repo and require silence. Both directions, or
 * the test proves nothing.
 *
 * Entirely offline and in-memory — the reader is injected, so nothing is written
 * to disk and no git repo is needed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { check, RULES } = require('../../tools/check-storage-safety.js');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, what, detail) {
  (cond ? pass++ : fail++);
  console.log((cond ? 'ok    ' : 'FAIL  ') + what + (detail !== undefined ? `  ${detail}` : ''));
}

// A repo that is entirely healthy. Each case below breaks exactly one thing, so
// a finding can only come from the change under test.
const GOOD = {
  'Dockerfile': [
    'FROM node:24-alpine',
    'WORKDIR /app',
    '# There is deliberately no VOLUME instruction here — see the long note.',
    'COPY package.json ./',
    'COPY public ./public',
    'RUN mkdir -p /app/data && chown node:node /app/data',
    'CMD ["node", "server.js"]',
  ].join('\n'),
  'server.js': [
    "const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');",
    "const FEEDS_PATH = process.env.FEEDS_PATH || path.join(DATA_DIR, 'feeds.json');",
    "const SEED_PATH = process.env.SEED_PATH || path.join(__dirname, 'seed', 'showinfo.json');",
    'function save() { writeJsonSoon(FEEDS_PATH, () => feedStore); }',
  ].join('\n'),
  'docker-compose.yml': [
    'services:',
    '  app:',
    '    environment:',
    '      - DATA_DIR=/app/data',
    '    volumes:',
    '      - wbai-archive-data:/app/data',
  ].join('\n'),
  '.gitignore': 'node_modules\ndata/\n',
  '.dockerignore': '.git\ndata\n',
};

function readerFor(files) {
  return rel => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null);
}
function run(files, opts = {}) {
  return check(Object.assign({ read: readerFor(files), stagedPaths: [] }, opts));
}
function withFile(name, contents) {
  return Object.assign({}, GOOD, { [name]: contents });
}
function idsOf(findings) { return findings.map(f => f.rule); }

console.log('#### the healthy fixture is silent (or every case below is meaningless)');
{
  const f = run(GOOD);
  ok(f.length === 0, 'a correct repo produces no findings', idsOf(f).join(',') || '(none)');
}

console.log('\n#### each rule fires on the thing it exists to catch');

// 1. the historical bug: a VOLUME with no explicit mount
{
  const f = run(withFile('Dockerfile', GOOD['Dockerfile'] + '\nVOLUME ["/app/data"]\n'));
  ok(idsOf(f).includes('dockerfile-no-volume'), 'VOLUME ["/app/data"] is blocked');
  ok(f.some(x => x.rule === 'dockerfile-no-volume' && x.level === 'block'), '...and it BLOCKS, not warns');
}

// ...but not on prose about it. The real Dockerfile explains VOLUME at length.
{
  const f = run(withFile('Dockerfile',
    GOOD['Dockerfile'] + '\n# There is deliberately NO VOLUME ["/app/data"] here.\n'));
  ok(!idsOf(f).includes('dockerfile-no-volume'),
     'a COMMENT mentioning VOLUME does not fire — the real Dockerfile is full of them');
}

// 2. bulk COPY would bake local data/ into the image
{
  const f = run(withFile('Dockerfile', GOOD['Dockerfile'] + '\nCOPY . .\n'));
  ok(idsOf(f).includes('dockerfile-no-bulk-copy'), 'COPY . . is blocked');
}
{
  const f = run(withFile('Dockerfile', GOOD['Dockerfile'] + '\nADD . /app\n'));
  ok(idsOf(f).includes('dockerfile-no-bulk-copy'), 'ADD . /app is blocked too');
}
{
  // The named copies the real Dockerfile uses must stay legal.
  const f = run(withFile('Dockerfile', GOOD['Dockerfile'] + '\nCOPY admin ./admin\n'));
  ok(!idsOf(f).includes('dockerfile-no-bulk-copy'), 'a NAMED copy is fine');
}

// 3. deleting the data dir at build time
{
  const f = run(withFile('Dockerfile', GOOD['Dockerfile'] + '\nRUN rm -rf /app/data/*\n'));
  ok(idsOf(f).includes('dockerfile-no-data-removal'), 'RUN rm -rf /app/data is blocked');
}

// 4. DATA_DIR default drifting away from ./data
{
  const f = run(withFile('server.js',
    GOOD['server.js'].replace("path.join(__dirname, 'data')", "'/var/lib/wbai'")));
  ok(idsOf(f).includes('data-dir-default'), 'a hardcoded DATA_DIR default is blocked');
}
{
  const f = run(withFile('server.js',
    GOOD['server.js'].replace("path.join(__dirname, 'data')", "path.join(__dirname, 'cache')")));
  ok(idsOf(f).includes('data-dir-default'), 'renaming the default directory is blocked');
}
{
  const f = run(withFile('server.js', GOOD['server.js'].replace(/const DATA_DIR[^\n]*\n/, '')));
  ok(idsOf(f).includes('data-dir-default'), 'removing DATA_DIR entirely is blocked');
}

// 5. a seed under DATA_DIR would be shadowed by the mount
{
  const f = run(withFile('server.js',
    GOOD['server.js'].replace("path.join(__dirname, 'seed', 'showinfo.json')",
                              "path.join(DATA_DIR, 'seed.json')")));
  ok(idsOf(f).includes('seed-outside-data-dir'), 'a seed inside DATA_DIR is blocked');
}

// 6. raw / destructive writes to a persisted path
for (const [label, line] of [
  ['writeFileSync over the live file', 'fs.writeFileSync(FEEDS_PATH, JSON.stringify(feedStore));'],
  ['unlinkSync on a persisted file',   'fs.unlinkSync(SHOWINFO_PATH);'],
  ['rmSync on the data dir',           'fs.rmSync(DATA_DIR, { recursive: true });'],
]) {
  const f = run(withFile('server.js', GOOD['server.js'] + '\n' + line + '\n'));
  ok(idsOf(f).includes('no-raw-writes-to-persisted-paths'), `${label} is blocked`);
}
{
  // writeJsonAtomic's own fd write must stay legal, or the rule is unusable.
  const f = run(withFile('server.js', GOOD['server.js'] + '\nfs.writeFileSync(fd, JSON.stringify(data));\n'));
  ok(!idsOf(f).includes('no-raw-writes-to-persisted-paths'),
     'writing to a file DESCRIPTOR is not flagged (that is writeJsonAtomic)');
}

// 7. compose env and mount drifting apart
{
  const f = run(withFile('docker-compose.yml',
    GOOD['docker-compose.yml'].replace('wbai-archive-data:/app/data', 'wbai-archive-data:/app/store')));
  ok(idsOf(f).includes('compose-mount-matches-data-dir'),
     'a mount target that does not match DATA_DIR is blocked');
}
{
  // Written out in full rather than regex-surgered from GOOD. The first version
  // of this case deleted nothing (GOOD has no trailing newline, so the pattern
  // never matched) and therefore asserted that an UNCHANGED healthy compose file
  // triggers the rule — it failed loudly, but it could just as easily have been
  // written to pass and prove nothing at all.
  const noMount = [
    'services:',
    '  app:',
    '    environment:',
    '      - DATA_DIR=/app/data',
  ].join('\n');
  const f = run(withFile('docker-compose.yml', noMount));
  ok(idsOf(f).includes('compose-mount-matches-data-dir'), 'no mount at all is blocked');
  // ...and prove the fixture really is missing the mount, so this can never
  // silently become a second copy of the case above.
  ok(!/volumes:/.test(noMount), 'self-test: the fixture genuinely declares no volume');
}

// 8/9. the ignore files
{
  const f = run(withFile('.gitignore', 'node_modules\n'));
  ok(idsOf(f).includes('gitignore-protects-data'), 'dropping data/ from .gitignore is blocked');
}
{
  const f = run(withFile('.dockerignore', '.git\n'));
  ok(idsOf(f).includes('dockerignore-excludes-data'), 'dropping data from .dockerignore is caught');
}

// 10. staging live data
{
  const f = check({ read: readerFor(GOOD), staged: true,
                    stagedPaths: ['public/app.js', 'data/feeds.json'] });
  ok(idsOf(f).includes('no-staged-data-files'), 'staging data/feeds.json is blocked');
  const g = check({ read: readerFor(GOOD), staged: true, stagedPaths: ['public/app.js'] });
  ok(!idsOf(g).includes('no-staged-data-files'), '...and an ordinary commit is not');
}

console.log('\n#### the override exists and works (a guard with no escape hatch gets deleted)');
{
  const f = run(withFile('Dockerfile',
    GOOD['Dockerfile'] + '\nVOLUME ["/app/data"]  # storage-safety:allow deliberate, see PR\n'));
  ok(!idsOf(f).includes('dockerfile-no-volume'), 'storage-safety:allow suppresses the finding');
}

console.log('\n#### every rule is exercised above');
{
  // Without this, adding a rule and forgetting its case leaves it untested
  // forever — which is exactly how test/feed-scan/selftest.js sat outside
  // `npm test` for months.
  const covered = new Set([
    'dockerfile-no-volume', 'dockerfile-no-bulk-copy', 'dockerfile-no-data-removal',
    'data-dir-default', 'seed-outside-data-dir', 'no-raw-writes-to-persisted-paths',
    'compose-mount-matches-data-dir', 'gitignore-protects-data',
    'dockerignore-excludes-data', 'no-staged-data-files',
  ]);
  const missing = RULES.map(r => r.id).filter(id => !covered.has(id));
  ok(missing.length === 0, 'no rule lacks a self-test case', missing.join(',') || '(all covered)');
}

console.log('\n#### and the REAL repo passes');
{
  const findings = check({ root: ROOT });
  const blocks = findings.filter(f => f.level === 'block');
  ok(blocks.length === 0, 'the checked-in repo has no blocking findings',
     blocks.map(b => `${b.rule}@${b.file}`).join(', ') || '(clean)');
  // Prove the real-repo check is actually reading files, rather than passing
  // because every read returned null.
  ok(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').includes('FROM node'),
     'self-test: the real Dockerfile really was readable');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
