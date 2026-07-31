'use strict';

/**
 * Studio layout — does the dashboard fit the screen it is on?
 *
 * Why this exists as its own suite: the studio shipped with every panel clipped
 * on the right at phone widths, and **nothing caught it**. The HTTP tests were
 * green, there were no console errors, no CSP violations, and
 * `document.scrollWidth === clientWidth` — the page did not scroll sideways,
 * because the overflow was being hidden rather than scrolled. It was visible
 * only in a screenshot.
 *
 * The cause was `min-width: auto` on grid items: the section holding a 122-row
 * table refused to shrink below the table's min-content width, which sized the
 * whole grid column to 619px inside a 390px viewport. So the probe below cannot
 * be "does the document scroll" — it has to be "is anything drawn outside the
 * viewport that is not inside something scrollable".
 *
 * Section 3 is the self-test required by CLAUDE.md §3a: it puts the bug back and
 * requires the probe to report it. An overflow test that has never seen overflow
 * is indistinguishable from one that cannot see it.
 *
 *   CDP_PORT=9225 node --experimental-websocket layout-tests.js
 */

const cdp = require('../live-stream/cdp.js');

const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.BASE || 'http://localhost:8080';
const PASSWORD = process.env.STUDIO_PASSWORD || 'local-dev-password';

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`       ${detail}`);
}

/* Anything painted past the right edge that is NOT inside a scrollable box.
 * A wide table inside `overflow:auto` is correct design, not overflow, so the
 * walk up the ancestor chain is the whole point of the measurement. */
const OVERFLOW_PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const scrolls = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (/auto|scroll|hidden/.test(o.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  };
  const bad = [...document.querySelectorAll('body *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 1 && !scrolls(el);
  });
  return JSON.stringify({
    vw,
    docScrolls: document.documentElement.scrollWidth > vw + 1,
    count: bad.length,
    worst: bad.slice(0, 3).map((el) => el.tagName.toLowerCase()
      + '.' + String(el.className || '').split(' ')[0]
      + ' right=' + Math.round(el.getBoundingClientRect().right)),
  });
})()`;

(async () => {
  const c = await cdp.connect(PORT);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });

  const ev = async (e) => (await c.send('Runtime.evaluate',
    { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  const size = (w) => c.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 900, deviceScaleFactor: 2, mobile: w < 500 });
  const go = async () => {
    await c.send('Page.navigate', { url: BASE + '/studio' });
    await new Promise((r) => setTimeout(r, 1500));
  };

  // ---- sign in once; the session cookie survives the navigations below
  await size(1100);
  await go();
  if (await ev("!!document.getElementById('loginForm')")) {
    await ev(`(function(){
      document.getElementById('password').value = ${JSON.stringify(PASSWORD)};
      document.getElementById('loginForm').requestSubmit();
    })()`);
    await new Promise((r) => setTimeout(r, 1800));
  }
  const isDash = await ev("!!document.getElementById('showTableBody')");
  console.log('\n1. the dashboard is up');
  ok('signed in and rendering the dashboard', isDash);
  if (!isDash) { console.log('\ncannot continue'); process.exit(1); }

  // The charts must have actually drawn — an empty page trivially fits.
  console.log('\n2. it fits every width it claims to support');
  for (const w of [1280, 1100, 768, 430, 390, 360]) {
    await size(w);
    await go();
    const drew = await ev(`document.querySelectorAll('.bar-row').length > 10
      && !!document.querySelector('#perDay svg')
      && document.querySelectorAll('#showTableBody tr').length > 0`);
    const r = JSON.parse(await ev(OVERFLOW_PROBE));
    ok(`${w}px — charts rendered`, drew);
    ok(`${w}px — nothing painted outside the viewport`, r.count === 0,
      `${r.count} element(s): ${r.worst.join(', ')}`);
    ok(`${w}px — the document itself does not scroll sideways`, !r.docScrolls);
  }

  /* ---- 3. the probe must be able to SEE the bug it was written for
   *
   * There are now TWO independent defences against the original overflow, and
   * this section removes them one at a time — which both proves the probe works
   * and documents that either one alone is sufficient:
   *
   *   1. `min-width: 0` on `.studio-section`, so a grid item may shrink below
   *      its content's minimum (the 122-row table).
   *   2. An explicit track floor — `minmax(min(21rem, 100%), 1fr)` — added when
   *      the layout was widened. A bare `1fr` track has an *automatic* minimum
   *      of `auto`, which is what let the column grow to fit min-content in the
   *      first place; `minmax()` replaces that with a real number.
   *
   * Tampering goes through the CSSOM because the app's CSP forbids injecting a
   * <style> element — itself worth knowing about this page.
   */
  console.log('\n3. self-test — remove each defence and watch it come back');
  await size(390);
  await go();
  const before = JSON.parse(await ev(OVERFLOW_PROBE));
  ok('clean at 390px before tampering', before.count === 0);

  await ev(`[].forEach.call(document.querySelectorAll('.studio-section'),
    function (s) { s.style.minWidth = 'auto'; }); true`);
  await new Promise((r) => setTimeout(r, 250));
  const oneGone = JSON.parse(await ev(OVERFLOW_PROBE));
  ok('the explicit track floor alone still holds the layout', oneGone.count === 0,
    `saw ${oneGone.count}: ${oneGone.worst.join(', ')}`);

  await ev("document.querySelector('.studio-main').style.gridTemplateColumns = '1fr'; true");
  await new Promise((r) => setTimeout(r, 250));
  const bothGone = JSON.parse(await ev(OVERFLOW_PROBE));
  ok('with both defences removed the probe reports the overflow', bothGone.count > 0,
    `saw ${bothGone.count} — if this is 0 the probe is blind and section 2 proves nothing`);

  console.log(failures ? `\n${failures} failure(s)` : '\nOK — all layout checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
