// Measures the overlay motion that actually reaches the screen.
//
// Deliberately does NOT read the stylesheet back: per CLAUDE.md §3a the
// declaration being present says nothing about the effect arriving. So this
// samples the *computed* transform frame by frame and asks the questions that
// only a real spring can answer yes to — did the panel pass its mark and come
// back? — plus the two regressions the `entering` gate exists to prevent.
const { connect } = require('../live-stream/cdp.js');
const BASE = 'http://localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
let entranceMs = 0;      // measured in the first section, compared against in the last
function check(ok, what, detail) {
  (ok ? pass++ : fail++);
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail !== undefined ? '  [' + detail + ']' : ''));
}

// Sample a computed property every animation frame for `ms`, starting the frame
// after `trigger` runs. Returns [{t, v}].
const SAMPLER = `
window.__sample = function(sel, prop, ms, trigger){
  return new Promise(function(done){
    var out = [], el = document.querySelector(sel), t0 = null;
    trigger();
    function tick(ts){
      if(t0 === null) t0 = ts;
      out.push({ t: Math.round(ts - t0), v: getComputedStyle(el)[prop] });
      if(ts - t0 < ms) requestAnimationFrame(tick); else done(out);
    }
    requestAnimationFrame(tick);
  });
};`;

// scale factor out of a matrix()/matrix3d() string
function scaleOf(m) {
  const n = (m.match(/matrix(3d)?\(([^)]+)\)/) || [])[2];
  if (!n) return null;
  return parseFloat(n.split(',')[0]);
}
function blurOf(s) {
  const m = (s || '').match(/blur\(([\d.]+)px\)/);
  return m ? parseFloat(m[1]) : (s === 'none' ? 0 : null);
}

