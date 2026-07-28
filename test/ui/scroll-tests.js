// "Changing a filter sends the list back to its first row."
//
// Asserts the SCROLL POSITION the user ends up at, and — the part that matters —
// that the first row of the new list is actually on screen afterwards. Checking
// only "scrollY got smaller" would pass on a function that moved you anywhere.
const { connect, sleep } = require('../live-stream/cdp.js');
// 9224: live-stream owns 9222 and touch owns 9223. See run.sh.
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log('  ok   ' + n))
                            : (fail++, console.log('  FAIL ' + n + (d ? '  -> ' + d : ''))); };

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');

  async function load(w = 390, touch = true) {
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 800, deviceScaleFactor: 1, mobile: touch });
    await p.send('Emulation.setTouchEmulationEnabled',
      touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2600);
  }
  const y = () => p.eval(`return Math.round(window.scrollY);`);
  const scrollTo = n => p.eval(`window.scrollTo(0, ${n}); return 1;`);

  // Is the first row of the list actually visible, below the sticky bars?
  const firstRowVisible = () => p.eval(`
    var el = document.querySelector('.card-wrap, .row.body');
    if(!el) return { ok:false, why:'no rows' };
    var r = el.getBoundingClientRect();
    var bar = document.querySelector('.controls-row').getBoundingClientRect();
    return { ok: r.top >= bar.bottom - 2 && r.top < innerHeight, top: Math.round(r.top),
             barBottom: Math.round(bar.bottom) };`);

  const listTop = () => p.eval(`
    var row = document.querySelector('.controls-row'), hero = document.querySelector('.hero');
    var st = parseFloat(getComputedStyle(row).top) || 0;
    return Math.round(Math.max(0, hero.getBoundingClientRect().top + window.scrollY + hero.offsetHeight - st));`);

  console.log('\n1. category change from deep in the list');
  await load();
  await p.eval(`try{localStorage.removeItem('wbai-view')}catch(e){}; return 1;`);
  await load();
  const target = await listTop();
  await scrollTo(3000);
  const deep = await y();
  ok('actually scrolled deep first', deep > 2000, 'y=' + deep);

  await p.eval(`
    document.getElementById('catTrigger').click();
    return 1;`);
  await sleep(400);
  await p.eval(`
    var opts = document.querySelectorAll('.cat-option');
    for (var i = 0; i < opts.length; i++) if (opts[i].dataset.cat === 'news') { opts[i].click(); break; }
    return 1;`);
  await sleep(500);
  const after = await y();
  ok('scrolled back up', after < deep, `${deep} -> ${after}`);
  ok('landed exactly at the list top', Math.abs(after - target) <= 1, `${after} vs target ${target}`);
  let v = await firstRowVisible();
  ok('first row of the NEW list is on screen', v.ok === true, JSON.stringify(v));
  ok('sticky bar is still parked at the top', v.barBottom > 0 && v.barBottom < 200, 'barBottom=' + v.barBottom);

  console.log('\n2. it only ever scrolls UP');
  await load();
  await scrollTo(0);
  await p.eval(`document.getElementById('catTrigger').click(); return 1;`);
  await sleep(300);
  await p.eval(`
    var opts = document.querySelectorAll('.cat-option');
    for (var i = 0; i < opts.length; i++) if (opts[i].dataset.cat === 'music') { opts[i].click(); break; }
    return 1;`);
  await sleep(400);
  ok('filtering from the top does not yank you down', (await y()) === 0, 'y=' + await y());

  console.log('\n3. search and sort reset it too (same defect)');
  await load();
  await scrollTo(3000);
  await p.eval(`
    var el = document.getElementById('q');
    el.value = 'radio';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;`);
  await sleep(500);
  ok('search resets the list', Math.abs((await y()) - target) <= 1, 'y=' + await y());

  // sort headers only exist in list view
  await load(1200, false);
  await p.eval(`document.querySelector('.view-btn[data-view="list"]').click(); return 1;`);
  await sleep(600);
  const t2 = await listTop();
  await scrollTo(3000);
  await p.eval(`document.querySelector('.sortbtn').click(); return 1;`);
  await sleep(500);
  ok('sorting resets the list', Math.abs((await y()) - t2) <= 1, `y=${await y()} target=${t2}`);

  console.log('\n4. the view toggle too — it resets paging to 40 rows');
  await p.eval(`try{localStorage.removeItem('wbai-view')}catch(e){}; return 1;`);
  await load(1200, false);
  await scrollTo(3000);
  await p.eval(`document.querySelector('.view-btn[data-view="list"]').click(); return 1;`);
  await sleep(600);
  const vy = await y();
  ok('switching view does not strand you past the end',
    vy < 3000, 'y=' + vy);
  v = await firstRowVisible();
  ok('first row visible after a view switch', v.ok === true, JSON.stringify(v));

  console.log('\n5. SELF-TEST — firstRowVisible() can still report FALSE');
  // Every assertion above is "the first row ended up on screen". That whole set
  // passes forever once the probe goes blind, so make it prove it can still
  // fail: scroll deep WITHOUT touching a filter, and require it to notice.
  await p.eval(`try{localStorage.removeItem('wbai-view')}catch(e){}; return 1;`);
  await load();
  await scrollTo(3000);
  const blind = await firstRowVisible();
  ok('reports NOT-visible when the page is deep and nothing reset it',
    blind.ok === false, JSON.stringify(blind));

  console.log('\n6. the refresh pill must NOT reset — it holds position on purpose');
  // Source-level guard, deliberately. The refresh path only fires when upstream
  // actually changes, which a test cannot provoke on demand; but its whole
  // design (it re-shows `shown` rows to keep you where you were) is undone the
  // moment someone adds resetListScroll to it, so pin that.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '../../public/app.js'), 'utf8');
  const refreshFn = src.slice(src.indexOf('function refreshArchive'),
                              src.indexOf('refreshBtn.addEventListener'));
  ok('found the refresh path to inspect', refreshFn.length > 200, 'len=' + refreshFn.length);
  ok('refreshArchive does not reset the scroll',
    !/resetListScroll/.test(refreshFn));
  ok('refreshArchive still restores the row count it had',
    /keepShown/.test(refreshFn));
  // and the initial load must not either — you can deep-link into a show
  const ingestFn = src.slice(src.indexOf('function ingest('), src.indexOf('function ingest(') + 400);
  ok('initial ingest() does not reset the scroll', !/resetListScroll/.test(ingestFn));

  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})();
