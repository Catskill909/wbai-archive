// Back-to-top regression suite. Drives the real, unmodified app in headless
// Chrome and asserts EFFECTS rather than declarations (CLAUDE.md §3a):
//
//   * "is it visible" is answered with elementFromPoint — could a finger actually
//     hit it — never by reading opacity. elementFromPoint honours
//     visibility:hidden AND pointer-events:none, so it measures reachability.
//   * every scroll is real synthesized input. Assigning scrollTop would move a
//     page whose scroll handling is completely broken.
//   * §6 is the self-test: it strips the hidden state and REQUIRES the same probe
//     to notice. Without it, every "the button is hidden" assertion in this file
//     could pass by going blind.
//
// The two assertions that exist because they caught real bugs:
//   §5  — while hidden, a tap at the button's coordinates must reach the LISTING.
//         Below 1360px the button overlays content, so an opacity-only hide would
//         silently eat row clicks forever.
//   §8  — the measured gap to .player-close, the ✕ that ENDS PLAYBACK. The two
//         share the right gutter, and only a vertical offset keeps them apart.
//   §12 — clearance over the resume toast. A hardcoded 3.6rem overlapped by 9px
//         on a 390px phone, where the toast wraps to two lines.
const { connect, sleep } = require('../live-stream/cdp');

// 9224 keeps this suite off test/live-stream's 9222 and test/touch's 9223.
const PORT = 9224;
const APP = 'http://localhost:8080/';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? pass++ : fail++);
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

const PROBE = `
  var b = document.getElementById('toTop');
  if(!b) return { exists:false };
  var cs = getComputedStyle(b);
  var r  = b.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + r.height/2;
  var top = document.elementFromPoint(cx, cy);
  return {
    exists:true,
    attr: b.getAttribute('data-show'),
    visibility: cs.visibility,
    opacity: +cs.opacity,
    // The honest question: would a tap at the button's centre reach the button?
    hittable: !!(top && (top === b || b.contains(top))),
    topEl: top ? (top.tagName.toLowerCase() + (top.id ? '#'+top.id : '')) : 'none',
    rect: { l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width, h:r.height, cx:cx, cy:cy },
    playerH: getComputedStyle(document.documentElement).getPropertyValue('--player-h').trim(),
    resumeH: getComputedStyle(document.documentElement).getPropertyValue('--resume-h').trim(),
    y: document.scrollingElement.scrollTop
  };`;

const RECT = sel => `
  var e = document.querySelector(${JSON.stringify(sel)});
  if(!e) return null;
  var r = e.getBoundingClientRect();
  return { t:r.top, b:r.bottom, l:r.left, r:r.right, w:r.width, h:r.height };`;