(async () => {
  const p = await connect(Number(process.env.CDP_PORT || 9227));
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await p.eval(SAMPLER + ' return 1;');

  console.log('\n#### the panel arrival is a spring, not an ease');
  const open = await p.eval(`
    return window.__sample('#showSheet', 'transform', 700, function(){
      document.querySelector('.show-open').click();
    });`);
  const scales = open.map(s => ({ t: s.t, s: scaleOf(s.v) })).filter(s => s.s !== null);
  const peak = Math.max(...scales.map(s => s.s));
  const start = scales[0].s;
  const range = 1 - start;
  // Overshoot only means anything RELATIVE TO THE TRAVEL. Measured absolutely it
  // read as 1.00039 and looked like a failure, when the spring was correct and
  // the distance was the problem — the first version of this probe said "no
  // spring" about a working spring. Normalise, or measure nothing.
  const overshoot = (peak - 1) / range;
  // The honest length of a transition is when the value stops changing at all.
  const lastChange = (() => {
    for (let i = scales.length - 1; i > 0; i--) {
      if (Math.abs(scales[i].s - scales[i - 1].s) > 1e-6) return scales[i].t;
    }
    return 0;
  })();

  check(scales.length > 12, 'the sampler saw a real animation (many frames)', scales.length);
  check(range > 0.04,
        'the arrival has enough travel for a curve to be felt at all',
        'scale ' + start.toFixed(3) + ' -> 1');
  check(overshoot > 0.005 && overshoot < 0.05,
        'the panel OVERSHOOTS past its resting scale then comes back — the spring',
        (overshoot * 100).toFixed(2) + '% of travel, peak ' + peak.toFixed(5));
  check(lastChange > 300,
        'the whole arrival runs well past the old .22s — the long settle is the point',
        lastChange + 'ms');
  entranceMs = lastChange;

  console.log('\n#### the scrim blur animates rather than snapping on');
  await p.eval(`document.getElementById('sheetClose').click(); return 1;`);
  await sleep(700);
  const scrim = await p.eval(`
    return window.__sample('#sheetScrim', 'backdropFilter', 500, function(){
      document.querySelector('.show-open').click();
    });`);
  const blurs = scrim.map(s => blurOf(s.v)).filter(b => b !== null);
  const distinct = new Set(blurs.map(b => b.toFixed(2)));
  check(blurs.length > 5, 'sampled the scrim backdrop-filter', blurs.length);
  check(distinct.size > 3,
        'blur passes through intermediate values (it is interpolating, not snapping)',
        distinct.size + ' distinct: ' + [...distinct].slice(0, 6).join(','));
  check(Math.max(...blurs) > 4, 'and it reaches full strength', Math.max(...blurs) + 'px');

  console.log('\n#### the contents stagger in behind the panel');
  await p.eval(`document.getElementById('sheetClose').click(); return 1;`);
  await sleep(700);
  const stag = await p.eval(`
    document.querySelector('.show-open').click();
    return new Promise(function(done){
      setTimeout(function(){
        var names = document.getElementById('showSheet')
          .getAnimations({ subtree:true })
          .map(function(a){ return a.animationName || (a.transitionProperty||''); });
        var head = document.querySelector('.sheet-head');
        done({
          entering: document.getElementById('showSheet').classList.contains('entering'),
          rises: names.filter(function(n){ return n === 'ovRise'; }).length,
          headOpacity: parseFloat(getComputedStyle(head).opacity)
        });
      }, 60);
    });`);
  check(stag.entering, 'the sheet is marked `entering` while it opens');
  check(stag.rises >= 2, 'several children are genuinely running ovRise', stag.rises + ' running');
  check(stag.headOpacity < 1,
        'the header is still fading up 60ms in — it did not just appear',
        stag.headOpacity.toFixed(3));

  console.log('\n#### ...and the gate really closes (the regression it exists for)');
  await sleep(900);
  const gated = await p.eval(`
    var eps = document.querySelectorAll('.ep');
    if(eps.length < 2) return { skip:true };
    return new Promise(function(done){
      eps[1].click();
      setTimeout(function(){
        var names = document.getElementById('showSheet')
          .getAnimations({ subtree:true })
          .map(function(a){ return a.animationName; });
        done({
          entering: document.getElementById('showSheet').classList.contains('entering'),
          rises: names.filter(function(n){ return n === 'ovRise'; }).length,
          headOpacity: parseFloat(getComputedStyle(document.querySelector('.sheet-head')).opacity)
        });
      }, 60);
    });`);
  if (gated.skip) {
    console.log('  --   no multi-episode show on the first row; skipped');
  } else {
    check(!gated.entering, 'choosing an episode leaves the sheet un-marked');
    check(gated.rises === 0, 'NOTHING re-staggers on a chip tap', gated.rises + ' running');
    check(gated.headOpacity === 1, 'the header never flickers', gated.headOpacity);
  }

  console.log('\n#### dismissal is faster than arrival, and asymmetric');
  const close = await p.eval(`
    return window.__sample('#showSheet', 'transform', 500, function(){
      document.getElementById('sheetClose').click();
    });`);
  const cs = close.map(s => ({ t: s.t, s: scaleOf(s.v) })).filter(s => s.s !== null);
  // Same metric as the entrance, so the two numbers are actually comparable —
  // the first version compared "time to get numerically close" against "total
  // duration" and called a correct asymmetry a failure.
  const exitMs = (() => {
    for (let i = cs.length - 1; i > 0; i--) {
      if (Math.abs(cs[i].s - cs[i - 1].s) > 1e-6) return cs[i].t;
    }
    return 0;
  })();
  check(exitMs > 0 && exitMs < entranceMs * 0.75,
        'the exit is markedly shorter than the entrance — dismissal is not an arrival',
        'exit ' + exitMs + 'ms vs entrance ' + entranceMs + 'ms');
  const cPeak = Math.max(...cs.map(s => s.s));
  check(cPeak <= 1.0005, 'and the exit does NOT bounce — dismissal just leaves', cPeak.toFixed(5));

  console.log('\n#### the phone bottom sheet — the case that was actually wrong');
  // On a phone the same box stops being a 4%-of-height nudge and becomes a
  // full-viewport slide. It inherited the desktop .22s and covered ~700px in
  // it, which is the one thing here that was a defect rather than a taste call.
  await p.send('Emulation.setDeviceMetricsOverride',
               { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await p.send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await p.eval(SAMPLER + ' return 1;');
  const phone = await p.eval(`
    return window.__sample('#showSheet', 'transform', 900, function(){
      document.querySelector('.show-open').click();
    });`);
  // translateY is m42 — the 6th number of matrix(), the 14th of matrix3d().
  const ys = phone.map(s => {
    const m = (s.v.match(/matrix(3d)?\(([^)]+)\)/) || []);
    if (!m[2]) return null;
    const n = m[2].split(',').map(Number);
    return { t: s.t, y: m[1] ? n[13] : n[5] };
  }).filter(Boolean);
  const travel = Math.max(...ys.map(s => s.y)) - Math.min(...ys.map(s => s.y));
  const phoneMs = (() => {
    for (let i = ys.length - 1; i > 0; i--) {
      if (Math.abs(ys[i].y - ys[i - 1].y) > 0.01) return ys[i].t;
    }
    return 0;
  })();
  check(travel > 300, 'it really is a full-height slide, not a nudge', Math.round(travel) + 'px');
  check(phoneMs > 380,
        'and it now gets time proportionate to that distance (was .22s for the same trip)',
        phoneMs + 'ms');
  await p.send('Emulation.clearDeviceMetricsOverride');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
