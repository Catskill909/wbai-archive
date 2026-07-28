// Theme-switch behaviour suite.
//
// Asserts EFFECTS: the painted background of real elements, the persisted
// value, the browser-chrome tint, and — the one that matters most — that the
// theme survives with app.js blocked, which is the only honest proof that the
// choice lands before the first paint rather than after the bundle runs.
const { connect, sleep } = require('../live-stream/cdp.js');
// 9224: live-stream owns 9222 and touch owns 9223. See run.sh.
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const DARK_BG = 'rgb(20, 16, 15)';    // --surface-0 dark
const LIGHT_BG = 'rgb(246, 241, 234)'; // --surface-0 light

// What the page actually looks like, plus the state behind it.
const SNAP = `
  var cs = getComputedStyle(document.body);
  var metas = [].slice.call(document.querySelectorAll('meta[name="theme-color"]'))
                 .map(function(m){ return m.getAttribute('content'); });
  var card = document.querySelector('.appbar');
  return {
    attr: document.documentElement.getAttribute('data-theme'),
    bodyBg: cs.backgroundColor,
    bodyInk: cs.color,
    appbarBg: card ? getComputedStyle(card).backgroundColor : null,
    sun: getComputedStyle(document.documentElement).getPropertyValue('--sun').trim(),
    stored: (function(){ try { return localStorage.getItem('wbai-theme'); } catch(e){ return 'ERR'; } })(),
    metas: metas,
    label: (document.getElementById('themeBtn')||{}).getAttribute
             ? document.getElementById('themeBtn').getAttribute('aria-label') : null,
    hasBtn: !!document.getElementById('themeBtn'),
    bootLoaded: !!window.WBAITheme
  };
`;

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Log.enable');

  const consoleErrors = [];
  p.on(m => {
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push(m.params.entry.text);
    }
  });

  async function load(theme, { touch = true } = {}) {
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 780, deviceScaleFactor: 2, mobile: touch });
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 });
    await p.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2000);
  }
  const clearStore = () => p.eval(`try{localStorage.removeItem('wbai-theme')}catch(e){}; return 1;`);

  // ---- 1. No stored preference: follow the system, in both directions ----
  console.log('\n1. follows the system when nothing is stored');
  await load('dark');
  await clearStore();
  await load('dark');
  let s = await p.eval(SNAP);
  ok('boot script ran (CSP allows it)', s.bootLoaded === true, JSON.stringify(s.bootLoaded));
  ok('button is in the DOM', s.hasBtn === true);
  ok('no data-theme attribute', s.attr === null, String(s.attr));
  ok('body paints dark', s.bodyBg === DARK_BG, s.bodyBg);
  ok('--sun is 0 (moon face)', s.sun === '0', s.sun);
  ok('label offers light', /light/.test(s.label || ''), s.label);

  await load('light');
  s = await p.eval(SNAP);
  ok('no data-theme attribute', s.attr === null, String(s.attr));
  ok('body paints light', s.bodyBg === LIGHT_BG, s.bodyBg);
  ok('--sun is 1 (sun face)', s.sun === '1', s.sun);
  ok('label offers dark', /dark/.test(s.label || ''), s.label);

  // ---- 2. A real click flips the whole page, not just the icon ----
  console.log('\n2. clicking flips the page and persists');
  await load('dark');
  await clearStore();
  await load('dark');
  const before = await p.eval(SNAP);
  await p.click('#themeBtn');
  await sleep(700);
  s = await p.eval(SNAP);
  ok('appbar actually changed colour', s.appbarBg !== before.appbarBg,
    before.appbarBg + ' -> ' + s.appbarBg);
  ok('body paints light after click', s.bodyBg === LIGHT_BG, s.bodyBg);
  ok('ink flipped too', s.bodyInk !== before.bodyInk, before.bodyInk + ' -> ' + s.bodyInk);
  ok('data-theme=light', s.attr === 'light', String(s.attr));
  ok('--sun flipped to 1', s.sun === '1', s.sun);
  ok('persisted to localStorage', s.stored === 'light', String(s.stored));
  ok('label now offers dark', /dark/.test(s.label || ''), s.label);
  ok('both theme-color metas say light', s.metas.every(c => c === '#ffffff'), JSON.stringify(s.metas));

  // ---- 3. The choice OUTLIVES a reload and OVERRIDES the OS ----
  console.log('\n3. survives reload and beats the OS preference');
  await load('dark');   // OS still says dark; stored says light
  s = await p.eval(SNAP);
  ok('still light after reload on a dark OS', s.bodyBg === LIGHT_BG, s.bodyBg);
  ok('data-theme survived', s.attr === 'light', String(s.attr));

  // ---- 4. THE NO-FLASH PROOF ----
  // Block app.js entirely. If the page is still light, the theme was applied by
  // the head script — i.e. before the body even finished parsing, let alone
  // before app.js would have run. If this ever regresses to app.js doing the
  // work, this test goes dark and the real page gets a flash on every load.
  console.log('\n4. theme applies with app.js blocked (proves it beats first paint)');
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*app.js*' }] });
  const blocked = [];
  p.on(async m => {
    if (m.method === 'Fetch.requestPaused') {
      blocked.push(m.params.request.url);
      await p.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' });
    }
  });
  await load('dark');
  s = await p.eval(SNAP);
  // The button ships with a static aria-label in the HTML; app.js REWRITES it to
  // name the action. So "still the static text" is the proof app.js never ran —
  // a null check would have been satisfied by the markup alone.
  ok('app.js really was blocked', blocked.length > 0 && s.label === 'Switch theme',
    'blocked=' + blocked.length + ' label=' + s.label);
  ok('page is STILL light without app.js', s.bodyBg === LIGHT_BG, s.bodyBg);
  ok('data-theme set by the head script', s.attr === 'light', String(s.attr));
  await p.send('Fetch.disable');

  // ---- 5. Self-test: the probe above can still see a failure ----
  // A suite of "it stayed light" assertions passes perfectly once the probe
  // goes blind. Strip the attribute and require the measurement to notice.
  console.log('\n5. self-test — the colour probe can still detect a change');
  await load('dark');
  const litUp = await p.eval(`
    document.documentElement.removeAttribute('data-theme');
    return getComputedStyle(document.body).backgroundColor;
  `);
  ok('removing data-theme visibly reverts to dark', litUp === DARK_BG, litUp);

  // ---- 6. Back to dark, and no console errors anywhere ----
  console.log('\n6. flips back, and the console is clean');
  await load('light');
  await p.click('#themeBtn');
  await sleep(700);
  s = await p.eval(SNAP);
  ok('dark on a light OS', s.bodyBg === DARK_BG, s.bodyBg);
  ok('persisted dark', s.stored === 'dark', String(s.stored));
  ok('both metas say dark', s.metas.every(c => c === '#1c1615'), JSON.stringify(s.metas));

  // ---- 7. Hero copy clamps on phones and opens on demand ----
  // Asserts RENDERED GEOMETRY, not the presence of the CSS: -webkit-line-clamp
  // is a declaration that silently does nothing without display:-webkit-box, so
  // "is the rule there" would pass on a paragraph running its full height.
  console.log('\n7. hero copy: two lines on phones, full on desktop');
  const HERO = `
    var pEl = document.getElementById('heroDesc');
    var b = document.getElementById('heroMore');
    var rp = pEl.getBoundingClientRect(), rb = b.getBoundingClientRect();
    var lh = parseFloat(getComputedStyle(pEl).lineHeight);
    return {
      lines: Math.round(rp.height / lh),
      moreShown: getComputedStyle(b).display !== 'none',
      moreText: b.textContent,
      expanded: b.getAttribute('aria-expanded'),
      // the button must hang off the LAST LINE, not sit under the paragraph —
      // a block button below would cost the very line the clamp saves
      onLastLine: Math.abs(rb.bottom - rp.bottom) < 2,
      // full text is in the DOM regardless, so screen readers are unaffected
      chars: pEl.textContent.trim().length,
      controlsTop: Math.round(document.querySelector('.controls-row').getBoundingClientRect().top)
    };`;

  await load('light');
  let h = await p.eval(HERO);
  ok('clamped to exactly 2 lines', h.lines === 2, 'lines=' + h.lines);
  ok('"more" is visible', h.moreShown === true);
  ok('"more" hangs off the last line', h.onLastLine === true);
  ok('full text still in the DOM for screen readers', h.chars > 300, 'chars=' + h.chars);
  const collapsedTop = h.controlsTop;

  await p.click('#heroMore');
  await sleep(500);
  const h2 = await p.eval(HERO);
  ok('expands past 2 lines', h2.lines > 5, 'lines=' + h2.lines);
  ok('label becomes "less"', h2.moreText === 'less', h2.moreText);
  ok('aria-expanded tracks it', h2.expanded === 'true', String(h2.expanded));
  ok('search moved DOWN when expanded (real estate was real)',
    h2.controlsTop > collapsedTop + 100, collapsedTop + ' -> ' + h2.controlsTop);

  await p.click('#heroMore');
  await sleep(500);
  const h3 = await p.eval(HERO);
  ok('collapses again', h3.lines === 2 && h3.moreText === 'more', JSON.stringify(h3.lines));

  // Desktop must be untouched: nothing hidden, no button.
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await p.send('Emulation.setDeviceMetricsOverride',
    { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(2000);
  const hd = await p.eval(HERO);
  ok('desktop shows the whole paragraph', hd.lines >= 3, 'lines=' + hd.lines);
  ok('desktop hides the "more" button', hd.moreShown === false);

  // ---- 9. Phone meta strip + card gutters ----
  console.log('\n9. phone real estate: tally, date, toggle, card width');
  const META = `
    function edges(sel){ var e=document.querySelector(sel); if(!e) return null;
      var r=e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }
    var count = document.getElementById('resultCount');
    var rc = count.getBoundingClientRect();
    var cards = [].slice.call(document.querySelectorAll('.card-wrap')).slice(0,6);
    var tops = cards.map(function(c){ return Math.round(c.getBoundingClientRect().top); });
    return {
      countText: count.textContent,
      countIsTally: count.classList.contains('is-count'),
      countTakesSpace: rc.width > 2 && rc.height > 2,
      // clipped-but-spoken: still a live region in the a11y tree
      countLiveRegion: count.getAttribute('aria-live'),
      longShown: getComputedStyle(document.querySelector('.clock-long')).display !== 'none',
      shortShown: getComputedStyle(document.querySelector('.clock-short')).display !== 'none',
      shortText: document.querySelector('.clock-short').textContent,
      grid: edges('.grid'), toggle: edges('.view-toggle'),
      search: edges('.search-field'),
      cardW: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : null,
      perRow: tops.filter(function(t){ return t === tops[0]; }).length,
      gutter: getComputedStyle(document.documentElement).getPropertyValue('--page-gutter').trim(),
      metaPadTop: parseFloat(getComputedStyle(document.querySelector('.controls')).paddingTop),
      metaPadBottom: parseFloat(getComputedStyle(document.querySelector('.controls')).paddingBottom),
      metaH: Math.round(document.querySelector('.controls').getBoundingClientRect().height),
      toggleH: Math.round(document.querySelector('.view-toggle').getBoundingClientRect().height)
    };`;

  await p.eval(`try{localStorage.removeItem('wbai-view')}catch(e){}; return 1;`);
  await load('dark');
  let mm = await p.eval(META);
  ok('tally is marked as a tally', mm.countIsTally === true);
  ok('tally takes NO layout space on a phone', mm.countTakesSpace === false);
  ok('tally text is still there (not emptied)', /shows found/.test(mm.countText), mm.countText);
  ok('tally is still a live region (screen readers keep it)',
    mm.countLiveRegion === 'polite', String(mm.countLiveRegion));
  ok('long date hidden, short date shown', !mm.longShown && mm.shortShown,
    `long=${mm.longShown} short=${mm.shortShown}`);
  ok('short date is one line and relative', /^Latest show · /.test(mm.shortText), mm.shortText);
  ok('toggle right edge == listing right edge',
    mm.toggle[1] === mm.grid[1], `${mm.toggle[1]} vs ${mm.grid[1]}`);
  ok('search left edge == listing left edge',
    mm.search[0] === mm.grid[0], `${mm.search[0]} vs ${mm.grid[0]}`);
  ok('two cards per row', mm.perRow === 2, 'perRow=' + mm.perRow);
  // 390px wide phone: the old stack (16 listing + 1 border + 16 #rows + 14 gap)
  // left 153px cards. Anything at/below that means the gutters crept back.
  ok('cards are wider than the old gutter stack allowed',
    mm.cardW > 158, 'cardW=' + mm.cardW);
  // The strip carried 13.6/16 sized for a two-line block it no longer has.
  ok('meta strip padding is trimmed on phones',
    mm.metaPadTop < 10 && mm.metaPadBottom < 12,
    `${mm.metaPadTop}/${mm.metaPadBottom}`);
  // ...but the toggle's own tap target must NOT have paid for it
  ok('toggle is still a full tap target', mm.toggleH >= 44, 'toggleH=' + mm.toggleH);
  ok('strip is little more than the control it holds',
    mm.metaH - mm.toggleH < 20, `metaH=${mm.metaH} toggleH=${mm.toggleH}`);

  // One phone gutter, not two: check the narrowest phone resolves the same
  // value as a mid-size one, so a reintroduced sub-400px tier fails here.
  await p.send('Emulation.setDeviceMetricsOverride',
    { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
  await p.send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(2200);
  const narrow = await p.eval(META);
  ok('320px uses the same gutter as 390px — no second tier',
    narrow.gutter === mm.gutter, `320=${narrow.gutter} 390=${mm.gutter}`);
  ok('320px still aligns and still fits two cards',
    narrow.toggle[1] === narrow.grid[1] && narrow.perRow === 2,
    `toggle=${narrow.toggle[1]} grid=${narrow.grid[1]} perRow=${narrow.perRow}`);

  // Desktop must keep the roomy 1rem gutter and show both the tally and the date
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await p.send('Emulation.setDeviceMetricsOverride',
    { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(2200);
  const md = await p.eval(META);
  ok('desktop gutter is still 1rem', md.gutter === '1rem', md.gutter);
  ok('desktop meta padding is UNtrimmed (13.6/16)',
    md.metaPadTop > 13 && md.metaPadBottom > 15, `${md.metaPadTop}/${md.metaPadBottom}`);
  ok('desktop still shows the tally', md.countTakesSpace === true);
  ok('desktop shows the long date, not the short', md.longShown && !md.shortShown,
    `long=${md.longShown} short=${md.shortShown}`);
  ok('desktop edges still align', md.toggle[1] === md.grid[1], `${md.toggle[1]} vs ${md.grid[1]}`);

  // ---- 11. App bar without the wordmark ----
  console.log('\n11. app bar: wordmark dropped on phones, nothing wraps');
  const BAR = `
    function box(sel){ var e=document.querySelector(sel); if(!e) return null;
      var b=e.getBoundingClientRect();
      if(b.width===0 && b.height===0) return null;
      return { l:Math.round(b.left), r:Math.round(b.right), h:Math.round(b.height) }; }
    var lab = document.querySelector('.on-air-label');
    var lh = parseFloat(getComputedStyle(lab).lineHeight);
    // open the drawer so its logo is measurable, then put it back
    document.getElementById('menuBtn').click();
    var drawerLogo = box('.menu-logo');
    document.getElementById('menuClose').click();
    return {
      brand: box('.appbar .brand'),
      menu: box('.menu-btn'),
      grid: box('.grid'),
      // the whole point of the exercise: one line, not two
      listenWraps: lab.getBoundingClientRect().height > lh * 1.5,
      drawerLogoH: drawerLogo ? drawerLogo.h : null,
      overflow: document.documentElement.scrollWidth > innerWidth
    };`;

  for (const w of [320, 360, 412]) {
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 800, deviceScaleFactor: 1, mobile: true });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2200);
    const b = await p.eval(BAR);
    ok(`${w}px: appbar wordmark is gone`, b.brand === null, JSON.stringify(b.brand));
    ok(`${w}px: "Listen Live" is ONE line`, b.listenWraps === false);
    ok(`${w}px: hamburger aligns with the listing edge`,
      b.menu.r === b.grid.r, `${b.menu.r} vs ${b.grid.r}`);
    ok(`${w}px: nothing overflows`, b.overflow === false);
    // the deleted .brand-logo override used to shrink this too
    ok(`${w}px: drawer logo is its own 22px, not the appbar's`,
      b.drawerLogoH === 22, 'h=' + b.drawerLogoH);
  }

  // Above phone-portrait the wordmark must come back
  for (const [w, touch] of [[560, true], [1200, false]]) {
    await p.send('Emulation.setTouchEmulationEnabled',
      touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await p.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 900, deviceScaleFactor: 1, mobile: touch });
    await p.send('Page.navigate', { url: 'http://localhost:8080/' });
    await sleep(2200);
    const b = await p.eval(BAR);
    ok(`${w}px: wordmark is back`, b.brand !== null && b.brand.l < 60, JSON.stringify(b.brand));
    ok(`${w}px: still aligned, still no overflow`,
      b.menu.r === b.grid.r && !b.overflow, `${b.menu.r} vs ${b.grid.r}`);
  }

  console.log('\n12. console is clean across every step above');
  // ERR_BLOCKED_BY_CLIENT is test 4 blocking app.js on purpose.
  const relevant = consoleErrors.filter(t =>
    !/favicon|archive2|confessor|streaming\.wbai|ERR_BLOCKED_BY_CLIENT/i.test(t));
  ok('no console errors (CSP included)', relevant.length === 0, relevant.join(' | '));

  await clearStore();
  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})();
