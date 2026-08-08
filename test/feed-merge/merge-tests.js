'use strict';

/**
 * mergeFeedItems() — the accumulation that makes this an archive.
 *
 * Why these exist: upstream serves only its five newest episodes per show, and
 * until 2026-08-07 fetchFeed REPLACED `items` with them, so every sixth episode
 * was forgotten the day it rotated out. The bug was invisible from the app —
 * five episodes per show looks like a station that publishes five episodes per
 * show. Nothing failed, nothing logged, the archive was just permanently
 * shallow. See docs/schedule-dev.md §7.8.
 *
 * CLAUDE.md §3a is the governing rule here, and it bites hard: a merge suite is
 * almost entirely assertions that something was NOT lost, and those pass
 * perfectly against a fixture where nothing was ever at risk. So the rotation
 * fixture below carries its own teeth — `assertRotated` REQUIRES that the fresh
 * window genuinely no longer lists the episode whose survival is being
 * asserted. Without it, "the old episode survived" is satisfied by a fixture in
 * which upstream never dropped it, and the suite would pass against the very
 * replace-wholesale code it exists to condemn.
 *
 * Offline: no network, no disk, runs in milliseconds.
 *
 *   node test/feed-merge/merge-tests.js
 */

const os = require('os');
const path = require('path');

// Requiring server.js runs its boot sequence, so point it at a throwaway
// directory first — same reason as test/storage/mount-tests.js.
process.env.DATA_DIR = path.join(os.tmpdir(), 'wbai-merge-tests');

const { mergeFeedItems } = require('../../server.js');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n         ${(e && e.message) || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// A real archive2 URL shape: the date and slot are IN the filename, which is
// why mp3 is a safe identity key.
const DAY = 86400;
const ep = (ymd, hhmmss, slug, over) => ({
  mp3: `https://archive2.wbai.org/mp3/wbai_${ymd}_${hhmmss}${slug}.mp3`,
  dt: Math.floor(Date.parse(
    `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}T${hhmmss.slice(0, 2)}:00:00Z`) / 1000),
  title: `${slug} ${ymd}`, durationSec: 3600, bytes: 57000000, desc: '', category: 'News',
  ...over,
});
const mp3s = (items) => items.map((i) => i.mp3);

// The teeth. A rotation fixture is only meaningful if the fresh window has
// actually dropped what we claim to be preserving.
function assertRotated(prev, fresh) {
  const freshSet = new Set(mp3s(fresh));
  const dropped = prev.filter((i) => !freshSet.has(i.mp3));
  assert(dropped.length > 0,
    'FIXTURE IS TOOTHLESS: upstream still lists every held episode, so this ' +
    'case cannot distinguish merging from replacing');
  return dropped;
}

console.log('mergeFeedItems');

check('with nothing held, the fresh window is the whole story', () => {
  const fresh = [ep('260804', '090000', 'covert'), ep('260728', '090000', 'covert')];
  eq(mergeFeedItems(undefined, fresh), fresh, 'should hand back the fresh array itself');
  eq(mergeFeedItems([], fresh), fresh, 'an empty history is the same case');
});

check('an episode that rotated out of upstream is KEPT', () => {
  // Five weeks held; upstream has since dropped the two oldest and gained one.
  const prev = ['260630', '260707', '260714', '260721', '260728'].map((d) => ep(d, '090000', 'covert'));
  const fresh = ['260714', '260721', '260728', '260804'].map((d) => ep(d, '090000', 'covert'));
  const dropped = assertRotated(prev, fresh);
  const out = mergeFeedItems(prev, fresh);
  for (const d of dropped) {
    assert(mp3s(out).includes(d.mp3), `lost ${path.basename(d.mp3)} — this is the whole bug`);
  }
  eq(out.length, 6, 'five held + one new, nothing duplicated');
});

check('and the merged list is exactly the union, with no duplicates', () => {
  const prev = ['260630', '260707', '260714'].map((d) => ep(d, '090000', 'covert'));
  const fresh = ['260714', '260721'].map((d) => ep(d, '090000', 'covert'));
  const out = mergeFeedItems(prev, fresh);
  eq(out.length, 4, 'the shared episode must be merged, not appended twice');
  eq(new Set(mp3s(out)).size, out.length, 'mp3 must be unique across the result');
});

check('newest first, so downstream order still holds', () => {
  const prev = ['260630', '260714'].map((d) => ep(d, '090000', 'covert'));
  const fresh = ['260721', '260707'].map((d) => ep(d, '090000', 'covert'));
  const out = mergeFeedItems(prev, fresh);
  const dts = out.map((i) => i.dt);
  eq(JSON.stringify(dts), JSON.stringify([...dts].sort((a, b) => b - a)), 'not sorted descending by dt');
});

check('a correction upstream wins over what we remembered', () => {
  const prev = [ep('260714', '090000', 'covert', { title: 'Covert Acton Buletin', desc: '' })];
  const fresh = [ep('260714', '090000', 'covert', { title: 'Covert Action Bulletin', desc: 'fixed' })];
  const out = mergeFeedItems(prev, fresh);
  eq(out.length, 1, 'same mp3 is the same episode');
  eq(out[0].title, 'Covert Action Bulletin', 'the newer telling should win');
  eq(out[0].desc, 'fixed', 'including its description');
});

check('history survives many harvests, not just one', () => {
  // Twenty weeks of a weekly show, harvested through a five-item window.
  const weeks = Array.from({ length: 20 }, (_, i) => ({
    mp3: `https://archive2.wbai.org/mp3/w${i}.mp3`, dt: 1780000000 + i * 7 * DAY, title: `ep${i}`,
  }));
  let held;
  for (let i = 0; i < weeks.length; i++) {
    const window = weeks.slice(Math.max(0, i - 4), i + 1).reverse();  // upstream's newest five
    held = mergeFeedItems(held, window);
  }
  eq(held.length, 20, 'every week should have been remembered');
  eq(held[0].title, 'ep19', 'newest first');
  eq(held[held.length - 1].title, 'ep0', 'including the very first, long since rotated out');
});

check('the corruption guard keeps the NEWEST items, not the first it saw', () => {
  // Not a retention policy — a stop against upstream making every URL look new.
  const prev = Array.from({ length: 2500 }, (_, i) => ({
    mp3: `https://x/old${i}.mp3`, dt: 1000 + i, title: `old${i}`,
  }));
  const fresh = [{ mp3: 'https://x/new.mp3', dt: 99999999, title: 'new' }];
  const out = mergeFeedItems(prev, fresh);
  eq(out.length, 2000, 'must be bounded');
  eq(out[0].title, 'new', 'the newest episode must never be the one discarded');
});

check('an item with no mp3 cannot poison the merge', () => {
  const prev = [ep('260714', '090000', 'covert'), { dt: 123, title: 'no enclosure' }];
  const fresh = [null, ep('260721', '090000', 'covert')];
  const out = mergeFeedItems(prev, fresh);
  eq(out.length, 2, 'unkeyable entries are skipped, the real ones are not');
  assert(out.every((i) => i && i.mp3), 'nothing unkeyable should reach the result');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('all feed-merge tests passed');
