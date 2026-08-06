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
  '.menu-close', '.social-btn', '.player-toggle', '.player-close',
  // The theme switch sits directly beside the hamburger, so the two have to
  // measure the same as well as look the same — this catches the pair drifting
  // apart, which is easy to do because their width is set in three places
  // (base, the 480px tightening, and the coarse-pointer block).
  '.theme-btn'
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
  // This section used to assert `getComputedStyle(document.body).overflow` and
  // passed green while the page scrolled behind ALL SIX overlays. The honest
  // probe is p.pageScrolls() — a real touch gesture through the compositor;
  // cdp.js documents why the two obvious alternatives both lie.
  //
  // `locked` deliberately requires BOTH the behaviour and the marker class: the
  // behaviour is what the user feels, the class localises a failure to the JS
  // (never toggled) vs the CSS (toggled, no effect).
  const locked = async () =>
    !(await p.pageScrolls()) &&
    await p.eval(`return document.documentElement.classList.contains('scroll-lock');`);

  // The page must be scrollable to begin with, or "locked" proves nothing.
  check('page scrolls with no overlay open', await p.pageScrolls());

  await p.click('.show-thumb');
  await sleep(700);
  check('info sheet locks the page',
        await p.eval(`return document.body.classList.contains('sheet-open');`) && await locked());

  // SELF-TEST — the guard against this whole section going quietly blind again.
  //
  // Every assertion here is of the form "the page did NOT move", and a probe
  // that can no longer move the page passes all of them for the wrong reason.
  // That is exactly how the computed-style version stayed green over six broken
  // overlays. So mutate the app out from under the probe — strip the lock while
  // the sheet is still open — and require the probe to NOTICE. If this fails,
  // every other PASS in section 4 is worthless, whatever it says.
  await p.eval(`document.documentElement.classList.remove('scroll-lock'); return 1;`);
  await sleep(200);
  const noticedUnlock = await p.pageScrolls();
  await p.eval(`document.documentElement.classList.add('scroll-lock'); return 1;`);
  await sleep(200);
  check('SELF-TEST: probe detects an UNLOCKED page in this same state',
        noticedUnlock, noticedUnlock ? 'section 4 has teeth'
                                     : 'section 4 is blind — ignore its other PASSes');

  const hasArt = await p.eval(`return !!document.querySelector('.sheet-art-zoom');`);
  if (hasArt) {
    await p.click('.sheet-art-zoom');
    await sleep(600);
    check('lightbox locks the page',
          await p.eval(`return document.body.classList.contains('lightbox-open');`) && await locked());
    await p.click('.lightbox-close');
    await sleep(500);
    // Nested: closing the lightbox must NOT unlock — the sheet is still up.
    check('lightbox close keeps the lock (sheet still open)',
          !await p.eval(`return document.body.classList.contains('lightbox-open');`) && await locked());
  } else {
    console.log('   SKIP  lightbox — this show has no artwork to zoom');
  }
  await p.eval(`document.getElementById('sheetClose').click(); return 1;`);
  await sleep(600);
  check('sheet releases the lock on close', await p.pageScrolls());

  // HONEST LIMITATION, so nobody reads more into this PASS than it carries: at
  // this 390px viewport `.donate-modal` is 100vw x 100dvh and the cross-origin
  // iframe fills it edge to edge, so EVERY sweep point lands on the iframe and a
  // drag can never reach the parent document. Verified against the unfixed code:
  // the gesture half reports "held" here even with no lock at all. It is the
  // marker-class half of `locked` that actually guards this one. The behavioural
  // half only bites on desktop widths, where the modal is a 940px card with
  // scrim around it — a viewport this suite doesn't emulate.
  await p.click('#donateBtn');
  await sleep(1200);
  check('donate modal locks the page',
        await p.eval(`return document.body.classList.contains('donate-open');`) && await locked());
  await p.eval(`document.getElementById('donateClose').click(); return 1;`);
  await sleep(500);
  check('donate modal releases the lock on close', await p.pageScrolls());

  await p.click('#menuBtn');
  await sleep(700);
  check('menu drawer locks the page',
        await p.eval(`return document.body.classList.contains('menu-open');`) && await locked());
  await p.eval(`document.getElementById('menuClose').click(); return 1;`);
  await sleep(500);
  check('menu drawer releases the lock on close', await p.pageScrolls());

  // The schedule — the sixth overlay, and the one this section was missing.
  // Opened from the drawer because that is the ONLY way in at this width: the
  // appbar's Schedule button is display:none below 480px, so a `p.click` on it
  // would throw rather than open anything.
  // Unlike donate, the behavioural half really bites here — the sheet starts
  // below --phone-sheet-gap, so the probe's top sweep point lands on bare scrim
  // and would reach the document if the lock were off.
  await p.click('#menuBtn');
  await sleep(700);
  await p.eval(`document.getElementById('menuSchedule').click(); return 1;`);
  await sleep(900);
  check('schedule locks the page',
        await p.eval(`return document.body.classList.contains('sched-open');`) && await locked());

  // Same self-test as the sheet above, for the same reason: "the page did not
  // move" is worthless from a probe that can no longer move it. Strip the lock
  // with the schedule still up and require the probe to notice.
  await p.eval(`document.documentElement.classList.remove('scroll-lock'); return 1;`);
  await sleep(200);
  const noticedSched = await p.pageScrolls();
  await p.eval(`document.documentElement.classList.add('scroll-lock'); return 1;`);
  await sleep(200);
  check('SELF-TEST: probe detects an UNLOCKED page behind the schedule',
        noticedSched, noticedSched ? 'the schedule check has teeth'
                                   : 'blind here — ignore the schedule PASS above');

  await p.eval(`document.getElementById('schedClose').click(); return 1;`);
  await sleep(700);
  check('schedule releases the lock on close', await p.pageScrolls());

  await p.click('#onAirBtn');
  await sleep(1400);
  check('live player locks the page',
        await p.eval(`return !!document.querySelector('.live-player.show');`) && await locked());
  await p.eval(`document.getElementById('lpClose').click(); return 1;`);
  await sleep(800);
  check('live player releases the lock on close', await p.pageScrolls());

  // The lock must not cost the reader their place in a 500-show listing.
  //
  // Twice: the mechanism alone, then the real path through the UI. Both, because
  // the isolated one can't be corrupted by anything else the app does, and the
  // real one is what a listener actually experiences.
  const keptPlace = await p.eval(`
    var se = document.scrollingElement, root = document.documentElement;
    se.scrollTop = 500;
    var before = se.scrollTop;
    root.classList.add('scroll-lock');
    var locked = se.scrollTop;
    root.classList.remove('scroll-lock');
    var after = se.scrollTop;
    se.scrollTop = 0;
    return { before: before, locked: locked, after: after };`);
  check('lock preserves scroll position — mechanism',
        keptPlace.before > 0 && keptPlace.locked === keptPlace.before
          && keptPlace.after === keptPlace.before,
        `${keptPlace.before} -> ${keptPlace.locked} -> ${keptPlace.after}`);

  // Same question, driven through the real UI. This needs clickInPlace(): plain
  // click() scrollIntoView()s its target, which would move the page itself and
  // then "prove" the position changed. Mark a row that is already on screen and
  // click that one — clickInPlace throws rather than scrolling if it isn't.
  const marked = await p.eval(`
    var se = document.scrollingElement;
    se.scrollTop = 500;
    var thumbs = document.querySelectorAll('.show-thumb');
    var hit = null;
    for (var i = 0; i < thumbs.length; i++){
      var r = thumbs[i].getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) continue;
      // In-view is not enough: the sticky search bar overlays the top of the
      // list, and a click there lands on INPUT#q instead. Require this row to
      // be the topmost element at its own centre.
      var top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      if (top && (top === thumbs[i] || thumbs[i].contains(top))) { hit = thumbs[i]; break; }
    }
    if (hit) hit.setAttribute('data-test-target', '1');
    return { ok: !!hit, top: se.scrollTop };`);
  if (marked.ok && marked.top > 0) {
    await p.clickInPlace('[data-test-target]');
    await sleep(800);
    const onOpen = await p.eval(`return document.scrollingElement.scrollTop;`);
    await p.eval(`document.getElementById('sheetClose').click(); return 1;`);
    await sleep(700);
    const onClose = await p.eval(`return document.scrollingElement.scrollTop;`);
    await p.eval(`var t=document.querySelector('[data-test-target]');
      if(t) t.removeAttribute('data-test-target'); return 1;`);
    check('lock preserves scroll position — real sheet open/close',
          onOpen === marked.top && onClose === marked.top,
          `${marked.top} -> ${onOpen} -> ${onClose}`);
  } else {
    check('lock preserves scroll position — real sheet open/close', false,
          'setup failed: no on-screen row at scrollTop 500');
  }

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

  // ---- 6. the ghost click
  //
  // A tap on a card is handled on TOUCHEND (the iOS momentum-scroll fix, app.js
  // "iOS Safari swallows the click…"). The browser still owes that tap a
  // synthetic click, which arrives ~70ms later AT THE SAME COORDINATES — by
  // which time the sheet the touchend just opened is under the finger. Before
  // 2026-08-06 that click hit the .sheet-scrim and closed the sheet again:
  // the modal flashed open and shut, and the card kept its focus ring because
  // closing returns focus to whatever opened the sheet. It looked like "modals
  // are broken on mobile", and no existing test could see it — everything here
  // and in test/episode-rail used p.click() or a deep link, neither of which
  // produces a ghost.
  console.log('\n6. ghost click after a touchend-handled tap');
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await p.send('Page.navigate', { url: APP });
  await sleep(3000);
  // back to gallery, where the card overlay is the tap target
  await p.eval(`try{ localStorage.removeItem('wbai-view'); }catch(e){} return 1;`);
  await p.send('Page.navigate', { url: APP });
  await sleep(3000);

  const realTap = async (x, y) => {
    const tp = [{ x: Math.round(x), y: Math.round(y), radiusX: 10, radiusY: 10, force: 1, id: 1 }];
    await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
    await sleep(50);
    await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const centre = sel => p.eval(`
    var e = document.querySelector(${JSON.stringify(sel)});
    if(!e) return null;
    var r = e.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };`);

  // Record every click, so we can tell "no ghost was fired" (a vacuous pass)
  // from "the ghost was fired and swallowed" (the actual fix).
  await p.eval(`
    window.__clicks = [];
    window.addEventListener('click', function(e){
      window.__clicks.push(String((e.target && e.target.className) || e.target.tagName).slice(0,30));
    }, true);
    return 1;`);

  const card = await centre('#rows .card-art.play-btn');
  check('a gallery card is present to tap', !!card);
  if (card) {
    await realTap(card.x, card.y);
    await sleep(900);
    const after = await p.eval(`
      var a = document.activeElement;
      return {
        sheetOpen: document.getElementById('showSheet').classList.contains('show'),
        clicks: window.__clicks,
        ringStyle: a ? getComputedStyle(a).outlineStyle : null,
        focusVisible: a && a.matches ? a.matches(':focus-visible') : null
      };`);

    check('tapping a card opens the sheet AND IT STAYS OPEN',
          after.sheetOpen === true, JSON.stringify(after.clicks));
    // The teeth: if Chrome ever stops emitting the ghost, the assertion above
    // starts passing for the wrong reason and this one fails to say so.
    check('self-test: the ghost click really did fire at the overlay',
          after.clicks.some(c => /sheet-scrim|sheet/.test(c)),
          after.clicks.join(',') || 'no clicks seen at all');
    check('no stuck focus ring on the card behind it',
          after.ringStyle === 'none' || after.focusVisible === false,
          after.ringStyle);

    // The swallow must be exactly one click wide: a DELIBERATE tap inside the
    // freshly-opened sheet, made quickly, must still register. It begins with a
    // touchstart of its own, which is what disarms the swallow.
    const chip = await centre('.eps-rail .ep:nth-child(3)');
    if (chip) {
      const beforeId = await p.eval(`return document.querySelector('.ep.on').getAttribute('data-id');`);
      await realTap(chip.x, chip.y);
      await sleep(400);
      const picked = await p.eval(`
        return { id: document.querySelector('.ep.on').getAttribute('data-id'),
                 open: document.getElementById('showSheet').classList.contains('show'),
                 playing: !document.querySelector('audio').paused };`);
      check('a fast deliberate tap inside the sheet still registers',
            picked.id !== beforeId && picked.open === true, beforeId + ' -> ' + picked.id);
      check('and choosing that way still does not start playback', picked.playing === false);
    }

    // Closing by tap must leave the listing usable, not ringed.
    const close = await centre('#sheetClose');
    await realTap(close.x, close.y);
    await sleep(800);
    const closed = await p.eval(`
      var a = document.activeElement;
      return { open: document.getElementById('showSheet').classList.contains('show'),
               ringStyle: a ? getComputedStyle(a).outlineStyle : null };`);
    check('the sheet closes on a tap', closed.open === false);
    check('and the card it came from is not left ringed', closed.ringStyle === 'none', closed.ringStyle);
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed\n`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
