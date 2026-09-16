// Reduced-motion hover suite: nothing lifts on hover when the OS asks for less motion.
//
// The bug this exists for: in dark mode a gallery card still rose 2px on hover
// with prefers-reduced-motion, because the override `.card-art.play-btn:hover`
// (0,3,0) lost to the lift it was meant to cancel,
// `.card-wrap:hover .card.card-art.play-btn` (0,5,0). An override written
// against a weaker selector than the rule it cancels looks right in the file
// and does nothing — so this suite doesn't read the overrides. It collects
// every :hover rule that sets a transform, hovers a real matching element with
// real mouse input, and measures the computed transform, in both themes and
// both views.
//
// "Moves" means position: the translate part of the transform changes between
// rest and hover. A centred glyph that only scales in place (.card-play's
// translate(-50%,-50%) scale(.82) -> scale(1)) does not move and is not a lift.
// Pseudo-element rules (::after, slider thumbs) can't be measured this way and
// are listed, not silently passed.
//
// Self-test (CLAUDE.md §3a.4): the same sweep with motion allowed must SEE the
// lifts, or a probe that can't detect a transform would pass everything.
//
//   APP_URL=http://localhost:8081 CDP_PORT=9228 node --experimental-websocket reduced-motion-hover-tests.js
const { connect, sleep } = require('../live-stream/cdp.js');
// translate components of a computed transform ("none" or matrix(a,b,c,d,e,f))
function translateOf(t) {
  const m = /^matrix\(([^)]+)\)$/.exec(t || '');
  if (!m) return [0, 0];
  const v = m[1].split(',').map(Number); return [v[4], v[5]];
}
function shift(a, b) { const [ax, ay] = translateOf(a), [bx, by] = translateOf(b); return Math.hypot(bx - ax, by - ay); }
const BASE = process.env.APP_URL || 'http://localhost:8080';
const PORT = Number(process.env.CDP_PORT) || 9228;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// Every :hover rule with a transform, outside reduced-motion blocks, turned
// into the selector of the element that moves (the rule's subject).
const COLLECT = `(function(){
  var out = [];
  function walk(rules, inReduce){
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.cssRules && r.media) { walk(r.cssRules, inReduce || /prefers-reduced-motion:\\s*reduce/.test(r.media.mediaText)); continue; }
      if (r.cssRules && !r.selectorText) { walk(r.cssRules, inReduce); continue; }
      if (inReduce || !r.selectorText || r.selectorText.indexOf(':hover') < 0) continue;
      var t = r.style && r.style.transform;
      if (!t || t === 'none') continue;
      r.selectorText.split(',').forEach(function(sel){
        if (sel.indexOf(':hover') < 0) return;
        var pseudo = /::/.test(sel);
        out.push({ rule: sel.trim(), pseudo: pseudo, target: sel.replace(/:hover/g, '').replace(/::[\w-]+/g, '').trim() });
      });
    }
  }
  [].forEach.call(document.styleSheets, function(s){ try { walk(s.cssRules, false); } catch (e) { /* cross-origin sheet: none are expected */ } });
  return JSON.stringify(out);
})()`;

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable'); await p.send('Runtime.enable');
  const ev = async e => (await p.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  const W = 1400, H = 1000;
  await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  // Storage keys differ between station builds (KPFK: "<id>:view", WBAI: "wbai-view").
  await p.send('Page.navigate', { url: BASE + '/' }); await sleep(1500);
  const keys = JSON.parse(await ev(`JSON.stringify(window.StationConfig && window.StationConfig.storagePrefix
    ? { view: StationConfig.storagePrefix + 'view', theme: StationConfig.storagePrefix + 'theme' }
    : { view: 'wbai-view', theme: 'wbai-theme' })`));

  async function sweep(motion, theme, view) {
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }, { name: 'prefers-color-scheme', value: 'light' }] });
    await ev(`localStorage.setItem('${keys.view}','${view}'); localStorage.setItem('${keys.theme}','${theme}'); 1`);
    await p.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('#rows .row.body, #rows .card-wrap').length > 4`)) break; await sleep(250); }
    await sleep(800);
    const rules = JSON.parse(await ev(COLLECT));
    const results = [];
    const find = async (target) => ev(`(function(){
        var list; try { list = document.querySelectorAll(${JSON.stringify(target)}); } catch (e) { return null; }
        for (var i = 0; i < list.length; i++) {
          var el = list[i], r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          if (r.width < 8 || r.height < 8 || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
          el.scrollIntoView({ block: 'center' });
          r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight) continue;
          window.__probe = el;
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }
        return null;
      })()`);
    for (const { rule, target, pseudo } of rules) {
      if (pseudo) { results.push({ rule, reachable: false, why: 'pseudo-element' }); continue; }
      let box = await find(target);
      if (!box) { // some controls only exist once the page is scrolled (back-to-top)
        await ev(`window.scrollTo(0, 2400); 1`); await sleep(500);
        box = await find(target);
      }
      if (!box) { results.push({ rule, reachable: false, why: 'not on screen' }); continue; }
      const { x, y } = JSON.parse(box);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: H / 2 });
      await sleep(450);
      const restT = await ev(`getComputedStyle(window.__probe).transform`);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(450); // past every hover transition in the file (.18s)
      const t = await ev(`getComputedStyle(window.__probe).transform`);
      const hovered = await ev(`window.__probe.matches(${JSON.stringify(rule.replace(/:hover.*$/, '') + ':hover')}) || !!window.__probe.closest(':hover')`);
      results.push({ rule, reachable: true, hovered, moved: shift(restT, t) > 0.5, transform: restT + ' -> ' + t });
    }
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: H / 2 });
    return results;
  }

  for (const theme of ['dark', 'light']) for (const view of ['grid', 'list']) {
    console.log(`\n${theme} · ${view} view`);
    const reduced = await sweep('reduce', theme, view);
    const allowed = await sweep('no-preference', theme, view);
    const reach = reduced.filter(r => r.reachable);
    ok(`${theme}/${view}: found hover-lift rules to check`, reduced.length > 0, 'none collected');
    for (const r of reach) ok(`${theme}/${view}: reduced motion, no lift — ${r.rule}`, r.hovered && !r.moved,
      !r.hovered ? 'pointer did not hover it' : 'moved: ' + r.transform);
    // self-test: with motion allowed the same probe must see at least one lift,
    // and in grid view it must see the card lift in this theme
    const seen = allowed.filter(r => r.reachable && r.moved);
    ok(`${theme}/${view}: self-test — motion allowed, the probe sees lifts`, seen.length > 0, 'no transform seen on any hovered element');
    if (view === 'grid') ok(`${theme}/grid: self-test — a gallery card lifts with motion allowed`,
      seen.some(r => /card/.test(r.rule)), 'no card lift seen: ' + seen.map(r => r.rule).join(' | '));
    const skipped = reduced.filter(r => !r.reachable).map(r => r.rule + ' [' + r.why + ']');
    if (skipped.length) console.log('  (not checked: ' + skipped.join(' | ') + ')');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
