#!/usr/bin/env node
/**
 * Proves the scanner's change detector can still see changes.
 *
 * A feed scanner spends almost all of its life printing "no changes", which is
 * indistinguishable from a scanner that has quietly gone blind. So every kind
 * of change it claims to detect gets synthesized here and asserted, and — just
 * as importantly — an unchanged input is asserted to produce *nothing*, so the
 * suite can't pass by simply firing on everything. CLAUDE.md §3a.
 *
 * Offline: no network, runs in milliseconds.
 *
 *   node selftest.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { diff, parseFeed, slugsFromDropdown, slugsFromRows } = require('./scan.js');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n         ${(e && e.message) || e}`);
  }
}

const liveFeed = (over) => ({
  slug: 'x', status: 200, bytes: 5000, items: 5,
  newest: '2026-07-28T12:00:00.000Z', lastModified: 'Tue, 28 Jul 2026 18:04:43 GMT',
  ...over,
});

const state = (feeds, maxItems) => ({
  scannedAt: '2026-07-27T00:00:00.000Z',
  maxItems: maxItems === undefined ? 5 : maxItems,
  feeds,
});

const kinds = (changes) => changes.map((c) => c.kind).sort();

console.log('feed-scan selftest\n');
console.log('change detection:');

check('NEW_FEED when an unseen slug arrives with items', () => {
  const c = diff(state({}), { maxItems: 5, feeds: { dn: liveFeed({ slug: 'dn' }) } });
  assert.deepStrictEqual(kinds(c), ['NEW_FEED']);
});

check('NEW_SLUG when an unseen slug arrives with no feed', () => {
  const c = diff(state({}), { maxItems: 0, feeds: { lenlo: { slug: 'lenlo', status: 404 } } });
  assert.deepStrictEqual(kinds(c), ['NEW_SLUG']);
});

check('FEED_APPEARED when a known 404 slug starts serving', () => {
  const c = diff(
    state({ lenlo: { slug: 'lenlo', status: 404 } }, 5),
    { maxItems: 5, feeds: { lenlo: liveFeed({ slug: 'lenlo' }) } });
  assert.deepStrictEqual(kinds(c), ['FEED_APPEARED']);
});

check('FEED_LOST on a 404', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn' }) }),
    { maxItems: 0, feeds: { dn: { slug: 'dn', status: 404 } } });
  assert.deepStrictEqual(kinds(c), ['FEED_LOST']);
});

// The July failure mode: HTTP 200, zero bytes. A status-only check calls this
// healthy, which is precisely how the feeds stayed "fine" while being dead.
check('FEED_LOST on HTTP 200 with zero bytes (the July failure mode)', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn' }) }),
    { maxItems: 0, feeds: { dn: { slug: 'dn', status: 200, bytes: 0, items: 0, empty: true } } });
  assert.deepStrictEqual(kinds(c), ['FEED_LOST']);
  assert.match(c[0].detail, /ZERO BYTES/);
});

check('FEED_LOST on HTTP 200 that parses to no items', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn' }) }),
    { maxItems: 0, feeds: { dn: { slug: 'dn', status: 200, bytes: 800, items: 0 } } });
  assert.deepStrictEqual(kinds(c), ['FEED_LOST']);
});

check('ITEM_COUNT when the per-feed episode count moves', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn', items: 5 }) }),
    { maxItems: 5, feeds: { dn: liveFeed({ slug: 'dn', items: 8 }) } });
  assert.ok(kinds(c).includes('ITEM_COUNT'), 'expected ITEM_COUNT, got ' + kinds(c));
});

check('NEW_EPISODE when the newest pubDate moves', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn' }) }),
    { maxItems: 5, feeds: { dn: liveFeed({ slug: 'dn', newest: '2026-07-29T12:00:00.000Z' }) } });
  assert.deepStrictEqual(kinds(c), ['NEW_EPISODE']);
});

check('SLUG_GONE when a remembered slug stops being offered', () => {
  const c = diff(state({ dn: liveFeed({ slug: 'dn' }) }), { maxItems: 0, feeds: {} });
  assert.deepStrictEqual(kinds(c), ['SLUG_GONE']);
});

// The whole reason this scanner exists rather than a one-off check: WBAI can
// raise the episode cap in their archiver, and that single number is what the
// "feeds cannot replace the scrape" conclusion rests on.
check('CAP_CHANGED when the archiver raises the episodes-per-feed cap', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn', items: 5 }) }, 5),
    { maxItems: 20, feeds: { dn: liveFeed({ slug: 'dn', items: 20 }) } });
  assert.ok(kinds(c).includes('CAP_CHANGED'), 'expected CAP_CHANGED, got ' + kinds(c));
  assert.match(c.find((x) => x.kind === 'CAP_CHANGED').detail, /out of date/);
});

console.log('\nsilence is real, not blindness:');

check('identical input produces NO changes', () => {
  const f = { dn: liveFeed({ slug: 'dn' }), lenlo: { slug: 'lenlo', status: 404 } };
  const c = diff(state(f), { maxItems: 5, feeds: JSON.parse(JSON.stringify(f)) });
  assert.deepStrictEqual(c, [], 'a quiet scan must be quiet for the right reason');
});

check('a 304 (notModified) result is not mistaken for a change', () => {
  const prev = liveFeed({ slug: 'dn' });
  const now = { ...prev, notModified: true };
  const c = diff(state({ dn: prev }), { maxItems: 5, feeds: { dn: now } });
  assert.deepStrictEqual(c, [], '304 carries prev forward; it must diff clean');
});

check('the live baseline diffs clean against itself', () => {
  const p = path.join(__dirname, 'state.json');
  if (!fs.existsSync(p)) {
    console.log('       (skipped — run `node scan.js` once to create state.json)');
    return;
  }
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(diff(s, s), []);
});

console.log('\nparsers:');

check('parseFeed counts items and finds the newest pubDate', () => {
  const xml = `<rss><channel><lastBuildDate>Tue, 28 Jul 2026 08:00:00 -0400</lastBuildDate>
    <item><pubDate>Mon, 27 Jul 2026 08:00:00 -0400</pubDate></item>
    <item><pubDate>Tue, 28 Jul 2026 08:00:00 -0400</pubDate></item></channel></rss>`;
  const r = parseFeed(xml);
  assert.strictEqual(r.items, 2);
  assert.strictEqual(r.newest, '2026-07-28T12:00:00.000Z');
});

check('parseFeed reports zero items rather than throwing on junk', () => {
  assert.strictEqual(parseFeed('<html>not a feed</html>').items, 0);
  assert.strictEqual(parseFeed('').items, 0);
});

check('slug parsers survive an unrecognisable page by returning nothing', () => {
  assert.deepStrictEqual(slugsFromDropdown('<html>nope</html>'), []);
  assert.deepStrictEqual(slugsFromRows('<html>nope</html>'), []);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(', '));
  process.exit(1);
}
