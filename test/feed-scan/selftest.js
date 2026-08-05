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
const { diff, parseFeed, slugsFromDropdown, slugsFromRows, NOTABLE } = require('./scan.js');

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

// The claims matter to this one: a feed that appears *without* the listing
// advertising it is a FEED_UNFETCHED as well, and rightly so. The plain
// FEED_APPEARED is the case where the button arrives with the feed behind it.
check('FEED_APPEARED when a known 404 slug starts serving', () => {
  const c = diff(
    state({ lenlo: { slug: 'lenlo', status: 404, claimed: false } }, 5),
    { maxItems: 5, feeds: { lenlo: liveFeed({ slug: 'lenlo', claimed: true }) } });
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

// The regression of 2026-07-29: archive2 began rendering a podcast XML button on
// 21 shows whose feeds 404. Anything gating on that claim publishes them.
check('CLAIM_MISMATCH when the listing advertises a feed that 404s', () => {
  const c = diff(
    state({ manrat: { slug: 'manrat', status: 404, claimed: false } }, 5),
    { maxItems: 5, feeds: { manrat: { slug: 'manrat', status: 404, claimed: true } } });
  assert.ok(kinds(c).includes('CLAIM_MISMATCH'), 'expected CLAIM_MISMATCH, got ' + kinds(c));
  assert.match(c.find((x) => x.kind === 'CLAIM_MISMATCH').detail, /hasRSS/);
});

check('CLAIM_MISMATCH on a brand-new slug that arrives already lying', () => {
  const c = diff(state({}), { maxItems: 0, feeds: { manrat: { slug: 'manrat', status: 404, claimed: true } } });
  assert.ok(kinds(c).includes('CLAIM_MISMATCH'), kinds(c));
});

check('CLAIM_RESOLVED when the feed finally appears', () => {
  const c = diff(
    state({ manrat: { slug: 'manrat', status: 404, claimed: true } }, 5),
    { maxItems: 5, feeds: { manrat: liveFeed({ slug: 'manrat', claimed: true }) } });
  assert.ok(kinds(c).includes('CLAIM_RESOLVED'), kinds(c));
});

check('CLAIM_RESOLVED when the listing stops advertising it', () => {
  const c = diff(
    state({ manrat: { slug: 'manrat', status: 404, claimed: true } }, 5),
    { maxItems: 0, feeds: { manrat: { slug: 'manrat', status: 404, claimed: false } } });
  assert.ok(kinds(c).includes('CLAIM_RESOLVED'), kinds(c));
});

// The mirror case: a live feed the listing does not advertise. The server
// eventually catches these (unclaimed slow probe, plus row synthesis when
// there is no listing row at all — see server.js applyFeeds) but it is still
// worth a human's attention, since it means upstream dropped a real show from
// its own listing.
check('FEED_UNFETCHED when a live feed has no XML button', () => {
  const c = diff(
    state({ dn: { slug: 'dn', status: 404, claimed: false } }, 5),
    { maxItems: 5, feeds: { dn: liveFeed({ slug: 'dn', claimed: false }) } });
  assert.ok(kinds(c).includes('FEED_UNFETCHED'), kinds(c));
  assert.match(c.find((x) => x.kind === 'FEED_UNFETCHED').detail, /slow unclaimed probe/);
});

console.log('\nsilence is real, not blindness:');

// A standing mismatch must not shout on every run — only the transition does.
// Without this, 21 currently-mismatched shows would make every scan exit 1 and
// the signal would be trained out of existence within a week.
check('a mismatch that was already there produces NO change', () => {
  const f = { manrat: { slug: 'manrat', status: 404, claimed: true } };
  const c = diff(state(f), { maxItems: 0, feeds: JSON.parse(JSON.stringify(f)) });
  assert.deepStrictEqual(c, [], 'a standing mismatch must be quiet');
});

check('a consistent claim (feed exists, button shown) produces NO change', () => {
  const f = { dn: liveFeed({ slug: 'dn', claimed: true }) };
  const c = diff(state(f), { maxItems: 5, feeds: JSON.parse(JSON.stringify(f)) });
  assert.deepStrictEqual(c, [], JSON.stringify(c));
});

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

console.log('\nnotable vs routine (this is what sets the exit status):');

// Run #4 of the GitHub workflow failed on 79 changes, 77 of which were new
// episodes and moving item counts. Left alone that is a failure mail every day,
// and a daily failure mail is one nobody reads on the day the feeds die.
check('an ordinary week of new episodes is NOT notable', () => {
  // `dn` holds items at the cap on both sides, so this fixture is churn and
  // nothing else — a moving cap is a separate, notable thing.
  const prev = { dn: liveFeed({ slug: 'dn', items: 5, claimed: true }) };
  const now = { dn: liveFeed({ slug: 'dn', items: 5, newest: '2026-08-02T12:00:00.000Z', claimed: true }) };
  for (const s of ['kwave', 'techtonic']) {
    prev[s] = liveFeed({ slug: s, items: 1, claimed: true });
    now[s] = liveFeed({ slug: s, items: 2, newest: '2026-08-02T12:00:00.000Z', claimed: true });
  }
  const c = diff(state(prev, 5), { maxItems: 5, feeds: now });
  assert.deepStrictEqual(kinds(c), ['ITEM_COUNT', 'ITEM_COUNT', 'NEW_EPISODE', 'NEW_EPISODE', 'NEW_EPISODE']);
  assert.deepStrictEqual(c.filter((x) => NOTABLE.has(x.kind)), [], 'churn must not raise an alarm');
});

check('a new show with no feed yet is reported but NOT notable', () => {
  const c = diff(state({}), { maxItems: 0, feeds: { cslatino: { slug: 'cslatino', status: 404 } } });
  assert.deepStrictEqual(kinds(c), ['NEW_SLUG']);
  assert.deepStrictEqual(c.filter((x) => NOTABLE.has(x.kind)), []);
});

// Demoted 2026-08-05. A feed switching on is the archive working: WBAI brings
// them up a show at a time, and the hourly harvest picks each one up unaided.
// Note that the identical event for a slug we had never seen is NEW_FEED, which
// was always routine — the two must not disagree about the same day's news.
check('a feed switching on is reported but NOT notable', () => {
  const c = diff(
    state({ explorafri: { slug: 'explorafri', status: 404, claimed: true } }, 5),
    { maxItems: 5, feeds: { explorafri: liveFeed({ slug: 'explorafri', items: 1, claimed: true }) } });
  // CLAIM_RESOLVED rides along because the listing had been advertising the
  // button ahead of the file — which is how explorafri actually looked.
  assert.deepStrictEqual(kinds(c), ['CLAIM_RESOLVED', 'FEED_APPEARED']);
  assert.deepStrictEqual(c.filter((x) => NOTABLE.has(x.kind)), [], 'a feed arriving must not mail anyone');

  const unseen = diff(state({}, 5),
    { maxItems: 5, feeds: { explorafri: liveFeed({ slug: 'explorafri', items: 1, claimed: true }) } });
  assert.deepStrictEqual(kinds(unseen), ['NEW_FEED']);
  assert.deepStrictEqual(unseen.filter((x) => NOTABLE.has(x.kind)), [], 'NEW_FEED and FEED_APPEARED must agree');
});

// The other half of the split, and the half that matters: the kinds that killed
// the site in July must still get through.
check('the July failure mode IS notable', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn' }) }),
    { maxItems: 0, feeds: { dn: { slug: 'dn', status: 200, bytes: 0, items: 0, empty: true } } });
  assert.deepStrictEqual(kinds(c.filter((x) => NOTABLE.has(x.kind))), ['FEED_LOST']);
});

