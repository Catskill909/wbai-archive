// Remote-playback (Cast / AirPlay) button suite.
//
// ⚠️ READ THIS BEFORE TRUSTING A GREEN RUN. **Headless Chrome has no Media
// Router.** It discovers no cast devices, ever. So this suite cannot tell
// "correctly hidden because no device is present" apart from "permanently
// invisible because this browser never reports devices at all" — it only ever
// observes one branch of that condition, which means it has not tested it.
//
// That is not hypothetical. On the day this shipped, all 30 assertions below
// passed and were reported as "built and working" while the button never
// appeared in desktop Chrome on a network full of cast devices (docs/
// casting-dev.md §5, §6a). Nothing here was wrong about what it measured; it
// simply could not see the thing that was broken.
//
// Anything device-dependent needs a real browser on a real network. No amount
// of CI substitutes. docs/casting-dev.md §6b carries the manual checklist.
//
// What it does prove is the part that breaks silently and affects everyone:
//
//   1. On a browser with NO remote playback (Firefox, Safari without AirPlay),
//      the button is REMOVED FROM THE DOM — not left behind as a dead control.
//      This is the path most of the app's users take and the only one that can
//      regress without anybody noticing.
//   2. With no device on the network, the button takes no space.
//   3. Section 2's probe is self-tested: it is forced to see a visible button
//      before it is trusted to report an absent one (CLAUDE.md §3a.5 — an
//      assertion of absence that has never failed is indistinguishable from a
//      blind one).
//   4. The bar still lays out with the button in it, at phone and desktop
//      widths, measured as rendered geometry.
const { connect, sleep } = require('../live-stream/cdp.js');
const PORT = Number(process.env.CDP_PORT) || 9224;
const APP = 'http://localhost:8080/';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// Rendered geometry, not the attribute. `hidden` is a declaration; width is the
// effect, and the two came apart once already in this codebase (touch-dev.md F7
// via the CSS `[hidden]` rule that has to beat `display:flex`).
const PROBE = `
  var b = document.getElementById('playerCast');
  if(!b) return { exists: false };
  var r = b.getBoundingClientRect();
  return {
    exists: true,
    attrHidden: b.hasAttribute('hidden'),
    w: Math.round(r.width), h: Math.round(r.height),
    rendered: r.width > 0 && r.height > 0,
    display: getComputedStyle(b).display,
    label: b.getAttribute('aria-label'),
    inTabOrder: b.tabIndex >= 0 && !b.hasAttribute('aria-hidden')
  };
`;

