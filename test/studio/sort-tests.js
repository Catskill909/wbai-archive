'use strict';

/**
 * "Every feed" — is the table actually sortable, and does it look it?
 *
 * The table has been sortable since it shipped and nobody could tell: only the
 * active column carried an arrow, so the other six read as plain labels. That
 * is a real defect even though every click worked, and it is exactly the kind
 * CLAUDE.md §3a is about — the behaviour was present, and the thing the user
 * needed (knowing it was there) was absent, and nothing measured the second.
 *
 * So this suite asserts both halves:
 *   - every header advertises itself as sortable before it is clicked, and
 *   - a real mouse click on each one puts the rows in the order that column
 *     claims, in both directions.
 *
 * Order is checked against ground truth — the same /api/studio/stats the page
 * rendered from — not against the rendered text, which is lossy (hours are
 * rounded, listening time is bucketed to "4m"), and would let a wrong order
 * pass whenever two rows round to the same string. The expected order is
 * computed inside the page so string collation is Chrome's, not Node's.
 *
 * Section 4 is the §3a self-test: the order probe is fed a deliberately
 * shuffled table and must report it. A suite of "the rows are in order"
 * assertions passes perfectly once the probe goes blind.
 *
 *   CDP_PORT=9225 BASE=http://localhost:8080 node --experimental-websocket sort-tests.js
 */

const cdp = require('../live-stream/cdp.js');

const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.BASE || 'http://localhost:8080';
const PASSWORD = process.env.STUDIO_PASSWORD || 'local-dev-password';

const KEYS = ['title', 'slug', 'episodes', 'seconds', 'plays', 'listened', 'newest'];
// A new column starts descending for numbers, ascending for text — studio.js.
const FIRST_DIR = (k) => (k === 'title' || k === 'slug' ? 'ascending' : 'descending');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`       ${detail}`);
}