check('a claim appearing without a feed IS notable', () => {
  const c = diff(
    state({ manrat: { slug: 'manrat', status: 404, claimed: false } }, 5),
    { maxItems: 5, feeds: { manrat: { slug: 'manrat', status: 404, claimed: true } } });
  assert.ok(c.filter((x) => NOTABLE.has(x.kind)).some((x) => x.kind === 'CLAIM_MISMATCH'), kinds(c));
});

check('a moved episode cap IS notable', () => {
  const c = diff(
    state({ dn: liveFeed({ slug: 'dn', items: 5 }) }, 5),
    { maxItems: 20, feeds: { dn: liveFeed({ slug: 'dn', items: 20 }) } });
  assert.ok(c.filter((x) => NOTABLE.has(x.kind)).some((x) => x.kind === 'CAP_CHANGED'), kinds(c));
});

// A kind nobody classified would be silently routine, i.e. silently invisible.
check('every kind NOTABLE names is a kind diff can actually emit', () => {
  const emitted = new Set(fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')
    .match(/kind: '[A-Z_]+'/g).map((m) => m.slice(7, -1)));
  for (const k of NOTABLE) {
    assert.ok(emitted.has(k), `NOTABLE lists ${k}, which diff never emits — a dead alarm`);
  }
});

// The workflow greps the notable lines out of the scan output to post them as
// annotations, so the failure email names what changed instead of saying only
// "exit code 1". That grep is a second copy of NOTABLE, written in YAML where
// nothing executes it — and this repo has already had one hand-maintained copy
// of this list (the README's) go stale. Drift here does not break the alarm; it
// makes the alarm arrive empty, which is worse than either working or failing.
check('the workflow annotation grep lists exactly the NOTABLE kinds', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'feed-scan.yml'), 'utf8');
  const m = yml.match(/grep -E '\^ \{4\}\(([A-Z_|]+)\)/);
  assert.ok(m, 'could not find the annotation grep in feed-scan.yml — did it move?');
  assert.deepStrictEqual(m[1].split('|').sort(), [...NOTABLE].sort(),
    'feed-scan.yml greps for a different set than NOTABLE — annotations will omit an alarm');
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
