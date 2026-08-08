#!/usr/bin/env node
/**
 * check-storage-safety — refuse to commit a change that could destroy the data
 * directory in production.
 *
 * WHY THIS EXISTS
 *
 * `data/feeds.json` is the only copy anywhere of this station's older listings.
 * Upstream serves five episodes per show and forgets the rest; since 2026-08-07
 * `mergeFeedItems` accumulates the ones that fall out of that window, so what is
 * on the volume is strictly more than what any re-harvest could rebuild. Losing
 * it is not "the cache is cold for an hour" — it is gone.
 *
 * The failure mode is also historically REAL here, not theoretical. This
 * deployment spent weeks silently rebuilding its data dir on every deploy
 * because a `VOLUME` instruction created a fresh anonymous volume per container
 * (CLAUDE.md §4, docs/DEPLOYMENT.md). Nothing in the UI showed it. Every obvious
 * number looked fine.
 *
 * What unites every way that goes wrong: the app keeps running and looks
 * healthy. An empty data dir is indistinguishable from a first boot, so the
 * damage is only visible if you were watching the right number at the right
 * moment. That is precisely the kind of risk worth catching before the commit
 * that causes it, rather than after the deploy that reveals it.
 *
 * WHAT IT DOES NOT DO
 *
 * Static checks over config. It cannot tell you whether the production volume is
 * actually mounted — only /healthz can, by reporting the same `storage.instanceId`
 * across two deploys. Per CLAUDE.md §4 a local pass is NO evidence about
 * production storage. Both belong in a definition of done, on separate lines.
 *
 * Usage:
 *   node tools/check-storage-safety.js            # working tree
 *   node tools/check-storage-safety.js --staged   # what is about to be committed
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- readers
// The hook cares about the content being COMMITTED, which is not necessarily
// what is in the working tree — `git add -p` and a later edit make those differ,
// and checking the wrong one would pass a commit that reintroduces the bug.
function workingTreeReader(root) {
  return rel => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); }
    catch (e) { return null; }
  };
}
function stagedReader(root) {
  const cache = new Map();
  return rel => {
    if (cache.has(rel)) return cache.get(rel);
    let out = null;
    try {
      out = execFileSync('git', ['show', `:${rel}`], { cwd: root, encoding: 'utf8' });
    } catch (e) {
      // Not staged (or not tracked) — fall back to the working tree, so a file
      // nobody touched is still checked rather than silently skipped.
      try { out = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e2) { out = null; }
    }
    cache.set(rel, out);
    return out;
  };
}

// ------------------------------------------------------------------ rules
//
// Each returns findings. `block` fails the commit; `warn` is printed and passes.
// An escape hatch exists for every blocking rule — a line containing
// `storage-safety:allow` — because a guard with no override gets deleted the
// first time it is wrong, and a deleted guard protects nothing.
const ALLOW = /storage-safety:allow/;

// Strip comments so a rule cannot fire on prose ABOUT the thing it forbids.
// This file and the Dockerfile both discuss `VOLUME` at length; without this the
// checker would flag its own documentation.
function stripHashComments(src) {
  return src.split('\n').map(l => (/^\s*#/.test(l) ? '' : l)).join('\n');
}

const RULES = [];

RULES.push({
  id: 'dockerfile-no-volume',
  why: 'A VOLUME with no explicit mount creates a NEW anonymous volume per container: '
     + 'data survives restarts, is discarded on the next deploy, and appears nowhere in any UI. '
     + 'This exact line cost this deployment weeks of silent loss.',
  run(read) {
    const src = read('Dockerfile');
    if (src == null) return [];
    const out = [];
    stripHashComments(src).split('\n').forEach((line, i) => {
      if (/^\s*VOLUME\b/.test(line) && !ALLOW.test(line)) {
        out.push({ level: 'block', file: 'Dockerfile', line: i + 1, text: line.trim() });
      }
    });
    return out;
  }
});

RULES.push({
  id: 'dockerfile-no-bulk-copy',
  why: 'COPY . / ADD . would bake the local data/ directory into the image. With no volume '
     + 'mounted that image data looks like real persistence and silently resets every deploy; '
     + 'with one mounted it is dead weight. The Dockerfile copies named paths for this reason.',
  run(read) {
    const src = read('Dockerfile');
    if (src == null) return [];
    const out = [];
    stripHashComments(src).split('\n').forEach((line, i) => {
      // `COPY . .` / `ADD . /app` — a bare-dot source, not `COPY public ./public`.
      if (/^\s*(COPY|ADD)\s+(--[\w=]+\s+)*\.\s+\S/.test(line) && !ALLOW.test(line)) {
        out.push({ level: 'block', file: 'Dockerfile', line: i + 1, text: line.trim() });
      }
    });
    return out;
  }
});

RULES.push({
  id: 'dockerfile-no-data-removal',
  why: 'A RUN that deletes or recreates the data dir runs on every image build, i.e. every deploy.',
  run(read) {
    const src = read('Dockerfile');
    if (src == null) return [];
    const out = [];
    stripHashComments(src).split('\n').forEach((line, i) => {
      if (/^\s*RUN\b/.test(line) && /\b(rm|rmdir)\b[^\n]*\/app\/data/.test(line) && !ALLOW.test(line)) {
        out.push({ level: 'block', file: 'Dockerfile', line: i + 1, text: line.trim() });
      }
    });
    return out;
  }
});

RULES.push({
  id: 'data-dir-default',
  why: 'server.js must keep resolving DATA_DIR from the environment with ./data as the fallback. '
     + 'If the default moves, a production container whose volume is mounted at the OLD path keeps '
     + 'the mount and writes somewhere else — the data is intact and unreachable, which reads as loss.',
  run(read) {
    const src = read('server.js');
    if (src == null) return [];
    if (ALLOW.test(src)) return [];
    const m = src.match(/const\s+DATA_DIR\s*=\s*([^;]+);/);
    if (!m) {
      return [{ level: 'block', file: 'server.js', line: null,
                text: 'no `const DATA_DIR = ...` found at all' }];
    }
    const expr = m[1].replace(/\s+/g, ' ').trim();
    const ok = /process\.env\.DATA_DIR/.test(expr)
            && /__dirname/.test(expr)
            && /['"]data['"]/.test(expr);
    return ok ? [] : [{
      level: 'block', file: 'server.js',
      line: src.slice(0, m.index).split('\n').length,
      text: `DATA_DIR resolves as: ${expr}`
    }];
  }
});

RULES.push({
  id: 'seed-outside-data-dir',
  why: 'A mounted volume shadows whatever the image put at that path, so a seed placed under '
     + 'DATA_DIR would never be read — and, if it ever were writable, would be overwritten by the '
     + 'live cache it is supposed to prime.',
  run(read) {
    const src = read('server.js');
    if (src == null) return [];
    const m = src.match(/const\s+SEED_PATH\s*=\s*([^;]+);/);
    if (!m || ALLOW.test(m[0])) return [];
    const expr = m[1].replace(/\s+/g, ' ').trim();
    return /DATA_DIR/.test(expr) ? [{
      level: 'block', file: 'server.js',
      line: src.slice(0, m.index).split('\n').length,
      text: `SEED_PATH is derived from DATA_DIR: ${expr}`
    }] : [];
  }
});

RULES.push({
  id: 'no-raw-writes-to-persisted-paths',
  why: 'Persisted files must go through writeJsonAtomic/writeJsonSoon. A bare writeFileSync '
     + 'truncates the live file first, so a crash mid-write leaves bytes that are not valid JSON — '
     + 'and readJsonFile discards an unparseable file and starts EMPTY, which the next write makes '
     + 'permanent. Deleting one outright is the same outcome without the crash.',
  run(read) {
    const src = read('server.js');
    if (src == null) return [];
    // The path constants that name something we must not lose.
    const PERSISTED = /\b(DATA_DIR|SHOWINFO_PATH|PROGRAMS_PATH|FEEDS_PATH|PHOTOMAP_PATH|KNOWN_SLUGS_PATH|STATS_DIR)\b/;
    const DANGER = /\bfs\.(writeFileSync|writeFile|rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|truncateSync|truncate|cpSync)\s*\(/;
    const out = [];
    src.split('\n').forEach((line, i) => {
      if (!DANGER.test(line) || !PERSISTED.test(line)) return;
      if (ALLOW.test(line)) return;
      out.push({ level: 'block', file: 'server.js', line: i + 1, text: line.trim() });
    });
    return out;
  }
});

RULES.push({
  id: 'compose-mount-matches-data-dir',
  why: 'The DATA_DIR env and the volume mount target are two halves of one fact. If they drift, '
     + 'the container writes to a path nothing is mounted at — every write succeeds, nothing survives.',
  run(read) {
    const src = read('docker-compose.yml');
    if (src == null || ALLOW.test(src)) return [];
    const envs = [...src.matchAll(/DATA_DIR=(\S+)/g)].map(m => m[1]);
    if (!envs.length) return [];
    // Mount targets: `- name:/target` or `- ./host:/target`, ignoring options.
    const targets = [...src.matchAll(/^\s*-\s+[^\s:#]+:([^\s:#]+)/gm)].map(m => m[1]);
    const out = [];
    for (const dir of new Set(envs)) {
      if (!targets.includes(dir)) {
        out.push({ level: 'block', file: 'docker-compose.yml', line: null,
                   text: `DATA_DIR=${dir} has no matching volume mount (mounts: ${targets.join(', ') || 'none'})` });
      }
    }
    return out;
  }
});

RULES.push({
  id: 'gitignore-protects-data',
  why: 'data/ must stay untracked. Tracked, a checkout or a revert would overwrite live station '
     + 'data with whatever was committed months ago.',
  run(read) {
    const src = read('.gitignore');
    if (src == null) return [{ level: 'block', file: '.gitignore', line: null, text: 'missing' }];
    if (ALLOW.test(src)) return [];
    const has = src.split('\n').some(l => /^\s*\/?data\/?\s*$/.test(l));
    return has ? [] : [{ level: 'block', file: '.gitignore', line: null,
                         text: 'no `data/` entry' }];
  }
});

RULES.push({
  id: 'dockerignore-excludes-data',
  why: 'Defence in depth for the bulk-COPY rule: if a COPY . ever lands, .dockerignore is what '
     + 'stops the local data/ going into the image with it.',
  run(read) {
    const src = read('.dockerignore');
    if (src == null) return [{ level: 'warn', file: '.dockerignore', line: null, text: 'missing' }];
    if (ALLOW.test(src)) return [];
    const has = src.split('\n').some(l => /^\s*\/?data\/?\s*$/.test(l));
    return has ? [] : [{ level: 'warn', file: '.dockerignore', line: null,
                         text: 'no `data` entry — nothing but the named COPYs keeps data/ out of the image' }];
  }
});

RULES.push({
  id: 'no-staged-data-files',
  why: 'Committing anything under data/ makes live station data part of the repo history.',
  run(read, ctx) {
    if (!ctx.staged) return [];
    return ctx.stagedPaths
      .filter(p => /^data\//.test(p))
      .map(p => ({ level: 'block', file: p, line: null, text: 'staged for commit' }));
  }
});

// ------------------------------------------------------------------- run
function check(opts = {}) {
  const root = opts.root || ROOT;
  const staged = !!opts.staged;
  const read = opts.read || (staged ? stagedReader(root) : workingTreeReader(root));
  let stagedPaths = [];
  if (staged && !opts.read) {
    try {
      stagedPaths = execFileSync('git', ['diff', '--cached', '--name-only'],
                                 { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (e) { /* not a git repo; the file rules still apply */ }
  }
  if (opts.stagedPaths) stagedPaths = opts.stagedPaths;

  const findings = [];
  for (const rule of RULES) {
    for (const f of rule.run(read, { staged, stagedPaths })) {
      findings.push(Object.assign({ rule: rule.id, why: rule.why }, f));
    }
  }
  return findings;
}

module.exports = { check, RULES };

if (require.main === module) {
  const staged = process.argv.includes('--staged');
  const findings = check({ staged });
  const blocks = findings.filter(f => f.level === 'block');
  const warns = findings.filter(f => f.level === 'warn');

  for (const f of findings) {
    const where = f.file + (f.line ? `:${f.line}` : '');
    console.error(`\n${f.level === 'block' ? '✗ BLOCK' : '! warn '}  [${f.rule}]  ${where}`);
    console.error(`         ${f.text}`);
    console.error(`         ${f.why}`);
  }
  if (blocks.length) {
    console.error(`\n${blocks.length} blocking storage-safety problem(s).`);
    console.error('If one is genuinely wrong, add `storage-safety:allow` to that line — and say why.\n');
    process.exit(1);
  }
  console.log(`storage safety: ok (${RULES.length} rules${warns.length ? `, ${warns.length} warning(s)` : ''})`);
  console.log('NOTE: static config only. Whether the production volume actually persisted is a');
  console.log('      question only /healthz can answer — compare storage.instanceId across deploys.');
}