const shown = s => s.hittable && s.visibility === 'visible' && s.opacity > 0.5;

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  // Real input. `mouse` synthesizes a wheel, which is what a desktop scroll is;
  // §12 switches to `touch` once the viewport is a phone.
  let source = 'mouse';
  const scroll = async (dy, speed = 2500) => {
    const vp = await p.eval(`return { w: innerWidth, h: innerHeight };`);
    await p.send('Input.synthesizeScrollGesture', {
      x: Math.round(vp.w / 2), y: Math.round(vp.h / 2),
      xDistance: 0, yDistance: -dy, gestureSourceType: source,
      speed, repeatCount: 0
    });
  };

  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: APP });
  await sleep(4000);

  console.log('\n1. at rest, top of page');
  let s = await p.eval(PROBE);
  check('the button exists', s.exists);
  check('hidden at the top of the page', !shown(s), `attr=${s.attr} vis=${s.visibility} hit=${s.hittable}`);
  await scroll(1000); await sleep(1400);              // 1000 < 1.5 * 1000
  s = await p.eval(PROBE);
  check('under the 1.5-viewport threshold it stays hidden', !shown(s),
    `scrolled ${Math.round(s.y)}px of a 1500px threshold`);

  console.log('\n2. deep in the listing, scrolling stops');
  await scroll(1600); await sleep(1400);
  s = await p.eval(PROBE);
  check('visible after scrolling deep and stopping', shown(s), `y=${Math.round(s.y)} opacity=${s.opacity}`);
  check('a real tap at its centre reaches the button', s.hittable, `topEl=${s.topEl}`);

  console.log('\n3. ducks out while moving (down), returns on the idle timer');
  await scroll(700); await sleep(250);
  s = await p.eval(PROBE);
  check('hidden 250ms into a downward scroll', !shown(s), `attr=${s.attr} hit=${s.hittable}`);
  await sleep(900);
  s = await p.eval(PROBE);
  check('back after ~800ms of stillness', shown(s), `attr=${s.attr}`);

  console.log('\n4. upward scroll shows it immediately, not on the timer');
  await scroll(700); await sleep(200);                // hide it; idle timer now pending
  s = await p.eval(PROBE);
  check('hidden going down (precondition)', !shown(s), `attr=${s.attr}`);
  await scroll(-250); await sleep(250);               // up, well inside the 800ms window
  s = await p.eval(PROBE);
  check('visible 250ms after an UPWARD scroll (no idle wait)', shown(s), `attr=${s.attr}`);

  console.log('\n5. while hidden it must not eat taps meant for the listing');
  await scroll(700); await sleep(250);
  s = await p.eval(PROBE);
  const coords = s.rect;
  check('hidden (precondition)', !shown(s), `attr=${s.attr}`);
  const under = await p.eval(`
    var el = document.elementFromPoint(${coords.cx}, ${coords.cy});
    return { tag: el ? el.tagName.toLowerCase() : 'none',
             id: el ? el.id : '', isBtn: !!(el && el.id === 'toTop') };`);
  check('a tap at its coordinates passes THROUGH to what is underneath',
    !under.isBtn, `hit <${under.tag}${under.id ? '#' + under.id : ''}>`);

  console.log('\n6. SELF-TEST: the probe above can still see the button');
  // If this fails, every "hidden" assertion in this file is worthless — it would
  // mean the probe reports "unreachable" no matter what the app does.
  await p.eval(`document.getElementById('toTop').setAttribute('data-show','true'); return 1;`);
  await sleep(300);
  s = await p.eval(PROBE);
  check('forcing data-show="true" makes the SAME probe report hittable', shown(s),
    `hit=${s.hittable} vis=${s.visibility} opacity=${s.opacity}`);
  // Same x exactly; y is 6px higher than §5 measured, because the hidden state
  // carries translateY(6px) — the probe was aimed at the parked position, which is
  // the correct thing to have probed.
  const dx = Math.abs(s.rect.cx - coords.cx), dy = coords.cy - s.rect.cy;
  check('and at the coordinates §5 probed (minus the 6px exit offset)',
    dx < 1 && dy > 4 && dy < 8,
    `${Math.round(coords.cx)},${Math.round(coords.cy)} vs ${Math.round(s.rect.cx)},${Math.round(s.rect.cy)} (dy=${dy})`);

  console.log('\n7. desktop geometry: right gutter, clear of the content column');
  const geo = await p.eval(`
    var b = document.getElementById('toTop').getBoundingClientRect();
    var l = document.querySelector('.listing').getBoundingClientRect();
    return { btnRight: b.right, btnLeft: b.left, colRight: l.right, w: innerWidth };`);
  check('sits RIGHT of the content column, not over it',
    geo.btnLeft >= geo.colRight, `button left=${Math.round(geo.btnLeft)} column right=${Math.round(geo.colRight)}`);
  check('and not jammed against the viewport edge',
    geo.w - geo.btnRight > 12, `${Math.round(geo.w - geo.btnRight)}px of margin`);

  console.log('\n8. lifts above the player bar, and clears the close ✕');
  await p.eval(`
    var bar = document.getElementById('playerBar');
    bar.hidden = false; document.body.classList.add('has-player'); return 1;`);
  await sleep(600);
  const lift = await p.eval(`
    var b = document.getElementById('toTop').getBoundingClientRect();
    var bar = document.getElementById('playerBar').getBoundingClientRect();
    return { btnBottom: b.bottom, barTop: bar.top,
             playerH: getComputedStyle(document.documentElement).getPropertyValue('--player-h').trim() };`);
  check('--player-h was measured from the real bar', /^[1-9]/.test(lift.playerH), lift.playerH);
  check('button clears the bar entirely', lift.btnBottom <= lift.barTop,
    `button bottom=${Math.round(lift.btnBottom)} bar top=${Math.round(lift.barTop)}`);

  // The point of the whole right-gutter compromise: this button and the ✕ that
  // ENDS PLAYBACK share one margin, and only the 2rem lift in the min-width:1360
  // block keeps them apart. Measure the real gap between the two boxes rather
  // than trusting that the numbers in the CSS still add up.
  const clash = await p.eval(`
    var a = document.getElementById('toTop').getBoundingClientRect();
    var c = document.querySelector('.player-close').getBoundingClientRect();
    var dx = Math.max(0, Math.max(a.left - c.right, c.left - a.right));
    var dy = Math.max(0, Math.max(a.top - c.bottom, c.top - a.bottom));
    return { dx: dx, dy: dy, gap: Math.sqrt(dx*dx + dy*dy),
             overlap: !(a.right < c.left || c.right < a.left || a.bottom < c.top || c.bottom < a.top) };`);
  check('does not overlap the close ✕', !clash.overlap);
  check('keeps >=28px of clear space from the close ✕', clash.gap >= 28,
    `gap=${clash.gap.toFixed(0)}px (dx=${clash.dx.toFixed(0)} dy=${clash.dy.toFixed(0)})`);
  await p.eval(`
    var bar = document.getElementById('playerBar');
    bar.hidden = true; document.body.classList.remove('has-player'); return 1;`);

  console.log('\n9. tablet width: centred overlay');
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await scroll(1800); await sleep(1400);
  s = await p.eval(PROBE);
  check('visible at tablet width', shown(s), `attr=${s.attr}`);
  check('horizontally centred', Math.abs(s.rect.cx - 500) < 2, `centre x=${Math.round(s.rect.cx)}`);

  console.log('\n10. gets out of the way of overlays');
  await p.click('.menu-btn');
  await sleep(700);
  const locked = await p.eval(`return document.documentElement.classList.contains('scroll-lock');`);
  s = await p.eval(PROBE);
  check('scroll-lock is on (precondition)', locked === true);
  check('unreachable behind an open overlay', !shown(s), `vis=${s.visibility} hit=${s.hittable} topEl=${s.topEl}`);
  await p.eval(`var c = document.querySelector('.menu-close'); if(c) c.click(); return 1;`);
  await sleep(800);

  console.log('\n11. the click actually returns the page to the top');
  await scroll(2200); await sleep(1400);
  s = await p.eval(PROBE);
  check('visible before the click (precondition)', shown(s), `y=${Math.round(s.y)}`);
  const before = s.y;
  // clickInPlace, not click: click() calls scrollIntoView() first, which would
  // make this assertion a measurement of the harness (see cdp.js).
  await p.clickInPlace('#toTop');
  await sleep(1600);
  const after = await p.eval(`
    return { y: document.scrollingElement.scrollTop,
             focus: document.activeElement ? document.activeElement.id : 'none' };`);
  check('page reached the top', after.y === 0, `${Math.round(before)} → ${after.y}`);
  check('focus followed the viewport (keyboard users are not stranded)',
    after.focus === 'top', `activeElement=#${after.focus}`);
  s = await p.eval(PROBE);
  check('and it did not flicker back on during the glide', !shown(s), `attr=${s.attr}`);

  console.log('\n12. phone: touch target, and clearance over the resume toast');
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await p.send('Emulation.setEmulatedMedia', { features: [
    { name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
    { name: 'hover',   value: 'none'   }, { name: 'any-hover',   value: 'none'   }
  ]});
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  source = 'touch';
  await sleep(500);
  await p.eval(`
    var bar = document.getElementById('playerBar');
    bar.hidden = false; document.body.classList.add('has-player'); return 1;`);
  await scroll(2200); await sleep(1400);
  s = await p.eval(PROBE);
  check('visible on a phone', shown(s), `attr=${s.attr}`);
  check('tap target is >=44px (HIG floor / WCAG 2.5.8)',
    s.rect.w >= 44 && s.rect.h >= 44, `${s.rect.w}x${s.rect.h}`);
  check('centred', Math.abs(s.rect.cx - 195) < 2, `centre x=${Math.round(s.rect.cx)}`);
  const parked = s.rect.b;

  // The resume toast floats above the bar in the same strip. --resume-h must be
  // measured, not assumed: the toast wraps to two lines at this width.
  await p.eval(`document.getElementById('resumeToast').hidden = false; return 1;`);
  await sleep(600);
  s = await p.eval(PROBE);
  const toast = await p.eval(RECT('.resume-toast'));
  check('--resume-h picked up the toast', /^[1-9]/.test(s.resumeH), s.resumeH);
  check('button lifted clear of the toast', s.rect.b <= toast.t,
    `button bottom=${Math.round(s.rect.b)} toast top=${Math.round(toast.t)} (toast is ${toast.h.toFixed(1)}px tall)`);
  await p.eval(`document.getElementById('resumeToast').hidden = true; return 1;`);
  await sleep(600);
  s = await p.eval(PROBE);
  check('and dropped back when the toast was dismissed', Math.abs(s.rect.b - parked) < 2,
    `${Math.round(parked)} → ${Math.round(s.rect.b)}`);

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
  p.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n💥 ' + e.message + '\n'); process.exit(1); });
