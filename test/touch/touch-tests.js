// Touch-affordance tests. Drives the real, unmodified app in headless Chrome
// with CDP coarse-pointer emulation, so every @media (pointer:coarse) and
// @media (hover:none) rule in styles.css is actually live during the run.
//
// Why this exists: without the Emulation.* calls below, headless Chrome reports
// `pointer: fine` / `hover: hover`, so the entire touch layer is inert and a
// regression in it passes silently. See docs/touch-dev.md §5.
//
// TRAP, learned the hard way: the app is served under `style-src 'self'` with no
// 'unsafe-inline'. Injecting a probe <style> from Runtime.evaluate is silently
// blocked and looks exactly like an emulation failure. Every assertion here
// reads the SHIPPED stylesheet — nothing is injected.
const { connect, sleep } = require('../live-stream/cdp');

// 9223 keeps this suite off test/live-stream's 9222 — see run.sh.
const PORT = 9223;

const APP = 'http://localhost:8080/';
const MIN = 44;   // Apple HIG floor / WCAG 2.5.8

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

// Effective tap target = the element's own box, or its ::before expander,
// whichever is larger. Phase 3 grows small controls with a transparent ::before
// so the visible ink never changes.
const TARGETS = [
  '.play-btn:not(.card-art)', '.menu-btn', '.view-btn', '.sheet-close',
  '.menu-close', '.social-btn', '.player-toggle', '.player-close'
];

const SIZES = `
  // The player bar is [hidden] until something plays, and a display:none box
  // measures 0x0. Show it the same way showPlayerBar() does so its transport is
  // measured for real rather than skipped.
  var bar = document.querySelector('.player-bar');
  if (bar) { bar.hidden = false; document.body.classList.add('has-player'); }
  var out = [];
  ${JSON.stringify(TARGETS)}.forEach(function(sel){
    var el = document.querySelector(sel);
    if(!el) { out.push({sel: sel, missing: true}); return; }
    var r  = el.getBoundingClientRect();
    var pb = getComputedStyle(el, '::before');
    var pw = parseFloat(pb.width) || 0, ph = parseFloat(pb.height) || 0;
    out.push({ sel: sel, w: Math.max(r.width, pw), h: Math.max(r.height, ph) });
  });
  return out;`;

// Directly interrogate the guard: find every @media rule in the shipped
// stylesheet whose condition mentions hover:hover, and ask whether it matches.
const GUARDS = `
  var conds = [];
  for (var i = 0; i < document.styleSheets.length; i++){
    var rules; try { rules = document.styleSheets[i].cssRules; } catch(e){ continue; }
    for (var j = 0; j < rules.length; j++){
      var r = rules[j];
      if (r.type === CSSRule.MEDIA_RULE && /hover\\s*:\\s*hover/.test(r.conditionText))
        conds.push(r.conditionText);
      if (r.type === CSSRule.MEDIA_RULE && r.cssRules){
        for (var k = 0; k < r.cssRules.length; k++){
          var n = r.cssRules[k];
          if (n.type === CSSRule.MEDIA_RULE && /hover\\s*:\\s*hover/.test(n.conditionText))
            conds.push(n.conditionText);
        }
      }
    }
  }
  return { count: conds.length, anyMatch: conds.some(function(c){ return matchMedia(c).matches; }) };`;

const BASE = `
  var btn = document.querySelector('.play-btn:not(.card-art)') || document.querySelector('button');
  var q = document.getElementById('q');
  return {
    tapHighlight: getComputedStyle(document.documentElement).webkitTapHighlightColor,
    touchAction:  getComputedStyle(btn).touchAction,
    userSelect:   getComputedStyle(btn).userSelect || getComputedStyle(btn).webkitUserSelect,
    inputFont:    getComputedStyle(q).fontSize,
    rangeTouch:   getComputedStyle(document.getElementById('playerRange')).touchAction,
    coarse:       matchMedia('(pointer: coarse)').matches,
    hoverNone:    matchMedia('(hover: none)').matches
  };`;

