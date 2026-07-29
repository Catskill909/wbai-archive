// "A reload lands at the top of the list, not where you left it."
//
// The list renders PAGE_SIZE (40) rows and appends more as you scroll. The
// browser's default scroll restoration replays an offset that was valid against
// several hundred rendered rows onto a page that currently has forty — so on
// Chrome for Android a reload deep in the archive lands in blank space past the
// end of the list. `history.scrollRestoration = 'manual'` in theme-boot.js turns
// that off.
//
// This suite asserts the EFFECT — where the viewport actually ends up after a
// real reload — not that the property reads 'manual'. Setting the property and
// still jumping is precisely the failure this is guarding, and a property check
// cannot tell the two apart (CLAUDE.md §3a).
//
// Section 3 is the self-test: it puts restoration back to 'auto' and REQUIRES
// the probe to report a jump. An assertion of "the page did not move" that has
// never been shown to fail is indistinguishable from a blind one.
const { connect, sleep } = require('../live-stream/cdp.js');
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  ok   ' + n))
                            : (fail++, console.log('  FAIL ' + n + (d ? '  -> ' + d : ''))); };

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');

  async function load(mobile = true) {
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 800, deviceScaleFactor: 1, mobile });
    await p.send('Emulation.setTouchEmulationEnabled',
      mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2600);
  }
  const y = () => p.eval(`return Math.round(window.scrollY);`);
  const scrollTo = n => p.eval(`window.scrollTo(0, ${n}); return 1;`);
  // Page.reload is the real thing — the same path a pull-to-refresh takes, and
  // the one that consults scrollRestoration. Re-navigating to the URL would not
  // exercise restoration at all and would pass no matter what.
  const reload = async () => { await p.send('Page.reload'); await sleep(2600); };

  console.log('\n1. reload from deep in the list');
  await load();
  await scrollTo(4000);
  const deep = await y();
  ok('scrolled deep before reloading', deep > 2000, 'y=' + deep);
  await reload();
  const after = await y();
  ok('reload landed at the top', after <= 2, 'y=' + after);

  console.log('\n2. the first row is actually on screen afterwards');
  // "scrollY is 0" is necessary but not sufficient — the list has to be usable.
  const firstRow = await p.eval(`
    var el = document.querySelector('.card-wrap, .row.body');
    if(!el) return { ok:false, why:'no rows rendered' };
    var r = el.getBoundingClientRect();
    return { ok: r.top > 0 && r.top < innerHeight, top: Math.round(r.top) };`);
  ok('a list row is visible in the viewport', firstRow.ok,
    firstRow.why || 'top=' + firstRow.top);

  console.log('\n3. self-test — the probe can still see a jump');
  // Restore the default and confirm the same probe reports a restored offset.
  // If this does NOT jump, the probe is blind and sections 1-2 prove nothing.
  await load();
  await p.eval(`history.scrollRestoration = 'auto'; return 1;`);
  await scrollTo(4000);
  const beforeAuto = await y();
  ok('scrolled deep again', beforeAuto > 2000, 'y=' + beforeAuto);
  await reload();
  const afterAuto = await y();
  ok('with restoration back on, the reload DOES jump (probe is not blind)',
    afterAuto > 200, 'y=' + afterAuto + ' — probe cannot see restoration; sections 1-2 are unproven');

  console.log('\n4. the property is set from <head>, before app.js runs');
  // Not a substitute for section 1 — a supplement. It catches the case where the
  // line is moved into app.js and happens to still pass because the list is
  // short enough that the jump is invisible.
  await load();
  const where = await p.eval(`
    var s = [].slice.call(document.querySelectorAll('script[src]')).map(function(x){
      return { src: x.getAttribute('src').split('?')[0], inHead: x.closest('head') !== null };
    });
    return { boot: s.find(function(x){ return /theme-boot/.test(x.src); }) || null,
             mode: history.scrollRestoration };`);
  ok('theme-boot.js is loaded from <head>', !!(where.boot && where.boot.inHead),
    JSON.stringify(where.boot));
  ok('scrollRestoration reads "manual" at rest', where.mode === 'manual', where.mode);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
