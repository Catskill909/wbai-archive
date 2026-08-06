// The photo map is the single point of failure for EVERY image in the app.
//
// Artwork has exactly one source: `pub_sched.php` is scraped for
// `pix/<slug>_med_<id>.jpg` preloads, and parseArchive builds each row's
// `photo` from that map. So an empty map does not degrade the listing — it
// removes every picture from it, while rows-parsed, feed counts and freshness
// all still read perfectly healthy.
//
// On 2026-08-06 that is exactly what happened locally: one flaky fetch of the
// schedule page, a `.catch(() => ({}))` that turned it into an empty map, and
// 480 of 536 rows silently lost their artwork with nothing logged. The map is
// remembered and persisted now, and this is the guard on the decision that
// makes it work. Offline and pure — no network, no server process.
const assert = require('assert');
const { pickPhotoMap, parseArchive } = require('../../server.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('ok    ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const remembered = { dn: '28', equal: '257', burnbabyburn: '384' };

ok('a failed fetch (null) keeps every remembered id', () => {
  assert.deepStrictEqual(pickPhotoMap(remembered, null), remembered);
});

// The case that actually bit: a 200 response that parses to nothing looks like
// success to every caller. It must be treated as the outage it is.
ok('a 200 that parsed to ZERO ids keeps them too — not "these shows have no art"', () => {
  assert.deepStrictEqual(pickPhotoMap(remembered, {}), remembered);
});

ok('a good scrape wins for the slugs it names', () => {
  const out = pickPhotoMap(remembered, { dn: '99' });
  assert.strictEqual(out.dn, '99');
});

// The grid only lists what is currently scheduled, but the archive holds ~60
// days of rows. Replacing rather than merging would blank last month's shows.
ok('slugs the grid no longer lists are NOT dropped', () => {
  const out = pickPhotoMap(remembered, { dn: '28' });
  assert.strictEqual(out.equal, '257');
  assert.strictEqual(out.burnbabyburn, '384');
});

ok('a first run with nothing remembered still takes the fresh map', () => {
  assert.deepStrictEqual(pickPhotoMap({}, { dn: '28' }), { dn: '28' });
  assert.deepStrictEqual(pickPhotoMap(undefined, { dn: '28' }), { dn: '28' });
});

ok('nothing remembered and nothing fetched is empty, not a crash', () => {
  assert.deepStrictEqual(pickPhotoMap({}, {}), {});
  assert.deepStrictEqual(pickPhotoMap(null, null), {});
});

ok('the remembered map is never mutated in place', () => {
  const before = JSON.stringify(remembered);
  pickPhotoMap(remembered, { newshow: '1' });
  assert.strictEqual(JSON.stringify(remembered), before);
});

// ---- and the half that proves the map is what actually paints the rows.
// Without this, every assertion above could pass while parseArchive ignored the
// map entirely — the "assert the effect, not the declaration" rule (CLAUDE.md §3a).
const ROW = '<tr name="show" id="tt_101" cat="14" sho="dn" dt="1786000000">' +
            '<span class="showtitle">Democracy Now!</span>' +
            '<span class=showdate>Thursday, August 6, 2026 8:00 am</span>' +
            '<span class=showlen>1:00:03</span></tr>';

ok('a row WITH a mapped slug gets a real /pix path', () => {
  const rows = parseArchive(ROW, { dn: '28' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].photo, '/pix/dn_med_28.jpg');
});

// The self-test with teeth: the same row through an EMPTY map must come back
// blank. If this ever stops being true, the assertion above stops meaning
// anything and the outage becomes invisible again.
ok('SELF-TEST: the same row through an empty map is blank — so the map is what does it', () => {
  const rows = parseArchive(ROW, {});
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].photo, '', 'an empty map must blank the photo, or this suite is measuring nothing');
});

console.log('\n' + (process.exitCode ? 'FAILED' : 'all ' + pass + ' photo-map tests passed'));