(async () => {
  const c = await cdp.connect(PORT);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });

  const ev = async (e) => (await c.send('Runtime.evaluate',
    { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  const json = async (e) => JSON.parse(await ev(e));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await c.send('Emulation.setDeviceMetricsOverride',
    { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: BASE + '/studio' });
  await wait(1500);
  if (await ev("!!document.getElementById('loginForm')")) {
    await ev(`(function(){
      document.getElementById('password').value = ${JSON.stringify(PASSWORD)};
      document.getElementById('loginForm').requestSubmit();
    })()`);
    await wait(2000);
  }

  console.log('\n1. the table is up and every column advertises itself');
  const rowCount = await ev("document.querySelectorAll('#showTableBody tr').length");
  ok('the dashboard rendered rows to sort', rowCount > 5, `${rowCount} rows`);
  if (!(rowCount > 5)) { console.log('\ncannot continue'); process.exit(1); }

  /* The affordance, measured as painted rather than as declared: an indicator
   * glyph that is actually drawn (content set, non-zero opacity) on all seven
   * headers, not just the sorted one. */
  const marks = await json(`(() => {
    const out = [];
    document.querySelectorAll('.th-sort').forEach((b) => {
      const a = getComputedStyle(b, '::after');
      out.push({
        key: b.getAttribute('data-sort'),
        glyph: a.content,
        opacity: Number(a.opacity),
        sorted: b.parentNode.getAttribute('aria-sort'),
        clickable: getComputedStyle(b).cursor,
      });
    });
    return JSON.stringify(out);
  })()`);
  ok('all seven columns are buttons', marks.length === 7, marks.length);
  const unsorted = marks.filter((m) => !m.sorted);
  ok('every unsorted column still shows a sort indicator',
    unsorted.length === 6 && unsorted.every((m) => m.glyph && m.glyph !== 'none'
      && m.glyph !== 'normal' && m.opacity > 0.15),
    JSON.stringify(unsorted));
  ok('every header is a pointer target',
    marks.every((m) => m.clickable === 'pointer'));
  ok('exactly one column is marked sorted',
    marks.filter((m) => m.sorted).length === 1,
    JSON.stringify(marks.map((m) => [m.key, m.sorted])));

  /* Ground truth. Mirrors the comparator in studio.js, including the tie-break
   * on title — which is deliberately NOT direction-flipped, so equal rows read
   * A-Z either way. Run in-page so localeCompare is the same implementation the
   * app used. */
  await ev(`window.__expected = (key, asc) => fetch('/api/studio/stats',
      { headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((d) => d.shows.slice().sort((a, b) => {
      let x = a[key], y = b[key];
      x = x === undefined ? 0 : x;
      y = y === undefined ? 0 : y;
      const r = (typeof x === 'string') ? x.localeCompare(y) : x - y;
      if (r === 0 && key !== 'title') return a.title.localeCompare(b.title);
      return asc ? r : -r;
    }).map((s) => s.slug));`);

  // Slug is the row identity; column index 1 in the rendered table.
  const shown = () => ev(`JSON.stringify([...document.querySelectorAll('#showTableBody tr')]
    .map((r) => r.cells[1].textContent))`);

  const clickHeader = async (key) => {
    const box = await json(`(() => {
      const b = document.querySelector('.th-sort[data-sort=${JSON.stringify(key)}]');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`);
    // The real thing, not .click() — a header covered by the sticky top bar or
    // by a sibling would still fire a synthetic click and never fire a real one.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await wait(200);
  };

  console.log('\n2. clicking each header sorts by that column, both ways');
  for (const key of KEYS) {
    for (const pass of [1, 2]) {
      const asc = pass === 1 ? FIRST_DIR(key) === 'ascending' : FIRST_DIR(key) !== 'ascending';
      await clickHeader(key);

      const state = await json(`JSON.stringify([...document.querySelectorAll('.th-sort')]
        .map((b) => [b.getAttribute('data-sort'), b.parentNode.getAttribute('aria-sort')])
        .filter((p) => p[1]))`);
      ok(`${key} — only this column is marked, ${asc ? 'ascending' : 'descending'}`,
        state.length === 1 && state[0][0] === key
          && state[0][1] === (asc ? 'ascending' : 'descending'),
        JSON.stringify(state));

      const want = await json(`window.__expected(${JSON.stringify(key)}, ${asc})
        .then(JSON.stringify)`);
      const got = JSON.parse(await shown());
      const at = got.findIndex((s, i) => s !== want[i]);
      ok(`${key} — the rows on screen are in that order`,
        got.length === want.length && at === -1,
        at === -1 ? `${got.length} vs ${want.length} rows`
          : `row ${at}: showing "${got[at]}", expected "${want[at]}"`);
    }
  }

  console.log('\n3. sorting and the filter compose');
  await ev(`(() => {
    const f = document.getElementById('showFilter');
    f.value = 'radio';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);
  await clickHeader('title');   // 'newest' was last; this makes title ascending
  const filtered = JSON.parse(await shown());
  const titles = await json(`JSON.stringify([...document.querySelectorAll('#showTableBody tr')]
    .map((r) => r.cells[0].textContent))`);
  ok('the filter narrowed the table', filtered.length > 0 && filtered.length < rowCount,
    `${filtered.length} of ${rowCount}`);
  ok('every remaining row matches the filter',
    titles.every((t, i) => (t + filtered[i]).toLowerCase().includes('radio')),
    JSON.stringify(titles.slice(0, 3)));
  ok('the narrowed rows are still sorted',
    titles.every((t, i) => i === 0 || titles[i - 1].localeCompare(t) <= 0),
    JSON.stringify(titles));

  await ev(`(() => {
    const f = document.getElementById('showFilter');
    f.value = '';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);

  /* ---- 4. the order probe must be able to see a wrong order
   *
   * Everything above is "the rows are in order", which is the shape of
   * assertion that passes forever once it stops looking. So break the order on
   * purpose — swap two rows in the DOM — and require the comparison to fail.
   * If this section reports "the probe did not notice", every ok() above is
   * worthless and the suite says so. */
  console.log('\n4. self-test — a shuffled table must be caught');
  await clickHeader('title');       // known state: title, one direction or the other
  const dir = await ev("document.querySelector('.th-sort[data-sort=\"title\"]').parentNode.getAttribute('aria-sort')");
  await ev(`(() => {
    const b = document.getElementById('showTableBody');
    b.insertBefore(b.rows[b.rows.length - 1], b.rows[0]);   // last row to the top
  })()`);
  const want = await json(`window.__expected('title', ${dir === 'ascending'})
    .then(JSON.stringify)`);
  const got = JSON.parse(await shown());
  const noticed = got.some((s, i) => s !== want[i]);
  ok('the probe notices a row moved out of order', noticed,
    'the comparison passed on a table that was deliberately shuffled — it is blind');

  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