async function load(p) {
  await p.send('Page.navigate', { url: APP });
  await sleep(1400);
}

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  // ---- 1. Supported browser (headless Chrome has HTMLMediaElement.remote) ----
  console.log('\n1. supported browser — button exists but stays out of the way');
  await load(p);

  // The bar itself is `hidden` until something plays, and display:none on an
  // ancestor gives EVERY descendant a zero box. Measuring the button inside a
  // hidden bar would report "not rendered" no matter what the button's own
  // styles said — which is precisely the blind assertion §2 exists to catch, and
  // did catch, on the first run of this suite. So the bar comes up first, and
  // only then is the button's own visibility a real question.
  const sup = await p.eval(`
    document.getElementById('playerBar').hidden = false;
    return { remote: 'remote' in document.createElement('audio'),
             barShown: getComputedStyle(document.getElementById('playerBar')).display !== 'none',
             probe: (function(){ ${PROBE} })() };
  `);
  ok('the player bar really is displayed (else the probe below is blind)',
    sup.barShown === true);
  ok('this Chrome really does expose remote playback (else §1 proves nothing)',
    sup.remote === true, JSON.stringify(sup.remote));
  ok('button survives in the DOM where remote playback exists',
    sup.probe.exists === true);
  ok('no device on the network -> button takes NO space',
    sup.probe.exists && sup.probe.rendered === false,
    JSON.stringify(sup.probe));
  ok('and it is the [hidden] rule doing it, not a zero-size box',
    sup.probe.display === 'none', sup.probe.display);

  // ---- 2. The self-test: prove the probe can still SEE a button ----------
  // Without this, §1 and §3 are assertions of absence that have never been
  // shown capable of failing.
  console.log('\n2. self-test — the probe is not blind');
  const seen = await p.eval(`
    document.getElementById('playerBar').hidden = false;   // §1 left it shown; be explicit
    var b = document.getElementById('playerCast');
    b.removeAttribute('hidden');
    var r = (function(){ ${PROBE} })();
    b.setAttribute('hidden','');
    var after = (function(){ ${PROBE} })();
    return { shown: r, restored: after };
  `);
  ok('probe reports a REVEALED button as rendered, with real size',
    seen.shown.rendered === true && seen.shown.w >= 30 && seen.shown.h >= 30,
    JSON.stringify(seen.shown));
  ok('revealed button is keyboard-reachable and labelled',
    seen.shown.inTabOrder === true && !!seen.shown.label,
    JSON.stringify({ tab: seen.shown.inTabOrder, label: seen.shown.label }));
  ok('probe reports it hidden again once restored',
    seen.restored.rendered === false);

  // ---- 3. Unsupported browser — the regression that matters -------------
  // Strip remote playback before ANY page script runs, then reload. This is the
  // Firefox / no-AirPlay-Safari path.
  console.log('\n3. no remote playback — the button must not exist at all');
  const strip = await p.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      try { delete HTMLMediaElement.prototype.remote; } catch(e){}
      try { delete HTMLMediaElement.prototype.webkitShowPlaybackTargetPicker; } catch(e){}
    `
  });
  await load(p);

  const un = await p.eval(`
    return { remote: 'remote' in document.createElement('audio'),
             picker: typeof document.createElement('audio').webkitShowPlaybackTargetPicker,
             probe: (function(){ ${PROBE} })() };
  `);
  ok('remote playback really is gone for this load (else §3 proves nothing)',
    un.remote === false && un.picker === 'undefined',
    JSON.stringify({ remote: un.remote, picker: un.picker }));
  ok('button is REMOVED from the DOM, not merely hidden',
    un.probe.exists === false, JSON.stringify(un.probe));

  // ---- 4. Layout — the bar still fits with the button in it -------------
  // The bar is `hidden` until something plays. Forcing it visible is fair here
  // because nothing about its layout depends on how it was shown, and geometry
  // is what is being measured. Playing real audio would add a network stream to
  // a layout test for nothing.
  console.log('\n4. layout — the bar absorbs the extra control at both ends');
  // Put remote playback back, or every width below would be measuring a bar
  // whose cast button app.js has already deleted.
  await p.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: strip.identifier });

  for (const w of [360, 414, 768, 1400]) {
    await p.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700
    });
    await load(p);
    const geo = await p.eval(`
      var bar = document.getElementById('playerBar');
      bar.hidden = false;
      var cast = document.getElementById('playerCast');
      cast.removeAttribute('hidden');
      var b = bar.getBoundingClientRect();
      var c = cast.getBoundingClientRect();
      var t = document.getElementById('playerTitle').getBoundingClientRect();
      var g = document.getElementById('playerToggle').getBoundingClientRect();
      return {
        barOverflows: bar.scrollWidth > bar.clientWidth + 1,
        castInViewport: c.left >= 0 && c.right <= innerWidth && c.width > 0,
        castW: Math.round(c.width),
        overlapsToggle: !(c.right <= g.left + 1 || c.left >= g.right - 1),
        titleW: Math.round(t.width),
        docOverflows: document.documentElement.scrollWidth > innerWidth + 1
      };
    `);
    ok(`${w}px — player bar does not overflow horizontally`,
      geo.barOverflows === false, JSON.stringify(geo));
    ok(`${w}px — cast button is fully on screen`,
      geo.castInViewport === true, JSON.stringify(geo));
    ok(`${w}px — cast button does not overlap play/pause`,
      geo.overlapsToggle === false, JSON.stringify(geo));
    ok(`${w}px — the title still has room to read (>80px)`,
      geo.titleW > 80, 'titleW=' + geo.titleW);
    ok(`${w}px — page itself gained no horizontal scroll`,
      geo.docOverflows === false, JSON.stringify(geo));
  }
  await p.send('Emulation.clearDeviceMetricsOverride');

  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