async function emulateTouch(p) {
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await p.send('Emulation.setEmulatedMedia', { features: [
    { name: 'pointer',     value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
    { name: 'hover',       value: 'none'   }, { name: 'any-hover',   value: 'none'   }
  ]});
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
}

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  // ---- 1. fine pointer: the guards must MATCH, or they'd be dead on desktop
  console.log('\n1. desktop baseline (pointer: fine)');
  await p.send('Page.navigate', { url: APP });
  await sleep(3000);
  const g0 = await p.eval(GUARDS);
  check('hover guards exist in the shipped stylesheet', g0.count > 0, g0.count + ' found');
  check('guards MATCH on a fine pointer (desktop hover still works)', g0.anyMatch === true);
  const b0 = await p.eval(BASE);
  check('search input is left alone on desktop', b0.inputFont !== '16px', b0.inputFont);
  // The Chrome profile is reused between runs, so a saved view preference from
  // the last run would survive and mask a regression in the default. Clear it
  // here; the step-2 navigate below then boots the app as a first-time visitor.
  await p.eval(`try{ localStorage.removeItem('wbai-view'); }catch(e){} return 1;`);

  // ---- 2. coarse pointer: emulate BEFORE navigating
  console.log('\n2. touch device (pointer: coarse, hover: none)');
  await emulateTouch(p);
  await p.send('Page.navigate', { url: APP });
  await sleep(3000);

  const b = await p.eval(BASE);
  check('emulation is actually live', b.coarse === true && b.hoverNone === true);
  check('tap highlight is transparent (the blue square)',
        /rgba\(0, 0, 0, 0\)|transparent/.test(b.tapHighlight), b.tapHighlight);
  check('buttons set touch-action:manipulation (no double-tap zoom)',
        b.touchAction === 'manipulation', b.touchAction);
  check('scrubber sets touch-action:none (drag is not stolen to pan)',
        b.rangeTouch === 'none', b.rangeTouch);
  check('buttons are not text-selectable on long-press',
        b.userSelect === 'none', b.userSelect);
  check('search input is 16px (no iOS focus-zoom)', b.inputFont === '16px', b.inputFont);

  const g = await p.eval(GUARDS);
  check('hover rules are INERT on touch (no stuck hover states)',
        g.anyMatch === false, g.count + ' guarded blocks, none matching');

  check('gallery is the default view for a first-time visitor', await p.eval(
    `return document.body.classList.contains('view-grid')
        && document.querySelector('.view-btn[data-view="grid"]')
             .getAttribute('aria-pressed') === 'true';`));

  // Gallery is the app's default view, but `.play-btn:not(.card-art)` and
  // `.show-thumb` below are list-row controls — in gallery view they simply do
  // not exist and every assertion about them reads "element not found". So
  // switch to list the way a listener would, through the real toggle. That also
  // exercises the toggle itself under coarse-pointer emulation.
  await p.click('.view-btn[data-view="list"]');
  await sleep(500);
  check('list view toggle works on touch', await p.eval(
    `return !document.body.classList.contains('view-grid')
        && !!document.querySelector('.show-thumb');`));

  console.log('\n3. tap targets >= ' + MIN + 'px');
  for (const t of await p.eval(SIZES)) {
    if (t.missing) { check(t.sel, false, 'element not found'); continue; }
    check(t.sel, t.w >= MIN && t.h >= MIN,
          `${Math.round(t.w)}x${Math.round(t.h)}`);
  }

  console.log('\n4. overlay scroll locks');
  await p.click('.show-thumb');
  await sleep(700);
  check('info sheet locks the page', await p.eval(
    `return document.body.classList.contains('sheet-open')
        && getComputedStyle(document.body).overflow === 'hidden';`));
  const hasArt = await p.eval(`return !!document.querySelector('.sheet-art-zoom');`);
  if (hasArt) {
    await p.click('.sheet-art-zoom');
    await sleep(600);
    check('lightbox locks the page', await p.eval(
      `return document.body.classList.contains('lightbox-open')
          && getComputedStyle(document.body).overflow === 'hidden';`));
    await p.click('.lightbox-close');
    await sleep(500);
    check('lightbox releases the lock on close', await p.eval(
      `return !document.body.classList.contains('lightbox-open');`));
  } else {
    console.log('   SKIP  lightbox — this show has no artwork to zoom');
  }
  await p.eval(`document.getElementById('sheetClose').click(); return 1;`);
  await sleep(600);
  await p.click('#donateBtn');
  await sleep(1200);
  check('donate modal locks the page', await p.eval(
    `return document.body.classList.contains('donate-open')
        && getComputedStyle(document.body).overflow === 'hidden';`));
  await p.eval(`document.getElementById('donateClose').click(); return 1;`);
  await sleep(500);
  check('donate modal releases the lock on close', await p.eval(
    `return !document.body.classList.contains('donate-open');`));

  // The scrubber is a deliberately tuned compromise, so it gets its own
  // assertions: a big press band WITHOUT a fat fixed bar eating the phone.
  // Both halves must hold — growing the band by growing the bar would pass a
  // naive size check while costing 10% of the screen forever.
  console.log('\n5. player bar: big scrub target, small bar');
  const s = await p.eval(`
    var bar = document.querySelector('.player-bar');
    bar.hidden = false; document.body.classList.add('has-player');
    var rng = document.getElementById('playerRange');
    var info = document.querySelector('.player-info');
    var r = rng.getBoundingClientRect(), ti = info.getBoundingClientRect();
    var owns = function(y){
      var el = document.elementFromPoint(r.left + r.width/2, y);
      return el === rng;
    };
    return {
      barH: bar.getBoundingClientRect().height,
      viewportH: innerHeight,
      band: r.height,
      ownsBand: owns(r.top + 2) && owns(r.top + r.height/2) && owns(r.bottom - 2),
      // The real question is behavioural, not a float comparison: does a press
      // on the title's own bottom edge still reach the title?
      stealsFromTitle: document.elementFromPoint(ti.left + 8, ti.bottom - 2) === rng
    };`);
  check('scrubber press band >= 28px', s.band >= 28, Math.round(s.band) + 'px');

  // Chrome exposes neither the thumb's computed box (getComputedStyle with the
  // pseudo hands back the input's own 114px width) nor the rule itself via
  // CSSOM — ::-webkit-slider-thumb rules are absent from cssRules entirely.
  // So this one is a SOURCE assertion against the shipped stylesheet, not a
  // computed one. Weaker, but real: it still fails if someone drops the rule.
  const css = await (await fetch(APP + 'styles.css')).text();
  const coarse = css.slice(css.lastIndexOf('@media (pointer: coarse)'));
  const thumb = /\.player-range::-webkit-slider-thumb\{[^}]*width:\s*(\d+)px/.exec(coarse);
  check('scrubber thumb >= 18px [source]', thumb && +thumb[1] >= 18,
        thumb ? thumb[1] + 'px' : 'rule not found');
  check('scrubber owns its whole band', s.ownsBand === true);
  check('band does not steal taps from the title button',
        s.stealsFromTitle === false);
  check('player bar stays under 12% of the phone screen',
        s.barH / s.viewportH < 0.12,
        `${Math.round(s.barH)}px of ${s.viewportH} = ${(s.barH / s.viewportH * 100).toFixed(1)}%`);

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed\n`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
